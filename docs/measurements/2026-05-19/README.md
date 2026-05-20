# Crucible v0.13.0 resource measurement campaign — 2026-05-19

Runbook for the measurement campaign per `CC_SPEC_CRUCIBLE_RESOURCE_MEASUREMENT_2026-05-19.md`. Validation fleet only; production backend (services-1) and the GPU host (gpu-1) are excluded.

## Output structure

```
docs/measurements/2026-05-19/
  README.md                                         (this file)
  scripts/
    collect_metrics.sh                              sampling loop, 5s interval
    run_idle.sh                                     30-min idle wrapper
    run_stress.sh                                   stress profile wrapper (a|b|c)
    summarise.py                                    CSV -> markdown summary
  idle/
    <hostname>.csv                                  per-host raw samples (5s interval)
    SUMMARY.md                                      cross-host summary (filled by summarise.py)
  stress/
    a-cpu-<hostname>.csv
    b-io-<hostname>.csv
    b-io-<hostname>-control.csv                     fio without agent (Profile B comparison)
    c-mem-<hostname>.csv
    SUMMARY.md                                      cross-host stress summary
  RESOURCE_MEASUREMENT_REPORT_2026-05-19.md         full report (filled in after data lands)
  RESOURCE_MEASUREMENT_MARKETING_BRIEF_2026-05-19.md  one-page marketing-safe extract
```

## Prerequisites per host

- `glassmkr-crucible.service` running on Crucible v0.13.0 (verify with `systemctl status glassmkr-crucible && glassmkr-crucible --version`).
- `python3` (stdlib only; no pip installs needed).
- For Profile A + C: `stress-ng` (`apt install stress-ng` / `dnf install stress-ng`).
- For Profile B: `fio` (`apt install fio` / `dnf install fio`).
- ~2 GB free on `/var/tmp/` for the Profile B fio file.

## Phase 1: Update fleet to v0.13.0

Update each host sequentially in the order documented in the spec §1.1. Per-host:

```bash
# (use whatever upgrade path each host was installed through)
sudo glassmkr-crucible upgrade   # or apt upgrade / docker pull + restart
sudo systemctl restart glassmkr-crucible
systemctl status glassmkr-crucible
glassmkr-crucible --version      # confirm 0.13.0
```

Verify before moving to the next host:
- `systemctl is-active glassmkr-crucible` returns `active`.
- Dashboard "Last seen" timestamp refreshes within the next snapshot interval.
- `journalctl -u glassmkr-crucible --since='-5min' --no-pager | grep -iE 'error|fail'` is empty.

For the host carrying the FAILING DISK alert (Ubuntu 24.04.3 host per the spec): confirm the alert continues to fire post-update (the snapshot still reports the failing drive; the dashboard rule still emits).

## Phase 2: Idle baseline (all 7 hosts)

On each host:

```bash
# Copy the scripts/ directory to the host (rsync, scp, or paste).
# Then:
cd /tmp/glassmkr-measurement
bash scripts/run_idle.sh > idle/$(hostname).csv
```

Each run takes 30 min (default; override with `IDLE_SECONDS=1800` env var). Sampling at 5s -> 360 rows per host.

After all 7 hosts complete, copy CSVs back to `docs/measurements/2026-05-19/idle/<hostname>.csv` and run:

```bash
python3 scripts/summarise.py idle/ > idle/SUMMARY.md
```

## Phase 3: Stress profiles (3 selected hosts)

Per spec §3, run the three profiles on these 3 hosts: `glassmkr-val-supermicro-x12qch`, `glassmkr-val-gigabyte-mc12le`, `glassmkr-val-asus-z12pp`.

Per host, per profile:

```bash
# Profile A: CPU saturation
bash scripts/run_stress.sh a > stress/a-cpu-$(hostname).csv
# Profile B: I/O saturation (also runs a separate 10-min control without agent)
bash scripts/run_stress.sh b > stress/b-io-$(hostname).csv
# Profile C: Memory pressure
bash scripts/run_stress.sh c > stress/c-mem-$(hostname).csv
```

Each profile takes 10 min (default; override with `STRESS_SECONDS=600`).

The Profile B control run is invoked automatically by `run_stress.sh b` and writes `stress/b-io-<hostname>-control.csv`. The control briefly stops the agent (`systemctl stop glassmkr-crucible`), runs fio for 10 min, then restarts the agent — make sure this is acceptable (no operator-set mutes will be lost; just a measurement window where the host doesn't ingest).

After all 3 hosts × 3 profiles complete, copy CSVs back and:

```bash
python3 scripts/summarise.py stress/ > stress/SUMMARY.md
```

## Phase 4: Fill in the report + marketing brief

`RESOURCE_MEASUREMENT_REPORT_2026-05-19.md` and `RESOURCE_MEASUREMENT_MARKETING_BRIEF_2026-05-19.md` ship with explicit `TODO:` markers next to every number that needs filling. Walk through them once `idle/SUMMARY.md` and `stress/SUMMARY.md` are in place.

## Phase 5: Commit + PR

Single PR with all artifacts under `docs/measurements/2026-05-19/`. Per spec §5, PR title: `chore: Crucible v0.13.0 resource measurement campaign across validation fleet`.

## Honest caveats applied during measurement

- Validation fleet ≠ customer fleet; document this in the report's caveats section (already noted in the skeleton).
- 30-min idle + 10-min stress windows; diurnal variance is uncaptured.
- All hosts in the same data centre; remote/edge deployments may differ.
- GPU collector excluded; gpu-1 is a separate measurement workstream.
