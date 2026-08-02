import { describe, it, expect } from "vitest";
import {
  buildEpoch,
  classifyCounter,
  epochIsComplete,
  readBootId,
  sameEpoch,
} from "../gpu-epoch.js";

const base = () =>
  buildEpoch({
    gpuUuid: "GPU-abc",
    pciBdf: "00000000:02:00.0",
    bootId: "boot-1",
    driverVersion: "580.173.02",
    nvmlVersion: "12.580",
    collectorVersion: "0.15.1",
  });

describe("epoch identity", () => {
  it("matches an identical epoch", () => {
    expect(sameEpoch(base(), base())).toBe(true);
  });

  it("is invalidated by every field that can reset a counter", () => {
    for (const [field, value] of [
      ["gpuUuid", "GPU-other"],
      ["pciBdf", "00000000:03:00.0"],
      ["bootId", "boot-2"],
      ["driverVersion", "581.0"],
      ["nvmlVersion", "12.581"],
      ["fabricManagerStartedAt", "2026-08-02T10:00:00Z"],
      ["collectorVersion", "0.16.0"],
    ] as const) {
      const changed = buildEpoch({
        gpuUuid: "GPU-abc",
        pciBdf: "00000000:02:00.0",
        bootId: "boot-1",
        driverVersion: "580.173.02",
        nvmlVersion: "12.580",
        collectorVersion: "0.15.1",
        [field]: value,
      } as any);
      expect(sameEpoch(base(), changed), `${field} must invalidate the epoch`).toBe(false);
    }
  });

  it("never matches against null", () => {
    expect(sameEpoch(base(), null)).toBe(false);
    expect(sameEpoch(null, null)).toBe(false);
  });

  it("requires device identity, boot identity and driver version to be complete", () => {
    expect(epochIsComplete(base())).toBe(true);
    expect(epochIsComplete(buildEpoch({ bootId: "b", driverVersion: "1", collectorVersion: "x" }))).toBe(false);
    expect(epochIsComplete(buildEpoch({ gpuUuid: "g", driverVersion: "1", collectorVersion: "x" }))).toBe(false);
    expect(epochIsComplete(buildEpoch({ gpuUuid: "g", bootId: "b", collectorVersion: "x" }))).toBe(false);
    // PCI BDF alone is an acceptable device anchor when the UUID is unreadable.
    expect(epochIsComplete(buildEpoch({ pciBdf: "p", bootId: "b", driverVersion: "1", collectorVersion: "x" }))).toBe(true);
  });
});

describe("classifyCounter", () => {
  it("returns a real delta when the epoch held and the counter rose", () => {
    const r = classifyCounter({ value: 10, epoch: base() }, { value: 17, epoch: base() });
    expect(r.kind).toBe("delta");
    expect(r.delta).toBe(7);
    expect(r.current).toBe(17);
  });

  it("returns delta 0 for an unchanged counter", () => {
    expect(classifyCounter({ value: 5, epoch: base() }, { value: 5, epoch: base() })).toMatchObject({
      kind: "delta",
      delta: 0,
    });
  });

  it("has no delta on the first sample", () => {
    const r = classifyCounter(null, { value: 3, epoch: base() });
    expect(r.kind).toBe("first_sample");
    expect(r.delta).toBeNull();
    expect(r.current).toBe(3);
  });

  // The whole point. A decrease inside one epoch means something zeroed the counter
  // underneath us. It must never surface as a negative delta and must never be read
  // as the problem having healed.
  it("reports a decrease as reset_observed, NOT as a negative delta or a recovery", () => {
    const r = classifyCounter({ value: 900, epoch: base() }, { value: 2, epoch: base() });
    expect(r.kind).toBe("reset_observed");
    expect(r.delta).toBeNull();
    expect(r.current).toBe(2);
  });

  it("refuses to difference across a driver reload", () => {
    const after = buildEpoch({
      gpuUuid: "GPU-abc",
      pciBdf: "00000000:02:00.0",
      bootId: "boot-1",
      driverVersion: "581.0",
      nvmlVersion: "12.580",
      collectorVersion: "0.15.1",
    });
    const r = classifyCounter({ value: 10, epoch: base() }, { value: 4000, epoch: after });
    expect(r.kind).toBe("unknown_epoch");
    expect(r.delta).toBeNull();
  });

  it("refuses to difference across a reboot even when the counter rose", () => {
    const rebooted = buildEpoch({
      gpuUuid: "GPU-abc",
      pciBdf: "00000000:02:00.0",
      bootId: "boot-2",
      driverVersion: "580.173.02",
      nvmlVersion: "12.580",
      collectorVersion: "0.15.1",
    });
    expect(classifyCounter({ value: 10, epoch: base() }, { value: 11, epoch: rebooted }).kind).toBe(
      "unknown_epoch",
    );
  });

  it("refuses to difference when either epoch is incomplete", () => {
    const partial = buildEpoch({ gpuUuid: "GPU-abc", collectorVersion: "0.15.1" });
    expect(classifyCounter({ value: 1, epoch: partial }, { value: 9, epoch: base() }).kind).toBe("unknown_epoch");
    expect(classifyCounter({ value: 1, epoch: base() }, { value: 9, epoch: partial }).kind).toBe("unknown_epoch");
  });

  it("always keeps the raw current value, whatever the verdict", () => {
    for (const r of [
      classifyCounter(null, { value: 42, epoch: base() }),
      classifyCounter({ value: 99, epoch: base() }, { value: 42, epoch: base() }),
      classifyCounter({ value: 1, epoch: buildEpoch({ collectorVersion: "z" }) }, { value: 42, epoch: base() }),
    ]) {
      expect(r.current).toBe(42);
    }
  });
});

describe("readBootId", () => {
  it("trims the kernel value", () => {
    expect(readBootId(() => "d6a1f0e2-0000-4000-8000-000000000000\n")).toBe(
      "d6a1f0e2-0000-4000-8000-000000000000",
    );
  });

  it("returns null when unreadable or empty, so the epoch is marked incomplete", () => {
    expect(readBootId(() => "")).toBeNull();
    expect(readBootId(() => "   \n")).toBeNull();
  });
});
