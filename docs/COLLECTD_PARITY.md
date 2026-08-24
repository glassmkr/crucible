# collectd vs Crucible: parity audit matrix

Audit date: 2026-08-23. Compared: collectd 5.12.0 plugin set (official wiki Table of Plugins) vs Crucible 0.15.1 (`package.json`, source under `src/collect/`) plus the dashboard alert rules (`glassmkr/apps/dashboard/src/lib/server/alerts/rules/*.yaml`).

Updated 2026-08-24: five collection closes landed on `oss-v1-sprint` (unreleased): context-switch/fork rates + procs_running/procs_blocked (`src/collect/host-activity.ts`), hugepages (`src/collect/memory.ts`), vmstat page-fault/scan/steal rates (`src/collect/vmstat.ts`), and cpufreq (`src/collect/cpufreq.ts`). Rows and counts below reflect these; the changes are collection-only (no dashboard rules yet).

This matrix gates public comparison claims. Statuses are assigned conservatively: a row is "covered" only when the plugin's primary signal is verifiably collected in Crucible source; anything uncertain or narrower is "partial" with the missing pieces named; "gap" means Crucible collects nothing comparable.

Evidence paths: `src/...` is the crucible repo; rule names refer to YAML files in `glassmkr/apps/dashboard/src/lib/server/alerts/rules/`.

## collectd project status (facts, dated, sourced)

- Last stable release: **5.12.0, published 2020-09-03** (GitHub API, `repos/collectd/collectd/releases`; collectd.org front page still offers 5.12.0 as the stable download as of 2026-08-23).
- 6.0 series: four release candidates only; rc0 2024-01-23, rc1 2024-01-29, rc2 2024-02-07, **rc3 2024-02-21 (latest)**. No 6.0 final exists as of 2026-08-23 (GitHub releases page). The 6.0 RC series is described on the releases page as a preview with expected breaking changes, not production ready.
- Activity: sporadic maintenance; latest commits on the default branch are from May 2026, with a handful of commits across Oct 2025 to Apr 2026 (GitHub API `repos/collectd/collectd/commits`, sampled 2026-08-23). No stable release in roughly six years.

## Honesty caveats that must survive into any public claim

1. **Cadence**: Crucible collects on a ~5-minute default interval (`interval_seconds` default 300, min 60, max 3600; `src/config.ts:66`). collectd's default `Interval` is 10 seconds. Do NOT claim high-frequency parity: sub-interval transients (short CPU spikes, brief link flaps, momentary saturation) can be missed by Crucible and caught by collectd.
2. **No NVLink saturation monitoring.** Crucible reports NVLink link state (up/down/inactive) with explicit capability disambiguation only (`src/lib/types.ts`, `NvLinkBasic` + `nvlink_capability`). Saturation is not buildable at 5-minute cadence and is not offered.
3. **No failure prediction** of any kind, including GPU/NVLink failure prediction.
4. Crucible's `io_latency.*_iops` fields are per-interval operation counts, not per-second rates (`src/collect/io-latency.ts` doc comment). Do not present them as IOPS rates.
5. GPU Tier 2 (DCGM) and Tier 3 (Redfish OEM) parsers are marked `"stub"` in source (`src/lib/types.ts`, `Tier2Snapshot` / `Tier3Snapshot`). Only Tier 1 (nvidia-smi) is fleet-tested. Claims about DCGM or Redfish GPU telemetry must say "experimental/stub".

## In-scope host and hardware plugins: COVERED (19)

