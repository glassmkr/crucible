# Changelog

All notable changes to `@glassmkr/crucible` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 convention: minor bumps may include breaking changes; we call them
out under `### Breaking` so downstream consumers can audit.

## [0.13.20] - 2026-07-05

### Fixed

- **Per-process FD scan now sees root-owned processes.** When Crucible runs as
  the unprivileged `glassmkr` service user, the per-process file-descriptor
  scan read `/proc/<pid>/fd` directly and got permission-denied on root-owned
  processes, silently skipping them: a root daemon leaking descriptors was
  invisible to the per-process `fd_exhaustion` signal (the host-wide
  `/proc/sys/fs/file-nr` path was unaffected). The scan now runs through the
  privileged facade (new `proc-fd` action) so it sees every process, and falls
  back to the in-process scan when the wrapper is absent, so it only ever gains
  visibility. Existing unprivileged-user hosts need a one-time wrapper refresh
  to gain the new action (rerunning `glassmkr-crucible init` does it); root
  hosts pick it up automatically.
- **Fan false positive on discrete PSU sensors (agent-side rule).** The
  agent's local `ipmi_fan_failure` rule counted a zero-RPM fan as failed even
  when its BMC state was `ok` (discrete PSU fan sensors report a state string,
  not an RPM). The BMC's own ok verdict now wins, mirroring the dashboard fix.

## [0.13.19] - 2026-07-05

### Added

- **DIMM population topology (SMBIOS Type 17).** The agent now reports each
  memory slot (populated or empty), its channel, socket, size, rank, rated
  and configured speed via a new `memory_topology` snapshot block, collected
  with `dmidecode -t 17` through the privileged facade (new `dmidecode-memory`
  action). The dashboard uses it to flag under-populated memory channels and
  DIMMs running below rated speed, the silent bandwidth killers on
  multi-channel CPUs (an 8-channel EPYC with 4 DIMMs runs at roughly half its
  peak). Locator parsing validated on real Supermicro, ASRock, Gigabyte, and
  ASUS boards, including dual-socket EPYC. Hosts without dmidecode, and VMs,
  simply omit the block. Existing hosts running the unprivileged service user
  need a one-time wrapper refresh to gain the new action (rerunning
  `glassmkr-crucible init` does it); root hosts pick it up automatically.

### Fixed

- **No more phantom SMART failure on virtual/unreadable devices.** A device
  smartctl could not interrogate (BMC virtual media such as "AMI Virtual
  HDisk0", USB bridges without a device type) was reported as
  `health: FAILED` with model "unknown", firing a critical `smart_failing`
  on a fake disk. The collector now skips 0-byte virtual block devices and
  treats "no SMART data" as exactly that, never as a failure.

## [0.13.18] - 2026-07-04

### Fixed

- **`kernel_needs_reboot` false positive on RHEL 8/9/10.** Kernel-reboot
  detection queried `rpm -q kernel`, but modern RHEL ships the kernel as
  `kernel-core`, so rpm returned the literal "package kernel is not installed".
  That string is non-empty and never equals the running kernel, so the alert
  fired on healthy hosts and showed "Installed kernel: package kernel is not
  installed". Detection now queries `kernel-core` (plus `kernel` and
  `kernel-default` for older RHEL / SUSE) and keeps only real version lines, so
  the running-vs-installed comparison is correct on the RHEL family. Confirmed
  on Rocky Linux 10.2; Debian/Ubuntu detection is unchanged.

## [0.13.17] - 2026-07-03

### Fixed

- **Privileged collection no longer stops on root hosts without the sudo
  wrapper.** 0.13.16 (via the audit §2.1 sudo-wrapper facade) routed all
  privileged collection through `sudo /usr/local/sbin/crucible-collect`, but
  that wrapper is installed only by `crucible init`. A host running the agent
  as root that never ran init (or was upgraded via `npm i -g` without it) had
  no wrapper, so IPMI, SMART, RAID, firewall, and dmesg collection silently
  returned nothing. `runPrivileged` now falls back to running the underlying
  command directly when it is root and the wrapper is absent (as root, exactly
  what the wrapper would exec); a non-root agent without the wrapper still
  collects nothing (it cannot and must not escalate). Restores the documented
  "User=root never loses collection" behavior.

## [0.13.16] - 2026-07-03

### Added

- **SSH config-vs-runtime detection.** The SSH security check reads `sshd -T`,
  which reflects the on-disk config, not the running daemon. So an operator who
  edits `sshd_config` to disable root-password login but forgets to reload or
  restart `sshd` would clear the `ssh_root_password` alert while the box stays
  exposed until the daemon reloads: the monitor reporting "safe" on a
  still-exploitable host. The SSH snapshot now carries `configApplied`, computed
  by comparing the newest `sshd_config*` mtime against the sshd unit's
  `StateChangeTimestampMonotonic` (which advances on a `reload` as well as a
  restart, so the recommended `systemctl reload` path is correctly seen as
  applied). A new `ssh_config_unapplied` alert fires while a config change is
  staged but not live, so a host is never reported all-clear on an unapplied SSH
  change. Defaults to "applied" when the signal is undeterminable (no systemd),
  so it never false-fires. Surfaced by the live blind-remediation campaign.

## [0.13.15] - 2026-07-01

### Added

- **SATA SSD endurance/wear is now collected.** Previously `percentage_used` was
  populated only from the NVMe health log, so a worn SATA SSD (for example a
  Crucial MX500 at 25% life remaining) reported no wear at all and the dashboard
  drive-wear rule could not see it. The SMART collector now reads a SATA SSD's
  vendor-specific wear attribute (Micron/Crucial 202, Intel 233, Samsung 177,
  others 173/231; normalized value = percent life remaining) and exposes it as
  `percentage_used = 100 - normalized_value`, matched by attribute name with a
  known-ID fallback and a temperature-attribute guard (ID 231 is wear on some
  drives, temperature on others). NVMe wear reporting is unchanged. Pairs with
  the dashboard drive-wear rule, which now covers SATA SSDs and adds a lower
  "plan replacement" watch tier.

