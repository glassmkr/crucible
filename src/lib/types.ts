import type { CollectionStatusMap, CollectorAvailability } from "./availability.js";

export interface Snapshot {
  collector_version: string;
  timestamp: string;
  system: SystemInfo;
  cpu: CpuInfo;
  memory: MemoryInfo;
  disks: DiskInfo[];
  smart: SmartInfo[];
  /** Fixed (non-removable) disks present in /sys/block for which SMART could
   *  NOT be read: smartctl missing/failed, or the controller needs a `-d` type
   *  the collector does not try (unsupported HBA/enclosure). Surfaces the
   *  "disks present but SMART unreadable" blind spot so a monitored host with
   *  unreadable drives is not indistinguishable from a diskless host. Excludes
   *  0-byte BMC virtual media and removable USB/SD media by construction, and
   *  is suppressed when the controller-passthrough path returned drives (the
   *  unreadable /sys/block entry is then the controller's own virtual disk).
   *  Omitted when empty. Crucible 0.14.4+. */
  smart_unreadable?: SmartUnreadable[];
  network: NetworkInfo[];
  raid: RaidInfo[];
  ipmi: IpmiInfo;
  dmi?: DmiInfo;
  thermal?: ThermalInfo;
  os_alerts: OsAlerts;
  /** Per-collector success/failure metadata. Older agents omit this map. */
  collection_status?: CollectionStatusMap;
  security?: SecurityData;
  /** OS extended-support enrollment (Ubuntu Pro/ESM, RHEL EUS). Omitted when
   *  no unprivileged mechanism is present. The dashboard os_end_of_life rule
   *  pairs this with the release EOL date so a past-standard-support host that
   *  is still enrolled is not falsely reported unsupported. Crucible 0.13.24+. */
  support_status?: SupportStatus;
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
  /** Transitional upgrade state: init must re-secure the legacy service-owned
   *  config as root-owned mode 0640. */
  config_migration_required?: boolean;

  // C1-C6 fields added 2026-05-19 (CC_SPEC_FORGE_FOLLOWUP_C1_C6_ACTIVATION).
  // Each is optional + omitted when the collector returns null; the
  // dashboard's activation PR carries capability gates that key off
  // field presence.
  /** EDAC memory-error counters per memory controller + DIMM. */
  ecc_edac?: EdacSnapshot;
  /** DIMM population + channel balance from SMBIOS Type 17 (dmidecode).
   *  Omitted on VMs / when dmidecode is unavailable. */
  memory_topology?: MemoryTopology;
  /** PSI pressure-stall counters per resource (cpu, memory, io). */
  psi?: PsiSnapshot;
  /** /proc/vmstat swap-in/out rates. */
  vmstat?: VmstatSnapshot;
  /** pstore / kdump / wtmp signals corroborating a reboot. */
  reboot_evidence?: RebootEvidence;
  /** Hardware RAID controllers scraped via vendor CLIs. */
  hardware_raid?: HardwareRaidSnapshot;

  // C7-C10 fields added 2026-05-19 (CC_SPEC_CRUCIBLE_C7_C10_NETWORK_
  // PROCESS_COLLECTION). Each is optional; the dashboard's activation
  // PR carries capability gates that key off field presence.
  /** Per-process FD scan (top-50 consumers + RLIMIT_NOFILE). */
  process_fd?: ProcessFdSnapshot;
  /** LACP / bonding driver state from /proc/net/bonding. */
  bonding?: BondingSnapshot;
  /** TCP segment / retransmit / listen-queue counters from
   *  /proc/net/snmp + /proc/net/netstat. */
  tcp_stats?: TcpStatsSnapshot;

  // C11-C18 fields (Crucible v0.12.0+, 2026-05-19). All optional;
  // capability gates in the dashboard's activation PR key off field
  // presence.
  /** C14 LVM thin pool metadata. */
  lvm?: LvmSnapshot;
  /** C15 ethtool advertised link-mode capture. */
  ethtool?: EthtoolSnapshot;
  /** C16 /proc/net/softnet_stat per-CPU drop counters + rate. */
  softnet?: SoftnetSnapshot;
  /** C13 distro-CVE collection (Ubuntu Pro / dnf / zypper). */
  cve?: CveSnapshot;
  /** C18 dmesg structured event parser. */
  dmesg_events?: DmesgEventsSnapshot;

