import { runPrivileged, isAllowedSmartType } from "../lib/privileged.js";
import { readdirSync, readFileSync } from "fs";
import type { SmartInfo, SmartUnreadable } from "../lib/types.js";

export interface CollectSmartOptions {
  /** Root of block-device discovery. Defaults to /sys/block. Injectable for tests. */
  sysBlock?: string;
  /** Read SMART JSON for a device (optionally with a `-d TYPE` selector).
   *  Defaults to the privileged smartctl wrapper. Injectable for tests. */
  probe?: (device: string, type?: string) => Promise<string | null>;
  /** Run `smartctl --scan-open`. Defaults to the privileged wrapper. Injectable. */
  scan?: () => Promise<string | null>;
}

export async function collectSmart(
  opts: CollectSmartOptions = {},
): Promise<{ smart: SmartInfo[]; unreadable: SmartUnreadable[] }> {
  const sysBlock = opts.sysBlock ?? "/sys/block";
  const probe = opts.probe ?? ((device: string, type?: string) =>
    runPrivileged("smart", type ? [device, type] : [device]));
  const scan = opts.scan ?? (() => runPrivileged("smart-scan"));

  // Find block devices. `eligible` marks a device that may be reported as a
  // SMART blind spot if unreadable: a FIXED (non-removable) disk with a known
  // non-zero size. Removable media (USB sticks/SD: removable=1) and ambiguous
  // (size-unreadable) devices are still probed for SMART but never flagged, so
  // the marker stays free of the two obvious false-positive classes.
  const devices: Array<{ path: string; eligible: boolean }> = [];
  try {
    const entries = readdirSync(sysBlock);
    for (const entry of entries) {
      if (!(entry.startsWith("sd") || entry.startsWith("nvme") || entry.startsWith("hd"))) continue;
      // Skip media-less virtual devices (BMC virtual media: "AMI Virtual
      // HDisk0" enumerates as a 0-byte USB /dev/sda on Supermicro/ASUS
      // boards). smartctl cannot interrogate them and they are not disks;
      // without this guard one produced a phantom "SMART failure on
      // /dev/sda" (agentic-17, 2026-07-05). 0-byte devices are dropped here so
      // they are never probed AND never flagged as a blind spot.
      let sizeNonZero = false;
      try {
        const size = parseInt(readFileSync(`${sysBlock}/${entry}/size`, "utf-8").trim(), 10);
        if (size === 0) continue;
        sizeNonZero = size > 0;
      } catch { /* unreadable size: let smartctl decide, but do not flag it */ }
      let removable = false;
      try {
        removable = readFileSync(`${sysBlock}/${entry}/removable`, "utf-8").trim() === "1";
      } catch { /* removable file absent: treat as fixed */ }
      devices.push({ path: `/dev/${entry}`, eligible: sizeNonZero && !removable });
    }
  } catch {
    return { smart: [], unreadable: [] };
  }

  const direct: SmartInfo[] = [];
  const unreadable: SmartUnreadable[] = [];
  for (const { path, eligible } of devices) {
    const output = await probe(path);
    if (!output) {
      // smartctl produced nothing: not installed, or the call failed/timed out.
      if (eligible) unreadable.push({ device: path, reason: "no_smartctl_output" });
      continue;
    }
    let info: SmartInfo | null = null;
    try {
      info = parseSmartctlJson(JSON.parse(output), path);
    } catch {
      if (eligible) unreadable.push({ device: path, reason: "parse_error" });
      continue;
    }
    if (info) {
      direct.push(info);
    } else if (eligible) {
      // smartctl ran but exposed no SMART surface: the controller needs a `-d`
      // type we do not try (unsupported HBA/enclosure). Distinct from 0-byte
      // virtual media (skipped) and removable media (not eligible).
      unreadable.push({ device: path, reason: "no_smart_data" });
    }
  }

  // Physical drives behind a hardware RAID/HBA controller do not appear in
  // /sys/block (only the controller's virtual disk does, and that reports SMART
  // unavailable -> null above). smartctl self-enumerates them via --scan-open,
  // which resolves the per-drive `-d TYPE` selector + device path; each is then
  // read with `-d TYPE` and flows through the SAME parseSmartctlJson. Additive:
  // bare-disk behavior above is unchanged. No storcli/vendor binary needed.
  const passthrough: SmartInfo[] = [];
  try {
    const scanOut = await scan();
    if (scanOut) {
      for (const { path, type } of parseScanOpen(scanOut)) {
        const out = await probe(path, type);
        if (!out) continue;
        try {
          // Synthetic device id: the backing path plus the selector, unique per
          // physical drive (serial is the real join key everywhere downstream).
          const info = parseSmartctlJson(JSON.parse(out), `${path}[${type}]`);
          if (info) {
            info.transport = type.split(",")[0]!.replace(/^sat\+/, "");
            info.backing_device = path;
            passthrough.push(info);
          }
        } catch {
          // Failed to parse this passthrough drive, skip it
        }
      }
    }
  } catch {
    // --scan-open unavailable: fall back to the /sys/block results only
  }

  // Blind-spot suppression: if the passthrough path produced drives, an
  // unreadable direct device is almost certainly the controller's OWN virtual
  // disk (which never reports SMART), not a blind spot: the physical drives'
  // SMART is covered via passthrough. Suppress the marker in that case so a
  // healthy HW-RAID box does not perpetually advise "SMART unreadable".
  const finalUnreadable = passthrough.length > 0 ? [] : unreadable;

  return { smart: mergeDriveResults(direct, passthrough), unreadable: finalUnreadable };
}

