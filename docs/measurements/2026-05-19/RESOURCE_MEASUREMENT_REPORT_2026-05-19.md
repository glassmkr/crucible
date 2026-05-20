# Crucible v0.13.0 resource measurement — 2026-05-19

Empirical measurement of the Crucible agent across the Glassmkr validation fleet. Per `CC_SPEC_CRUCIBLE_RESOURCE_MEASUREMENT_2026-05-19.md`. Backs the marketing surface sweep's "lightweight" claim recalibration.

> **Status: skeleton.** All numbers marked `TODO:` await fill-in from the per-host CSVs + summaries. The scripts at `scripts/` produce those summaries; the runbook in `README.md` covers the workflow.

---

## Executive summary

TODO: 2-3 paragraphs once `idle/SUMMARY.md` and `stress/SUMMARY.md` are populated. Template:

> "We measured Crucible v0.13.0 on N hosts of the validation fleet — vendor + OS family diverse — over a 30-minute idle baseline and three 10-minute stress profiles on a 3-host representative subset. Median resident memory was TODO MB (range TODO-TODO MB across the 7 hosts). Median CPU usage was TODO % at the default 60-second snapshot interval. Under CPU saturation the agent maintained snapshot cadence with TODO total drift. Under random-read I/O saturation, fio throughput dropped by TODO % when the agent was running concurrently."
>
> "Is 'lightweight' defensible? TODO: yes/with-caveats/no, plus the recalibrated number for marketing copy."
>
> "Two outliers worth flagging: TODO (or 'no outliers')."

---

## Fleet under measurement

| Host | Vendor | OS | Hardware class | Notes |
|---|---|---|---|---|
| `glassmkr-val-asrock-x570d4u` | ASRock Rack | Debian 12 (bookworm) | AMD whitebox | First updated 2026-05-DD |
| `glassmkr-val-gigabyte-mc12le` | Gigabyte | Debian 13 (trixie) | AMD whitebox | Stress subset (Profile A/B/C) |
| `glassmkr-val-supermicro-x12qch` | Supermicro | Ubuntu 22.04.5 | Intel server | Stress subset |
| `glassmkr-val-asus-z12pp` | ASUS | Debian 13 (trixie) | Intel server | Stress subset |
| `glassmkr-val-gigabyte-mz62hd` | Gigabyte | AlmaLinux 9.6 | AMD server | Idle only |
| `glassmkr-val-supermicro-h1*` | Supermicro | Rocky Linux 9.6 | Intel server | Idle only |
| `glassmkr-val-supermi*` | Supermicro | Ubuntu 24.04.3 | Intel server | **FAILING DISK** alert; idle only; post-update regression check |

Excluded by spec §6:
- `glassmkr-services-1`: production Forge backend, excluded to avoid bias.
- `glassmkr-gpu-1`: GPU collector, separate measurement workstream.

---

## Idle baseline (Phase 2)

30-minute window per host at the default 5-second sample interval (~360 rows each). Source CSVs: `idle/<hostname>.csv`. Summary: `idle/SUMMARY.md` (regenerate with `python3 scripts/summarise.py idle/`).

### Per-host idle table

TODO: paste the table from `idle/SUMMARY.md` here (or link). Expected columns: hostname, samples, RSS median/p95/peak, CPU% median/p95, FD max, thread max, IO read/write deltas.

### Cross-host variance

TODO: flag any host whose RSS exceeds 2× the fleet median, or whose CPU% exceeds 3× the median.

Expected variance sources per spec §2.3:
- Hardware class (single-socket whitebox vs dual-socket server).
- OS family / kernel version / systemd version.
- Disk count (more drives → more SMART queries → longer disk collector).
- Optional collectors enabled (LVM thin, hardware RAID, ZFS): each adds dependency-driven runtime.

If a host is `>3×` the median, investigate before publishing claims and document the cause in this section.

### Headline idle numbers

- **Median RSS:** TODO MB
- **Median CPU%:** TODO
- **Fleet RSS range:** TODO-TODO MB (low and high host)
- **Snapshot cadence:** TODO (should be ~60s default)
- **No FD leaks observed over 30 min:** TODO (fd_count stable across samples?)

---

## Stress profile results (Phase 3)

Three profiles × three hosts. Source CSVs: `stress/{a-cpu,b-io,c-mem}-<hostname>.csv` plus `stress/b-io-<hostname>-control.csv`. Summary: `stress/SUMMARY.md`.

### Profile A — CPU saturation

`stress-ng --cpu 0 --cpu-method all --timeout 600s` for 10 min on each of the 3 representative hosts. Agent collecting concurrently.

| Host | Agent CPU% median | Agent CPU% p95 | Snapshot duration impact | Collector timeouts |
|---|---|---|---|---|
| `glassmkr-val-supermicro-x12qch` | TODO | TODO | TODO | TODO |
| `glassmkr-val-gigabyte-mc12le` | TODO | TODO | TODO | TODO |
| `glassmkr-val-asus-z12pp` | TODO | TODO | TODO | TODO |

**Question to answer in this section:** Does the agent maintain snapshot cadence under full CPU pressure? Quantify any drift in seconds.

### Profile B — I/O saturation

