#!/usr/bin/env python3
"""Summarise measurement CSVs into a markdown SUMMARY.md.

Reads every *.csv file in the directory passed on argv and emits a
markdown table to stdout with one row per host (idle dir) or per
host+profile (stress dir).

Per-host stats per the spec §2.2:
  - rss_kb:  median, p95, peak
  - cpu_pct: median, p95
  - sample_count, sample_interval_estimate (median delta between
    consecutive ts_iso) so we can sanity-check the 5s spacing
  - fd_count, thread_count: max (to catch leaks)
  - cpu_jiffies_delta_total: utime+stime delta from first to last
    sample (raw cpu-time consumed during the window)
  - io_read_bytes_delta, io_write_bytes_delta: same shape

stdlib only.
"""

from __future__ import annotations

import csv
import math
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


def parse_ts(s: str) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None


def to_float(s: str) -> Optional[float]:
    if s is None or s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def to_int(s: str) -> Optional[int]:
    if s is None or s == "":
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def median(xs: list[float]) -> Optional[float]:
    if not xs:
        return None
    xs = sorted(xs)
    n = len(xs)
    return xs[n // 2] if n % 2 == 1 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def p95(xs: list[float]) -> Optional[float]:
    if not xs:
        return None
    xs = sorted(xs)
    idx = max(0, min(len(xs) - 1, math.ceil(0.95 * len(xs)) - 1))
    return xs[idx]


def fmt(v: Optional[float], unit: str = "", places: int = 1) -> str:
    if v is None:
        return "-"
    if isinstance(v, int) or v == int(v):
        return f"{int(v)}{unit}"
    return f"{v:.{places}f}{unit}"


def classify(name: str) -> tuple[str, str]:
    """Return (profile_label, host) for a stress CSV; else ("idle", host)."""
    m = re.match(r"^([a-c])-(cpu|io|mem)-(.+?)(?:-control)?\.csv$", name)
    if m:
        prof = m.group(1).upper()
        label = m.group(2)
        host = m.group(3)
        if "-control" in name:
            return (f"{prof}-{label}-control", host)
        return (f"{prof}-{label}", host)
    return ("idle", Path(name).stem)


def summarise_one(path: Path) -> dict:
    rss: list[float] = []
    cpu: list[float] = []
    fd: list[int] = []
    threads: list[int] = []
    timestamps: list[datetime] = []
    utime_first: Optional[int] = None
    utime_last: Optional[int] = None
    stime_first: Optional[int] = None
    stime_last: Optional[int] = None
    io_r_first: Optional[int] = None
    io_r_last: Optional[int] = None
    io_w_first: Optional[int] = None
    io_w_last: Optional[int] = None
    rows = 0
    empty_rows = 0

    with path.open() as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows += 1
            if not row.get("pid"):
                empty_rows += 1
                continue
            ts = parse_ts(row.get("ts_iso") or "")
            if ts:
                timestamps.append(ts)
            r = to_float(row.get("rss_kb") or "")
            if r is not None:
                rss.append(r)
            c = to_float(row.get("cpu_pct") or "")
            if c is not None:
                cpu.append(c)
            f_c = to_int(row.get("fd_count") or "")
            if f_c is not None:
                fd.append(f_c)
            t_c = to_int(row.get("thread_count") or "")
            if t_c is not None:
                threads.append(t_c)
            ut = to_int(row.get("cpu_user_jiffies") or "")
            st = to_int(row.get("cpu_sys_jiffies") or "")
            if ut is not None:
                utime_last = ut
                if utime_first is None:
                    utime_first = ut
            if st is not None:
                stime_last = st
                if stime_first is None:
                    stime_first = st
            ior = to_int(row.get("io_read_bytes") or "")
            iow = to_int(row.get("io_write_bytes") or "")
            if ior is not None:
                io_r_last = ior
                if io_r_first is None:
                    io_r_first = ior
            if iow is not None:
                io_w_last = iow
                if io_w_first is None:
                    io_w_first = iow

    interval_est: Optional[float] = None
    if len(timestamps) > 2:
        deltas = [
            (timestamps[i + 1] - timestamps[i]).total_seconds()
            for i in range(len(timestamps) - 1)
        ]
        interval_est = median(deltas)

    window_s: Optional[float] = None
    if len(timestamps) >= 2:
        window_s = (timestamps[-1] - timestamps[0]).total_seconds()

    cpu_jiffies_delta = None
    if utime_first is not None and stime_first is not None and utime_last is not None and stime_last is not None:
        cpu_jiffies_delta = (utime_last - utime_first) + (stime_last - stime_first)

    io_read_delta = None
    if io_r_first is not None and io_r_last is not None:
        io_read_delta = io_r_last - io_r_first
    io_write_delta = None
    if io_w_first is not None and io_w_last is not None:
        io_write_delta = io_w_last - io_w_first

    return {
        "samples_total": rows,
        "samples_empty": empty_rows,
        "interval_s_est": interval_est,
        "window_s": window_s,
        "rss_kb_median": median(rss),
        "rss_kb_p95": p95(rss),
        "rss_kb_peak": max(rss) if rss else None,
        "cpu_pct_median": median(cpu),
        "cpu_pct_p95": p95(cpu),
        "fd_max": max(fd) if fd else None,
        "thread_max": max(threads) if threads else None,
        "cpu_jiffies_delta_total": cpu_jiffies_delta,
        "io_read_bytes_delta": io_read_delta,
        "io_write_bytes_delta": io_write_delta,
    }


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: summarise.py <csv-dir>", file=sys.stderr)
        return 2
    csv_dir = Path(argv[1])
    if not csv_dir.is_dir():
        print(f"not a directory: {csv_dir}", file=sys.stderr)
        return 2

    csvs = sorted(csv_dir.glob("*.csv"))
    if not csvs:
        print(f"no CSVs found in {csv_dir}", file=sys.stderr)
        return 1

    rows = []
    for p in csvs:
        label, host = classify(p.name)
        try:
            stats = summarise_one(p)
        except Exception as e:  # noqa: BLE001
            print(f"[warn] {p}: {e}", file=sys.stderr)
            continue
        rows.append((label, host, stats))

    # Markdown output.
    print(f"# Measurement summary — {csv_dir.name}")
    print()
    print(f"Generated from {len(rows)} CSV file(s) under `{csv_dir}/`.")
    print()
    print("| Label | Host | Samples | Empty | Interval(s) | Window(s) | RSS median (MB) | RSS p95 (MB) | RSS peak (MB) | CPU% median | CPU% p95 | FD max | Threads max | CPU jiffies | IO read (MB) | IO write (MB) |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for label, host, s in sorted(rows):
        rss_mb = lambda kb: kb / 1024 if kb is not None else None  # noqa: E731
        io_mb = lambda b: b / (1024 * 1024) if b is not None else None  # noqa: E731
        print(
            "| {label} | {host} | {n} | {empty} | {iv} | {win} | {rm} | {r95} | {rp} | {cm} | {c95} | {fdm} | {thr} | {jif} | {ior} | {iow} |".format(
                label=label,
                host=host,
                n=s["samples_total"],
                empty=s["samples_empty"],
                iv=fmt(s["interval_s_est"], "", 1),
                win=fmt(s["window_s"], "", 0),
                rm=fmt(rss_mb(s["rss_kb_median"]), "", 1),
                r95=fmt(rss_mb(s["rss_kb_p95"]), "", 1),
                rp=fmt(rss_mb(s["rss_kb_peak"]), "", 1),
                cm=fmt(s["cpu_pct_median"], "", 2),
                c95=fmt(s["cpu_pct_p95"], "", 2),
                fdm=fmt(s["fd_max"], "", 0),
                thr=fmt(s["thread_max"], "", 0),
                jif=fmt(s["cpu_jiffies_delta_total"], "", 0),
                ior=fmt(io_mb(s["io_read_bytes_delta"]), "", 2),
                iow=fmt(io_mb(s["io_write_bytes_delta"]), "", 2),
            )
        )

    print()
    print("Generated by `scripts/summarise.py`.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