/**
 * Merge direct-attached and controller-passthrough SMART results, deduping ONLY
 * the one real duplication case: an IT-mode/JBOD HBA that exposes the same
 * physical drive both directly (/dev/sdX) AND via --scan-open. A passthrough
 * entry is dropped only when its serial already appeared among the DIRECT
 * disks.
 *
 * Direct disks are NEVER deduped against each other: two distinct bare disks
 * that happen to report the same placeholder serial (e.g. "000000000000",
 * common on cheap/enclosure drives) are separate devices and must both stay, or
 * a failing one would silently vanish with no smart_failing alert (Codex
 * 2026-07-17). Serial-less entries are always kept. Pure/exported for testing.
 */
export function mergeDriveResults(direct: SmartInfo[], passthrough: SmartInfo[]): SmartInfo[] {
  const directSerials = new Set(direct.map((r) => r.serial).filter(Boolean));
  const dedupedPassthrough = passthrough.filter(
    (r) => !r.serial || !directSerials.has(r.serial),
  );
  return [...direct, ...dedupedPassthrough];
}

/**
 * Parse `smartctl --scan-open` output, keeping only controller-passthrough
 * devices (physical drives behind a hardware RAID/HBA). Lines look like:
 *   /dev/bus/0 -d sat+megaraid,8 # /dev/bus/0 [megaraid_disk_08] [SAT], ATA device
 * Direct disks (`-d scsi`, `-d sat`, `-d nvme`) are skipped: they are already
 * covered by the /sys/block enumeration. Only selectors that pass
 * isAllowedSmartType (the same grammar the wrapper enforces) are forwarded, so
 * the collector never attempts a selector the root wrapper will reject. Pure/
 * exported for unit testing.
 */
export function parseScanOpen(text: string): Array<{ path: string; type: string }> {
  const out: Array<{ path: string; type: string }> = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(\S+)\s+-d\s+(\S+)/);
    if (!m) continue;
    const path = m[1]!;
    const type = m[2]!;
    if (!isAllowedSmartType(type)) continue;
    out.push({ path, type });
  }
  return out;
}

