import { run } from "../lib/exec.js";
import { readProcFile } from "../lib/parse.js";
import type { DiskInfo } from "../lib/types.js";

interface MountInfo {
  device: string;
  mount: string;
  fstype: string;
  options: string;
}

/** Mount table of the HOST namespace. PID 1 is outside any service sandbox. */
const HOST_MOUNTS = "/proc/1/mounts";
/** Our own namespace. Under `ProtectSystem=strict` this reports `/` as `ro`. */
const SELF_MOUNTS = "/proc/mounts";

export interface ParsedMounts {
  mounts: MountInfo[];
  /** False when we could only read our own namespace, which means `options`
   *  may describe the sandbox rather than the host and must not be used to
   *  assert filesystem state. */
  fromHostNamespace: boolean;
}

/**
 * Read the mount table, preferring the HOST namespace.
 *
 * WHY /proc/1/mounts AND NOT /proc/mounts. Our own unit sets
 * `ProtectSystem=strict` (src/init.ts), which remounts `/` READ-ONLY inside the
 * service's mount namespace. `/proc/mounts` is `/proc/self/mounts`, so the
 * collector was reading a correct answer to the wrong question: it shipped
 * `ro,relatime,...` for `/` on a host whose root was perfectly writable, and the
 * dashboard raised a CRITICAL `filesystem_readonly` on 19 of 21 fleet hosts. The
 * only hosts spared were the two still running the pre-hardening unit.
 *
 * Reproducible with no Crucible involved:
 *   sudo systemd-run --property=ProtectSystem=strict grep ' / ' /proc/mounts
 *
 * PID 1 lives outside every service sandbox, so its table is the host's. Verified
 * as the real service user inside an identical sandbox: uid 999 CAN read
 * /proc/1/mounts and does get `rw` while its own namespace says `ro`. The unit
 * permits it because it sets neither `ProtectProc` nor `ProcSubset`.
 *
 * The fallback is NOT a silent one. `hidepid=`, `ProtectProc=invisible` or
 * `ProcSubset=pid` would make /proc/1/mounts unreadable, and in that case the
 * self view is known to be wrong under sandboxing, so we flag it and consumers
 * must abstain rather than assert. Reporting "unknown" is correct; reporting a
 * value we know the sandbox distorts is what caused this bug.
 */
export function parseMounts(read: (p: string) => string | null = readProcFile): ParsedMounts {
  const hostRaw = read(HOST_MOUNTS);
  const fromHostNamespace = hostRaw !== null && hostRaw.length > 0;
  const raw = (fromHostNamespace ? hostRaw : read(SELF_MOUNTS)) || "";
  const mounts: MountInfo[] = [];
  for (const line of raw.split("\n")) {
    const parts = line.split(" ");
    if (parts.length < 4) continue;
    mounts.push({
      device: parts[0],
      mount: parts[1],
      fstype: parts[2],
      options: parts[3],
    });
  }
  return { mounts, fromHostNamespace };
}

export async function collectDisks(): Promise<DiskInfo[]> {
  const dfOutput = await run("df", ["-B1", "--output=source,target,size,used,avail,pcent", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs"]);
  if (!dfOutput) return [];

  // Get inode data (df -i without --output, parse standard columns)
  const dfInodeOutput = await run("df", ["-i", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs"]);
  const inodeMap = new Map<string, { total: number; used: number; free: number }>();
  if (dfInodeOutput) {
    // Standard df -i output: Filesystem Inodes IUsed IFree IUse% Mounted_on
    for (const line of dfInodeOutput.trim().split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const mountPoint = parts[5];
      inodeMap.set(mountPoint, {
        total: parseInt(parts[1]) || 0,
        used: parseInt(parts[2]) || 0,
        free: parseInt(parts[3]) || 0,
      });
    }
  }

  // Mount options and fstype, from the HOST namespace where possible.
  const { mounts, fromHostNamespace } = parseMounts();
  const mountMap = new Map<string, MountInfo>();
  for (const m of mounts) {
    mountMap.set(m.mount, m);
  }

  const lines = dfOutput.trim().split("\n").slice(1);
  const disks: DiskInfo[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const device = parts[0];
    const mount = parts[1];
    const totalBytes = parseInt(parts[2]) || 0;
    const usedBytes = parseInt(parts[3]) || 0;
    const availBytes = parseInt(parts[4]) || 0;
    const pctStr = parts[5].replace("%", "");
    const percent = parseInt(pctStr) || 0;

    if (!device.startsWith("/dev/")) continue;

    const mountInfo = mountMap.get(mount);
    const inodes = inodeMap.get(mount);

    disks.push({
      device,
      mount,
      total_gb: Math.round((totalBytes / 1073741824) * 100) / 100,
      used_gb: Math.round((usedBytes / 1073741824) * 100) / 100,
      available_gb: Math.round((availBytes / 1073741824) * 100) / 100,
      percent_used: percent,
      fstype: mountInfo?.fstype,
      options: mountInfo?.options,
      // Only present when true, so ordinary snapshots are unchanged. Set when the
      // host mount table was unreadable and `options` therefore describes our own
      // possibly-sandboxed namespace; the dashboard must not assert read-only on it.
      ...(mountInfo && !fromHostNamespace ? { options_unreliable: true as const } : {}),
      inodes_total: inodes?.total,
      inodes_used: inodes?.used,
      inodes_free: inodes?.free,
    });
  }

  return disks;
}