| collectd plugin | What it reads | Crucible status | Evidence | Notes |
|---|---|---|---|---|
| cpu | Per-CPU time in user/system/wait/idle/interrupt | covered | `src/collect/cpu.ts` (/proc/stat, per-core); rules `cpu_high`, `cpu_iowait_high` | Per-core user/system/iowait/idle/irq/softirq percentages |
| load | Load averages | covered | `src/collect/cpu.ts` (/proc/loadavg); rule `load_high` | 1m/5m/15m |
| memory | RAM usage | covered | `src/collect/memory.ts` (/proc/meminfo); rules `ram_high`, `mem_pressure_high` | Reports total/used/available/free; no separate buffers vs cached split (folded into available) |
| swap | Swap space usage and swap I/O | covered | `src/collect/memory.ts` (swap totals) + `src/collect/vmstat.ts` (pswpin/pswpout rates); rule `swap_high` | |
| df | Filesystem space usage | covered | `src/collect/disks.ts` (/proc/1/mounts + statfs, incl. inodes); rules `disk_space_high`, `inode_high`, `disk_fill_projection`, `filesystem_readonly` | Reads the HOST mount table, not the sandbox namespace |
| disk | Per-device I/O statistics (iostat-like) | covered | `DiskInfo.io_read_mb_s/io_write_mb_s/latency_p99_ms` + `src/collect/io-latency.ts` (/proc/diskstats); rules `disk_latency_high`, `io_pressure_high` | `read_iops`/`write_iops` are per-interval counts, not rates; no merged-ops or pending-ops counters |
| interface | NIC traffic, errors, drops | covered | `src/collect/network.ts` (/proc/net/dev + /sys/class/net: throughput, error subtypes incl. CRC/frame/length/carrier, drops, operstate, speed); rules `interface_errors`, `interface_saturation`, `link_speed_mismatch` | |
| thermal | ACPI thermal zone temperatures | covered | `src/collect/thermal.ts` (thermal_zone source); rule `cpu_temperature_high` | hwmon preferred, thermal_zone as fallback |
| smart | Disk S.M.A.R.T. health | covered | `src/collect/smart.ts`: health verdict, temperature, reallocated/pending sectors, attributes 187/188/189/10/196/198/199, self-test log, NVMe critical warning decode, spare, wear, media errors; `smart_unreadable` blind-spot surfacing; rules `smart_failing`, `drive_smart_unreadable`, `nvme_critical_warning`, `nvme_wear_high` | Exceeds collectd's smart plugin: hardware-RAID passthrough (`-d` types), Seagate raw unpacking, masked-self-test-failure handling |
| hddtemp | Drive temperatures | covered | `src/collect/smart.ts` (`temperature_c` per drive) | Via smartctl, not the hddtemp daemon |
| ipmi | BMC hardware sensors | covered | `src/collect/ipmi.ts`: sensors with thresholds, fans, SEL events with severity + per-vendor parser quality, ECC from named sensors and SEL, PSU redundancy; rules `ipmi_fan_failure`, `ipmi_sel_critical`, `ipmi_sel_full`, `ipmi_monitoring_unavailable`, `psu_redundancy_loss`, `ecc_errors`, `cmos_battery_low` | Exceeds collectd's ipmi plugin (sensors only): SEL, chassis facts, BMC-presence disambiguation |
| md | Linux software RAID state | covered | `src/collect/raid.ts`; rule `raid_degraded` | No resync/rebuild-progress field |
| uptime | System uptime | covered | `src/collect/system.ts` (`uptime_seconds`); feeds `unexpected_reboot` | |
| conntrack | Connection-tracking table usage | covered | `src/collect/conntrack.ts` (count/max/percent + insert_failed and drop rates); rule `conntrack_exhaustion` | |
| fhcount | File handle usage | covered | `src/collect/fd.ts`: system-wide allocated/max + per-process top-50 with RLIMIT_NOFILE proximity; rule `fd_exhaustion` | |
| gpu_nvidia | NVIDIA GPU metrics | covered | `src/collect/gpu.ts` Tier 1 (nvidia-smi): utilization, VRAM, temp, power, clocks, ECC volatile/aggregate, retired pages, throttle reasons, XID events, PCIe link gen/width, NVLink link state; rules `gpu_thermal_critical`, `gpu_uncorrected_ecc`, `gpu_corrected_ecc_storm`, `gpu_xid_critical`, `gpu_pcie_link_degraded`, `gpu_power_cap_throttling`, `nvlink_link_down`, `gpu_driver_unsafe_reboot`, `gpu_driver_or_firmware_drift` | Exceeds collectd's NVML metric set, BUT: Tier 2 DCGM and Tier 3 Redfish are stubs; no NVLink saturation; no failure prediction |
| contextswitch | Context switch rate | covered | `src/collect/host-activity.ts` (/proc/stat `ctxt`, per-second rate; collection-only, no rule) | Also emits fork rate + procs_running/procs_blocked from the same file (see processes row). Added 2026-08-24, unreleased |
| cpufreq | CPU frequency scaling | covered | `src/collect/cpufreq.ts` (sysfs `scaling_cur_freq`/`scaling_min_freq`/`scaling_max_freq`/`scaling_governor` per CPU + min/max/mean summary; collection-only, no rule) | Reads `scaling_cur_freq` (world-readable), never root-only `cpuinfo_cur_freq`; field absent on hosts without cpufreq (VMs). C-states/package power remain uncovered (turbostat row). Added 2026-08-24, unreleased |
| hugepages | Hugepage usage | covered | `src/collect/memory.ts` (`memory.hugepages`: HugePages_Total/Free/Rsvd + Hugepagesize, absolute values; collection-only, no rule) | Emitted only when HugePages_Total > 0; absent field means no pool configured. No per-NUMA-node hugepage split. Added 2026-08-24, unreleased |

