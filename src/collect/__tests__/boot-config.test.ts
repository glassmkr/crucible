// Boot-config integrity parser tests. Fixtures are REAL fleet captures:
// healthy-{alma,rocky,debian,ubuntu}.txt are the 2026-08-30 val boxes (must
// stay silent), and broken-rocky-danger-window.txt is the val-rocky failure
// reconstructed from the postmortem: the box still running the last-good
// kernel while `dnf` has staged the new kernel whose BLS entry + the
// /etc/kernel/cmdline source both carry the DEAD root UUID (9e80229d), the
// exact state that should have paged BEFORE the fatal reboot.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseBootConfig } from "../boot-config.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "boot-config", n), "utf8");

describe("parseBootConfig: healthy fleet captures stay silent", () => {
  for (const box of ["alma", "rocky", "debian", "ubuntu"]) {
    it(`${box}: default entry bootable + matches mounted, no drift`, () => {
      const d = parseBootConfig(fx(`healthy-${box}.txt`));
      expect(d.available).toBe(true);
      expect(d.mounted_root?.uuid).toBeTruthy();
      // Ground truth established, every entry's root resolves to a present fs.
      expect(d.entries.length).toBeGreaterThan(0);
      expect(d.unbootable_entry_count).toBe(0);
      // The default/selected entry can find root, and it is the mounted one.
      expect(d.default_entry_bootable).not.toBe(false);
      expect(d.default_entry_wrong_fs).not.toBe(true);
      expect(d.source_regressed).not.toBe(true);
    });
  }

  it("identifies a default entry on RHEL (grubenv saved_entry)", () => {
    const d = parseBootConfig(fx("healthy-rocky.txt"));
    expect(d.entries.some((e) => e.is_default)).toBe(true);
    expect(d.default_entry_bootable).toBe(true);
  });

  it("identifies a default entry on Debian (GRUB_DEFAULT=0 -> first menuentry)", () => {
    const d = parseBootConfig(fx("healthy-debian.txt"));
    expect(d.entries.every((e) => e.source === "grub.cfg")).toBe(true);
    const def = d.entries.find((e) => e.is_default);
    expect(def).toBeTruthy();
    expect(def!.resolvable).toBe(true);
    expect(def!.matches_mounted).toBe(true);
  });

  it("parses the RHEL cmdline source and finds it consistent", () => {
    const d = parseBootConfig(fx("healthy-alma.txt"));
    expect(d.cmdline_source?.path).toBe("/etc/kernel/cmdline");
    expect(d.cmdline_source?.resolvable).toBe(true);
    expect(d.cmdline_source?.matches_mounted).toBe(true);
  });
});

describe("parseBootConfig: val-rocky danger window fires CRITICAL", () => {
  const d = parseBootConfig(fx("broken-rocky-danger-window.txt"));

  it("ground truth is still healthy (box is up on the last-good kernel)", () => {
    expect(d.available).toBe(true);
    expect(d.mounted_root?.uuid).toBe("01950b15-603a-4685-8c00-03ad5b22618f");
  });

  it("the default (saved) entry cannot find its root filesystem", () => {
    const def = d.entries.find((e) => e.is_default);
    expect(def).toBeTruthy();
    expect(def!.kernel).toContain("687.42.1");
    expect(def!.root_spec).toBe("UUID=9e80229d-48ee-4412-ae76-c18439c52af8");
    expect(def!.resolvable).toBe(false);
    // THE critical signal: next boot target has no root fs.
    expect(d.default_entry_bootable).toBe(false);
  });

  it("the poisoned kernel-cmdline source is flagged as regressed", () => {
    expect(d.source_regressed).toBe(true);
  });

  it("counts the unbootable entries (new kernel + its rescue)", () => {
    expect(d.unbootable_entry_count).toBe(2);
  });

  it("the last-good kernel entry is still bootable (not a blanket failure)", () => {
    const good = d.entries.find((e) => e.kernel?.includes("687.41.1"));
    expect(good?.resolvable).toBe(true);
    expect(good?.matches_mounted).toBe(true);
  });
});

describe("parseBootConfig: synthesized drift + unavailable cases", () => {
  it("source_regressed fires when /etc/kernel/cmdline points at a present-but-wrong fs", () => {
    // Take healthy alma and repoint ONLY the cmdline source at the ESP UUID
    // (present, but not the root). Default entry still fine -> WARNING not CRIT.
    const raw = fx("healthy-alma.txt").replace(
      /(===FILE:\/etc\/kernel\/cmdline:present===\nroot=UUID=)4668459a-fcdf-4e3e-8f76-58952370e82d/,
      "$196C7-63E5",
    );
    const d = parseBootConfig(raw);
    expect(d.default_entry_bootable).toBe(true); // boots today
    expect(d.source_regressed).toBe(true); // but the next kernel would regress
  });

  it("available:false when blkid failed (never fire on missing data)", () => {
    const raw = "===MOUNTED_ROOT===\n/dev/md127\n===BLKID===\nBLKID_FAILED\n===BOOT_LS===\n";
    const d = parseBootConfig(raw);
    expect(d.available).toBe(false);
    expect(d.default_entry_bootable).toBeNull();
  });

  it("available:false when the mounted root has no resolvable fs UUID", () => {
    const raw =
      "===MOUNTED_ROOT===\n/dev/md99\n===BLKID===\nDEVNAME=/dev/md127\nUUID=aaaa\nTYPE=xfs\n\n===BOOT_LS===\n";
    const d = parseBootConfig(raw);
    expect(d.available).toBe(false);
  });

  it("a raid-member partition UUID never satisfies a root reference", () => {
    // md127 is the fs; sda2 is a linux_raid_member carrying the ARRAY uuid.
    // A boot entry pointing root at the array-member uuid must be unbootable.
    const raw = [
      "===MOUNTED_ROOT===",
      "/dev/md127",
      "===BLKID===",
      "DEVNAME=/dev/md127",
      "UUID=1111-fs",
      "LABEL=root",
      "TYPE=xfs",
      "",
      "DEVNAME=/dev/sda2",
      "UUID=2222-array",
      "LABEL=host:root",
      "TYPE=linux_raid_member",
      "",
      "===BOOT_LS===",
      "===FILE:/boot/grub2/grubenv:present===",
      "saved_entry=mid-1.0",
      "===FILE:/boot/loader/entries/mid-1.0.conf:present===",
      "title Test 1.0",
      "version 1.0",
      "options root=UUID=2222-array ro",
      "",
    ].join("\n");
    const d = parseBootConfig(raw);
    expect(d.default_entry_bootable).toBe(false);
    expect(d.unbootable_entry_count).toBe(1);
  });
});
