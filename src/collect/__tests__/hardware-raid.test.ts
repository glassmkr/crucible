import { describe, it, expect } from "vitest";
import { parseMegaraidJson } from "../hardware-raid.js";

// Field names (EID:Slt, DID, DG, Med, Intf, Model, State, DG/VD, TYPE) are
// verified against live `storcli /c0 show all J` captures from the validation
// fleet on 2026-09-02: a LSI 9364-8i (SATA RAID10) and a tri-mode 9560-16i
// (NVMe RAID1). storcli and perccli share this schema.

// A degraded 9364-8i: RAID10 Dgrd, member 4:3 offlined (Grok's e4/s3 case).
const DEGRADED_9364 = JSON.stringify({
  Controllers: [
    {
      "Command Status": { Controller: 0, Status: "Success" },
      "Response Data": {
        Status: { "Controller Status": "Needs Attention" },
        "VD LIST": [
          { "DG/VD": "0/0", TYPE: "RAID10", State: "Dgrd", Access: "RW", Size: "32.741 TB", Name: "" },
        ],
        "PD LIST": [
          { "EID:Slt": "4:0", DID: 0, State: "Onln", DG: 0, Size: "16.370 TB", Intf: "SATA", Med: "HDD", Model: "WDC  WUH721818ALE6L4" },
          { "EID:Slt": "4:1", DID: 2, State: "Onln", DG: 0, Size: "16.370 TB", Intf: "SATA", Med: "HDD", Model: "WDC  WUH721818ALE6L4" },
          { "EID:Slt": "4:2", DID: 1, State: "Onln", DG: 0, Size: "16.370 TB", Intf: "SATA", Med: "HDD", Model: "WDC  WUH721818ALE6L4" },
          { "EID:Slt": "4:3", DID: 3, State: "Offln", DG: 0, Size: "16.370 TB", Intf: "SATA", Med: "HDD", Model: "WDC  WUH721818ALE6L4" },
        ],
      },
    },
  ],
});

// A healthy 9560-16i: RAID1 of two Intel NVMe SSDs, both online.
const HEALTHY_9560 = JSON.stringify({
  Controllers: [
    {
      "Command Status": { Controller: 0, Status: "Success" },
      "Response Data": {
        Status: { "Controller Status": "Optimal" },
        "VD LIST": [
          { "DG/VD": "0/239", TYPE: "RAID1", State: "Optl", Access: "RW", Size: "3.492 TB", Name: "" },
        ],
        "PD LIST": [
          { "EID:Slt": "252:4", DID: 1, State: "Onln", DG: 0, Size: "3.492 TB", Intf: "NVMe", Med: "SSD", Model: "INTEL SSDPF2KX038XZ                     " },
          { "EID:Slt": "252:6", DID: 0, State: "Onln", DG: 0, Size: "3.492 TB", Intf: "NVMe", Med: "SSD", Model: "INTEL SSDPF2KX038XZ                     " },
        ],
      },
    },
  ],
});

describe("parseMegaraidJson", () => {
  it("names the offlined physical drive and degraded array (Grok H-D5)", () => {
    const [ctrl] = parseMegaraidJson(DEGRADED_9364, "lsi");
    expect(ctrl.vendor).toBe("lsi");
    expect(ctrl.controller_id).toBe("0");
    expect(ctrl.state).toBe("Needs Attention");

    // The whole point of the fix: name the member, not just the controller.
    expect(ctrl.degraded_disks).toBe(1);
    expect(ctrl.degraded_drives).toHaveLength(1);
    const pd = ctrl.degraded_drives![0];
    expect(pd.enclosure_slot).toBe("4:3");
    expect(pd.state).toBe("Offln");
    expect(pd.device_id).toBe(3);
    expect(pd.drive_group).toBe(0);
    expect(pd.media).toBe("HDD");
    expect(pd.interface).toBe("SATA");
    // Internal double-space in the vendor model is collapsed.
    expect(pd.model).toBe("WDC WUH721818ALE6L4");

    // The degraded array is identified too.
    expect(ctrl.virtual_drives).toHaveLength(1);
    expect(ctrl.virtual_drives![0]).toMatchObject({
      id: "0/0",
      raid_level: "RAID10",
      state: "Dgrd",
      degraded: true,
    });

    // raw_summary carries a human locator.
    expect(ctrl.raw_summary).toContain("4:3");
    expect(ctrl.raw_summary).toContain("Dgrd");
  });

  it("reports a healthy controller with no degraded drives and null summary", () => {
    const [ctrl] = parseMegaraidJson(HEALTHY_9560, "lsi");
    expect(ctrl.state).toBe("Optimal");
    expect(ctrl.degraded_disks).toBe(0);
    expect(ctrl.degraded_drives).toEqual([]);
    expect(ctrl.virtual_drives![0].degraded).toBe(false);
    expect(ctrl.raw_summary).toBeNull();
  });

  it("tags perccli output as vendor dell (shared schema)", () => {
    const [ctrl] = parseMegaraidJson(HEALTHY_9560, "dell");
    expect(ctrl.vendor).toBe("dell");
  });

  it("surfaces an unfamiliar non-healthy PD state (allowlist, not denylist)", () => {
    const raw = JSON.stringify({
      Controllers: [
        {
          "Command Status": { Controller: 0 },
          "Response Data": {
            Status: { "Controller Status": "Needs Attention" },
            "VD LIST": [{ "DG/VD": "0/0", TYPE: "RAID5", State: "Pdgd" }],
            "PD LIST": [
              { "EID:Slt": "8:2", DID: 5, State: "Rbld", DG: 0, Med: "SSD", Model: "SAMSUNG MZ" },
              { "EID:Slt": "8:3", DID: 6, State: "Onln", DG: 0, Med: "SSD", Model: "SAMSUNG MZ" },
            ],
          },
        },
      ],
    });
    const [ctrl] = parseMegaraidJson(raw, "lsi");
    expect(ctrl.degraded_disks).toBe(1);
    expect(ctrl.degraded_drives![0].enclosure_slot).toBe("8:2");
    expect(ctrl.degraded_drives![0].state).toBe("Rbld");
  });

  it("returns [] on non-JSON output", () => {
    expect(parseMegaraidJson("Controller = 0\nStatus = Optimal", "lsi")).toEqual([]);
  });

  it("returns [] when there are no controllers", () => {
    expect(parseMegaraidJson(JSON.stringify({ Controllers: [] }), "lsi")).toEqual([]);
  });

  it("reports null degraded_disks when a controller has no PD LIST", () => {
    const raw = JSON.stringify({
      Controllers: [
        {
          "Command Status": { Controller: 0 },
          "Response Data": { Status: { "Controller Status": "Optimal" } },
        },
      ],
    });
    const [ctrl] = parseMegaraidJson(raw, "lsi");
    expect(ctrl.degraded_disks).toBeNull();
    expect(ctrl.degraded_drives).toEqual([]);
    expect(ctrl.virtual_drives).toEqual([]);
  });
});
