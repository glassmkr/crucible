export interface Snapshot {
  collector_version: string;
  timestamp: string;
  system: SystemInfo;
  cpu: CpuInfo;
  memory: MemoryInfo;
  disks: DiskInfo[];
  smart: SmartInfo[];
  network: NetworkInfo[];
  raid: RaidInfo[];
  ipmi: IpmiInfo;
  dmi?: DmiInfo;
  thermal?: ThermalInfo;
  os_alerts: OsAlerts;
  security?: SecurityData;
  zfs?: ZfsData;
  io_errors?: { count: number; devices: string[] };
  io_latency?: Array<{ device: string; avg_read_latency_ms: number | null; avg_write_latency_ms: number | null; read_iops: number; write_iops: number }>;
  conntrack?: ConntrackData;
  systemd?: SystemdData;
  ntp?: NtpData;
  file_descriptors?: FileDescriptorData;
  // Planned-reboot flag: set only on the first snapshot after a reboot
  // that was marked with `crucible-agent mark-reboot` / `reboot`. Dashboard
  // reads this to suppress the `unexpected_reboot` rule. Single-use:
  // subsequent snapshots don't carry it.
  expected_reboot?: boolean;
  expected_reboot_reason?: string;

  // C1-C6 fields added 2026-05-19 (CC_SPEC_FORGE_FOLLOWUP_C1_C6_ACTIVATION).
  // Each is optional + omitted when the collector returns null; the
  // dashboard's activation PR carries capability gates that key off
  // field presence.
  /** EDAC memory-error counters per memory controller + DIMM. */
  ecc_edac?: EdacSnapshot;
  /** PSI pressure-stall counters per resource (cpu, memory, io). */
  psi?: PsiSnapshot;
  /** /proc/vmstat swap-in/out rates. */
  vmstat?: VmstatSnapshot;
  /** pstore / kdump / wtmp signals corroborating a reboot. */
  reboot_evidence?: RebootEvidence;
  /** Hardware RAID controllers scraped via vendor CLIs. */
  hardware_raid?: HardwareRaidSnapshot;
}

// === C1 EDAC ===

export interface EdacDimm {
  /** dimm_label (vendor-defined string, e.g. "CPU1_DIMM_A1"). */
  label: string;
  /** dimm_location (slot number / chip-channel ordering). */
  location: string;
  /** DIMM size in MB; null if /sys did not report. */
  size_mb: number | null;
  ce_count: number;
  ue_count: number;
}

export interface EdacSnapshot {
  /** Sum of ce_count across all memory controllers. */
  edac_corrected_total: number;
  /** Sum of ue_count across all memory controllers. */
  edac_uncorrected_total: number;
  /** Per-DIMM detail. Empty array on hosts where dimm metadata
   *  isn't exposed (older EDAC drivers). */
  dimms: EdacDimm[];
}

// === C2 PSI ===

export interface PsiResource {
  /** Rolling average % over the last 10 / 60 / 300 seconds. */
  avg10: number;
  avg60: number;
  avg300: number;
  /** Cumulative microseconds stalled since boot. */
  total: number;
}

export interface PsiSnapshot {
  cpu?: { some: PsiResource; full?: PsiResource };
  memory?: { some: PsiResource; full?: PsiResource };
  io?: { some: PsiResource; full?: PsiResource };
}

// === C3 vmstat ===

export interface VmstatSnapshot {
  /** Cumulative pswpin since boot. */
  pswpin_total: number;
  pswpout_total: number;
  /** Per-second swap-in rate over the most recent interval; null on
   *  the first snapshot (no baseline) or after a counter reset (host
   *  reboot mid-session). */
  pswpin_rate: number | null;
  pswpout_rate: number | null;
}

// === C4 reboot evidence ===

export interface RebootEvidence {
  /** True if /sys/fs/pstore/ contains any dmesg-* / console-* records
   *  from the prior kernel. */
  pstore_present: boolean;
  /** Number of pstore records found (zero when pstore_present=false). */
  pstore_record_count: number;
  /** True if /var/crash/ contains a kdump vmcore. */
  vmcore_present: boolean;
  /** Most recent `last reboot -F` output line, verbatim. Null if
   *  `last` is unavailable or wtmp is empty. */
  wtmp_reboot_record: string | null;
  /** Heuristic: true when wtmp shows a `shutdown` record before the
   *  most recent reboot (suggests a clean shutdown). false when only
   *  the boot record is present (suggests hard reset or power loss). */
  prior_shutdown_clean: boolean;
}

// === C5 hardware RAID ===

export interface HardwareRaidController {
  vendor: "dell" | "hpe" | "lsi" | "adaptec";
  controller_id: string;
  /** Vendor-reported overall state, e.g. "Optimal", "Degraded",
   *  "Critical", "Failed", or "Unknown". The dashboard's
   *  raid_degraded evaluator pages on any state != "Optimal". */
  state: string;
  /** Count of physical disks the controller flagged as failed /
   *  degraded; null when the parser couldn't extract this. */
  degraded_disks: number | null;
  /** Optional vendor-text excerpt the dashboard can surface in
   *  evidence; null when not captured. */
  raw_summary: string | null;
}