## [0.13.14] - 2026-06-27

### Fixed

- **Clean reboots are no longer misreported as unclean shutdowns.** The
  reboot-evidence collector detected a clean shutdown by running
  `last shutdown -F`, which returns nothing on modern systemd + util-linux
  (verified on Ubuntu 6.17 kernels) even after a clean `sudo reboot`. So
  `prior_shutdown_clean` was false on every clean reboot, and the dashboard's
  `unexpected_reboot` rule escalated deliberate, planned reboots to a critical
  "unclean shutdown" alert. The collector now reads `last -x -F` (the `-x` flag
  surfaces the `shutdown` and `runlevel` system records) and treats a boot as
  clean when a shutdown record sits immediately before it. Additive; no config
  change.

## [0.13.13] - 2026-06-27

### Added

- **GPU driver-resilience facts** (`gpu.driver_resilience`): on a host with an
  NVIDIA GPU, the agent now reports whether the `nvidia` kernel module is
  loaded, whether `nouveau` is loaded, and whether `nouveau` is blacklisted.
  These are collected from sysfs and `/proc/modules` even when `nvidia-smi` is
  dead, which is exactly the dangerous case: if `nouveau` is not blacklisted it
  binds the GPU first on the next reboot, the NVIDIA driver cannot load,
  `nvidia-smi` fails, and a marketplace host silently de-lists itself. The
  dashboard's new `gpu_driver_unsafe_reboot` rule consumes these facts to warn
  before the reboot happens. Additive and backward compatible.

### Fixed

- **`kernel_needs_reboot` false positive on a non-kernel reboot flag**: the
  Debian/Ubuntu reboot check trusted `/var/run/reboot-required` unconditionally,
  but that flag is set by ANY package that wants a reboot (libc, systemd, dbus),
  not just the kernel. A host whose running kernel was already the newest
  installed could fire a spurious `kernel_needs_reboot`. The check now compares
  the running kernel to the newest installed kernel (matching the other
  detection methods) and only falls back to the flag when the installed kernel
  cannot be determined.

## [0.13.12] - 2026-06-26

### Added

- **`memory.free_mb`** (MemFree from `/proc/meminfo`): the genuinely-unused
  RAM, distinct from MemAvailable (which counts reclaimable page cache). Lets
  the dashboard split a host's headroom into reclaimable cache vs truly free
  in the memory breakdown. Additive and backward compatible; the existing
  `used_mb` / `available_mb` semantics are unchanged.

## [0.13.11] - 2026-06-16

### Added

- **Drive serial number and firmware** are now collected per disk, parsed from
  the smartctl JSON the agent already reads (SATA and NVMe). They appear in the
  snapshot's SMART data so the dashboard can include them in hardware alerts and
  provider / RMA workflows. Optional: the rare drive whose firmware omits them
  is parsed as before. No new external calls.

## [0.13.10] - 2026-06-11

### Added

- **PSI availability notice at startup.** When `/proc/pressure` is missing the
  agent now logs that cpu/memory/io pressure alerts cannot fire and how to
  enable PSI (`psi=1` boot parameter). Stock RHEL-family kernels (CentOS,
  Alma, Rocky, RHEL) ship PSI compiled in but disabled by default; previously
  the agent just omitted the data silently, so the gap was invisible.

### Fixed

- **Server IP no longer shows the BMC's USB NIC.** The primary IP was the
  first `hostname -I` token; on Supermicro boards the BMC's virtual USB
  interface (usb0, APIPA 169.254.x) often enumerates first, so the
  dashboard and every notification showed 169.254.x as the server's
  address. The agent now prefers the first global-scope address and only
  falls back to link-local/loopback when nothing else exists.
- **Removed a dead 5-minute SEL filter stub.** `collectSelEvents` declared
  (but never applied) a five-minute recency cutoff; the real contract is
  "last 20 SEL events regardless of age, dashboard applies the window."
  No behavior change; the misleading comment is gone.
- **Docker quickstart pulls from Docker Hub.** `docker-compose.yml` now
  references `docker.io/glassmkr/crucible:latest`. The previous default,
  `ghcr.io/glassmkr/crucible`, requires authentication to pull, so the
  documented anonymous `docker compose up` failed with `denied`.
- **Removed dead `HOST_PROC` / `HOST_SYS` plumbing from the compose file.**
  The agent never read those variables or the `/host/proc`, `/host/sys`
  mounts; it reads `/proc` and `/sys` at their normal paths, which already
  expose the host kernel's state in a privileged host-network container.

## [0.13.9] - 2026-06-07

### Fixed

- **dnf-automatic `apply_updates` detection** now matches the full Python
  configparser affirmative set (`yes` / `true` / `on` / `1`, case-insensitive)
  and anchors the value. A host configured with e.g. `apply_updates = True` is
  now correctly read as "applies updates", and `apply_updates = yessir` no
  longer matches. Previously only a case-sensitive, unanchored `yes` matched.
  RHEL / Fedora family only; no effect on Debian / Ubuntu hosts.
- **`/etc/os-release` parsing** tolerates non-spec lines (trailing whitespace,
  a space after the closing quote, CRLF endings): the distro id is trimmed and
  unquoted so it resolves to the right family instead of falling through to
  "unknown". Well-formed os-release files are unaffected.

## [0.13.8] - 2026-06-03

### Changed

- **Internal collector refactor (no behavior change).** Extracted two
  more shared helpers from per-collector boilerplate. A `RateTracker`
  (the cumulative-counter to per-second-rate state machine, including
  first-snapshot and counter-reset handling) now backs the conntrack and
  softnet collectors; `parseEqualsKeyValue` and `parseColumnarStat` now
  back the systemd-unit and TCP-stats parsers. The rate and parse logic
  is unchanged: the extractions preserve the prior per-counter semantics
  exactly, and collectors with materially different shapes (vmstat,
  io-latency, PSI, base-16 and headerless network counters) were
  deliberately left on their own logic. No change to the data collected,
  the CLI, the config schema, or the snapshot payload sent to the
  dashboard; a maintainability pass verified by the full test suite
  (401 tests).

