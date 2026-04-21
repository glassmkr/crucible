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
  // that was marked with `crucible-agent mark-reboot` / `reboot`. Forge
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

export interface IpmiInfo {
  available: boolean;
  sensors: Array<{
    name: string;
    value: number | string;
    unit: string;
    status: string;
    upper_critical?: number;
  }>;
  ecc_errors: { correctable: number; uncorrectable: number };
  sel_entries_count: number;
  sel_events_recent: SelEvent[];
  fans: FanStatus[];
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
