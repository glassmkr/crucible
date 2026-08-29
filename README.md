# Crucible

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@glassmkr/crucible.svg)](https://www.npmjs.com/package/@glassmkr/crucible)

<!-- Canonical rule count: 65 across 9 categories. -->
Lightweight bare-metal server monitoring agent. Collects hardware and OS health every 60 seconds at the default interval and pushes snapshots to the [Glassmkr Dashboard](https://app.glassmkr.com), which evaluates 65 alert rules across 9 categories and sends notifications.

Open source. MIT licensed. Built by [Glassmkr](https://glassmkr.com). Crucible is the open-source product; the optional [Glassmkr Dashboard](https://app.glassmkr.com) is a hosted SaaS that consumes Crucible's snapshots.

**Resource usage:** under 1% of host RAM on every host we tested. Crucible 0.13.6 measured across all 10 validation hosts at steady state shows a median 108 MB RSS (range 81 to 116 MB; varies primarily with the bundled Node version). Effectively 0% CPU at the default 60-second snapshot interval. Random-read I/O throughput delta under 1.5% under fio saturation (no measurable impact on customer workloads).

**Security:** See [glassmkr.com/trust](https://glassmkr.com/trust) for the full list of what Crucible does and does not collect.

## Screenshots

![Dashboard alert with copy-pasteable fix commands](https://glassmkr.com/screenshots/alerts.png?v=20260701)
*Illustration composed for this README, not a capture: the alert, its
evidence, and the commands are written into the showcase component; no host
produced them. It shows the layout of a P1 alert with the rule trigger,
evidence, and remediation commands. Each rule ships pre-written fix content;
the agent does not write to your server.*

![Storage and SMART drive health](https://glassmkr.com/screenshots/hardware.png?v=20260701)
*Illustration composed for this README, not a capture: the drive models,
capacities, and SMART values are written into the showcase component. It shows
the layout of per-mount capacity and per-disk SMART status; real deployments
check SMART attributes, NVMe Critical Warning bits, and ZFS pool state.*

![Server fleet overview](https://glassmkr.com/screenshots/overview.png?v=20260701)
*Illustration composed for this README, not a capture: hostnames are
invented and the addresses are from the RFC 5737 documentation range. It shows
the fleet view layout with per-server status, distro, IP, and last-seen
timestamp; alerted servers surface a counter at a glance.*

## Install

The fastest path: bootstrap script. Detects Node and npm, installs the
agent, and runs `glassmkr-crucible init` to validate your key, write
`/etc/glassmkr/crucible.yaml`, write the systemd unit, and start the
service.

```bash
curl -sf https://glassmkr.com/install.sh | bash -s -- --api-key gmk_cru_live_<your-key>
```

Or run the steps yourself:

```bash
sudo npm install -g @glassmkr/crucible
sudo glassmkr-crucible init --api-key - < /path/to/protected-key-file
```

`init` is the canonical first-run path. It validates the key shape,
optionally probes the ingest endpoint, writes config + systemd unit
with the right binary path for your distro, and enables the service.
Run `glassmkr-crucible init --help` for the full flag list.

## Quick Start

1. Create an API key in the Glassmkr Dashboard (Servers → Add server).
2. Run `init`:

   ```bash
   sudo glassmkr-crucible init --api-key - < /path/to/protected-key-file
   ```

   This writes `/etc/glassmkr/crucible.yaml`, writes the systemd unit,
   and starts the service. Pass `--name` to override the dashboard
   server name (defaults to the host's hostname). Pass `--no-start` if
   you want to inspect the unit before enabling it. Pass `--api-key -`
   to read the key from stdin (handy for password-manager pipes). Literal
   values remain supported for compatibility, but they can be exposed by
   process listings and shell history. A systemd credential can be passed
   without argv exposure with
   `sudo glassmkr-crucible init --api-key - < "$CREDENTIALS_DIRECTORY/crucible-api-key"`.

   Snapshots appear in the Glassmkr Dashboard within seconds of the first
   push.

If you can't or won't run `init` (config-management is doing it for
you, or you're customising the systemd unit), the manual flow is in
the **Manual install** section below.

## CLI Reference

```
glassmkr-crucible [options]
glassmkr-crucible init        [--api-key <K>] [--name <N>] [--ingest-url <U>] [--no-start] [--force] [--no-verify]
glassmkr-crucible enroll      --account-key <K> [--name <N>] [--tags a,b] [--dashboard-url <U>] [--no-start] [--force]
glassmkr-crucible doctor ipmi [--config <P>]
glassmkr-crucible mark-reboot [--reason TEXT] [--ttl DURATION]
glassmkr-crucible reboot      [--reason TEXT] [--ttl DURATION]

Options:
  -v, --version    Print version and exit
  -h, --help       Print this help and exit
  -c, --config     Path to config file (default: /etc/glassmkr/crucible.yaml)
```

`--config=PATH` and the legacy positional form `glassmkr-crucible /path/to.yaml` both work, and `-c`/`--config` is accepted by every subcommand (on `init`/`enroll` it names where the config is written). An unrecognized flag on `init`/`enroll` is an error, not a silent no-op. Without options, Crucible runs as a long-lived collector daemon. Numeric exit codes for scripting are documented in [docs/EXIT_CODES.md](docs/EXIT_CODES.md).

## Configuration

`init` writes `/etc/glassmkr/crucible.yaml`. (Installs predating v0.13.5 have the file at `/etc/glassmkr/collector.yaml`; the agent reads either path, preferring the new name. Run `glassmkr-crucible init` to migrate the legacy file lossless.) The schema:

```yaml
server_name: "web-01"
collection:
  interval_seconds: 60
  ipmi: true
  smart: true
dashboard:
  enabled: true
  url: "https://app.glassmkr.com"
  api_key: "gmk_cru_live_<...>_<4>"
  allow_insecure_endpoint: false
  allowed_origins: []
prometheus:
  enabled: false
  address: "127.0.0.1"
  port: 9101
```

That is the shape, not the whole schema: `thresholds:` (local alert limits),
`channels:` (agent-local Telegram/email/Slack notifications), per-collector
toggles (`thermal`, `dmi`, `enforce_ipmitool_min_version`), and
`dashboard.tls_pin` are all documented with defaults in
[config/crucible.example.yaml](config/crucible.example.yaml). Unknown keys
anywhere in the file are ignored with a journal warning naming the key, so a
typo cannot silently disable a setting.

The opt-in Prometheus listener binds to loopback by default and has no built-in
authentication. To scrape it remotely, keep the loopback bind and place an
authenticated proxy or an equivalent host ACL in front of it. Set `address`
explicitly only when that network boundary is already in place.

Dashboard and enrollment endpoints require HTTPS and public DNS by default.
For trusted self-hosting, set `allow_insecure_endpoint: true`, or add narrowly
scoped origins such as `https://ingest.internal.example` to `allowed_origins`.
Both `init` and `enroll` offer the equivalent `--allow-insecure-endpoint` and repeatable
`--allow-endpoint-origin <ORIGIN>` flags. These exceptions permit credentials
to reach the named endpoint, so keep them as narrow as possible.

Hand-edit any time. The agent re-reads on restart. Run
`glassmkr-crucible init --help` for the full flag list.

## Upgrading

Run `init` after installing a new version so it can refresh the service unit,
privilege wrapper, and config ownership before the service restarts:

```bash
sudo npm i -g @glassmkr/crucible
sudo glassmkr-crucible init
sudo systemctl restart glassmkr-crucible
```

Existing service-owned configs continue to load during the ownership migration.
The agent emits a warning and sets `config_migration_required: true` in snapshots
until `init` preserves the file content and changes it to `root:glassmkr` mode
`0640`. A new config or a `--force` rewrite still requires `--api-key`.

### Migrating from 0.9.x to 0.10.x

**Breaking change in 0.10.0**: the top-level config block was renamed
from `forge:` to `dashboard:`, and the default endpoint changed from
`forge.glassmkr.com` to `app.glassmkr.com`. Edit your existing
`/etc/glassmkr/crucible.yaml` (or the legacy `/etc/glassmkr/collector.yaml` on pre-0.13.5 installs):

```yaml
# OLD (0.9.x):
forge:
  enabled: true
  url: "https://forge.glassmkr.com"
  api_key: "gmk_cru_live_..."

# NEW (0.10+):
dashboard:
  enabled: true
  url: "https://app.glassmkr.com"
  api_key: "gmk_cru_live_..."
```

The `api_key` value itself is unchanged; only the parent key
(`forge:` → `dashboard:`) and the endpoint hostname need updating.
After the edit, restart the service:

```bash
sudo systemctl restart glassmkr-crucible
```

For a clean reinstall from scratch, prefer `init --force`:

```bash
sudo systemctl stop glassmkr-crucible
sudo glassmkr-crucible init --api-key <K> --force
```

## Rebooting without noise

Crucible distinguishes planned reboots from unplanned ones and gives each rule a short grace period after boot so that transient conditions (bond slave still negotiating, clock not synced yet) do not page you.

Before a planned reboot:

```
sudo glassmkr-crucible reboot --reason "kernel update"
```

Or, if you prefer to trigger the reboot yourself:

```
sudo glassmkr-crucible mark-reboot --reason "kernel update"
sudo reboot
```

Both write a short-lived marker to `/var/lib/crucible/reboot-expected`. The agent reads it once on startup, sets `expected_reboot: true` on the first post-boot snapshot, and deletes the file. Dashboard reads that flag and suppresses the `server_rebooted_unexpectedly` alert for that boot only.

The marker is single-use and expires 10 minutes after it is written (override with `--ttl 5m` / `--ttl 1h`), so a forgotten marker cannot silence a genuine crash reboot next week. If systemd fails to reboot the host, the marker simply expires on its own.

Per-rule grace windows are applied separately: bond-slave-down and CPU-temperature get 60 s, interface errors 120 s, clock-sync / NTP 300 s, others 0 s. Suppressed evaluations are recorded in alert history with status `suppressed_boot_grace` or `suppressed_planned_reboot` so you can audit exactly why a rule didn't fire during a given boot.

## Manual install

The canonical install path is `glassmkr-crucible init` (see "Install"
above). For ops engineers writing config-management modules, `init`
gives you a stable interface that's covered by the test suite; prefer
it over hand-rolling the equivalent.

Do not hand-write a root service unit. To let configuration management stage
the reviewed unit without starting it, use the supported no-start flow:

```bash
sudo glassmkr-crucible init --api-key <K> --no-start
sudo systemctl cat glassmkr-crucible
```

After reviewing the generated config, wrapper, sudoers entry, and unit:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now glassmkr-crucible
sudo systemctl status glassmkr-crucible
```

Re-run `init --force --no-start` after a distro or npm-prefix change so the
generated unit follows the installed binary safely.

## Security boundaries

Crucible runs as the unprivileged `glassmkr` user. A root-owned, fixed-action
wrapper grants only the hardware and kernel reads required by privileged
collectors. If wrapper setup fails, the service stays unprivileged and those
collectors report unavailable data instead of silently running the whole agent
as root. An operator can explicitly accept the old behavior for recovery by
setting `GLASSMKR_ALLOW_ROOT_FALLBACK=1` while running `init` or `enroll`; the
installer emits a prominent security warning when it honors this override.

The service user receives `systemd-journal` membership for failed-unit context.
`init` removes the broader legacy `adm` membership when present. The generated
unit enables `ProtectHome`, `PrivateTmp`, `ProtectControlGroups`, and
`ProtectSystem=strict`, with write access limited to `/var/lib/glassmkr` and
`/var/lib/crucible`.

`NoNewPrivileges` and `RestrictSUIDSGID` are deliberately not set because the
collector's narrow root wrapper is reached through the setuid `sudo` binary.
`LockPersonality` and `ProtectKernelTunables` are also deliberately omitted:
systemd makes either directive imply `NoNewPrivileges=yes`, and an explicit
`NoNewPrivileges=no` cannot override that implication. Classic sudo then cannot
perform its setuid transition. `sudo-rs` may tolerate the same context, so a
green result on a sudo-rs host does not validate classic sudo.
This is a residual risk: the wrapper and sudoers rule are root-owned, fixed
action, and fail closed, but the service can still invoke that reviewed setuid
boundary. Keep sudo's `secure_path` configured and do not grant the `glassmkr`
user any broader sudo access.

Before shipping this hardening on a distro, install and start the real generated
unit, wait for its first collection, then run the privileged-wrapper smoke test:

```bash
sudo npm run test:hardened-wrapper
```

The test inspects the running `glassmkr-crucible.service`, requires its effective
`NoNewPrivileges` value to be `no`, and checks the current service invocation's
journal for a successful fixed privileged action. This proves escalation under
the real persistent unit, its shipped sandbox, the installed sudo, and the host
SELinux policy. The real installed unit is required for a green result.

A `systemd-run --pipe` reproduction is not authoritative on RHEL-family hosts:
SELinux can reject sudo from that transient harness even with no sandbox
directives. Validate the persistent unit on a RHEL-family host with SELinux
enforcing and on a Debian or Ubuntu host with classic sudo before rollout.
Never add `/etc/glassmkr` to `ReadWritePaths`; runtime configuration stays
read-only.

Failed-unit journal excerpts cross the host-to-dashboard data boundary. The
feature remains enabled, but the agent exports at most five lines per unit,
512 characters per line, and 4096 journal characters per snapshot. It redacts
Bearer/Basic credentials, common password and API-key assignments, known key
shapes, JWTs, URL userinfo, and sensitive URL query values. Redaction is
best-effort, so applications should still avoid writing secrets to logs.

## What It Collects

| Module | Data |
|--------|------|
| CPU | Aggregate and per-core utilization (user, system, iowait, idle) |
| Memory | RAM usage, swap usage, EDAC counters, vmstat pswpin/pswpout |
| Pressure (PSI) | cpu / io / memory `some` and `full` stall avg + total (kernel >= 4.20) |
| Disks | Space per mount point, inode counts, mount options, filesystem type, LVM thin metadata |
| SMART | Drive health, model, temperature, power-on hours, reallocated sectors, NVMe wear, NVMe Critical Warning decode |
| Network | Interface traffic, delta error/drop counters, link speed, ethtool advertised modes, softnet per-CPU drops |
| RAID | mdadm array status, degraded detection; hardware RAID via storcli/perccli (fleet-tested), ssacli/arcconf (stub) |
| IPMI | Sensor readings, ECC errors, SEL events, fan RPM, PSU redundancy state; vendor SEL parsers (Dell/Supermicro/HPE fleet-tested, Lenovo/Cisco/OpenBMC stub) |
| Security | SSH config, firewall status, pending updates, kernel vulnerabilities, kernel-needs-reboot, CVE collection |
| ZFS | Pool state, vdev redundancy class, SLOG/L2ARC split, scrub age, scrub errors |
| GPU (NVIDIA) | nvidia-smi tier 1 (default), DCGM tier 2 (enrichment), Redfish OEM tier 3 (stub); per-GPU XID events, temperature, ECC, power draw, PCIe link state |
| I/O | Per-device latency, IOPS, dmesg I/O errors, structured dmesg events |
| Conntrack | nf_conntrack table usage, insert_failed rate |
| Network process | Per-process FD scan, LACP partner state, TCP retrans rate |
| Systemd | Failed unit count, Result codes, bounded and redacted journal excerpts |
| NTP | Sync state and source |
| File descriptors | System-wide allocation |
| Reboot evidence | pstore / kdump / wtmp; expected-vs-unexpected reboot classification |

<!-- Canonical rule count: 65 across 9 categories. -->
Dashboard evaluates 65 alert rules server-side across 9 categories (storage, zfs, filesystem, memory & CPU, network, hardware/BMC, time & services, security & patching, GPU), with priorities P1 Urgent through P4 Low. Every rule ships with deep FIX content (copy-pasteable remediation + verdict prior + rollback notes); 30+ are verified end-to-end on real hardware. Full list: [glassmkr.com/docs/rules](https://glassmkr.com/docs/rules).

## Requirements

- Linux (any distribution: Ubuntu, Debian, RHEL, Rocky, Alma, Arch, Alpine)
- Node.js 22.19.0 or newer (Node 22 LTS is supported; the floor is undici 8's own engines.node)
- Root access for installation of the narrow privileged wrapper; the daemon runs as `glassmkr`
- Optional: `smartmontools` for SMART data, `ipmitool` for IPMI data, `zfsutils-linux` for ZFS pools

## Documentation

- [Getting Started](https://glassmkr.com/docs/getting-started)
- [Configuration Reference](https://glassmkr.com/docs/configuration)
- [Alert Rules (61)](https://glassmkr.com/docs/rules)
- [Troubleshooting](https://glassmkr.com/docs/troubleshooting)
- [API Reference](https://glassmkr.com/docs/api)

## Versioning

Semver, with the compatibility surface defined precisely: from 1.0.0, the
config file schema, the CLI (flags and [exit codes](docs/EXIT_CODES.md)), the
privileged wrapper's action set, and the dashboard API contract the agent
speaks only break on a major version. New collectors, optional snapshot
fields, and new flags are minor; fixes are patches. The freeze-review record
is [docs/V1_FREEZE.md](docs/V1_FREEZE.md).

## Support and release cadence

Maintained. Releases happen when there is something to release; security fixes
are prioritized. Where Crucible has actually been exercised (as opposed to
where it should work) is recorded in [SUPPORT.md](SUPPORT.md).

## License

MIT. See [LICENSE](LICENSE). Third-party dependency licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This repository does not use
per-file license headers; the LICENSE file governs the whole tree.