export function parseSmartctlJson(data: Record<string, unknown> & {
  model_name?: string;
  model_family?: string;
  serial_number?: string;
  firmware_version?: string;
  smart_status?: { passed?: boolean };
  temperature?: { current?: number };
  power_on_time?: { hours?: number };
  nvme_smart_health_information_log?: {
    percentage_used?: number;
    temperature?: number;
    /** NVMe Critical Warning byte (NVM Express spec §5.21). */
    critical_warning?: number;
    available_spare?: number;
    available_spare_threshold?: number;
    media_errors?: number;
    num_err_log_entries?: number;
  };
  ata_smart_attributes?: { table?: Array<{ id?: number; name?: string; value?: number; raw?: { value?: number } }> };
  ata_smart_self_test_log?: {
    standard?: {
      table?: Array<{
        type?: { string?: string };
        status?: { value?: number; string?: string; passed?: boolean };
        lifetime_hours?: number;
        lba?: number;
      }>;
      error_count_total?: number;
    };
  };
}, device: string): SmartInfo | null {
  // No SMART surface at all: smartctl emitted JSON but could not interrogate
  // the device (USB bridge without a -d type, BMC virtual media, unsupported
  // enclosure). "Cannot read SMART" is NOT "FAILED": before this guard,
  // `smart_status?.passed` being undefined fell through to FAILED and fired a
  // phantom critical smart_failing on AMI Virtual HDisk0 (agentic-17).
  if (data.smart_status === undefined && data.nvme_smart_health_information_log === undefined) {
    return null;
  }

  const info: SmartInfo = {
    device,
    model: data.model_name || data.model_family || "unknown",
    serial: data.serial_number,
    firmware: data.firmware_version,
    health: data.smart_status?.passed ? "PASSED" : "FAILED",
    temperature_c: data.temperature?.current,
    power_on_hours: data.power_on_time?.hours,
  };

  // NVMe specific
  if (data.nvme_smart_health_information_log) {
    const nvme = data.nvme_smart_health_information_log;
    info.percentage_used = nvme.percentage_used;
    info.temperature_c = nvme.temperature;
    // C17 (2026-05-19): expose the raw Critical Warning byte + per-bit
    // decoded flags so Dashboard's nvme_critical_warning rule can fire
    // on the specific failure modes. Per NVM Express spec §5.21.
    if (typeof nvme.critical_warning === "number") {
      info.critical_warning_raw = nvme.critical_warning;
      info.critical_warning_decoded = decodeNvmeCriticalWarning(nvme.critical_warning);
    }
    if (typeof nvme.available_spare === "number") {
      info.nvme_available_spare = nvme.available_spare;
    }
    if (typeof nvme.available_spare_threshold === "number") {
      info.nvme_available_spare_threshold = nvme.available_spare_threshold;
    }
    // Error counters from the same health log page: uncorrectable media
    // errors and the error-information log entry count. Growth over time is
    // the signal; the dashboard owns interpretation.
    if (typeof nvme.media_errors === "number") {
      info.media_errors = nvme.media_errors;
    }
    if (typeof nvme.num_err_log_entries === "number") {
      info.num_err_log_entries = nvme.num_err_log_entries;
    }
  }

  // SATA specific
  if (data.ata_smart_attributes?.table) {
    // SSD endurance/wear. Unlike NVMe (which has a dedicated percentage_used
    // field), a SATA SSD reports wear through a vendor-specific attribute whose
    // NORMALIZED value is "% life remaining" (100 = new, counts down toward the
    // failure threshold). Convert the most-worn such attribute into
    // percentage_used so a SATA SSD flows the SAME wear field NVMe does, which
    // is what the dashboard wear rule + trend engine read. Without this a worn
    // SATA SSD (e.g. a Crucial MX500 at 25% life remaining) is invisible to
    // wear detection. Match by attribute NAME (authoritative, and disambiguates
    // ID 231, which is wear on some drives and temperature on others) with a
    // known-ID fallback (Micron/Crucial 202, Intel 233, Samsung 177, other 173).
    // ID 231 is deliberately NOT in the id-only fallback: it is temperature on
    // some drives, so a generic-named 231 would be misread as wear (used = 100 -
    // value) on a healthy drive. A 231-as-wear drive carries a wear-like NAME
    // that the regex above already catches. Skip anything that looks like a
    // temperature attribute.
    let ssdWearUsedPct: number | null = null;
    // Seagate firmware packs multi-counters into some 48-bit raws; the unpack
    // is applied ONLY to Seagate 188 (see below). Detect by model.
    const modelStr = `${data.model_name ?? ""} ${data.model_family ?? ""}`.toLowerCase();
    const isSeagate = /seagate|\bst\d{3,}/.test(modelStr);
    for (const attr of data.ata_smart_attributes.table) {
      if (attr.id === 5 || attr.name === "Reallocated_Sector_Ct") {
        info.reallocated_sectors = attr.raw?.value || 0;
      }
      if (attr.id === 197 || attr.name === "Current_Pending_Sector") {
        info.pending_sectors = attr.raw?.value || 0;
      }
      // Drive-health early-warning expansion (2026-07-16): the remaining
      // Backblaze-five markers (187/188/198) plus path (199), mechanical
      // (10, 189) and remap-event (196) counters. Raw values only; the
      // dashboard owns threshold/trend interpretation.
      if (attr.id === 187 || attr.name === "Reported_Uncorrect") {
        // Verbatim: smartmontools treats 187 as a raw 48-bit value. Only
        // Seagate 188 is a documented packed counter (see below), so do NOT
        // truncate 187 (a magnitude heuristic would corrupt a legitimate
        // count above 65535 on any vendor).
        info.reported_uncorrectable = attr.raw?.value || 0;
      }
      if (attr.id === 188 || attr.name === "Command_Timeout") {
        // Seagate packs 188 as three 16-bit counters in the 48-bit raw; the
        // low 16 bits are the actual timeout count. Unpack ONLY on Seagate;
        // every other vendor reports a plain raw that must pass through, or a
        // genuine large count would be truncated.
        const raw = attr.raw?.value || 0;
        info.command_timeout = isSeagate ? unpackSeagateCounter(raw) : raw;
      }
      // 189: name-gated, NOT id-gated. ID 189 is High_Fly_Writes on rotating
      // HDDs but "SSD Health Flags" (PLP/thermal state) on some SATA SSDs
      // (e.g. Seagate Nytro XF1230), where an id-only match would feed a
      // flags bitfield into the high-fly-writes burst detector as a false
      // warning. The drivedb name is authoritative (the id-231 lesson).
      if (attr.name === "High_Fly_Writes") {
        info.high_fly_writes = attr.raw?.value || 0;
      }
      if (attr.id === 10 || attr.name === "Spin_Retry_Count") {
        info.spin_retries = attr.raw?.value || 0;
      }
      if (attr.id === 196 || attr.name === "Reallocated_Event_Count") {
        info.reallocation_events = attr.raw?.value || 0;
      }
      if (attr.id === 198 || attr.name === "Offline_Uncorrectable") {
        info.offline_uncorrectable = attr.raw?.value || 0;
      }
      if (attr.id === 199 || attr.name === "UDMA_CRC_Error_Count") {
        info.udma_crc_errors = attr.raw?.value || 0;
      }
      const name = (attr.name || "").toLowerCase();
      const isWearName = /wear.?level|wearout|life.?left|life.?time|percent.?life|ssd.?life|endurance/.test(name);
      const isWearId = attr.id === 202 || attr.id === 233 || attr.id === 177 || attr.id === 173;
      const looksTemperature = name.includes("temp");
      if ((isWearName || isWearId) && !looksTemperature && typeof attr.value === "number") {
        // Normalized value is life remaining; used = 100 - remaining. Take the
        // most-worn (highest used) across candidates: conservative for a
        // plan-replacement signal.
        const used = Math.min(100, Math.max(0, 100 - attr.value));
        if (ssdWearUsedPct == null || used > ssdWearUsedPct) ssdWearUsedPct = used;
      }
    }
    // Only fill percentage_used for a SATA drive; NVMe already set it from its
    // own health log above.
    if (ssdWearUsedPct != null && info.percentage_used == null) {
      info.percentage_used = ssdWearUsedPct;
    }
  }

  // SMART self-test log (ATA; `--all` includes it, so this is parse-only).
  // Emit a compact summary rather than the whole 21-slot table. last_failed_*
  // tracks the newest FAILED entry separately from the newest entry: a later
  // passing short test would otherwise mask a read failure. Log entries
  // persist for the drive's life and lifetime_hours wraps mod 65536 (ATA
  // spec), so consumers must recency-gate against power_on_hours before
  // alerting on a failure.
  const selftest = data.ata_smart_self_test_log?.standard;
  if (selftest?.table && selftest.table.length > 0) {
    const newest = selftest.table[0]!;
    // Failure = status high nibble 3..8 (fatal/unknown/electrical/servo/read/
    // handling damage per ATA), which already excludes aborted-by-host (1)
    // and interrupted-by-reset (2). The nibble is the authoritative signal;
    // we do NOT also require status.passed === false, because smartmontools
    // omits `passed` for nibble 3 (fatal/unknown), so an AND would silently
    // drop a fatal self-test failure.
    const failed = selftest.table.find((e) => {
      const nibble = (e.status?.value ?? 0) >> 4;
      return nibble >= 3 && nibble <= 8;
    });
    info.self_test = {
      last_type: newest.type?.string,
      last_status: newest.status?.string || "unknown",
      last_passed: newest.status?.passed,
      last_lifetime_hours: newest.lifetime_hours,
    };
    if (failed) {
      info.self_test.last_failed_lifetime_hours = failed.lifetime_hours;
      if (typeof failed.lba === "number") {
        info.self_test.last_failed_lba = failed.lba;
      }
    }
    if (typeof selftest.error_count_total === "number") {
      info.self_test.error_count_total = selftest.error_count_total;
    }
  }

  return info;
}

