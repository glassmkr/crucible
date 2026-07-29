// Tests for BMC device-node presence detection.
//
// This exists because the IPMI capability reasons cannot express whether a BMC is
// present: the tooling reasons are emitted before any BMC contact, and
// `no_bmc_device` collapses a dead BMC together with a missing wrapper and a
// timeout. Finding #1/#2 of the 2026-07-29 adversarial review.

import { describe, expect, it } from "vitest";
import { findBmcDeviceNode, IPMI_DEVICE_NODES } from "../bmc-presence.js";

describe("findBmcDeviceNode", () => {
  it("returns /dev/ipmi0 when present, the overwhelmingly common case", () => {
    expect(findBmcDeviceNode({ exists: (p) => p === "/dev/ipmi0" })).toBe("/dev/ipmi0");
  });

  it("falls back to the older node paths", () => {
    expect(findBmcDeviceNode({ exists: (p) => p === "/dev/ipmi/0" })).toBe("/dev/ipmi/0");
    expect(findBmcDeviceNode({ exists: (p) => p === "/dev/ipmidev/0" })).toBe("/dev/ipmidev/0");
  });

  it("prefers the first node in the documented order when several exist", () => {
    // Deterministic output matters: the dashboard shows this path to operators.
    expect(findBmcDeviceNode({ exists: () => true })).toBe(IPMI_DEVICE_NODES[0]);
  });

  it("returns null when no node exists, which means UNDETERMINED not 'no BMC'", () => {
    // The distinction is load-bearing: ipmi_devintf may simply not be loaded, so
    // a caller must never read null as proof the host has no BMC.
    expect(findBmcDeviceNode({ exists: () => false })).toBeNull();
  });

  it("treats an unreadable /dev entry as absent and keeps looking", () => {
    // A throwing stat on one path must not abort the whole snapshot.
    const exists = (p: string) => {
      if (p === "/dev/ipmi0") throw new Error("EACCES");
      return p === "/dev/ipmi/0";
    };
    expect(findBmcDeviceNode({ exists })).toBe("/dev/ipmi/0");
  });

  it("returns null rather than throwing when every path throws", () => {
    expect(findBmcDeviceNode({ exists: () => { throw new Error("EACCES"); } })).toBeNull();
  });
});