  /** C19 GPU collection (NVIDIA L4/A100/H100/H200/B200). Three-tier
   *  capability gated; Tier 1 = nvidia-smi, Tier 2 = DCGM, Tier 3 =
   *  Redfish OEM (stub in v0.13.0). Per CC_SPEC_CRUCIBLE_GPU_
   *  COLLECTION_2026-05-19.md. */
  gpu?: GpuSnapshot;
}

// === C19 GPU ===

export interface GpuCapabilities {
  nvidia_smi: boolean;
  nvidia_driver_version: string | null;
  dcgm: boolean;
  dcgmi_version: string | null;
  redfish_endpoint: string | null;
  redfish_oem_schema: "supermicro_hgx" | "dell_xe" | "hpe_apollo" | "nvidia_reference" | "unknown" | null;
  probe_duration_ms: number;
}

export interface NvLinkBasic {
  link_id: number;
  state: "up" | "down" | "inactive";
  speed_gbps: number;
}

export interface XidEvent {
  timestamp_iso: string;
  xid_code: number;
  pci_bdf: string;
  severity: "critical" | "warning" | "info";
  raw_message: string;
}

export interface Gpu {
  index: number;
  uuid: string;
  name: string;
  pci_bdf: string;
  vbios_version: string;
  vram_total_mib: number;
  vram_used_mib: number;
  temp_c: number;
  power_draw_w: number;
  power_limit_w: number;
  utilization_gpu_percent: number;
  utilization_mem_percent: number;
  clock_graphics_mhz: number;
  clock_sm_mhz: number;
  clock_mem_mhz: number;
  pstate: string;
  pcie_link_gen_current: number;
  pcie_link_gen_max: number;
  pcie_link_width_current: number;
  pcie_link_width_max: number;
  // Upstream PCIe port's max link width = the electrical width of the slot the
  // GPU sits in (from sysfs). Compared with pcie_link_width_current, this tells a
  // card in a physically-narrower slot (current == slot max: benign) from a link
  // trained below the slot's capability (current < slot max: real degradation).
  // null when sysfs is unavailable (non-Linux / container); the dashboard then
  // falls back to comparing against the card's own pcie_link_width_max.
  pcie_slot_max_width: number | null;
  ecc_mode_current: boolean;
  ecc_errors_corrected_volatile: number;
  ecc_errors_corrected_aggregate: number;
  ecc_errors_uncorrected_volatile: number;
  ecc_errors_uncorrected_aggregate: number;
  retired_pages_single_bit: number | null;
  retired_pages_double_bit: number | null;
  retired_pages_pending: number | null;
  thermal_slowdown_active: boolean;
  thermal_violation_total_ms: number | null;
  power_violation_total_ms: number | null;
  fan_speed_percent: number | null;
  nvlink_links: NvLinkBasic[];
  performance_state_reasons: string[];
}

export interface Tier1Snapshot {
  available: true;
  gpus: Gpu[];
  xid_events: XidEvent[];
  driver_version: string;
}

export interface Tier2Snapshot {
  available: true;
  /** "stub" in v0.13.0; lifts to "fleet-tested" post-validation. */
  parser_quality: "stub" | "fleet-tested";
  nvswitch_status: Array<{
    uuid: string;
    port_count_total: number;
    port_count_active: number;
    port_count_faulted: number;
    faulted_ports: number[];
  }>;
  nvlink_detailed: Array<NvLinkBasic & {
    remote_gpu_uuid: string | null;
    remote_nvswitch_uuid: string | null;
    replay_errors: number;
    recovery_errors: number;
    crc_errors: number;
    flit_crc_errors: number;
  }>;
  retired_pages_detail: Array<{
    gpu_uuid: string;
    address: string;
    cause: "single_bit_ecc" | "double_bit_ecc";
    retired_at_iso: string;
  }>;
  thermal_violation_time_series_ms: number;
  power_violation_time_series_ms: number;
  topology_actual: { nodes: string[]; edges: Array<{ from: string; to: string; link_count: number }> };
  topology_expected: { nodes: string[]; edges: Array<{ from: string; to: string; link_count: number }> } | null;
  /** Raw `dcgmi health` output (capped at 4KB) for v0.13.0; future
   *  releases structure this. */
  health_summary_raw: string;
}