`fio --rw=randread --bs=4k --iodepth=64 --runtime=600s` against a 2 GB file. Run twice per host: once with the agent **stopped** (control), once with it running. Compare fio throughput.

| Host | fio throughput control (IOPS) | fio throughput with agent (IOPS) | Delta (IOPS) | Agent IO read (MB/min) |
|---|---|---|---|---|
| `glassmkr-val-supermicro-x12qch` | TODO | TODO | TODO | TODO |
| `glassmkr-val-gigabyte-mc12le` | TODO | TODO | TODO | TODO |
| `glassmkr-val-asus-z12pp` | TODO | TODO | TODO | TODO |

**Question to answer:** Does Crucible measurably slow customer I/O workloads? The delta column is the answer. Treat any delta within ±1% as noise; >5% requires a follow-up investigation into which collector is the culprit.

### Profile C — Memory pressure

`stress-ng --vm 4 --vm-bytes 75% --vm-method all --timeout 600s`. Look for agent RSS getting paged out, collector timeouts because the OS is swapping.

| Host | Agent RSS stable under pressure? | Snapshot duration impact | Swap activity? |
|---|---|---|---|
| `glassmkr-val-supermicro-x12qch` | TODO | TODO | TODO |
| `glassmkr-val-gigabyte-mc12le` | TODO | TODO | TODO |
| `glassmkr-val-asus-z12pp` | TODO | TODO | TODO |

**Question to answer:** Does the agent degrade gracefully under memory pressure, or does it amplify the problem?

---

## Marketing-safe claims

The numbers in this section are what marketing copy can cite. The methodology footnote below applies to all of them.

### Resident memory (RAM)

> "Crucible typically uses **TODO MB RAM** at idle (median across a 7-host validation fleet, 30-minute window). Range TODO-TODO MB."

### CPU overhead

> "Crucible adds **TODO % CPU** on a 4-core host at the default 60-second snapshot interval (median; p95 TODO %)."

### I/O footprint

> "Crucible's I/O footprint averaged **TODO MB/min** of disk reads (mostly SMART, sysfs, and /proc) during normal operation. Under random-read I/O saturation, fio throughput dropped by **TODO %** with the agent running vs without — TODO: 'within noise' or 'measurable; follow-up investigation under way'."

### Graceful degradation

> "Under CPU saturation, snapshot cadence remained stable (drift < TODO seconds over 10 min). Under memory pressure, the agent's RSS remained stable — no swap activity observed on hosts with sufficient swap headroom; the snapshot collector reported TODO collector timeouts."

### Methodology footnote (apply to every claim)

> "Measured 2026-05-DD on Glassmkr's 7-host validation fleet (3 vendors, 4 OS families, mix of single-socket whitebox and dual-socket server hardware). Stress profiles ran on a 3-host representative subset. Validation-fleet measurements are not necessarily representative of every customer deployment; we publish customer-fleet measurements separately when that workstream completes. GPU collector excluded; measured separately."

---

## Honest caveats

Per spec §4.1 ("Honest caveats"):

- **Validation fleet ≠ customer fleet.** These hosts run in a single data centre; customer deployments may differ in disk count, optional collectors enabled, kernel version, and ambient noise.
- **30-min idle + 10-min stress windows.** Doesn't capture diurnal variance. A 24-hour window would catch any periodic spike (e.g. cron-driven SMART rescans on certain controllers).
- **All hosts in the same data centre.** Doesn't reflect remote/edge deployments where network egress + ingest latency may differ.
- **GPU collector excluded.** `snap.gpu` is capability-gated and only exercises on NVIDIA hosts; the GPU validation hosts are a separate measurement workstream.
- **Trusted Publishing path only.** The npm-published agent version is the one measured. Self-built customers (running from source) may see different numbers.
- **`stress-ng --vm-bytes 75%`** runs against available memory. Hosts with tight memory headroom may swap during Profile C; that's part of the signal but it confounds the "agent RSS stable" question. Document per-host swap behaviour in the Profile C section.

---

## Data appendix

Per-host raw samples + per-profile raw samples:

```
docs/measurements/2026-05-19/
  idle/
    glassmkr-val-asrock-x570d4u.csv          (TODO populated)
    glassmkr-val-gigabyte-mc12le.csv
    glassmkr-val-supermicro-x12qch.csv
    glassmkr-val-asus-z12pp.csv
    glassmkr-val-gigabyte-mz62hd.csv
    glassmkr-val-supermicro-h*.csv
    glassmkr-val-supermi*.csv
    SUMMARY.md
  stress/
    a-cpu-glassmkr-val-supermicro-x12qch.csv
    a-cpu-glassmkr-val-gigabyte-mc12le.csv
    a-cpu-glassmkr-val-asus-z12pp.csv
    b-io-glassmkr-val-supermicro-x12qch.csv
    b-io-glassmkr-val-supermicro-x12qch-control.csv
    b-io-glassmkr-val-supermicro-x12qch.fio.txt
    b-io-glassmkr-val-supermicro-x12qch-control.fio.txt
    ...
    c-mem-glassmkr-val-supermicro-x12qch.csv
    ...
    SUMMARY.md
```

Filling instructions: run the campaign per `README.md`; copy CSVs back; regenerate the two `SUMMARY.md` files via `summarise.py`; paste headline numbers into the TODO markers above; rewrite the Executive summary; commit.
