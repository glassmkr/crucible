// Tests for the interface flap-counter slice of the network collector
// (collectCarrierFlaps). collectd parity close (connectivity, partial)
// 2026-08-24.
//
// Fixture-root pattern: the helper takes a /sys/class/net-shaped root.
// Known-bad cases FIRST (round-5 lesson): missing file, malformed value,
// first-cycle null delta, counter reset.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectCarrierFlaps } from "../network.js";

let root: string;

async function writeIface(name: string, files: Record<string, string>): Promise<void> {
  const dir = join(root, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) {
    await fs.writeFile(join(dir, k), v);
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "net-flaps-test-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("collectCarrierFlaps: capability gate (absent means not-exposed)", () => {
  it("returns null when carrier_changes does not exist (old kernel)", async () => {
    await writeIface("eth0", { operstate: "up\n" });
    expect(collectCarrierFlaps("eth0", undefined, root)).toBeNull();
  });

  it("returns null when the value is malformed, never a fabricated 0", async () => {
    await writeIface("eth0", { carrier_changes: "garbage\n" });
    expect(collectCarrierFlaps("eth0", undefined, root)).toBeNull();
  });
});

describe("collectCarrierFlaps: raw counter + interval delta", () => {
  it("first cycle: raw counter present, delta null (no baseline, never 0)", async () => {
    await writeIface("eth0", { carrier_changes: "4\n" });
    const r = collectCarrierFlaps("eth0", undefined, root);
    expect(r).toEqual({ carrier_changes: 4, carrier_changes_delta: null });
  });

  it("subsequent cycle: delta = flaps since the last snapshot", async () => {
    await writeIface("eth0", { carrier_changes: "6\n" });
    const r = collectCarrierFlaps("eth0", 4, root);
    expect(r!.carrier_changes).toBe(6);
    expect(r!.carrier_changes_delta).toBe(2);
  });

  it("a stable link reports delta 0 (an answer, distinct from null)", async () => {
    await writeIface("eth0", { carrier_changes: "4\n" });
    const r = collectCarrierFlaps("eth0", 4, root);
    expect(r!.carrier_changes_delta).toBe(0);
  });

  it("counter reset (driver reload): delta falls back to the current value", async () => {
    // Matches network.ts's established wrap convention: current < prev
    // means reset, use current as the delta.
    await writeIface("eth0", { carrier_changes: "3\n" });
    const r = collectCarrierFlaps("eth0", 10, root);
    expect(r!.carrier_changes_delta).toBe(3);
  });

  it("includes carrier_up_count/carrier_down_count where present", async () => {
    await writeIface("eth0", {
      carrier_changes: "5\n",
      carrier_up_count: "3\n",
      carrier_down_count: "2\n",
    });
    const r = collectCarrierFlaps("eth0", undefined, root);
    expect(r!.carrier_up_count).toBe(3);
    expect(r!.carrier_down_count).toBe(2);
  });

  it("omits up/down counts when the kernel does not expose them", async () => {
    await writeIface("eth0", { carrier_changes: "5\n" });
    const r = collectCarrierFlaps("eth0", undefined, root);
    expect(r).not.toBeNull();
    expect("carrier_up_count" in r!).toBe(false);
    expect("carrier_down_count" in r!).toBe(false);
  });
});
