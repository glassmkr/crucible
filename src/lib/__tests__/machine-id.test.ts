import { describe, it, expect } from "vitest";
import { readMachineId } from "../machine-id.js";

const GOOD_UUID = "4c4c4544-0042-3010-8058-b4c04f584a33";
const GOOD_MACHINE_ID = "9f3c2b1a4d5e6f708192a3b4c5d6e7f8";

// Build a fake readFileSync from a path->content map; unknown paths throw
// ENOENT like the real fs.
function reader(files: Record<string, string>): (p: string) => string {
  return (p: string) => {
    if (p in files) return files[p];
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  };
}

describe("readMachineId", () => {
  it("prefers a valid DMI product_uuid", () => {
    const r = readMachineId(reader({
      "/sys/class/dmi/id/product_uuid": GOOD_UUID + "\n",
      "/etc/machine-id": GOOD_MACHINE_ID + "\n",
    }));
    expect(r).toEqual({ id: GOOD_UUID, source: "product_uuid" });
  });

  it("falls back to /etc/machine-id when product_uuid is unreadable", () => {
    const r = readMachineId(reader({ "/etc/machine-id": GOOD_MACHINE_ID + "\n" }));
    expect(r).toEqual({ id: GOOD_MACHINE_ID, source: "machine_id" });
  });

  it("rejects a bogus vendor product_uuid and falls back to machine-id", () => {
    const r = readMachineId(reader({
      "/sys/class/dmi/id/product_uuid": "03000200-0400-0500-0006-000700080009\n",
      "/etc/machine-id": GOOD_MACHINE_ID + "\n",
    }));
    expect(r).toEqual({ id: GOOD_MACHINE_ID, source: "machine_id" });
  });

  it("rejects the all-zero product_uuid", () => {
    const r = readMachineId(reader({
      "/sys/class/dmi/id/product_uuid": "00000000-0000-0000-0000-000000000000\n",
      "/etc/machine-id": GOOD_MACHINE_ID + "\n",
    }));
    expect(r?.source).toBe("machine_id");
  });

  it("uses the dbus machine-id as a last resort", () => {
    const r = readMachineId(reader({ "/var/lib/dbus/machine-id": GOOD_MACHINE_ID + "\n" }));
    expect(r).toEqual({ id: GOOD_MACHINE_ID, source: "machine_id" });
  });

  it("returns null when nothing usable is present", () => {
    expect(readMachineId(reader({}))).toBeNull();
  });

  it("normalises case and trims whitespace", () => {
    const r = readMachineId(reader({ "/sys/class/dmi/id/product_uuid": "  " + GOOD_UUID.toUpperCase() + "  \n" }));
    expect(r).toEqual({ id: GOOD_UUID, source: "product_uuid" });
  });
});