## In-scope host and hardware plugins: PARTIAL (16)

| collectd plugin | What it reads | Crucible status | Evidence | What is missing |
|---|---|---|---|---|
| sensors | lm-sensors/hwmon temperatures, voltages, fan speeds | partial | `src/collect/thermal.ts` (hwmon temperatures) | hwmon voltages and fan speeds are not read (fans/voltages only via IPMI on BMC hosts); some AMD hwmon layouts undercount, so `max_cpu_celsius` can read roughly 10C low |
| ethstat | Driver-specific NIC counters via ethtool -S | partial | `src/collect/ethtool.ts` | Only advertised link modes + autoneg are read; no driver-private `ethtool -S` statistics |
| netlink | Detailed interface/qdisc statistics via netlink | partial | `src/collect/network.ts` (sysfs/proc counters) | No qdisc/class statistics; standard counters only |
| connectivity | Interface up/down (event-driven via netlink) | partial | `src/collect/network.ts` (`operstate` per snapshot), `src/collect/bonding.ts` (`link_failure_count`) | Polled, not event-driven: a flap between ~5-minute samples is missed |
| mdevents | md RAID event notifications | partial | `src/collect/raid.ts` (state polled each snapshot) | No event-driven udev/mdadm notification; no resync progress |
| processes | Process counts by state, fork rate, per-process aggregates | partial | `src/collect/os-alerts.ts` (zombie count, OOM kills), `src/collect/fd.ts` (per-process FD top-50); plus, added 2026-08-24 unreleased: `src/collect/host-activity.ts` (fork rate, procs_running, procs_blocked) | No total/sleeping/stopped state breakdown beyond running/blocked, no per-process CPU/RSS aggregates |
| irq | Interrupt counts per IRQ line | partial | `src/collect/cpu.ts` (per-core irq/softirq CPU-time percent) | No per-IRQ-line counters from /proc/interrupts |
| protocols | All /proc/net/snmp + netstat protocol counters | partial | `src/collect/tcp-stats.ts` (TCP segments, retransmits, listen overflows/drops); rules `tcp_retrans_high`, `listen_overflow`, `accept_backlog_or_syn_flood` | TCP subset only; no IP/ICMP/UDP counters |
| ipstats | IP-layer counters | partial | Same as protocols row | IP-layer counters not collected; TCP subset only |
| ntpd | NTP daemon statistics | partial | `src/collect/ntp.ts` (timedatectl/chronyc: synced, offset, source, daemon running) + `time_drift_ms` in `src/collect/os-alerts.ts`; rules `ntp_not_synced`, `clock_drift` | No per-peer offset/jitter/frequency-error detail |
| chrony | Chrony tracking statistics | partial | `src/collect/ntp.ts` (`chronyc tracking` parsed) | Sync state and offset only; no sources/peer statistics |
| vmem | Detailed /proc/vmstat (paging, faults) | partial | `src/collect/vmstat.ts` (pswpin/pswpout rates; plus, added 2026-08-24 unreleased: pgfault/pgmajfault rates and pgscan/pgsteal rates summed over the reclaim-source counters) | No pgpgin/pgpgout paging-I/O counters; no per-zone or per-source breakdown (aggregate sums only) |
| mcelog | Machine check exceptions | partial | `src/collect/edac.ts` (EDAC CE/UE incl. per-DIMM), evaluator `mce_uncorrected` keyed off EDAC (`evaluator.ts` "23.3 mce_uncorrected (EDAC)"); IPMI SEL machine-check events classified critical (`src/collect/ipmi.ts:362`) | No /dev/mcelog or mcelog-daemon decode of CPU cache/bus/TLB machine checks |
| lvm | LVM volume group / logical volume usage | partial | `src/collect/lvm.ts` (thin-pool data + metadata percent); rule `lvm_thinpool_metadata_high` | No VG/LV size and usage statistics outside thin pools |
| pcie_errors | PCIe error/event counters | partial | `src/collect/gpu.ts` (GPU PCIe link gen/width degradation incl. slot-width comparison); rule `gpu_pcie_link_degraded` | GPU links only; no host-wide PCIe AER error counters |
| redfish | Hardware telemetry via Redfish API | partial | `src/lib/types.ts` `Tier3Snapshot` (GPU OEM Redfish) | Stub parser only (`parser_quality: "stub"`); no general Redfish hardware polling |

