import { describe, it, expect, beforeEach } from "vitest";
import { RateTracker } from "../rate.js";

describe("RateTracker.computeRate", () => {
  let r: RateTracker;
  beforeEach(() => {
    r = new RateTracker();
  });

  it("returns null on the first observation of a key (no baseline)", () => {
    expect(r.computeRate("c", 100, 1000)).toBeNull();
  });

  it("computes per-second rate from a normal positive delta", () => {
    expect(r.computeRate("c", 100, 1000)).toBeNull(); // baseline
    // +50 counts over 2 seconds = 25/s
    expect(r.computeRate("c", 150, 3000)).toBe(25);
  });

  it("computes a fractional rate", () => {
    r.computeRate("c", 0, 0);
    // +1 over 0.5s = 2/s
    expect(r.computeRate("c", 1, 500)).toBe(2);
  });

  it("returns 0 for a zero delta over a positive interval", () => {
    r.computeRate("c", 100, 1000);
    expect(r.computeRate("c", 100, 2000)).toBe(0);
  });

  it("returns null and rebaselines on a counter reset (negative delta)", () => {
    r.computeRate("c", 100, 1000);
    // Counter went backwards (reboot / rollover): null this tick.
    expect(r.computeRate("c", 10, 2000)).toBeNull();
    // ...and the baseline is now the post-reset value, so the next tick
    // rates against 10, not 100. +20 over 1s = 20/s.
    expect(r.computeRate("c", 30, 3000)).toBe(20);
  });

  it("returns null for a zero elapsed interval but still rebaselines the value", () => {
    r.computeRate("c", 100, 1000);
    // Same instant: elapsedSec == 0 -> null (no divide).
    expect(r.computeRate("c", 200, 1000)).toBeNull();
    // Baseline value advanced to 200 at t=1000; next tick rates against
    // 200. +50 over 1s = 50/s.
    expect(r.computeRate("c", 250, 2000)).toBe(50);
  });

  it("returns null for a negative elapsed interval (clock went backwards)", () => {
    r.computeRate("c", 100, 2000);
    expect(r.computeRate("c", 200, 1000)).toBeNull();
  });

  it("tracks multiple keys independently", () => {
    r.computeRate("a", 100, 1000);
    r.computeRate("b", 200, 1000);
    // a: +10/1s = 10; b: +40/1s = 40. Same nowMs (callers share one
    // capture instant for counters that must advance together).
    expect(r.computeRate("a", 110, 2000)).toBe(10);
    expect(r.computeRate("b", 240, 2000)).toBe(40);
  });

  it("does not let one key's reset affect another key", () => {
    r.computeRate("a", 100, 1000);
    r.computeRate("b", 100, 1000);
    expect(r.computeRate("a", 50, 2000)).toBeNull(); // a reset
    expect(r.computeRate("b", 150, 2000)).toBe(50); // b unaffected
  });

  it("reset() drops all baselines so the next call is treated as first", () => {
    r.computeRate("c", 100, 1000);
    r.reset();
    expect(r.computeRate("c", 150, 2000)).toBeNull();
    // And tracking resumes from the new baseline.
    expect(r.computeRate("c", 200, 3000)).toBe(50);
  });
});
