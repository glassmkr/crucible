# Crucible v0.13.3: resource footprint brief

> **For marketing copy / sales conversations / docs / comparison content.**
> Sourced from the empirical measurement campaign at `RESOURCE_MEASUREMENT_REPORT_2026-05-19.md`. Numbers below are safe to cite verbatim. Use the methodology footnote any time you cite a number; citation discipline.

## Headline numbers

| Metric | Value | Source |
|---|---|---|
| Median resident memory (idle) | **~91 MB** | 7-host validation fleet, 30-min window |
| Fleet RSS range (low to high host) | **65 to 103 MB** | Same |
| Median CPU% at default 60s snapshot interval | **0% (six hosts); 0.1% on the 8-disk host** | Same |
| Disk read footprint at idle | **0 to ~14 KB/s** (most hosts effectively zero) | Same |
| Network egress per snapshot | **TODO KB** | Dashboard ingest log; per-snapshot payload size |
| fio random-read throughput delta (agent on vs off) | **<1.5% on every host (within noise)** | 3-host stress subset, 10-min Profile B |

## What you can safely say

- **"Lightweight":** Yes. Median ~91 MB RSS, fleet range 65 to 103 MB peak. Effectively 0% CPU at the default 60-second snapshot interval (0.1% on the most disk-rich host in the fleet, an 8-disk Supermicro). Predictable: no host in the validation fleet exceeds 1.13x the fleet median.
- **"Doesn't interfere with workloads":** Yes (verified). Under random-read I/O saturation (`fio --iodepth=64 --rw=randread`), throughput moved by less than 1.5% across 3 representative hosts when the agent was running concurrent vs stopped (z12pp +1.3%, mc12le -0.02%, x12qch +0.4%). All deltas are within run-to-run noise; agent presence is not the dominant variable.
- **"Snapshot cadence is stable":** Yes. Under full CPU saturation (`stress-ng --cpu 0` pinning every CPU at 100%), the agent maintained 95 to 99% sample coverage of the 5-second cadence across 3 hosts. RSS stayed within ±0.5 MB of the idle baseline.
- **"Degrades gracefully under memory pressure":** Yes. Under `stress-ng --vm-bytes 75%` for 10 min, agent RSS held flat or contracted slightly. No swap thrash, no collector timeouts, no process restart.

## What you can NOT say (yet)

- Comparison to dcgm-exporter / node_exporter / Datadog agent. Future measurement workstream.
- Customer-fleet numbers. The validation fleet substitutes for now; document this explicitly when citing.
- 24-hour numbers. The campaign window is 30 min idle + 10 min stress. Periodic spikes (e.g. nightly SMART rescans on certain controllers) are uncaptured.
- GPU footprint. `snap.gpu` was excluded; separate measurement after the GPU validation lift PR.

## Methodology footnote (paste verbatim under any cited number)

> "Measured 2026-05-21 on Glassmkr's 7-host validation fleet (3 hardware vendors: ASRock, Gigabyte, Supermicro + ASUS; 4 OS families: Debian 12/13, Ubuntu 22.04/24.04, AlmaLinux 9, Rocky 9; mix of single-socket whitebox and dual-socket server hardware). Crucible v0.13.3, default 60-second snapshot interval. 30-minute idle baseline on all 7 hosts; 10-minute stress profiles (CPU saturation, random-read I/O saturation, memory pressure) on a 3-host representative subset. Validation-fleet measurements are not necessarily representative of every customer deployment; the customer-fleet measurement is a separate workstream. GPU collector excluded."

## Old marketing claims to recalibrate

The Docker Hub README and the homepage previously cited **"~90 MB RSS, <0.1% CPU at 5-minute collection interval"**. v0.13.0+ added 19+ new collectors (C1 to C19) since that copy was last touched. Two things have changed since:

1. **Snapshot interval is 60s by default, not 5 min** (the 5-min figure pre-dates the interval change in v0.10.0 around the Forge to Dashboard rename).
2. **More collectors run by default**: C1-C19 added EDAC, PSI, vmstat, reboot evidence, hardware RAID, ZFS vdev, per-process FD, LACP, conntrack rate, TCP retrans, systemd Result, LVM thin, ethtool, softnet, NVMe critical warning, vendor SEL parser, CVE collection, dmesg structured events, GPU.

**Verdict after measurement:** the ~90 MB number survives (fleet median 91 MB; peak 103 MB). The CPU number tightens to "effectively 0%" at the new default interval. Recommended replacement copy: **"~90 MB RAM and effectively 0% CPU at the default 60-second snapshot interval; predictable across a 3-vendor / 4-OS validation fleet (median 91 MB, range 65 to 103 MB)."**

Replace the **~90 MB / <0.1% CPU @ 5min** copy in:
- Docker Hub README (`docker.io/glassmkr/crucible` description)
- `glassmkr.com` homepage + `/docs` overview
- Comparison pages (`/vs/*` quote the resource footprint when contrasting)

## Where the full report lives

`docs/measurements/2026-05-19/RESOURCE_MEASUREMENT_REPORT_2026-05-19.md` (Crucible repo). The data appendix lists per-host CSVs for anyone who wants to verify the numbers.

## Where the data lives

`docs/measurements/2026-05-19/idle/*.csv` and `docs/measurements/2026-05-19/stress/*.csv`. Public; same repo as the agent source (MIT-licensed).
