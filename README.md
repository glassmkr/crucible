# Crucible

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@glassmkr/crucible.svg)](https://www.npmjs.com/package/@glassmkr/crucible)

Lightweight bare metal server monitoring agent. Collects hardware and OS health data, pushes snapshots to [Forge](https://forge.glassmkr.com) every 5 minutes. Forge evaluates 36 alert rules and sends notifications.

Open source. MIT licensed. Built by [Glassmkr](https://glassmkr.com).

## Quick Install

```bash
curl -sf https://forge.glassmkr.com/install | bash
```

Or via npm:

```bash
npm install -g @glassmkr/crucible
```

## What Crucible Collects

| Module | Data |
|--------|------|
| **CPU** | Aggregate and per-core utilization (user, system, iowait, idle, irq, softirq) |
| **Memory** | RAM usage, swap usage |
| **Disks** | Space per mount point, inode counts, mount options, filesystem type |
| **SMART** | Drive health, model, temperature, power-on hours, reallocated sectors, NVMe wear |
| **Network** | Interface traffic, error/drop counts, link speed |
| **RAID** | mdadm array status, degraded detection |
| **IPMI** | Sensor readings (temperatures, fans, voltages, power), ECC errors, SEL events |
| **Security** | SSH config, firewall status, pending updates, kernel vulnerabilities |

## Alert Rules

Crucible collects the data. Forge evaluates 36 alert rules server-side and sends notifications via Telegram and Slack.

**Categories:** OS (9), Storage (8), Network (4), Hardware/IPMI (5), ZFS (2), Security (6), Service Health (2).

**Priorities:** P1 Urgent, P2 High, P3 Medium, P4 Low.

See the full rule list: [forge.glassmkr.com/docs/alerts](https://forge.glassmkr.com/docs/alerts)

## Configuration

Edit `/etc/glassmkr/collector.yaml`:

```yaml
server_name: "web-01"
collection:
  interval_seconds: 300
  ipmi: true
  smart: true
forge:
  enabled: true
  url: "https://forge.glassmkr.com"
  api_key: "col_xxx"
```

Full configuration reference: [forge.glassmkr.com/docs/configuration](https://forge.glassmkr.com/docs/configuration)

## Requirements

- Linux (any distribution: Ubuntu, Debian, RHEL, Rocky, Alma, Arch, Alpine)
- Node.js 18+
- Root access (for SMART, IPMI, and system metrics)
- Optional: `smartmontools` (SMART data), `ipmitool` (IPMI data)

## How It Works

1. Crucible runs as a systemd service
2. Every 5 minutes, it collects a complete health snapshot
3. The snapshot is pushed to Forge via HTTPS (POST /api/v1/ingest)
4. Forge evaluates alert rules and sends notifications
5. Data appears in the Forge dashboard within seconds of push

## Documentation

- [Getting Started](https://forge.glassmkr.com/docs/getting-started)
- [Configuration Reference](https://forge.glassmkr.com/docs/configuration)
- [Alert Rules (36)](https://forge.glassmkr.com/docs/alerts)
- [Troubleshooting](https://forge.glassmkr.com/docs/troubleshooting)
- [API Reference](https://forge.glassmkr.com/docs/api)

## License

MIT. See [LICENSE](LICENSE).