## [0.13.7] - 2026-06-03

### Changed

- **Internal collector refactor (no behavior change).** Deduplicated
  repeated collector boilerplate into shared helpers: file reads
  (`readFileTrim` / `readFileInt` / `readDirSafe`), CLI and systemd-unit
  presence checks (`which` / `isUnitActive`), kernel-log reading plus
  ISO/ctime timestamp parsing (`lib/dmesg`, now shared by the GPU XID
  and dmesg-events collectors), and `/etc/os-release` ID parsing (the
  CVE collector now uses the same canonical reader as the system
  collector). Removed dead/unused exports. No change to the data
  collected, the CLI, the config schema, or the snapshot payload sent to
  the dashboard; this is a maintainability and footprint pass, verified
  by the full test suite (379 tests).

## [0.13.6] - 2026-05-29

### Fixed

- **dnf-automatic download-only timer no longer reported as
  configured.** The RHEL/Rocky/Alma auto-update check treated any
  enabled dnf-automatic timer as "configured", including the
  download-only timers (`dnf-automatic.timer` /
  `dnf-automatic-download.timer` with `apply_updates != yes`). A
  download-only host then suppressed the dashboard's
  `pending_security_updates` rule while patches were downloaded but
  never applied; the host appeared patched while it was not (observed
  on a validation host with 26 pending updates, some Critical). The
  check now requires either `dnf-automatic-install.timer` (applies
  unconditionally) or a legacy/download timer **with**
  `apply_updates = yes` in `/etc/dnf/automatic.conf`; otherwise it
  reports `configured: false` with a `details` string naming the
  cause. Mirrors the config-aware rigor the Debian/unattended-upgrades
  path already had.

## [0.13.5] - 2026-05-22

### Changed

- **Config file renamed from `/etc/glassmkr/collector.yaml` to
  `/etc/glassmkr/crucible.yaml`.** The agent has been named "Crucible"
  since v0.10; the config-file rename was the last piece of the
  half-finished rename. The on-disk YAML format is unchanged; only
  the file name and the default-path constant move.

### Added

- **Backwards-compat read-path fallback.** When the agent starts
  without an explicit `--config` flag and the new
  `/etc/glassmkr/crucible.yaml` does not exist but the legacy
  `/etc/glassmkr/collector.yaml` does, the agent transparently uses
  the legacy file and emits a one-line warn to stderr:
  `"[crucible] Using legacy config path /etc/glassmkr/collector.yaml; run 'glassmkr-crucible init' to migrate to /etc/glassmkr/crucible.yaml"`.
  Existing installs continue to work unmodified.

- **Lossless migration in `init`.** When `glassmkr-crucible init`
  runs into the canonical path and a legacy
  `/etc/glassmkr/collector.yaml` exists, the file is renamed (atomic
  on the same filesystem; `/etc` is always one mount) before any
  write. Operator-edited content (telegram tokens, custom thresholds,
  tls_pin) is preserved verbatim — the file is not re-generated.
  The systemd unit is regenerated to point at the new path and
  daemon-reload picks up the change. If both files happen to exist,
  init warns and leaves the legacy file alone; pass `--force` to
  regenerate the canonical file from scratch.

### Notes

- Customers running v0.13.4 or earlier do not need to do anything.
  The legacy file path is the read-path default if the new file is
  absent. Run `sudo glassmkr-crucible init --api-key <K>` on next
  upgrade to migrate (the agent preserves all edits).
- Explicit `--config /some/path.yaml` continues to honour the
  caller-supplied path with no fallback or migration; only the
  default-path bare-invocation gets the new behaviour.

## [0.13.4] - 2026-05-22

### Changed

- **README sweep for the Bench retirement.** Removed the
  "See also the Bench MCP packages (`@glassmkr/bench-*` on npm)
  for AI-tool access to your Glassmkr fleet" line at the top of
  the README. The `@glassmkr/bench-*` packages were deprecated on
  npm and the bench.glassmkr.com surface was retired
  (2026-05-22). Crucible is now the single open-source product;
  the optional Dashboard SaaS sits next to it. No code changes
  in this release. Required because the npm-published README is
  frozen at publish time; a patch bump is the cheapest way to
  refresh the package page + the Docker Hub Overview.

## [0.13.3] - 2026-05-21

### Fixed

- **ZFS parser missed SLOG vdevs on ZFS 2.2+ output.** `parseZpoolStatus()`
  matched section headers via `/^logs\s*$/` which expected `logs` at the
  start of a line. ZFS 2.2 emits the section header tab-prefixed with a
  trailing tab (`"\tlogs\t\n"`). The mismatch routed every SLOG vdev
  into `pool.vdevs[]` with class `stripe` instead of `pool.slog_vdevs[]`.
  Dashboard rule `zfs_slog_faulted` could therefore never fire on
  modern hosts. Matcher now accepts either form; same fix applied to
  `cache` and `spares` section headers. Verified on val-mz62hd
  (AlmaLinux 9.6, ZFS 2.2.9).

- **ZFS parser missed never-scrubbed state on fresh pools.** ZFS 2.2+
  omits the `scan:` line entirely on a freshly-created pool that has
  never been scrubbed (older versions emitted `scan: none requested`).
  The old parser only matched the explicit phrase and left
  `scrub_never_run` unset, so the dashboard's `zfs_scrub_errors` rule
  could never fire the "you should schedule a scrub" branch on fresh
  pools. The parser now also flags `scrub_never_run` when it reaches
  the `errors:` end-of-pool marker without having seen any `scan:`
  line.

- Both issues filed in `CC_OPERATIONAL_BACKLOG_2026-05-21.md` and
  surfaced during the chapter closure plan's Session A.1.

## [0.13.2] - 2026-05-21

### Fixed

