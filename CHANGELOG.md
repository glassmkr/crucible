# Changelog

All notable changes to `@glassmkr/crucible` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 convention: minor bumps may include breaking changes; we call them
out under `### Breaking` so downstream consumers can audit.

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
