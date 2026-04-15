# Crucible

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@glassmkr/crucible.svg)](https://www.npmjs.com/package/@glassmkr/crucible)

Lightweight bare metal server monitoring agent. Collects hardware and OS health every 5 minutes and pushes snapshots to a [Forge](https://forge.glassmkr.com) dashboard, which evaluates 38 alert rules and sends notifications.

Open source. MIT licensed. Built by [Glassmkr](https://glassmkr.com). See also [Bench](https://github.com/glassmkr/bench), the MCP server collection.

**Resource usage:** ~90MB RSS memory (varies by hardware: servers with more IPMI sensors use more), <0.1% CPU at 5-minute collection interval. Collects IPMI, SMART, ZFS, network bonds, security posture, conntrack, systemd, NTP, and file descriptors.

**Security:** See [glassmkr.com/security](https://glassmkr.com/security) for the full list of what Crucible does and does not collect.

## Install

```bash
npm install -g @glassmkr/crucible
```

Or use the bootstrap script:

```bash
curl -sf https://forge.glassmkr.com/install | bash
```

## Docker

```bash
# Create config directory
sudo mkdir -p /etc/glassmkr

# Create config (replace with your Forge credentials)
sudo tee /etc/glassmkr/collector.yaml << 'EOF'
server_name: "web-01"
collection:
  interval_seconds: 300
  ipmi: true
  smart: true
forge:
  enabled: true
  url: "https://forge.glassmkr.com"
  api_key: "col_YOUR_KEY_HERE"
EOF

# Run with docker compose
curl -O https://raw.githubusercontent.com/glassmkr/crucible/main/docker-compose.yml
docker compose up -d

# Check logs
docker compose logs -f crucible
```

Images are published to [ghcr.io/glassmkr/crucible](https://github.com/glassmkr/crucible/pkgs/container/crucible) on every tag release. The container needs `--privileged` and `network_mode: host` for IPMI, SMART, and accurate host network monitoring. Details in the [compose file](./docker-compose.yml).

## Quick Start

1. Create an API key in the Forge dashboard (Servers, then Add server).
2. Drop a config at `/etc/glassmkr/collector.yaml`:

   ```yaml
   server_name: "web-01"
   collection:
     interval_seconds: 300
     ipmi: true
     smart: true
   forge:
     enabled: true
     url: "https://forge.glassmkr.com"
     api_key: "col_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   ```

3. Run as a systemd service (recommended) or directly:

   ```bash
   sudo glassmkr-crucible
   ```

   Snapshots appear in the Forge dashboard within seconds of the first push.

## CLI Reference

```
glassmkr-crucible [options]

Options:
  -v, --version    Print version and exit
  -h, --help       Print this help and exit
  -c, --config     Path to config file (default: /etc/glassmkr/collector.yaml)
```

`--config=PATH` and the legacy positional form `glassmkr-crucible /path/to.yaml` both work. Without options, Crucible runs as a long-lived collector daemon.

## Systemd Service

Create `/etc/systemd/system/glassmkr-crucible.service`:

```ini
[Unit]
Description=Glassmkr Crucible - Bare Metal Monitoring
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/glassmkr-crucible /etc/glassmkr/collector.yaml
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now glassmkr-crucible
sudo systemctl status glassmkr-crucible
```

## What It Collects

| Module | Data |
|--------|------|
| CPU | Aggregate and per-core utilization (user, system, iowait, idle) |
| Memory | RAM usage, swap usage |
| Disks | Space per mount point, inode counts, mount options, filesystem type |
| SMART | Drive health, model, temperature, power-on hours, reallocated sectors, NVMe wear |
| Network | Interface traffic, delta error/drop counters, link speed |
| RAID | mdadm array status, degraded detection |
| IPMI | Sensor readings, ECC errors, SEL events, fan RPM |
| Security | SSH config, firewall status, pending updates, kernel vulnerabilities, kernel-needs-reboot |
| ZFS | Pool state, scrub age, scrub errors |
| I/O | Per-device latency, IOPS, dmesg I/O errors |
| Conntrack | nf_conntrack table usage |
| Systemd | Failed unit count |
| NTP | Sync state and source |
| File descriptors | System-wide allocation |

Forge evaluates 38 alert rules server-side across OS, Storage, Network, Hardware, ZFS, Security, and Service Health, with priorities P1 Urgent through P4 Low. Full list: [forge.glassmkr.com/docs/alerts](https://forge.glassmkr.com/docs/alerts).

## Requirements

- Linux (any distribution: Ubuntu, Debian, RHEL, Rocky, Alma, Arch, Alpine)
- Node.js 18+
- Root access (for SMART, IPMI, dmesg, and `/proc` access)
- Optional: `smartmontools` for SMART data, `ipmitool` for IPMI data, `zfsutils-linux` for ZFS pools

## Documentation

- [Getting Started](https://forge.glassmkr.com/docs/getting-started)
- [Configuration Reference](https://forge.glassmkr.com/docs/configuration)
- [Alert Rules (36)](https://forge.glassmkr.com/docs/alerts)
- [Troubleshooting](https://forge.glassmkr.com/docs/troubleshooting)
- [API Reference](https://forge.glassmkr.com/docs/api)

## License

MIT. See [LICENSE](LICENSE).