export interface Tier3Snapshot {
  available: true;
  /** "stub" in v0.13.0 per Simon's 2026-05-19 ship-ahead decision. */
  parser_quality: "stub" | "fleet-tested";
  oem_schema: string;
  baseboard_thermal_c: number | null;
  baseboard_power_input_w: number | null;
  hgx_baseboard_status?: "ok" | "warning" | "critical" | null;
  gpu_module_status: Array<{ uuid: string; status: "ok" | "warning" | "critical" }>;
}

// Reboot-resilience of the GPU driver stack. Collected even when nvidia-smi is
// absent or broken, because the dangerous state (nouveau bound, the real nvidia
// module not loaded) is exactly when nvidia-smi fails. A host is reboot-safe
// only when the nvidia module is loaded AND nouveau is blacklisted; otherwise
// nouveau can win the boot race on the next reboot and the GPU does not come
// back, silently de-listing a marketplace (Vast) host.
export interface GpuDriverResilience {
  nvidia_pci_present: boolean;    // an NVIDIA GPU (vendor 0x10de, display/3D class) is on the PCI bus
  nvidia_module_loaded: boolean;  // the real `nvidia` kernel module is loaded
  nouveau_module_loaded: boolean; // the open-source `nouveau` module is loaded (competes for the GPU)
  nouveau_blacklisted: boolean;   // a `blacklist nouveau` directive exists in /etc/modprobe.d
}

export interface GpuSnapshot {
  available: boolean;
  reason?: string;
  capabilities: GpuCapabilities;
  driver_resilience?: GpuDriverResilience;
  tier1?: Tier1Snapshot | { available: false; reason: string };
  tier2?: Tier2Snapshot | { available: false; reason: string };
  tier3?: Tier3Snapshot | { available: false; reason: string };
}

// === C14 LVM thin ===

export interface LvmThinPool {
  lv_name: string;
  vg_name: string;
  data_percent: number;
  metadata_percent: number;
}

export interface LvmSnapshot {
  available: boolean;
  reason?: string;
  thin_pools: LvmThinPool[];
}

// === C15 ethtool ===

export interface EthtoolInterface {
  iface: string;
  advertised_auto_negotiation: boolean | null;
  advertised_link_modes: string[];
}

export interface EthtoolSnapshot {
  available: boolean;
  reason?: string;
  interfaces: EthtoolInterface[];
}

// === C16 softnet ===

export interface SoftnetSnapshot {
  available: boolean;
  reason?: string;
  total_dropped_cumulative: number;
  per_cpu_dropped: number[];
  total_dropped_rate_per_sec: number | null;
}

// === C13 CVE collection ===

export type CveSeverity = "critical" | "important" | "moderate" | "low" | "unknown";
export type CveDistro =
  | "ubuntu"
  | "rhel"
  | "fedora"
  | "rocky"
  | "alma"
  | "centos"
  | "sles"
  | "opensuse"
  | "debian"
  | "unknown";

export interface KernelCve {
  cve_id: string;
  severity: CveSeverity;
  package_name: string;
  fixed_version?: string;
}

export interface CveSnapshot {
  available: boolean;
  reason?: string;
  error?: string;
  distro: CveDistro;
  kernel_cves_pending: KernelCve[];
  total_critical_pending: number;
  total_important_pending: number;
  /** "fleet-tested" for Ubuntu Pro JSON / dnf JSON paths; "stub" for
   *  text-only fallbacks where parsing is best-effort. */
  parser_quality: "fleet-tested" | "stub";
}

// === C18 dmesg structured events ===

export type DmesgEventType =
  | "scsi_sense"
  | "nvme_reset"
  | "ext4_remount_readonly";

export interface DmesgStructuredEvent {
  /** ISO-8601 timestamp (best-effort; dmesg --time-format=iso). */
  timestamp_iso: string;
  event_type: DmesgEventType;
  severity: "critical" | "warning" | "informational";
  details: Record<string, string | number | boolean>;
  raw_line: string;
}

