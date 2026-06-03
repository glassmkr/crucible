// Shared cumulative-counter -> per-second-rate state machine.
//
// Several collectors read a monotonically increasing /proc counter and
// report its per-second rate of change across snapshot intervals. They
// all duplicated the same bookkeeping: hold the previous value + capture
// time, return null on the first snapshot (no baseline to delta against)
// and after a counter reset (negative delta = host reboot / rollover),
// and guard against a zero/negative elapsed interval. This centralizes
// that logic so each collector keeps only its own parse + output shape.
//
// Semantics (must match the inline versions this replaced, byte for
// byte):
//   - First observation of a key: returns null, stores the baseline.
//   - elapsedSec = (nowMs - prevCapturedAtMs) / 1000. Rate is only
//     computed when elapsedSec > 0; otherwise null.
//   - delta = value - prevValue. Rate is only computed when delta >= 0;
//     a negative delta (counter reset / wraparound) returns null.
//   - On EVERY call after the first, the stored baseline is replaced
//     with {value, capturedAtMs: nowMs} regardless of whether a rate was
//     produced (so a reset tick rebaselines and the next tick can rate
//     again).
//
// Callers tracking multiple counters that must share one capture instant
// (so their baselines advance together) capture nowMs once and pass the
// same value to each computeRate call.

interface Baseline {
  value: number;
  capturedAtMs: number;
}

export class RateTracker {
  private readonly previous = new Map<string, Baseline>();

  /**
   * Record `value` for `key` at `nowMs` and return the per-second rate
   * since the previous observation, or null on the first observation,
   * after a counter reset (negative delta), or for a non-positive
   * elapsed interval. The baseline is always updated.
   */
  computeRate(key: string, value: number, nowMs: number): number | null {
    const prev = this.previous.get(key);
    this.previous.set(key, { value, capturedAtMs: nowMs });
    if (!prev) return null;
    const elapsedSec = (nowMs - prev.capturedAtMs) / 1000;
    if (elapsedSec <= 0) return null;
    const delta = value - prev.value;
    if (delta < 0) return null;
    return delta / elapsedSec;
  }

  /** Drop all stored baselines (test hook + reset-on-counter-source-loss). */
  reset(): void {
    this.previous.clear();
  }
}
