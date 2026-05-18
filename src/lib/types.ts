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

export interface ZfsPool {
  name: string;
  state: string;
  errors_text: string;
  scrub_errors?: number;
  scrub_repaired?: string;
  last_scrub_date?: string;
  scrub_never_run?: boolean;
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
