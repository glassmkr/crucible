# Crucible v0.13.0 — resource footprint brief

> **For marketing copy / sales conversations / docs / comparison content.**
> Sourced from the empirical measurement campaign at `RESOURCE_MEASUREMENT_REPORT_2026-05-19.md`. Numbers below are safe to cite verbatim. Use the methodology footnote any time you cite a number — citation discipline.

## Headline numbers

| Metric | Value | Source |
|---|---|---|
| Median resident memory (idle) | **TODO MB** | 7-host validation fleet, 30-min window |
| Fleet RSS range (low → high) | **TODO → TODO MB** | Same |
| Median CPU% at default 60s snapshot interval | **TODO %** | Same |
| Disk read footprint per minute | **TODO MB/min** | Same |
| Network egress per snapshot | **TODO KB** | Dashboard ingest log; per-snapshot payload size |
| fio random-read throughput delta (agent on vs off) | **TODO %** | 3-host stress subset, 10-min Profile B |

## What you can safely say

- **"Lightweight":** TODO — fill in based on report's recalibration. Either "yes, X MB" or "lightweight on smaller servers; up to Y MB on dual-socket servers with many drives." Be specific.
- **"Doesn't interfere with workloads":** TODO — fill in based on the Profile B fio delta. If within ±1% noise: "no measurable impact on customer I/O workloads under saturation"; if >5%: do not make this claim until investigation closes.
- **"Snapshot cadence is stable":** TODO — Profile A drift in seconds.

## What you can NOT say (yet)

- Comparison to dcgm-exporter / node_exporter / Datadog agent. Future measurement workstream.
- Customer-fleet numbers. The validation fleet substitutes for now; document this explicitly when citing.
- 24-hour numbers. The campaign window is 30 min idle + 10 min stress. Periodic spikes (e.g. nightly SMART rescans on certain controllers) are uncaptured.
- GPU footprint. `snap.gpu` was excluded; separate measurement after the GPU validation lift PR.

## Methodology footnote (paste verbatim under any cited number)

> "Measured 2026-05-DD on Glassmkr's 7-host validation fleet (3 hardware vendors, 4 OS families: Debian 12/13, Ubuntu 22.04/24.04, AlmaLinux 9, Rocky 9; mix of single-socket whitebox and dual-socket server hardware). 30-minute idle baseline on all 7 hosts; 10-minute stress profiles (CPU saturation, random-read I/O saturation, memory pressure) on a 3-host representative subset. Validation-fleet measurements are not necessarily representative of every customer deployment; the customer-fleet measurement is a separate workstream. GPU collector excluded."

## Old marketing claims to recalibrate

The Docker Hub README and the homepage previously cited **"~90 MB RSS, <0.1% CPU at 5-minute collection interval"**. v0.13.0 added 13+ new collectors since that copy was last touched. Two things have changed since:

1. **Snapshot interval is 60s by default, not 5 min** (the 5-min figure pre-dates the interval change).
2. **More collectors run by default** — C1-C19 added EDAC, PSI, vmstat, reboot evidence, hardware RAID, ZFS vdev, per-process FD, LACP, conntrack rate, TCP retrans, systemd Result, LVM thin, ethtool, softnet, NVMe critical warning, vendor SEL parser, CVE collection, dmesg structured events, GPU.

Either or both of the above can move the actual headline numbers. The campaign output recalibrates these claims. Replace the **~90 MB / <0.1% CPU @ 5min** copy in:
- Docker Hub README (`docker.io/glassmkr/crucible` description)
- `glassmkr.com` homepage + `/docs` overview
- Comparison pages (`/vs/*` quote the resource footprint when contrasting)

## Where the full report lives

`docs/measurements/2026-05-19/RESOURCE_MEASUREMENT_REPORT_2026-05-19.md` (Crucible repo). The data appendix lists per-host CSVs for anyone who wants to verify the numbers.

## Where the data lives

`docs/measurements/2026-05-19/idle/*.csv` and `docs/measurements/2026-05-19/stress/*.csv`. Public — same repo as the agent source (MIT-licensed).
