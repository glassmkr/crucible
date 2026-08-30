// Boot-config integrity collector (1.2.0).
//
// From the val-rocky boot-failure postmortem (2026-08-30): a `dnf` security
// update installed a new kernel whose generated boot entry inherited a STALE
// root=UUID from /etc/kernel/cmdline (left over from a prior reinstall). The
// real root filesystem had a different UUID, so on the next reboot dracut
// could not find root and dropped to the emergency shell. Nothing warned
// beforehand; the box was simply dead on the next reboot.
//
// This collector reads the boot configuration through the privileged wrapper
// (a fixed, read-only scan: findmnt + blkid + /boot listing + the cmdline
// sources + BLS entries + grub.cfg root= lines) and cross-checks every boot
// target's root= filesystem reference against the filesystems that actually
// exist. The dashboard's boot_config_broken / boot_config_drift rules consume
// the precomputed summary flags. The parser is pure and exported so it is
// unit-tested against real fleet captures.

import { runPrivileged } from "../lib/privileged.js";
import type { BootConfigData, BootEntry } from "../lib/types.js";

/** Pull the `root=` token out of a kernel command line / options string. */
function extractRootSpec(line: string): string | null {
  const m = line.match(/(?:^|\s)root=(\S+)/);
  return m ? m[1] : null;
}

/** Classify a root= spec against the present filesystems + the mounted root. */
function classifyRootSpec(
  rootSpec: string | null,
  presentUuids: Set<string>,
  presentLabels: Set<string>,
  mountedUuid: string | null,
  mountedLabel: string | null,
): { resolvable: boolean | null; matchesMounted: boolean | null } {
  if (!rootSpec) return { resolvable: null, matchesMounted: null };
  if (rootSpec.startsWith("UUID=")) {
    const u = rootSpec.slice(5);
    return {
      resolvable: presentUuids.has(u),
      matchesMounted: mountedUuid != null ? u === mountedUuid : null,
    };
  }
  if (rootSpec.startsWith("LABEL=")) {
    const l = rootSpec.slice(6);
    return {
      resolvable: presentLabels.has(l),
      matchesMounted: mountedLabel != null ? l === mountedLabel : null,
    };
  }
  // A /dev path or a PARTUUID/other form: not verifiable from blkid alone.
  return { resolvable: null, matchesMounted: null };
}

interface Sections {
  order: { header: string; body: string }[];
}

/** Split the scan output into its ===HEADER=== delimited sections. */
function splitSections(raw: string): Sections {
  const order: { header: string; body: string }[] = [];
  let header: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (header !== null) order.push({ header, body: body.join("\n") });
  };
  for (const line of raw.split("\n")) {
    const m = line.match(/^===(.*)===$/);
    if (m) {
      flush();
      header = m[1];
      body = [];
    } else if (header !== null) {
      body.push(line);
    }
  }
  flush();
  return { order };
}

/** Parse blkid `-o export` output: blank-line-separated records. */
function parseBlkid(body: string): {
  byDevname: Map<string, { uuid: string | null; label: string | null }>;
  uuids: Set<string>;
  labels: Set<string>;
  failed: boolean;
} {
  const byDevname = new Map<string, { uuid: string | null; label: string | null }>();
  const uuids = new Set<string>();
  const labels = new Set<string>();
  if (/^\s*BLKID_FAILED\s*$/m.test(body) || body.trim() === "") {
    return { byDevname, uuids, labels, failed: true };
  }
  for (const record of body.split(/\n\s*\n/)) {
    let dev: string | null = null;
    let uuid: string | null = null;
    let label: string | null = null;
    let type: string | null = null;
    for (const line of record.split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k === "DEVNAME") dev = v;
      else if (k === "UUID") uuid = v;
      else if (k === "LABEL") label = v;
      else if (k === "TYPE") type = v;
    }
    if (!dev) continue;
    byDevname.set(dev, { uuid, label });
    // Only count real filesystems as "present roots": a linux_raid_member
    // partition carries the ARRAY uuid, not a mountable fs uuid, and must
    // never satisfy a root=UUID reference (that is what the md device is for).
    if (type === "linux_raid_member") continue;
    if (uuid) uuids.add(uuid);
    if (label) labels.add(label);
  }
  return { byDevname, uuids, labels, failed: false };
}

