# Feasibility: running Crucible under a systemd timer (oneshot) instead of the daemon

Assessment only; no code changed. Repo state: branch `oss-v1-sprint`, v0.15.1.

## How the daemon works today

- `src/index.ts:498-514`: single-flight loop; `runLoop()` awaits `collect()`, then re-arms `setTimeout` with `max(0, intervalMs - elapsed)` for a fixed start-to-start cadence. No jitter anywhere in the codebase. Interval: `config.collection.interval_seconds`, default 300s, clamped 60..3600 (`src/config.ts:66`).
- The cadence math exists specifically so the period never becomes `collect + interval`, which "can exceed the dashboard's 2x-interval unreachable threshold and false-fire server_unreachable" (`src/index.ts:490-497`). A naive `OnUnitActiveSec=` timer reintroduces exactly that period, plus systemd's default `AccuracySec=1min` wobble.
- Unit written by `src/init.ts:141-193`: `Type=simple`, `Restart=always`, `RestartSec=10`, `User=` unprivileged, `ProtectHome=read-only`, `PrivateTmp`, `ProtectControlGroups`, `ProtectSystem=strict`, `ReadWritePaths=-/var/lib/glassmkr -/var/lib/crucible`. `LockPersonality`/`ProtectKernelTunables` are deliberately omitted (`src/init.ts:156-159`): they imply `NoNewPrivileges=yes`, which broke the setuid sudo wrapper on classic-sudo distros. Any timer-mode unit must copy the hardening block verbatim, not "improve" it.

## What state lives only in process memory (lost per timer run)

Every timer run is a "first cycle". Cross-cycle state, per field:

1. `src/collect/io-latency.ts:28` `previousCounters` (per-device /proc/diskstats). Loss: `avg_read/write_latency_ms` always null, `read_iops`/`write_iops` always 0 (these are interval deltas by contract, lines 7-17). The dashboard `disk_latency_high` rule goes permanently blind.
2. `src/collect/network.ts:24` `previousCounters`. Loss: rx/tx error, drop, CRC, frame, length, carrier deltas all 0 every cycle (lines 135-144); NIC-error rules never fire. (Throughput is unaffected: `rx_bytes_sec` is a within-cycle 1s two-sample.)
3. `src/collect/vmstat.ts:23` `previous`. Loss: `pswpin_rate`/`pswpout_rate` always null; swap-thrash detection dead.
4. `src/collect/tcp-stats.ts:49` `previous`. Loss: `retrans_ratio`, `retrans_rate_per_sec`, listen overflow/drop rates always null.
5. `src/collect/conntrack.ts:28` and `src/collect/softnet.ts:37`: `RateTracker` instances (`src/lib/rate.ts:32-56`). Loss: insert_failed/drop and softnet drop rates always null.
6. `src/index.ts:271-272` `lastSecurityResult`/`lastSecurityAt`: the stale-data fallback on a security collection error disappears.
7. `src/collect/security.ts:76-83` `pendingUpdatesCache` (1h TTL). Loss: the expensive apt/dnf pending-updates probe runs EVERY 5 minutes instead of hourly.
8. `src/lib/version-check.ts:11-12` `lastCheckTime` (6h). Loss: a dashboard `/api/v1/version` fetch every run instead of 4x/day.
9. `src/index.ts:212-234`: `cachedDmi` (once at startup; cheap to re-read) and `ipmiCapability` + `ipmiCheckCounter` (re-probe every 12 cycles): re-detected every run; correct but spawns extra subprocesses per cycle.
10. `src/lib/availability.ts:14-15` `lastErrorLogAt` (5-min error-log throttle): journal noise only.

Already safe on disk: alert dedupe/notify state is persisted at `/var/lib/glassmkr/alert-state.json` (`src/alerts/state.ts:19`, loaded at import line 117, saved each cycle line 168), so Slack/Telegram/email notifications would NOT re-fire per run. The planned-reboot marker (`/var/lib/crucible/reboot-expected`) is consume-once at startup and works identically. GPU counters carry no cross-cycle agent state: the epoch model (`src/lib/gpu-epoch.ts`) deliberately puts the comparison server-side ("The agent's job is only to emit the epoch key beside every counter", lines 22-23); `collect/gpu.ts` holds no `previous` map. CPU percent is a within-cycle 1s two-sample (`src/collect/cpu.ts:55-58`).

## Network failure behaviour