export interface DmesgEventsSnapshot {
  available: boolean;
  reason?: string;
  events: DmesgStructuredEvent[];
  events_by_type: Record<DmesgEventType, number>;
  /** Window of dmesg we consume per snapshot (seconds). */
  window_seconds: number;
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
  /** C9 (2026-05-19): cumulative insert_failed counter (sum across CPUs)
   *  from /proc/net/stat/nf_conntrack. Optional because pre-0.11.0
   *  agents omit it. */
  insert_failed_total?: number;
  /** C9: cumulative drop counter from /proc/net/stat/nf_conntrack. */
  drop_total?: number;
  /** Per-second insert_failed rate over the most recent snapshot
   *  interval. Null on first snapshot, on counter reset, or when the
   *  stat file is unavailable. */
  insert_failed_rate_per_sec?: number | null;
  drop_rate_per_sec?: number | null;
}

// === C7 process FD ===

export interface ProcessFdEntry {
  pid: number;
  comm: string;
  fd_count: number;
  rlimit_nofile_soft: number;
  rlimit_nofile_hard: number;
  /** fd_count / rlimit_nofile_soft * 100, rounded to one decimal. Zero
   *  when soft limit is unlimited (no useful proximity signal). */
  percent_of_soft_limit: number;
}

export interface ProcessFdSnapshot {
  available: boolean;
  reason?: string;
  /** Top 50 processes by fd_count. */
  top_consumers: ProcessFdEntry[];
  /** Number of numeric /proc/<pid> entries we considered. */
  total_processes_scanned: number;
  /** Aggregate signal: max percent_of_soft_limit across top_consumers.
   *  Null when top_consumers is empty. */
  highest_percent_of_limit: number | null;
}

// === C8 bonding / LACP ===

export interface BondSlave {
  name: string;
  mii_status: string;
  link_failure_count: number;
  permanent_hw_addr: string;
  aggregator_id: number | null;
  partner_churn_state: string | null;
  partner_lacp_port_state: number | null;
  /** Convenience flag derived from the LACP port-state bitfield's
   *  synchronization bit (bit 3, 0x08). Null when the bond is not
   *  LACP or partner state was not captured. */
  partner_lacp_synchronized: boolean | null;
}

export interface BondAggregator {
  id: number;
  number_of_ports: number;
  actor_key: number | null;
  partner_key: number | null;
  partner_mac_address: string | null;
}

export interface Bond {
  name: string;
  mode: string;
  is_lacp: boolean;
  lacp_rate: string | null;
  slaves: BondSlave[];
  /** Equal to slaves.length; surfaces the "configured" port count
   *  alongside active_aggregator.number_of_ports so the dashboard can
   *  compute a shortfall. */
  configured_port_count: number;
  active_aggregator: BondAggregator | null;
}

export interface BondingSnapshot {
  available: boolean;
  reason?: string;
  bonds: Bond[];
}

// === C10 TCP stats ===

export interface TcpStatsSnapshot {
  available: boolean;
  reason?: string;
  out_segs_total?: number;
  retrans_segs_total?: number;
  in_segs_total?: number;
  /** Retransmits divided by segments sent over the most recent
   *  interval. Range 0.0 - 1.0. Null on first snapshot or counter
   *  reset. Zero when no outbound traffic in the interval. */
  retrans_ratio?: number | null;
  retrans_rate_per_sec?: number | null;
  /** Optional listen-queue counters from /proc/net/netstat TcpExt.
   *  Absent when /proc/net/netstat is not readable. */
  listen_overflows_total?: number;
  listen_drops_total?: number;
  listen_overflows_rate_per_sec?: number | null;
  listen_drops_rate_per_sec?: number | null;
}