## In-scope host and hardware plugins: GAP (28)

| collectd plugin | What it reads | Crucible status | Notes |
|---|---|---|---|
| battery | Laptop battery charge/state | gap | Server fleet target; CMOS battery low IS detected, but via IPMI sensor (rule `cmos_battery_low`), not this plugin's scope |
| buddyinfo | Memory fragmentation (buddy allocator) | gap | |
| capabilities | Per-process Linux capabilities | gap | Crucible security checks (`src/collect/security.ts`) cover other posture items, not process capabilities |
| cgroups | Per-cgroup resource accounting | gap | No container/cgroup metrics |
| cpusleep | CPU sleep/idle time | gap | Mobile-focused plugin |
| dcpmm | Intel Optane persistent memory | gap | |
| drbd | DRBD replication state | gap | |
| entropy | Kernel entropy pool | gap | |
| filecount | File count/size in directories | gap | |
| fscache | FS-Cache statistics | gap | |
| infiniband | InfiniBand port counters | gap | Relevant to GPU fleets; nothing comparable collected |
| intel_pmu | CPU performance counters | gap | |
| intel_rdt | Intel RDT cache/bandwidth monitoring | gap | |
| ipc | SysV IPC statistics | gap | |
| iptables | Firewall rule match counters | gap | Crucible checks only whether a firewall is active (`src/collect/security.ts`; rule `no_firewall`), no per-rule counters |
| nfs | NFS client/server operation stats | gap | |
| numa | Per-NUMA-node memory stats | gap | `memory_topology` (dmidecode) covers DIMM population, not runtime NUMA allocation |
| ping | Active ICMP latency probing | gap | Dashboard `server_unreachable` detects missed agent check-ins (evaluator.ts); that is liveness, not ICMP latency measurement |
| procevent | Process lifecycle events (netlink) | gap | |
| sysevent | Kernel/rsyslog event stream | gap | `src/collect/dmesg-events.ts` parses a narrow fixed set (scsi_sense, nvme_reset, ext4 remount-ro), not a general event stream |
| synproxy | SYNPROXY mitigation counters | gap | SYN-flood symptom partially visible via listen-queue stats (rule `accept_backlog_or_syn_flood`), but no synproxy counters |
| tape | Tape drive I/O | gap | |
| tcpconns | TCP connection counts by state/port | gap | `tcp_stats` is aggregate segment counters, a different signal |
| turbostat | CPU frequency, C-states, package power | gap | No CPU power/turbo/C-state residency collection |
| ubi | UBI flash filesystem | gap | |
| users | Logged-in user count | gap | |
| wireless | Wireless interface quality | gap | Server fleet target; WiFi not collected |
| zfs_arc | ZFS ARC cache performance | gap | ARC stats not read; ZFS pool/vdev/scrub HEALTH is covered and richer than collectd (see Crucible-only section) |

