import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectDmi, classifyVendor, formatVendorLine } from "../dmi.js";

let root: string;

async function writeDmi(files: Record<string, string>) {
  await fs.mkdir(root, { recursive: true });
  for (const [k, v] of Object.entries(files)) {
    await fs.writeFile(join(root, k), v);
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "dmi-test-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("classifyVendor", () => {
  it("identifies Dell", () => {
    expect(classifyVendor("Dell Inc.", "PowerEdge R740")).toEqual({ vendor: "dell", is_virtual: false });
  });
  it("identifies HPE", () => {
    expect(classifyVendor("HPE", "ProLiant DL380 Gen10")).toEqual({ vendor: "hpe", is_virtual: false });
    expect(classifyVendor("Hewlett Packard Enterprise", "")).toEqual({ vendor: "hpe", is_virtual: false });
  });
  it("identifies legacy HP ProLiant", () => {
    expect(classifyVendor("HP", "ProLiant DL360 G7")).toEqual({ vendor: "hpe", is_virtual: false });
  });
  it("identifies Supermicro", () => {
    expect(classifyVendor("Supermicro", "Super Server")).toEqual({ vendor: "supermicro", is_virtual: false });
  });
  it("identifies ASRockRack", () => {
    expect(classifyVendor("ASRockRack", "EPYC")).toEqual({ vendor: "asrockrack", is_virtual: false });
  });
  it("identifies Lenovo", () => {
    expect(classifyVendor("LENOVO", "ThinkSystem")).toEqual({ vendor: "lenovo", is_virtual: false });
  });
  it("identifies KVM/QEMU as virtual", () => {
    expect(classifyVendor("QEMU", "Standard PC")).toEqual({ vendor: "virtual", is_virtual: true });
  });
  it("identifies VMware as virtual", () => {
    expect(classifyVendor("VMware, Inc.", "VMware Virtual Platform")).toEqual({ vendor: "virtual", is_virtual: true });
  });
  it("identifies VirtualBox as virtual", () => {
    expect(classifyVendor("innotek GmbH", "VirtualBox")).toEqual({ vendor: "virtual", is_virtual: true });
  });
  it("identifies Hyper-V as virtual via product_name", () => {
    expect(classifyVendor("Microsoft Corporation", "Virtual Machine")).toEqual({ vendor: "virtual", is_virtual: true });
  });
  it("does NOT mark a real Surface as virtual just because of Microsoft sys_vendor", () => {
    expect(classifyVendor("Microsoft Corporation", "Surface Book 2")).toEqual({ vendor: "generic", is_virtual: false });
  });
  it("falls back to generic for unknown vendors", () => {
    expect(classifyVendor("Some Random Vendor", "Some Product")).toEqual({ vendor: "generic", is_virtual: false });
  });
  it("handles missing sys_vendor", () => {
    expect(classifyVendor(null, null)).toEqual({ vendor: "generic", is_virtual: false });
  });
});

describe("collectDmi", () => {
  it("reads Dell PowerEdge fixture", async () => {
    await writeDmi({
      sys_vendor: "Dell Inc.\n",
      product_name: "PowerEdge R740\n",
      bios_version: "2.21.2\n",
      bios_date: "2024-08-15\n",
    });
    const info = await collectDmi(root);
    expect(info.available).toBe(true);
    expect(info.vendor).toBe("dell");
    expect(info.product_name).toBe("PowerEdge R740");
    expect(info.bios_version).toBe("2.21.2");
    expect(info.is_virtual).toBe(false);
  });

  it("returns available:false when nothing exists", async () => {
    const info = await collectDmi(join(root, "nope"));
    expect(info.available).toBe(false);
    expect(info.vendor).toBe("generic");
  });

  it("trims trailing newlines and whitespace", async () => {
    await writeDmi({
      sys_vendor: "Supermicro\n\n",
      product_name: "Super Server  \n",
    });
    const info = await collectDmi(root);
    expect(info.raw_vendor).toBe("Supermicro");
    expect(info.product_name).toBe("Super Server");
  });
});