export interface SystemdData extends CollectorAvailability {
  failed_units: string[];
  failed_count: number | null;
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

export interface SecurityData extends CollectorAvailability {
  ssh: { permitRootLogin: string; passwordAuthentication: string; rootPasswordExposed: boolean; configApplied: boolean; configMtime?: number | null; configLoadedAt?: number | null } | null;
  firewall: { available: boolean; active: boolean | null; source: string; details: string; error?: string };
  pending_updates: { distro: string; pendingCount: number; available: boolean } | null;
  kernel_vulns: Array<{ name: string; status: string; mitigated: boolean; available?: boolean; error?: string }>;
  kernel_reboot: { running: string; installed: string; needsReboot: boolean } | null;
  auto_updates: { configured: boolean; mechanism: string; details: string };
}

// Mirrors the SupportStatus interface in collect/support-status.ts (kept in
// sync by hand, matching the SecurityData duplication convention above).
export interface SupportStatus {
  source: "ubuntu-pro" | "rhel-eus-repos";
  extended_support_active: boolean | null;
  details: string;
  attached?: boolean;
  esm_infra?: boolean;
  esm_apps?: boolean;
  eus?: boolean;
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
  /** MemFree from /proc/meminfo: truly-unused RAM (not counting reclaimable
   *  page cache). Lets the dashboard split available headroom into
   *  reclaimable cache vs genuinely free. Added Crucible 0.13.12. */
  free_mb: number;
  swap_total_mb: number;
  swap_used_mb: number;
}

/** One SMBIOS Type 17 Memory Device record (a physical DIMM slot). */
export interface MemoryDimm {
  locator: string;              // e.g. "DIMMA1"
  bank_locator: string | null;  // e.g. "P0_Node0_Channel0_Dimm0"
  socket: number | null;        // parsed from P<n> / CPU<n>; 0 for single-socket
  channel: string | null;       // normalized channel id (e.g. "0" or "A")
  slot: number | null;          // slot within the channel (DPC index)
  populated: boolean;
  size_mb: number | null;
  rank: number | null;
  type: string | null;          // DDR4 / DDR5
  speed_mts: number | null;     // rated speed
  configured_mts: number | null;// running speed (< rated => downclock)
  manufacturer: string | null;
  part_number: string | null;
}

/** DIMM population topology derived from dmidecode -t 17. These are the raw
 *  COLLECTED facts only; the controller/quadrant-balance judgment (Tier 2) is
 *  derived dashboard-side from these + the snapshot's cpu_model against a
 *  CPU-family map, so the map can be updated without an agent re-release. */
export interface MemoryTopology {
  source: "dmidecode";
  total_slots: number;
  populated_slots: number;
  available_channels: number;
  populated_channels: number;
  /** Any populated DIMM whose configured speed is below its rated speed. */
  downclocked: boolean;
  /** >1 distinct part number / size / rank among populated DIMMs. */
  mixed_parts: boolean;
  dimms: MemoryDimm[];
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
  // How the drive was reached. Omitted/"direct" for a normal /dev/sdX|nvme
  // block device; the controller family (e.g. "megaraid") for a physical
  // drive read through a hardware RAID/HBA via smartctl `-d TYPE` passthrough.
  transport?: string;
  // For a passthrough drive, the backing device path smartctl was pointed at
  // (e.g. "/dev/bus/0"); absent for direct disks.
  backing_device?: string;
  model: string;
  // Drive identity for hardware RMA / provider-ticket workflows. smartctl
  // --json exposes both at the top level for SATA and NVMe; optional because
  // the rare drive whose firmware omits them should not break the parse.
  serial?: string;
  firmware?: string;
  health: string;
  temperature_c?: number;
  percentage_used?: number;
  reallocated_sectors?: number;
  pending_sectors?: number;
  power_on_hours?: number;
  // C17 (2026-05-19) NVMe Critical Warning. Present only on NVMe
  // devices whose smartctl output included the field.
  critical_warning_raw?: number;
  critical_warning_decoded?: {
    available_spare_low: boolean;
    temperature_threshold: boolean;
    reliability_degraded: boolean;
    read_only: boolean;
    volatile_memory_backup_failed: boolean;
    persistent_memory_readonly: boolean;
  };
  nvme_available_spare?: number;
  nvme_available_spare_threshold?: number;
  // Drive-health early-warning expansion (2026-07-16). ATA raw counters,
  // absent when the drive does not report the attribute. Field names match
  // what the dashboard trend engine expects. 187/188/189 are Seagate-unpacked
  // (low 16 bits of the packed raw) so they read as true counts fleet-wide.
  reported_uncorrectable?: number; // 187
  command_timeout?: number; // 188
  high_fly_writes?: number; // 189
  spin_retries?: number; // 10
  reallocation_events?: number; // 196
  offline_uncorrectable?: number; // 198
  /** 199 UDMA CRC: interface/cabling errors, NOT media health. */
  udma_crc_errors?: number;
  // NVMe health-log error counters (growth over time is the signal).
  media_errors?: number;
  num_err_log_entries?: number;
  /**
   * Newest SMART self-test log state (ATA; smartctl --all carries the log).
   * last_failed_* is the newest FAILED entry, kept separately because a later
   * passing test would otherwise mask a read failure in the newest slot.
   * lifetime_hours wraps mod 65536 per ATA spec; consumers must recency-gate
   * a failure against power_on_hours before alerting.
   */
  self_test?: {
    last_type?: string;
    last_status: string;
    last_passed?: boolean;
    last_lifetime_hours?: number;
    last_failed_lba?: number;
    last_failed_lifetime_hours?: number;
    error_count_total?: number;
  };
}

/** A fixed disk present in /sys/block whose SMART could not be read. See the
 *  Snapshot.smart_unreadable doc comment for the blind-spot rationale. */
export interface SmartUnreadable {
  /** The /dev node, e.g. "/dev/sda". */
  device: string;
  /** Why SMART was unreadable; drives the dashboard remediation headline.
   *  - no_smartctl_output: the privileged smartctl call produced nothing
   *    (smartmontools not installed, or the invocation failed/timed out).
   *  - no_smart_data: smartctl ran but exposed no SMART surface (controller
   *    needs a `-d` type the collector does not try; unsupported HBA/enclosure).
   *  - parse_error: smartctl output was present but could not be parsed. */
  reason: "no_smartctl_output" | "no_smart_data" | "parse_error";
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
  /** Canonical severity assigned by the unified SEL classifier:
   *  "critical" | "warning" | "info". Pre-C11 only this field existed;
   *  post-C11 this is the same value but explicitly canonical. */
  severity: string;
  /** C11 (2026-05-19): vendor-aware parser quality. "fleet-tested"
   *  for Dell, HPE, Supermicro (we have validated their SEL output
   *  against real fleet hosts). "stub" for Lenovo, Cisco, OpenBMC
   *  (first real customer per vendor surfaces parser bugs). "unknown"
   *  when the BMC vendor couldn't be identified from DMI. */
  parser_quality?: "fleet-tested" | "stub" | "unknown";
}

/** Per-vendor SEL parser quality tag from C11 (2026-05-19). */
export type BmcVendor =
  | "dell"
  | "hpe"
  | "supermicro"
  | "lenovo"
  | "cisco"
  | "openbmc"
  | "unknown";

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
  | { available: false; reason: "no_ipmitool_binary" | "no_bmc_device" | "execution_failed" | "permission_denied" | "ipmitool_cve_2020_5208"; detail?: string };

export interface IpmiInfo {
  available: boolean;
  /** C11 (2026-05-19): which BMC vendor the SEL events came from.
   *  Derived from DMI vendor + ipmitool mc info; "unknown" when
   *  identification failed. Dashboard's ipmi_sel_critical TUNE keys
   *  parser_quality off this. Optional so pre-0.12.0 snapshots
   *  remain wire-compatible. */
  bmc_vendor?: BmcVendor;
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
    available?: boolean;
    error?: string;
    correctable: number | null;
    uncorrectable: number | null;
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
  /** Stable per-device identifier (the hwmon device's PCI path, or the hwmonN
   *  dir as a fallback). Distinguishes two sockets running the same driver that
   *  report an identical label (e.g. dual "k10temp Tctl"), so per-sensor alert
   *  state keys on the socket, not just the label. Omitted on older agents. */
  chip_id?: string;
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
  /**
   * Stable per-resource identifier for rules that emit one alert per disk,
   * drive, RAID array, interface, or sensor (a device path, mount point,
   * interface name, sensor label, etc.). The notify-state machine keys on
   * `type` + `instance`, so a second failing drive is tracked and notified
   * independently instead of collapsing into the first drive's `type` entry.
   * Omit for singleton (one-per-host) alerts, where `type` alone is identity.
   */
  instance?: string;
}