- **GPU throttle-reasons collector silently no-ops on driver 550+.**
  `enrichThrottleReasons()` matched the old `<clocks_throttle_reasons>`
  XML block emitted by driver 535 and earlier. Driver 550 renamed the
  block to `<clocks_event_reasons>` and the per-element tags from
  `clocks_throttle_reason_*` to `clocks_event_reason_*`. On driver
  550-equipped hosts, Crucible's `performance_state_reasons` array
  stayed empty even with sw_power_cap active, which meant the
  dashboard's `gpu_power_cap_throttling` and `gpu_thermal_critical`
  rules could never fire. The matcher now accepts either prefix and
  also handles the driver-550 plural `display_clocks_setting` tag.
  Discovered 2026-05-20 on glassmkr-gpu-1 (NVIDIA L4, driver 550.163.01)
  when a power-cap test failed to surface the alert.

## [0.13.1] - 2026-05-20

### Fixed

- **GPU Tier 1 collector field-name typo.** v0.13.0 queried nvidia-smi
  with `--query-gpu=...,retired_pages.double_bit_ecc.count,...`; the
  correct field name is `retired_pages.double_bit.count` (no `_ecc`
  suffix). NVIDIA's naming is asymmetric: single-bit is
  `single_bit_ecc.count`, double-bit drops the `_ecc`. On driver 550+,
  nvidia-smi prints the error to stderr and exits 0 with empty stdout;
  Crucible then reported `tier1.available=false, reason="nvidia-smi
  returned no GPU rows"` even on hosts with working drivers. Confirmed
  on the val-L4 / val-RTXA4000 / val-A16 validation hosts; live patch
  was applied via sed in-place, this release replaces the patch with
  the proper fix in source.

## [0.13.0] - 2026-05-20