export interface HardwareRaidSnapshot {
  controllers: HardwareRaidController[];
}

export interface ConntrackData {
  available: boolean;
  count: number;
  max: number;
  percent: number;
}

export interface SystemdData {
  failed_units: string[];
  failed_count: number;
  /** Last 5 journal lines per failed unit, populated only when at
   *  least one unit is failed. Keys match `failed_units`. Codex
   *  experiment 2026-05-12. */
  journal_excerpts?: Record<string, string[]>;
}

export interface NtpData {
  synced: boolean;
  offset_seconds: number;
  source: string;
  daemon_running: boolean;
}

export interface FileDescriptorData {
  allocated: number;
  free: number;
  max: number;
  percent: number;
}

export interface ZfsVdev {
  /** Vdev name, e.g. "raidz2-0", "mirror-0", or a raw device for
   *  single-device top-level stripes. */
  name: string;
  /** Vdev state from `zpool status` (ONLINE, DEGRADED, FAULTED,
   *  REMOVED, SUSPENDED, UNAVAIL). */
  state: string;
  /** Redundancy class. C6 addition (2026-05-19): scaled vdev severity
   *  matrix on the dashboard side depends on this so a DEGRADED
   *  raidz1 (zero remaining tolerance) pages differently from a
   *  DEGRADED raidz2 (one disk-fault budget left). */
  redundancy_class: "mirror" | "raidz1" | "raidz2" | "raidz3" | "draid" | "stripe";
  /** Number of child devices under this vdev in a non-ONLINE state. */
  degraded_disks_count: number;
}

export interface ZfsPool {
  name: string;
  state: string;
  errors_text: string;
  scrub_errors?: number;
  scrub_repaired?: string;
  last_scrub_date?: string;
  scrub_never_run?: boolean;
  /** Top-level data vdevs. Always present from collector v0.10.4+.
   *  Dashboard tolerates absent (older agents) via capability gates. */
  vdevs: ZfsVdev[];
  /** Separate log (SLOG / ZIL) vdevs. Empty array on pools without
   *  a SLOG configured. */
  slog_vdevs: ZfsVdev[];
  /** Cache (L2ARC) vdevs. Empty array on pools without L2ARC. */
  l2arc_vdevs: ZfsVdev[];
}

export interface ZfsData {
  pools: ZfsPool[];
}

export interface SecurityData {
  ssh: { permitRootLogin: string; passwordAuthentication: string; rootPasswordExposed: boolean } | null;
  firewall: { active: boolean; source: string; details: string };
  pending_updates: { distro: string; pendingCount: number; available: boolean } | null;
  kernel_vulns: Array<{ name: string; status: string; mitigated: boolean }>;
  kernel_reboot: { running: string; installed: string; needsReboot: boolean } | null;
  auto_updates: { configured: boolean; mechanism: string; details: string };
}

export interface SystemInfo {
  hostname: string;
  ip: string;
  os: string;
  /** `ID=` from /etc/os-release, lowercased. e.g. "ubuntu", "debian", "rocky", "arch", "alpine". */
  os_id?: string;
  /** `ID_LIKE=` from /etc/os-release, lowercased, space-separated. Used by Dashboard
   *  to pick distro-family-specific fix command variants. e.g. on Rocky this
   *  is "rhel centos fedora"; on Ubuntu it is "debian". */
  os_id_like?: string;
  /** `VERSION_ID=` from /etc/os-release, lowercased. e.g. "13" on Debian
   *  trixie, "24.04" on Ubuntu, "9.6" on Rocky. Combined with `os_id` by
   *  Dashboard to form the distro token (`debian-13` etc.) that
   *  FIX-workflow variant patterns key on. Added 2026-05-18. */
  os_version_id?: string;
  kernel: string;
  uptime_seconds: number;
}

export interface CpuCoreInfo {
  core: number;
  user_percent: number;
  system_percent: number;
  iowait_percent: number;
  idle_percent: number;
  irq_percent: number;
  softirq_percent: number;
}

export interface CpuInfo {
  user_percent: number;
  system_percent: number;
  iowait_percent: number;
  idle_percent: number;
  load_1m: number;
  load_5m: number;
  load_15m: number;
  cores?: CpuCoreInfo[];
}

export interface MemoryInfo {
  total_mb: number;
  used_mb: number;
  available_mb: number;
  swap_total_mb: number;
  swap_used_mb: number;
}

export interface DiskInfo {
  device: string;
  mount: string;
  total_gb: number;
  used_gb: number;
  available_gb: number;
  percent_used: number;
  fstype?: string;
  options?: string;
  inodes_total?: number;
  inodes_used?: number;
  inodes_free?: number;
  io_read_mb_s?: number;
  io_write_mb_s?: number;
  latency_p99_ms?: number;
}

export interface SmartInfo {
  device: string;
  model: string;
  health: string;
  temperature_c?: number;
  percentage_used?: number;
  reallocated_sectors?: number;
  pending_sectors?: number;
  power_on_hours?: number;
}