Today: one push attempt per cycle, 10s timeout, no queue, no backoff; on failure the snapshot is dropped and the log says "will retry next cycle", meaning the NEXT snapshot, not this one (`src/push/dashboard.ts:163, 188-191`). Timer mode is behaviourally identical here; no regression and no improvement. Two timer-specific wrinkles: the dashboard throttles to one snapshot per server per 55s (handled 429 path, lines 169-179), so `Persistent=true` catch-up bursts after downtime must be avoided or spaced; and local alert evaluation/notification keeps working offline in both modes because alert state is on disk.

## (a) What breaks or degrades under oneshot-timer mode

- Broken outright without new persistence: all interval-delta telemetry in items 1-5 above; roughly 6 collectors and every dashboard rule that reads them (disk latency/saturation, NIC errors, swap thrash, TCP retrans, conntrack pressure, softnet drops) degrade to permanent first-cycle output.
- Broken if enabled: the Prometheus scrape server (`src/metrics-server.ts`, default off, `src/config.ts:95-99`) needs a live process; timer mode cannot serve it.
- Degraded: cadence guarantees (server_unreachable false-fire risk unless `OnCalendar` + tight `AccuracySec` is used); security stale-fallback; per-run cost of the pending-updates probe, version check, DMI read, IPMI capability probe, and privileged-wrapper self-check (`src/index.ts:183-185`, whose journal line is documented as the authoritative sandbox canary in the persistent unit).
- Unit rewrite: `Type=oneshot` + a `.timer`, drop `Restart=always`; the NNP-sensitive hardening set must be carried over unchanged (history: three shipped fixes around checked-vs-executed mismatches; treat `src/init.ts` as sensitive).

## (b) Disk persistence needed to close the gaps, and invasiveness

A boot-scoped baseline store, e.g. `/var/lib/glassmkr/counter-baselines.json`, written atomically (the exact pattern already exists in `saveAlertStateFile`, `src/alerts/state.ts:74-102`):

- Serialize/restore for `RateTracker` (one small addition in `src/lib/rate.ts`) plus the four bespoke `previous` holders (io-latency, network, vmstat, tcp-stats): roughly 6 modules touched plus one new shared helper. Moderate, not trivial.
- Correctness trap: baselines MUST be keyed by `/proc/sys/kernel/random/boot_id`. In daemon mode a reboot kills the baselines with the process; a persisted baseline surviving a reboot meets near-zero counters, and `io-latency.ts` `delta()` (line 63-66) returns `current` on wrap, fabricating a huge interval count. Without boot scoping, timer mode invents phantom IOPS after every reboot.
- Also persist `pendingUpdatesCache` timestamp+result and `lastCheckTime` (small), or accept the per-run cost. Elapsed-time handling is free: baselines carry `capturedAtMs`, so rates stay correct across uneven gaps.

Estimate: 300-500 lines including tests, plus fixture-first guard tests per the round-5 lesson. The dashboard side needs nothing.

## (c) Footprint benefit actually gained

Measured daemon RSS: median ~91 MB, fleet range 65-103 MB, ~0% CPU, 11 threads (docs/measurements/2026-05-19/RESOURCE_MEASUREMENT_REPORT_2026-05-19.md). Timer mode trades that for: near-zero memory between runs, but a full Node cold start every 5 minutes (V8 init + importing the 2.7 MB dist, order 200-400 ms CPU), plus re-running startup probes, plus (without cache persistence) an apt/dnf pending-updates walk per cycle that today runs hourly. Net: save ~90 MB of mostly-idle RSS on machines whose whole point is 64 GB-2 TB of RAM (0.14% of a 64 GB box), while total CPU and fork churn go UP. The daemon is already the cheaper design on this hardware class; the benefit is real only for very small self-hosted VPS installs.

## (d) Recommendation

Not for v1.x; plausible "later", never as the default. The memory saved is negligible on the target hardware; the cost is a cross-cutting persistence layer with a genuine correctness trap (boot-scoped baselines), a unit rewrite in the most historically fragile file in the repo (`src/init.ts` hardening + NNP interaction), re-derivation of the cadence engineering that already fixed server_unreachable false fires, loss of the Prometheus mode, and higher per-run CPU. If OSS users ask for a low-footprint mode (e.g. awesome-selfhosted crowd on 1 GB VPSes), ship it later as an explicit opt-in `--oneshot` mode gated on the baseline store landing first, with `OnCalendar` + `AccuracySec=1s` and `Persistent=false` in the timer, and keep the daemon the documented default.