GPU/fabric telemetry collection ships as a new category. Three-tier
capability-gated: nvidia-smi (Tier 1, full) + DCGM (Tier 2, basic) +
Redfish OEM (Tier 3, stub). Per Simon's 2026-05-19 ship-ahead-of-
fleet-validation decision, all three tiers ship with explicit
provenance markers so the dashboard's GPU rules can surface honesty
in evidence:

  - Tier 1: validation-pending (lifts to fleet-tested in the follow-
    up PR after Simon's 2-3 GPU hosts have run v0.13.0 for 3-5 days)
  - Tier 2: desk-research-only (lifts to fleet-tested if a validation
    host runs nv-hostengine)
  - Tier 3: stub (Supermicro HGX + NVIDIA reference schemas pending
    fleet validation; the detection probe + collector framework are
    in place, the schema-specific queries are not)

### Added

- **GPU collection (C19).** New `snap.gpu` field. Detects NVIDIA
  data-center GPUs (L4 / A100 / H100 / H200 / B200) via the
  nvidia-smi binary; <10ms short-circuit on non-NVIDIA hosts so
  existing customers see zero performance impact.

  **Tier 1 (nvidia-smi):** GPU presence, model, UUID, driver version,
  vbios, VRAM total/used, temperature, power draw/limit, utilisation,
  clocks, pstate, PCIe link gen/width (current + max), ECC mode +
  counters (corrected/uncorrected, volatile/aggregate), retired pages
  (single-bit/double-bit/pending), fan speed, NVLink basic state +
  per-link bandwidth, performance_state_reasons (throttle flags from
  the XML output including hw_slowdown / hw_thermal_slowdown /
  sw_power_cap), and parsed XID events from dmesg with severity per
  NVIDIA's published XID table.

  **Tier 2 (DCGM):** when `nv-hostengine` is running and `dcgmi` is
  installed, runs `dcgmi health -g 0 -c` and surfaces the raw output
  alongside reserved fields for future structured parsing
  (nvswitch_status, nvlink_detailed, retired_pages_detail,
  thermal/power violation time-series, topology_actual). Tagged
  `parser_quality: "stub"`. Lifts to "fleet-tested" in a follow-up
  release once Simon's validation hosts surface DCGM output.

  **Tier 3 (Redfish OEM):** detection probe returns null endpoint /
  null schema; collector returns `available: false` with reason
  citing "stub in v0.13.0; Supermicro HGX + NVIDIA reference schemas
  pending fleet validation". The framework is in place; the schema-
  specific Redfish queries are not. Dashboard rules consuming Tier 3
  fields (none in the first GPU rule release) capability-gate cleanly.

### Capability gating

Zero performance and zero error overhead on hosts without NVIDIA
GPUs. The `which nvidia-smi` probe is the gate; if absent, all three
tiers short-circuit immediately and `snap.gpu.available = false`. On
NVIDIA hosts with broken driver state (nvidia-smi present but query
times out), the probe returns nvidia_smi=false rather than treating
the broken state as an alertable signal — that's `gpu_xid_critical`
territory (XID 79 surfaces "GPU has fallen off the bus" via the
dmesg path independently).

### Unblocks

Glassmkr Dashboard's first GPU rule release per `CC_SPEC_GPU_RULES_
2026-05-19.md`: 8 rules consuming `snap.gpu.tier1.*` primarily;
`nvlink_link_down` + `gpu_corrected_ecc_storm` consume Tier 2 when
available; future tier-3-primary rules wait for fleet validation.

### Scope deferred to follow-up releases

- AMD Instinct / Intel Gaudi GPU collection.
- MIG (Multi-Instance GPU) partition awareness.
- vGPU virtualisation signals.
- DCGM diagnostic invocation (operator-initiated; never run from
  always-on agent telemetry).
- NCCL collective failure detection (application-cooperative).
- Tier 3 Supermicro HGX + NVIDIA reference Redfish schema queries
  (waits for fleet validation; the framework ships in this release).
- GPU topology drift detection (needs a baseline mechanism).

### Validation status

Simon brings 2-3 GPU servers into the validation fleet
post-release. Provenance markers will be tightened from
"validation-pending" to "fleet-tested" in a Dashboard follow-up PR
after 3-5 days of clean fleet data.

## [0.12.0] - 2026-05-19

Eight collectors land together. All shipped; none deferred from the
Phase 0 escape valve (complexity assessments held).

### Added

- **C12 systemd Result field.** `snap.systemd.failed_unit_details[unit]`
  exposes `Result` (systemd's failure classifier: oom-kill / watchdog /
  exit-code / timeout / start-limit-hit / ...) plus `ActiveState`,
  `SubState`, `NRestarts`. Unblocks Dashboard's
  `systemd_service_failed` TUNE + `service_flapping` +
  `systemd_service_oom_killed` rules.

- **C14 LVM thin pool metadata.** New `snap.lvm.thin_pools[]` with
  per-pool `metadata_percent` and `data_percent`. Metadata exhaustion
  is silent and catastrophic; Dashboard's `lvm_thinpool_metadata_high`
  rule pages on >=80% / >=95% metadata utilisation.

- **C15 ethtool advertised link modes.** New `snap.ethtool.interfaces[]`
  with `advertised_link_modes[]` and `advertised_auto_negotiation`.
  Unblocks Dashboard's `link_speed_mismatch` TUNE (current vs highest
  advertised speed).

- **C16 softnet drops.** New `snap.softnet` with per-CPU dropped column
  from `/proc/net/softnet_stat` plus agent-computed total drop rate
  per second (vmstat (C3) rate-calc pattern). Unblocks Dashboard's
  `softnet_drops` new rule.

- **C17 NVMe Critical Warning decode.** `snap.smart` NVMe devices gain
  `critical_warning_raw` plus six decoded boolean flags
  (available_spare_low / temperature_threshold / reliability_degraded /
  read_only / volatile_memory_backup_failed /
  persistent_memory_readonly) per NVM Express spec §5.21. Unblocks
  Dashboard's `nvme_critical_warning` P0 rule.

- **C11 vendor SEL parser quality tagging.** `snap.ipmi.bmc_vendor`
  identifies the BMC vendor (from DMI); each `sel_events_recent[]`
  entry now carries `parser_quality`: "fleet-tested" for dell / hpe /
  supermicro, "stub" for lenovo / cisco / openbmc, "unknown"
  otherwise. The existing keyword-based severity classifier (which
  has run vendor-agnostic since launch and produces canonical
  critical/warning/info values) is unchanged; this release adds the
  honesty surface Dashboard's `ipmi_sel_critical` TUNE consumes to
  flag stub-parser emissions in evidence. ipmitool mc info-based
  Manufacturer detection is a follow-up; DMI vendor is the single
  signal in this release.

- **C13 distro CVE collection.** New `snap.cve` with per-distro paths:
  Ubuntu Pro via `pro security-status --format=json` (requires
  `GLASSMKR_UBUNTU_PRO_TOKEN` env var; absence yields silent
  `available: false`); RHEL family via `dnf updateinfo list
  --security` text scrape; SUSE family via `zypper list-patches`
  table. `parser_quality` flags Ubuntu Pro path as fleet-tested
  (JSON-driven) and the text-scrape paths as stub. Unblocks
  Dashboard's `kernel_vulnerabilities` REDESIGN from a
  /sys/devices/system/cpu/vulnerabilities mitigation-status check
  into an upstream-CVE-driven rule.

- **C18 dmesg structured events.** New `snap.dmesg_events.events[]`
  parses the last hour of dmesg for three high-signal classes: SCSI
  sense codes (sense key + device), NVMe controller resets
  (controller + action), ext4 remount-readonly (device). PCIe AER and
  XFS classes from the original spec are deferred because format
  varies materially across kernel 5.x and 6.x — included classes
  cover the highest-frequency operational signals. Unblocks
  Dashboard's `disk_io_errors` TUNE, `filesystem_readonly`
  corroboration, and event-stream enrichment for `lacp_partner_lost`.

### Capability gating

All eight collectors degrade gracefully on hosts where the underlying
source is absent. Specifically:

- C12: `systemctl show` failure on a unit -> `result: "unknown"` for
  that unit; other units still ship details.
- C14: `lvs` binary absent -> `available: false, reason: "lvs not
  available"`.
- C15: `ethtool --version` fails -> `available: false`. Per-interface
  read failures are tolerated; the snapshot ships data for whichever
  interfaces returned.
- C16: `/proc/net/softnet_stat` not readable -> `available: false`.
- C17: NVMe device without `critical_warning` field -> decoded field
  absent (SATA devices unaffected).
- C11: BMC vendor unidentifiable from DMI -> `bmc_vendor: "unknown"`
  and `parser_quality: "unknown"` on each event; the existing
  vendor-agnostic classifier still runs.
- C13: missing `pro` / `dnf` / `zypper` CLI -> `available: false`.
  Ubuntu Pro token unset -> `available: false` with explicit reason
  (legitimate state on non-Pro hosts).
- C18: `dmesg` unreadable (CAP_SYSLOG missing or
  `kernel.dmesg_restrict=1` with non-root) -> `available: false`.

### Deferred from this release

- **C18 PCIe AER + XFS error event parsing.** Original spec listed
  five event classes; this release ships three. PCIe AER message
  shape varies across kernel 5.x and 6.x; XFS error patterns vary by
  mount option. Including them would double the regex test surface
  without proportional operational value. Future Crucible release
  picks them up if customer signal warrants.
- **C11 OpenBMC identification via `ipmitool mc info` Manufacturer
  Name.** DMI vendor is the single detection signal in this release;
  OpenBMC ships as DMI vendor "generic" which collapses to
  `bmc_vendor: "unknown"`. Follow-up adds the mc info probe.

## [0.11.0] - 2026-05-19

### Added

- **C7 per-process file descriptor scan.** New `snap.process_fd` field
  reports the top 50 processes by open-FD count alongside each
  process's `RLIMIT_NOFILE` soft and hard limits and a percent-of-soft
  ratio. Unblocks Dashboard's per-process `fd_exhaustion` path
  (system-wide path stays). Two-pass strategy keeps overhead bounded
  on busy hosts: cheap `readdir` over `/proc/<pid>/fd/` to find the
  top consumers, then `/proc/<pid>/limits` read for each.

- **C8 LACP partner state.** New `snap.bonding` field with per-bond
  mode, LACP rate, slave list with MII status + link-failure counts,
  partner LACP port-state bitfield, derived `partner_lacp_synchronized`
  flag (synchronization bit set in the port state), and
  `active_aggregator` with `number_of_ports` vs configured. Unblocks
  Dashboard's `lacp_partner_lost` rule (an MII-up bond with a dead
  partner is a silent failure that `bond_slave_down`'s MII check
  misses).