describe("formatVendorLine", () => {
  it("formats Dell with full metadata", () => {
    const line = formatVendorLine({
      available: true, vendor: "dell", raw_vendor: "Dell Inc.", product_name: "PowerEdge R740",
      bios_version: "2.21.2", bios_date: "2024-08-15", is_virtual: false,
    });
    expect(line).toBe("Vendor: PowerEdge R740 (Dell Inc., BIOS 2.21.2, 2024-08-15)");
  });
  it("formats virtual succinctly", () => {
    const line = formatVendorLine({
      available: true, vendor: "virtual", raw_vendor: "QEMU", product_name: "Standard PC",
      bios_version: null, bios_date: null, is_virtual: true,
    });
    expect(line).toBe("Vendor: virtual (QEMU)");
  });
  it("formats unavailable", () => {
    const line = formatVendorLine({
      available: false, vendor: "generic", raw_vendor: null, product_name: null,
      bios_version: null, bios_date: null, is_virtual: false,
    });
    expect(line).toBe("Vendor: unknown (DMI not available)");
  });
});

describe("classifyVendor: HP edge cases (regression for 0.8.0 medium)", () => {
  it("identifies 'Hewlett-Packard Company' (legacy ProLiant DL3xx Gen8 era)", () => {
    expect(classifyVendor("Hewlett-Packard Company", "ProLiant DL380 G7")).toEqual({ vendor: "hpe", is_virtual: false });
  });
  it("identifies 'Hewlett-Packard' without 'Company' suffix", () => {
    expect(classifyVendor("Hewlett-Packard", "ProLiant")).toEqual({ vendor: "hpe", is_virtual: false });
  });
  it("identifies 'Hewlett Packard' with space (no hyphen)", () => {
    expect(classifyVendor("Hewlett Packard", "ProLiant")).toEqual({ vendor: "hpe", is_virtual: false });
  });
  it("does NOT classify 'HP-UX' as HP (it's an OS, hyphen is non-whitespace)", () => {
    expect(classifyVendor("HP-UX", "Some Product")).toEqual({ vendor: "generic", is_virtual: false });
  });
  it("still identifies 'HP ProLiant DL360' as HP", () => {
    // sys_vendor is rarely this, but the rule should handle the common
    // 'HP <space> something' shape from older firmwares.
    expect(classifyVendor("HP ProLiant DL360", "DL360 G7")).toEqual({ vendor: "hpe", is_virtual: false });
  });
});

describe("classifyVendor: board_vendor fallback (val campaign, asrock)", () => {
  it("falls back to baseboard vendor when sys_vendor is 'To Be Filled By O.E.M.'", () => {
    // The exact asrock case: consumer/OEM board, placeholder sys_vendor,
    // real vendor only in baseboard-manufacturer.
    expect(classifyVendor("To Be Filled By O.E.M.", "X570D4U", "ASRockRack")).toEqual({ vendor: "asrockrack", is_virtual: false });
  });

  it("falls back for other common placeholder strings", () => {
    expect(classifyVendor("Default string", "X11", "Supermicro").vendor).toBe("supermicro");
    expect(classifyVendor("System manufacturer", "Z790", "ASRock").vendor).toBe("asrockrack");
  });

  it("falls back when sys_vendor is simply unrecognized", () => {
    expect(classifyVendor("Acme Whitebox Co", "Model 1", "Dell Inc.").vendor).toBe("dell");
  });

  it("prefers a recognized sys_vendor over board_vendor", () => {
    // A real Dell system with a Dell board: sys_vendor wins, no fallback.
    expect(classifyVendor("Dell Inc.", "PowerEdge R740", "Dell Inc.").vendor).toBe("dell");
  });

  it("stays generic when neither sys_vendor nor board_vendor is recognized", () => {
    expect(classifyVendor("To Be Filled By O.E.M.", "X", "Also Unknown").vendor).toBe("generic");
  });

  it("does not use board_vendor for virtual detection", () => {
    // A hypervisor sys_vendor is authoritative; board_vendor is irrelevant.
    expect(classifyVendor("QEMU", "Standard PC", "Seabios")).toEqual({ vendor: "virtual", is_virtual: true });
  });

  it("backwards-compatible when board_vendor is omitted", () => {
    expect(classifyVendor("To Be Filled By O.E.M.", "X570D4U").vendor).toBe("generic");
  });
});