/**
 * Unpack a Seagate multi-counter SMART raw value. Seagate firmware packs up
 * to three 16-bit counters into the 48-bit raw for some attributes (188
 * Command_Timeout is the documented case: the low 16 bits are the actual
 * timeout count, higher words are threshold-bucketed variants). Values that
 * fit in 16 bits pass through unchanged, so plain counters on other vendors
 * are unaffected.
 */
export function unpackSeagateCounter(raw: number): number {
  return raw > 0xffff ? raw % 0x10000 : raw;
}

/**
 * Decode the NVMe Critical Warning byte (NVM Express spec §5.21):
 *   bit 0: available spare below threshold
 *   bit 1: temperature outside operating range
 *   bit 2: NVM subsystem reliability degraded
 *   bit 3: media in read-only mode
 *   bit 4: volatile memory backup device has failed
 *   bit 5: persistent memory region became read-only (NVMe 1.4+)
 *
 * Bit ordering differs across docs; this implementation follows the
 * spec verbatim. Any non-zero bit is a vendor-recommended immediate-
 * action signal.
 */
export function decodeNvmeCriticalWarning(byte: number): {
  available_spare_low: boolean;
  temperature_threshold: boolean;
  reliability_degraded: boolean;
  read_only: boolean;
  volatile_memory_backup_failed: boolean;
  persistent_memory_readonly: boolean;
} {
  return {
    available_spare_low: (byte & 0x01) !== 0,
    temperature_threshold: (byte & 0x02) !== 0,
    reliability_degraded: (byte & 0x04) !== 0,
    read_only: (byte & 0x08) !== 0,
    volatile_memory_backup_failed: (byte & 0x10) !== 0,
    persistent_memory_readonly: (byte & 0x20) !== 0,
  };
}