- **C9 conntrack insert_failed rate.** `snap.conntrack` gains four
  optional fields: `insert_failed_total`, `drop_total`,
  `insert_failed_rate_per_sec`, `drop_rate_per_sec`. Cumulative
  counters come from `/proc/net/stat/nf_conntrack` (summed across
  CPUs); rates computed agent-side using the vmstat (C3) module-level
  previous-counter pattern. First snapshot ships rates as `null`.
  Counter wraparound / host reboot resets the baseline.

- **C10 TCP retransmit + listen-queue stats.** New `snap.tcp_stats`
  field. From `/proc/net/snmp` Tcp: `out_segs_total`, `retrans_segs_total`,
  `in_segs_total` plus agent-computed `retrans_ratio` (retransmits per
  segment sent) and `retrans_rate_per_sec`. From `/proc/net/netstat`
  TcpExt: `listen_overflows_total`, `listen_drops_total` and their
  rates. Unblocks Dashboard's `tcp_retrans_high` and `listen_overflow`
  rules (the latter rounding out the `accept_backlog_or_syn_flood`
  classifier's subordinate set). Same first-snapshot-null pattern as
  C3 / C9.

### Capability gating

All four collectors degrade gracefully on hosts where the underlying
`/proc` surface is absent or the relevant kernel module is not
loaded. Each collector reports either an `available: false` payload
or an absent snapshot field; no errors, no log noise. Dashboard's
activation PR carries matching capability gates.

## [0.10.0] - 2026-05-14

### Breaking

- **Config schema key rename.** Top-level `forge:` block is now
  `dashboard:`. Existing `collector.yaml` files using the old key fail
  to parse with a Zod error pointing at the missing `dashboard:` field.
  Edit your config: replace `forge:` with `dashboard:` (everything
  nested stays the same). The old key is **not** accepted as a
  deprecated alias — clean break per the "Forge → Dashboard" workstream
  spec.
- **Default ingest endpoint.** The hardcoded default for fresh installs
  is now `https://app.glassmkr.com/api/v1/ingest` (was
  `https://forge.glassmkr.com/api/v1/ingest`). Anyone relying on the
  default needs to wait for the corresponding DNS cutover so
  `app.glassmkr.com` resolves, or set `dashboard.url` explicitly.

### Changed

- Log prefix `[forge]` → `[dashboard]` on the push pipeline.
- Internal source rename `src/push/forge.ts` → `src/push/dashboard.ts`;
  exports `pushToDashboard` / `initDashboardAgent` (were `pushToForge`
  / `initForgeAgent`). Affects anyone importing from
  `@glassmkr/crucible/push` programmatically (very small audience).
- README, CLI `--help`, init wizard, and example
  `collector.example.yaml` updated to reference the Glassmkr Dashboard
  instead of "Forge".
- Error message wording: "Double-check the key in your Forge dashboard."
  → "...your Glassmkr dashboard."

### Migration steps

1. Edit `/etc/glassmkr/collector.yaml` (or wherever the config lives):
   replace the top-level `forge:` key with `dashboard:`. Indented
   content (url, api_key, tls_pin) stays identical.
2. If you relied on the URL default: either set `dashboard.url`
   explicitly, or upgrade after the dashboard's DNS cutover so
   `app.glassmkr.com` resolves.
3. `sudo npm install -g @glassmkr/crucible@latest && sudo systemctl restart glassmkr-crucible`

## [0.9.3] - 2026-05-13

### Fixed

- Customer-visible state staleness after config changes. Pre-0.9.3 the entire `security` block on the snapshot was cached for 1 hour (every 12th collection cycle at the default 300s interval), which meant after a customer fixed a `no_firewall` / `ssh_root_password` / `unattended_upgrades_disabled` alert, the Forge dashboard kept showing the old state for up to 60 minutes. The cache existed because `apt list --upgradable` and `dnf updateinfo list security` are genuinely slow, but the cache was over-eager: every other sub-check (firewall `ufw status`, `sshd -T`, `/sys/devices/system/cpu/vulnerabilities/`, `systemctl is-active`) is fast and should run every cycle. Now: only the `pending_updates` sub-check is cached (1h TTL inside `collectSecurity()`); every other sub-check runs on every snapshot. Customer config fixes show up on the next 5-minute ingest cycle. Surfaced by `CLEANUP_REPORT_2026-05-13.md`.

## [0.9.2] - 2026-05-13

### Fixed

- `parseSelTimestamp` now emits strict ISO-8601 strings for every BMC date format observed in production. Pre-fix the function produced shapes like `23-06-17T09:05:27 UTCZ` (2-digit year not expanded, trailing ` UTC` from the time field passed through) which Forge's `ipmi_sel_critical` rule could not parse for its rolling time-window check. Two-digit years now expand using the standard `00-69 = 20YY` / `70-99 = 19YY` convention; any trailing ` UTC` on the time component is stripped before composition. Forge-side fail-open path remains as belt-and-braces. Closes the experiment finding paired with [glassmkr/glassmkr#60](https://github.com/glassmkr/glassmkr/pull/60).

### Added

- `collect/systemd.ts` now collects the last 5 journal lines per failed unit via `journalctl -u <unit> --no-pager -n 5 -o cat` and emits them on the snapshot as `systemd.journal_excerpts[unit]`. Cost is zero on the happy path (no failed units → no journalctl calls). Closes the experiment finding paired with [glassmkr/glassmkr#60](https://github.com/glassmkr/glassmkr/pull/60). Older Forge versions ignore the new field; current Forge displays the excerpt directly in the alert evidence so the customer doesn't have to SSH.

## [0.9.1] - 2026-05-08

### Added

- `glassmkr-crucible init` subcommand for canonical first-run setup. Validates the API key, optionally probes the ingest endpoint, writes `/etc/glassmkr/collector.yaml` (mode 0600), writes a systemd unit at `/etc/systemd/system/glassmkr-crucible.service` (mode 0644) with `ExecStart` pointing at the dynamically-detected binary path, runs `daemon-reload`, and (unless `--no-start`) enables and starts the service. Closes the F2 protocol gap surfaced in the Phase 2 API dogfood synthesis. See README "Quick Start" and `glassmkr-crucible init --help`. Supports `--api-key -` to read the key from stdin (avoids leaking to shell history). Requires root for the filesystem and systemd writes.
- IPMI sensor classifier: per-socket pre-filter in `src/lib/ipmi-sensor-filter.ts` that drops `CPU<N>_DTS` when `CPU<N>_TEMP` (or `CPU<N> Temp`) is also present on the same socket. Closes [#2](https://github.com/glassmkr/crucible/issues/2): false-positive `cpu_temperature_high` alerts on Gigabyte AMD platforms with BMC firmware 12.61, where `CPU<N>_DTS` reports ~30°C above the actual k10temp die temperature.

### Changed

- README: `init` is now documented as the canonical first-run path. The manual install flow is retained as a "Manual install" section for ops engineers customising the systemd unit, with the dynamic `command -v` snippet from the F5 fix. New "Migrating from manual install" subsection covers the (no-op) upgrade path for existing 0.9.0 hand-rolled setups.

### Backwards-compatibility

- Existing 0.9.0 installations with a hand-written `collector.yaml` and systemd unit continue working unchanged. No migration required.
- Customers on Gigabyte AMD platforms may see fewer false-positive `cpu_temperature_high` alerts after upgrading. This is the intended fix (#2). The `*_DTS` sensors are dropped in-collector before publish, so Forge's IPMI fallback path no longer sees them; hwmon-primary on Forge already used the correct `k10temp` value, so this also closes the IPMI-fallback parity gap.

### Internal

- New tests: `src/lib/__tests__/ipmi-sensor-filter.test.ts` (11 cases covering Gigabyte AMD, dual-socket EPYC, Dell-style, Supermicro-style, fallback-when-only-DTS, stable order); `src/__tests__/init.test.ts` (23 cases covering API-key validation, YAML emission, systemd unit shape, happy path, `--no-start`, `--force`, stdin, missing binary, connectivity probe 401/5xx/network-error, `--name`, `--ingest-url`, `systemctl enable` failure); `src/__tests__/cli.test.ts` extended with 6 cases for `init` argument parsing.
- Test count: 210 passing (was 168). Build: 0 type errors.

## [0.9.0] - 2026-05-07

Aligns Crucible with the Forge programmatic-API workstream. **No
collector-side code changes required for this release** — the agent
still reads its key as an opaque string and sends it as a Bearer
token. The version bump exists to let operators correlate "I rotated
on Forge to a `gmk_cru_live_*` key" with "I'm running Crucible
0.9.0 or later".

### Operator-facing change

When you next rotate a server's collector key on Forge (via the
dashboard or `POST /api/v1/servers/{id}/rotate-key`), Forge issues a
key in the new format:

  gmk_cru_live_<43-char-base62>_<4-char-checksum>     (49 chars total)

instead of the old:

  col_<32 hex>                                        (36 chars total)

The new format includes a Stripe-style prefix for support legibility,
a CRC32 checksum so Forge can reject malformed keys at the edge
without a DB lookup, and HMAC+pepper storage on the Forge side
(replacing bcrypt, which was overkill for 256-bit high-entropy keys).
GitHub secret-scanning partner registration for the `gmk_cru_live_`
prefix is queued.

After rotating: update the agent's config file with the new value:

  forge:
    api_key: "gmk_cru_live_..."

then `sudo systemctl restart glassmkr-collector`.

### Breaking

- **None for the agent itself.** Both old (`col_*`) and new
  (`gmk_cru_live_*`) keys continue to authenticate against Forge.
  Operators rotate at their own pace; Forge accepts both formats
  during the migration window. There is no scheduled cutoff for
  the legacy format in v0.9; that decision lands at v1.0 or earlier
  if customer demand drives it.

### Notes

- 0.9.0 is the floor version Forge documents for the new `gmk_cru_*`
  rotation flow. Earlier 0.8.x agents work fine; the version bump is
  about narrative alignment rather than wire-format incompatibility.
- The agent's auto-update path picks up 0.9.0 on next service restart
  for any field agent on 0.8.x.
- glassmkr-services-1 (currently 0.7.0) and glassmkr-gpu-1 (currently
  0.6.6) will both auto-update to 0.9.0 on next restart.

## [0.8.1] - 2026-05-06

Patch release closing P1 bugs Codex identified in 0.8.0. No new
features, no schema changes. Recommended upgrade for anyone running
0.8.0.

### Fixed
- **AMD k10temp / zenpower CPU temperature is now produced even when
  Tdie is unavailable**. 0.8.0 always skipped Tctl and never picked
  Tccd as a CPU reading, so kernels exposing only Tctl, or only Tccd*,
  produced no CPU reading and `cpu_temperature_high` couldn't fire on
  affected AMD hosts. Fallback order: Tdie → first Tccd → Tctl. Tctl
  now also surfaces in `other_readings` rather than being silently
  dropped.
- **`cpu_temperature_high` IPMI fallback no longer false-fires on
  non-temperature sensors.** 0.8.0's filter accepted any sensor whose
  name contained `cpu` or `temp`, ignoring the unit. A `CPU_FAN1`
  reading 2000 RPM would alert as `2000°C critical`. Filter now
  requires the sensor unit to indicate temperature (`C`, `°C`,
  `degrees C`, etc.), the name to include `cpu` or `processor`, and
  excludes ambient/inlet/PCH/DIMM/PSU sensors that happen to read in
  °C. Mirrors Forge's evaluator.
- **`psu_redundancy_loss` now matches IPMI discrete `cr`/`nr` status
  codes.** 0.8.0 only matched the text `fail`/`absent`. ipmitool
  commonly reports critical PSU states as the short codes `cr`
  (critical) or `nr` (non-recoverable) in the status column; on
  Supermicro and Dell that meant a PSU in fault state with status
  `cr` and a hex value did not fire unless the Dell aggregate
  redundancy field happened to save it.
- **DMI `Hewlett-Packard Company` is now classified as `hpe`.** 0.8.0's
  legacy-HP regex `(^|\W)hp(\W|$)` did not match the literal
  "Hewlett-Packard" string (no `HP` token in `Hewlett`). Added explicit
  `Hewlett-Packard` / `Hewlett Packard` matching, ahead of the
  standalone `HP` rule. Tightened the standalone `HP` rule to
  whitespace boundaries only so `HP-UX` (an OS name) doesn't
  false-match.

### Internal
- 18 new regression tests covering the four fixes above. Total tests:
  168 (was 150).
- Glassmkr's `validate-rule-ids.mjs` now schema-checks `RULES.json`
  before running drift comparison: catches invalid `side` values,
  duplicate IDs, malformed entries, non-snake_case ids.

### Note on Forge integration

The Codex review against 0.8.0 flagged that Forge's server-side
evaluator doesn't yet read the new `snap.thermal`,
`snap.ipmi.ecc_errors_from_sel`, `snap.ipmi.psu_redundancy_state`, or
`snap.dmi` fields. **Collector-side rules (used for Telegram / Slack /
email notifications shipped directly from the agent) DO use these
fields.** The Forge dashboard alerts come from a separate server-side
evaluator that needs to be extended in a future Forge release. Snapshot
ingestion accepts the new fields without erroring (TS cast, no Zod);
they're persisted but not yet evaluated.

This is a Forge feature gap, not a 0.8.0 / 0.8.1 collector bug.

## [0.8.0] - 2026-05-06

### Added
- `/sys/class/hwmon` thermal collection. CPU temperature now monitored on any
  Linux host with thermal sensors, not just hosts with a BMC. Works on
  Raspberry Pi, Dell, HPE, Supermicro, AMD (k10temp/zenpower), Intel (coretemp),
  and a range of ARM SoCs via the `cpu-thermal-chips.ts` allowlist.
- `/sys/class/thermal/thermal_zone*` fallback when hwmon is empty.
- DMI/SMBIOS vendor detection (`/sys/class/dmi/id/`). New `snap.dmi` field
  with vendor classification (Dell, HPE, Supermicro, ASRockRack, Lenovo,
  Inspur, Cisco, virtual, generic) and BIOS metadata.
- Vendor-aware IPMI sensor classification. Dell PowerEdge PSU sensors
  (`PS1 Status`, `PS2 Status`, `PS Redundancy`) now match correctly.
- Dell ECC error counting from SEL events. Dell does not expose ECC counters
  as named numeric sensors; cumulative counts now derived from
  `ipmitool sel elist` parsing.
- IPMI capability detection at startup. No-BMC hosts (Raspberry Pi, VMs,
  containers without `/dev` mapped) skip the four per-cycle `ipmitool`
  exec attempts. Reasoned failure surfaced as `snap.ipmi.detection`.
- New snapshot fields: `snap.thermal`, `snap.dmi`, `snap.ipmi.detection`,
  `snap.ipmi.psu_redundancy_state`, `snap.ipmi.ecc_errors_from_sel`.
- New public API: `ALL_RULE_IDS` exported from `@glassmkr/crucible/api`.
  Side-effect-free entry point added; the default `@glassmkr/crucible`
  entry point is the CLI and runs the agent on import.
- Static `rule-ids.json` shipped alongside `dist/`. Read by the Glassmkr
  drift validator without spawning a JS module load.
- New config flags: `collection.thermal: true` (default), `collection.dmi: true`
  (default).

### Changed
- `cpu_temperature_high` rule now prefers the hwmon source and falls back
  to IPMI substring filtering only when hwmon yielded no usable readings.
  Alert payload includes the source (`hwmon coretemp Package id 0` vs
  `IPMI CPU1 Temp`).
- `ecc_errors` rule reads `max(named_sensor_count, sel_derived_count)`.
  Alert payload calls out which source fired.
- `psu_redundancy_loss` rule supports Dell aggregate redundancy sensor
  in addition to per-PSU detection. Per-PSU detection now uses a
  vendor-aware classifier that recognises Dell `PS<N>` patterns.
- File header in `src/alerts/rules.ts` corrected to state 23 rules
  (was 15, off by 8).

### Fixed
- `disk_latency_high` rule now reads from `snap.io_latency` where the
  data lives, instead of `snap.disks[].latency_p99_ms` which no
  collector ever populated. Rule had never fired since being added.

### Breaking
- Rule ID `swap_active` renamed to `swap_high` to match Forge convention.
  Downstream consumers routing alerts on the old ID must update. The
  rule's behaviour is unchanged.

### Internal
- New rule audit document at `RULE_AUDIT.md` covering all 23 rules.
- 84 new tests across thermal, DMI, vendor sensors, IPMI capability
  detection, swap rule, ALL_RULE_IDS sync, and rule integration.
  Total test count: 150 (was 66).

### Migration

If you route alerts on rule ID:

```diff
- swap_active
+ swap_high
```

If you read snapshots: new optional fields are additive. Existing
fields unchanged. Forge ingestion in 2026-05 already accepts the
new shape (snapshot validation is a TS cast, not a Zod schema).

## [0.7.1] - 2026-04 (and earlier)

See git history for releases prior to this changelog being introduced.
Last release before this was published as `c8af7bf`:
"chore: kill hardcoded 'Glassmkr Collector v0.1.0' strings;
centralise version".