## Out-of-scope collectd plugins (108)

Listed for completeness; excluded from parity scoring with the reason given.

| Group | Plugins | Reason out of scope |
|---|---|---|
| Application/service readers (36) | apache, ascent, bind, ceph, cvmfs, dbi, dns, email, genericjmx, gmond, memcachec, memcached, modbus, monitorus, mysql, netapp, nginx, olsrd, openldap, openvpn, oracle, ovs_events, ovs_stats, pinba, postgresql, powerdns, puppet_reports, redis, routeros, slurm, statsd, teamspeak2, tokyotyrant, varnish, xmms, zookeeper | Application/service metrics, not host hardware/OS telemetry |
| Write/output plugins (20) | amqp1, carbon, csv, opentsdb, rrdcached, rrdtool, snmp_agent, write_graphite, write_http, write_influxdb_udp, write_kafka, write_log, write_mongodb, write_prometheus, write_redis, write_riemann, write_sensu, write_stackdriver, write_syslog, write_tsdb | Metric output/storage; Crucible pushes snapshots to its own dashboard |
| Metric transport (5) | amqp, grpc, mqtt, network, unixsock | Metric transport protocols, not collection |
| Logging/notification/metadata (8) | logfile, log_logstash, syslog, notify_desktop, notify_email, notify_nagios, threshold, uuid | Log/alert delivery and metadata; Crucible's dashboard rule engine plus notification channels replace `threshold` + `notify_*` |
| Generic scraping/extension (13) | aggregation, curl, curl_json, curl_xml, exec, java, lua, perl, python, table, tail, tail_csv, logparser | Generic ETL and plugin-extension mechanisms; NOTE the honest flip side: Crucible has no user-defined custom-metric mechanism at all |
| Virtualization/partitioning (6) | virt, openvz, vserver, zone, lpar, xencpu | Guests-of-host and non-Linux partitioning telemetry |
| Non-target platforms / external sensor hardware (15) | apple_sensors, pf, madwifi, mbmon, onewire, aquaero, barometer, multimeter, serial, sigrok, ted, gps, mic, apcups, nut | External devices (UPS, lab instruments, 1-Wire) or non-Linux platforms; Crucible targets Linux servers |
| External device polling (1) | snmp | Polls other network devices; Crucible is a host agent |
| Kernel service stats (1) | ipvs | Load-balancer service metrics, not host hardware/health |
| DPDK telemetry (3) | dpdkevents, dpdkstat, dpdk_telemetry | DPDK application telemetry |

## Crucible-only capabilities (verified in source; collectd has no equivalent plugin)