export interface NetworkInfo {
  interface: string;
  speed_mbps: number;
  rx_bytes_sec: number;
  tx_bytes_sec: number;
  /** Delta over the collection interval (rx_errors + any subtype counter). */
  rx_errors: number;
  tx_errors: number;
  rx_drops: number;
  tx_drops: number;
  /** Delta over the collection interval. Null if counter not available on this NIC. */
  rx_packets?: number;
  tx_packets?: number;
  /** Fine-grained RX hardware-error subtypes (deltas). Null if unavailable. */
  rx_crc_errors?: number;
  rx_frame_errors?: number;
  rx_length_errors?: number;
  /** TX physical-layer fault counter (delta). Null if unavailable. */
  tx_carrier_errors?: number;
  operstate?: string; // "up", "down", "unknown", etc. from /sys/class/net/{iface}/operstate
  bond_master?: string; // if this interface is a bond slave, the bond name
  is_bond_master?: boolean; // true when this entry represents the bond aggregate
}

export interface RaidInfo {
  device: string;
  level: string;
  status: string;
  degraded: boolean;
  disks: string[];
  failed_disks: string[];
}

export interface SelEvent {
  id: number;
  timestamp: string;
  sensor: string;
  sensor_type: string;
  event: string;
  direction: string;
  severity: string;
}

export interface FanStatus {
  name: string;
  rpm: number;
  status: string;
}

export type Vendor =
  | "dell"
  | "hpe"
  | "supermicro"
  | "asrockrack"
  | "lenovo"
  | "inspur"
  | "cisco"
  | "generic"
  | "virtual";

export interface DmiInfo {
  available: boolean;
  vendor: Vendor;
  /** Exact /sys/class/dmi/id/sys_vendor contents, trimmed. */
  raw_vendor: string | null;
  product_name: string | null;
  bios_version: string | null;
  bios_date: string | null;
  is_virtual: boolean;
}

export type PsuRedundancyState = "fully_redundant" | "redundancy_lost" | "redundancy_degraded" | "unknown";

export type IpmiCapability =
  | { available: true; method: "ipmitool_in_band"; ipmitool_version: string | null }
  | { available: false; reason: "no_ipmitool_binary" | "no_bmc_device" | "execution_failed" | "permission_denied"; detail?: string };

export interface IpmiInfo {
  available: boolean;
  /** One-shot startup detection result; helps Dashboard surface "IPMI not
   *  available on this host" with a precise reason. Not present on
   *  pre-detection snapshots (older agent versions). */
  detection?: IpmiCapability;
  sensors: Array<{
    name: string;
    value: number | string;
    unit: string;
    status: string;
    upper_critical?: number;
  }>;
  /**
   * Named-sensor ECC counters from `ipmitool sensor`. `null` when the
   * agent could not probe IPMI at all (no ipmitool, no /dev/ipmi0, etc.).
   * Distinguishes "we have a real zero reading from the BMC" from "we
   * couldn't ask". Before 0.9.4 this was always `{ correctable: 0,
   * uncorrectable: 0 }` even when IPMI was unavailable, which made the
   * Dashboard dashboard render "ECC: 0 / 0" on boxes that aren't being
   * probed. glassmkr#29 / cross-vendor IPMI audit Phase 1.
   */
  ecc_errors: { correctable: number; uncorrectable: number } | null;
  /**
   * ECC error counts derived from SEL events instead of named sensors.
   * Dell iDRAC reports memory ECC only via SEL on the Memory entity, so
   * the named-sensor counter (`ecc_errors`) stays at zero on Dell. The
   * `ecc_errors` rule reads max(named, sel) to cover both vendors.
   * Cumulative since last SEL clear, not rate over interval.
   */
  ecc_errors_from_sel?: {
    correctable: number;
    uncorrectable: number;
    newest_event_timestamp: string | null;
  };
  /**
   * Aggregate PSU redundancy state from a vendor sensor (currently Dell
   * `PS Redundancy` only). Undefined on hosts where no aggregate sensor
   * exists; the rule then falls back to per-PSU status checks.
   */
  psu_redundancy_state?: PsuRedundancyState;
  /**
   * `null` when ECC/sensor data is unavailable for the same reason as
   * `ecc_errors`. Distinguishes "BMC reports 0 SEL events" from "we
   * couldn't ask the BMC".
   */
  sel_entries_count: number | null;
  sel_events_recent: SelEvent[];
  fans: FanStatus[];
}

export interface ThermalReading {
  label: string;
  value_celsius: number;
  source_chip: string;
  source: "hwmon" | "thermal_zone";
}

export interface ThermalInfo {
  available: boolean;
  source: "hwmon" | "thermal_zone" | "none";
  cpu_readings: ThermalReading[];
  other_readings: ThermalReading[];
  max_cpu_celsius: number | null;
}

export interface OsAlerts {
  oom_kills_recent: number;
  zombie_processes: number;
  time_drift_ms: number;
}

export interface AlertResult {
  type: string;
  severity: "critical" | "warning";
  title: string;
  message: string;
  evidence: Record<string, unknown>;
  recommendation: string;
}