/** Parse one BLS entry .conf body. */
function parseBlsEntry(header: string, body: string): { title: string; version: string | null; options: string | null } {
  let title = "";
  let version: string | null = null;
  let options: string | null = null;
  for (const line of body.split("\n")) {
    if (line.startsWith("title ")) title = line.slice(6).trim();
    else if (line.startsWith("version ")) version = line.slice(8).trim();
    else if (line.startsWith("options ")) options = line.slice(8).trim();
  }
  if (!title) title = header; // fall back to the path
  return { title, version, options };
}

/**
 * Parse the raw boot-config scan into structured, pre-judged data.
 * Pure: no I/O, so it is exercised directly by fixtures in tests.
 */
export function parseBootConfig(raw: string): BootConfigData {
  const { order } = splitSections(raw);
  const get = (h: string) => order.find((s) => s.header === h)?.body ?? null;

  // --- ground truth: mounted root + present filesystems ---
  const mountedSourceRaw = (get("MOUNTED_ROOT") ?? "").trim();
  const mountedSource = mountedSourceRaw && mountedSourceRaw !== "?" ? mountedSourceRaw.split("\n")[0].trim() : null;
  const blkidBody = get("BLKID") ?? "";
  const blk = parseBlkid(blkidBody);

  if (blk.failed) {
    return baseUnavailable("blkid unavailable: cannot enumerate filesystems");
  }
  const mountedFs = mountedSource ? blk.byDevname.get(mountedSource) ?? null : null;
  const mountedUuid = mountedFs?.uuid ?? null;
  const mountedLabel = mountedFs?.label ?? null;
  if (!mountedSource || !mountedUuid) {
    return baseUnavailable(
      mountedSource
        ? `mounted root ${mountedSource} has no resolvable fs UUID`
        : "could not determine the mounted root device",
    );
  }

  const classify = (spec: string | null) =>
    classifyRootSpec(spec, blk.uuids, blk.labels, mountedUuid, mountedLabel);

  // --- default-entry selection ---
  // RHEL: grubenv saved_entry names a BLS stem. Debian: GRUB_DEFAULT.
  const grubenv = get("FILE:/boot/grub2/grubenv:present") ?? get("FILE:/boot/grub/grubenv:present") ?? "";
  const savedEntry = (grubenv.match(/^saved_entry=(.+)$/m)?.[1] ?? "").trim();
  const grubDefaultRaw = (get("FILE:/etc/default/grub:present") ?? "").match(/^GRUB_DEFAULT=(.+)$/m)?.[1]?.trim() ?? "";
  const grubDefault = grubDefaultRaw.replace(/^["']|["']$/g, "");

  // --- BLS entries (RHEL) ---
  const entries: BootEntry[] = [];
  const blsHeaders = order.filter((s) => /^FILE:\/boot\/loader\/entries\/.*\.conf:present$/.test(s.header));
  for (const sec of blsHeaders) {
    const path = sec.header.replace(/^FILE:/, "").replace(/:present$/, "");
    const stem = path.replace(/^.*\//, "").replace(/\.conf$/, "");
    const { title, version, options } = parseBlsEntry(path, sec.body);
    const rootSpec = options ? extractRootSpec(options) : null;
    const { resolvable, matchesMounted } = classify(rootSpec);
    entries.push({
      source: "bls",
      title,
      kernel: version,
      root_spec: rootSpec,
      resolvable,
      matches_mounted: matchesMounted,
      is_default: savedEntry !== "" && stem === savedEntry,
    });
  }

  // --- grub.cfg menuentries (Debian) only when there are no BLS entries ---
  if (entries.length === 0) {
    const grubCfg =
      get("GRUBCFG:/boot/grub/grub.cfg:present") ??
      get("GRUBCFG:/boot/grub2/grub.cfg:present") ??
      order.find((s) => /^GRUBCFG:.*grub\.cfg:present$/.test(s.header))?.body ??
      "";
    let topIndex = -1;
    let pendingTitle: string | null = null;
    let depth = 0;
    for (const line of grubCfg.split("\n")) {
      const t = line.trim();
      const menu = t.match(/^menuentry\s+'([^']*)'/) ?? t.match(/^menuentry\s+"([^"]*)"/);
      if (menu && depth === 0) {
        pendingTitle = menu[1];
        topIndex += 1;
      }
      const linux = t.match(/^linux(?:16|efi)?\s+(\S+)\s+(.*)$/);
      if (linux && pendingTitle !== null) {
        const kpath = linux[1];
        const rootSpec = extractRootSpec(linux[2]);
        const { resolvable, matchesMounted } = classify(rootSpec);
        const kv = kpath.match(/vmlinuz-(\S+)/);
        // Debian numeric GRUB_DEFAULT indexes top-level menuentries (0-based).
        const idx = topIndex;
        const isDefault =
          (/^\d+$/.test(grubDefault) ? Number(grubDefault) === idx : idx === 0);
        entries.push({
          source: "grub.cfg",
          title: pendingTitle,
          kernel: kv ? kv[1] : null,
          root_spec: rootSpec,
          resolvable,
          matches_mounted: matchesMounted,
          is_default: isDefault,
        });
        pendingTitle = null;
      }
      // Track submenu nesting so nested (advanced) entries do not shift the
      // top-level index used by numeric GRUB_DEFAULT.
      depth += (line.match(/{/g)?.length ?? 0);
      depth -= (line.match(/}/g)?.length ?? 0);
      if (depth < 0) depth = 0;
    }
  }

  // --- cmdline source (RHEL /etc/kernel/cmdline) ---
  const cmdlineBody = get("FILE:/etc/kernel/cmdline:present");
  let cmdlineSource: BootConfigData["cmdline_source"] = null;
  if (cmdlineBody != null) {
    const rootSpec = extractRootSpec(cmdlineBody);
    const { resolvable, matchesMounted } = classify(rootSpec);
    cmdlineSource = { path: "/etc/kernel/cmdline", root_spec: rootSpec, resolvable, matches_mounted: matchesMounted };
  }

  // --- summary flags (evaluator reads these directly) ---
  const def = entries.find((e) => e.is_default) ?? null;
  const default_entry_bootable =
    def == null ? null : def.resolvable === false ? false : def.resolvable === true ? true : null;
  const default_entry_wrong_fs =
    def != null && def.resolvable === true ? def.matches_mounted === false : null;
  const unbootable_entry_count = entries.filter((e) => e.resolvable === false).length;
  const source_regressed =
    cmdlineSource == null || cmdlineSource.matches_mounted == null
      ? null
      : cmdlineSource.matches_mounted === false;

  return {
    available: true,
    mounted_root: { source: mountedSource, uuid: mountedUuid, label: mountedLabel },
    cmdline_source: cmdlineSource,
    entries,
    default_entry_bootable,
    default_entry_wrong_fs,
    unbootable_entry_count,
    source_regressed,
  };
}

function baseUnavailable(reason: string): BootConfigData {
  return {
    available: false,
    error: reason,
    mounted_root: null,
    cmdline_source: null,
    entries: [],
    default_entry_bootable: null,
    default_entry_wrong_fs: null,
    unbootable_entry_count: 0,
    source_regressed: null,
  };
}

/**
 * Collect boot-config integrity. Returns available:false (never throws) when
 * the privileged scan is unavailable, so older/unprivileged hosts and the
 * dashboard rules degrade gracefully.
 */
export async function collectBootConfig(): Promise<BootConfigData> {
  let raw: string | null = null;
  try {
    raw = await runPrivileged("boot-config", [], 15000);
  } catch (err) {
    return baseUnavailable(`boot-config scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw == null || raw.trim() === "") {
    return baseUnavailable("boot-config scan produced no output (wrapper unavailable or unprivileged)");
  }
  return parseBootConfig(raw);
}