- **Alert rules with remediation**: a YAML rule catalog with per-rule fix workflows evaluated dashboard-side (`glassmkr/apps/dashboard/src/lib/server/alerts/rules/*.yaml` + `evaluator.ts`); collectd's `threshold` plugin does static limits with no remediation content. (Do not quote a pinned rule count; read the coverage test.)
- **SMART verdict logic and blind-spot surfacing**: deterministic health verdicts, `smart_unreadable` reporting so unreadable drives are distinguishable from a diskless host, self-test-log masking handling, hardware-RAID `-d` passthrough (`src/collect/smart.ts`, `src/lib/types.ts`).
- **Hardware RAID controllers** via vendor CLIs: Dell/HPE/LSI/Adaptec state + degraded-disk counts (`src/collect/hardware-raid.ts`).
- **PSI pressure-stall** metrics for cpu/memory/io (`src/collect/psi.ts`; rules `cpu_pressure_high`, `mem_pressure_high`, `io_pressure_high`); collectd has no PSI plugin.
- **EDAC per-DIMM ECC counters** (`src/collect/edac.ts`; rules `ecc_errors`, `mce_uncorrected`) and **memory topology**: DIMM population, channel balance, downclock and mixed-parts detection from SMBIOS Type 17 (`src/collect/memory-topology.ts`; rule `memory_channels_underpopulated`).
- **GPU inventory and driver resilience**: XID event capture, throttle reasons, retired pages, plus nouveau-vs-nvidia boot-race safety check (`src/collect/gpu.ts`, `GpuDriverResilience` in `src/lib/types.ts`; rules `gpu_driver_unsafe_reboot`, `gpu_driver_or_firmware_drift`).
- **Reboot evidence facts**: pstore records, kdump vmcore, wtmp records, clean-shutdown heuristic (`src/collect/reboot-evidence.ts`), IPMI chassis power provenance (`src/collect/chassis.ts`), planned-reboot marker; rule `unexpected_reboot`. Facts only: attribution is layered and the honest common answer is "unknown"; never claim reboot-cause certainty.
- **Security posture**: SSH config exposure, firewall active state, pending security updates, kernel vulnerability mitigations, needs-reboot, auto-update config (`src/collect/security.ts`; rules `ssh_root_password`, `no_firewall`, `pending_security_updates`, `kernel_needs_reboot`, `unattended_upgrades_disabled`, `ssh_config_unapplied`).
- **Distro CVE collection** for pending kernel CVEs (`src/collect/cve.ts`; rule `kernel_vulnerabilities`) and **OS end-of-life / extended-support detection** (`src/collect/support-status.ts`; rule `os_end_of_life`).
- **systemd failed units with bounded, redacted journal excerpts** (`src/collect/systemd.ts`; rules `systemd_service_failed`, `systemd_service_oom_killed`, `service_flapping`).
- **ZFS pool health**: pool/vdev/SLOG/L2ARC states with redundancy-class-aware severity, scrub errors and staleness (`src/collect/zfs.ts`; rules `zfs_pool_unhealthy`, `zfs_scrub_errors`, `zfs_slog_faulted`).
- **Bonding/LACP detail**: per-slave MII state, partner sync bit, aggregator port shortfall (`src/collect/bonding.ts`; rules `bond_slave_down`, `lacp_partner_lost`).
- **softnet drop counters** per CPU (`src/collect/softnet.ts`; rule `softnet_drops`).
- **Structured dmesg events**: scsi_sense, nvme_reset, ext4 remount-readonly (`src/collect/dmesg-events.ts`; rules `disk_io_errors`, `filesystem_readonly`).
- **OOM kill detection** (`src/collect/os-alerts.ts`; rule `oom_kills`).
- **DMI/BIOS inventory** with vendor identification and BIOS age (`src/collect/dmi.ts`; rule `bios_firmware_age`).
- **Per-collector availability metadata** (`collection_status` in `src/lib/types.ts`): distinguishes "answered no" from "could not ask" per collector.

## Counts

In-scope collectd host/hardware read plugins assessed: 63.

- Covered: 19
- Partial: 16
- Gap: 28
- Out-of-scope: 108

(2026-08-24 update: contextswitch, cpufreq, and hugepages moved gap to covered; the vmem and processes partial rows improved. Previous counts: covered 16, gap 31.)

## Gaps for prioritisation

1. **CPU power and C-state visibility (turbostat)**: cpufreq scaling frequencies are now collected (2026-08-24), but C-state residency and package power remain invisible, so sustained frequency capping is visible while its thermal/power cause is not.
2. **Process-level aggregates (processes)**: fork rate and running/blocked counts are now collected (2026-08-24), but there is still no full state breakdown (sleeping/stopped/total) and no per-process CPU/RSS aggregates.
3. **Active connectivity probing and sub-interval link events (ping + connectivity)**: no ICMP latency measurement; link flaps shorter than the ~5-minute interval are missed because operstate is polled, not event-driven.
4. **Host-wide PCIe AER counters (pcie_errors)**: only GPU PCIe link degradation is watched; NIC/HBA/NVMe PCIe errors are invisible.
5. **InfiniBand port counters (infiniband)**: relevant to GPU fleets; nothing comparable collected.
6. Runners-up: ZFS ARC statistics (pool health covered, cache performance not); NUMA runtime memory detail; TCP connections by state/port (tcpconns); driver-private NIC counters (`ethtool -S`); user-defined custom metrics (collectd exec/tail/table have no Crucible equivalent).
