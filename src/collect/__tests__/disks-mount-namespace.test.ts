// Regression guard for the `filesystem_readonly` fleet-wide false positive
// (2026-07-30). Our own unit sets ProtectSystem=strict, which remounts `/`
// READ-ONLY inside the service's mount namespace. The collector read
// /proc/mounts (= /proc/self/mounts) and therefore shipped `ro` for `/` on hosts
// whose root was perfectly writable, raising a CRITICAL on 19 of 21 fleet hosts.
//
// These fixtures are REAL captures, not invented: taken from
// crucible-val-hdd-destroy-1 on 2026-07-30, where the host table said `rw` and
// the agent's own namespace said `ro` for the same device.

import { describe, it, expect } from "vitest";
import { parseMounts } from "../disks.js";

const HOST_TABLE = [
  "/dev/sdb2 / ext4 rw,relatime,discard,errors=remount-ro 0 0",
  "/dev/sdb1 /boot/efi vfat rw,relatime,fmask=0022 0 0",
].join("\n");

// Identical, except every real filesystem reads `ro`, which is what
// ProtectSystem=strict does to the service's view.
const SANDBOXED_TABLE = [
  "/dev/sdb2 / ext4 ro,relatime,discard,errors=remount-ro 0 0",
  "/dev/sdb1 /boot/efi vfat ro,relatime,fmask=0022 0 0",
].join("\n");

function reader(map: Record<string, string | null>) {
  return (p: string) => (p in map ? map[p] : null);
}

describe("parseMounts: host namespace preference", () => {
  it("reports the HOST as rw even when our own namespace says ro", () => {
    // THE BUG, in one assertion. Both tables are present, exactly as on a real
    // sandboxed host; the collector must not believe its own namespace.
    const { mounts, fromHostNamespace } = parseMounts(
      reader({ "/proc/1/mounts": HOST_TABLE, "/proc/mounts": SANDBOXED_TABLE }),
    );
    const root = mounts.find((m) => m.mount === "/");
    expect(root?.options).toContain("rw");
    expect(root?.options).not.toMatch(/(^|,)ro(,|$)/);
    expect(fromHostNamespace).toBe(true);
  });

  it("reads /proc/1/mounts, not /proc/mounts, when both are readable", () => {
    const seen: string[] = [];
    parseMounts((p) => {
      seen.push(p);
      return p === "/proc/1/mounts" ? HOST_TABLE : SANDBOXED_TABLE;
    });
    expect(seen[0]).toBe("/proc/1/mounts");
  });

  it("still reports a GENUINE read-only root, so the fix does not mute the rule", () => {
    // The fix must not become "never report ro". A truly read-only host has ro in
    // the HOST table too.
    const genuinelyRo = "/dev/sdb2 / ext4 ro,relatime,errors=remount-ro 0 0";
    const { mounts, fromHostNamespace } = parseMounts(
      reader({ "/proc/1/mounts": genuinelyRo, "/proc/mounts": genuinelyRo }),
    );
    expect(mounts.find((m) => m.mount === "/")?.options).toMatch(/(^|,)ro(,|$)/);
    expect(fromHostNamespace).toBe(true);
  });

  it("falls back to our own namespace but FLAGS it when /proc/1/mounts is unreadable", () => {
    // hidepid=, ProtectProc=invisible or ProcSubset=pid would do this. The data is
    // then known to be distorted under sandboxing, so the caller must be told.
    const { mounts, fromHostNamespace } = parseMounts(
      reader({ "/proc/1/mounts": null, "/proc/mounts": SANDBOXED_TABLE }),
    );
    expect(mounts).toHaveLength(2);
    expect(fromHostNamespace).toBe(false);
  });

  it("treats an EMPTY host table as unreadable rather than as zero mounts", () => {
    // An empty read must not be mistaken for "this host has no filesystems",
    // which would silently drop every disk from the snapshot.
    const { mounts, fromHostNamespace } = parseMounts(
      reader({ "/proc/1/mounts": "", "/proc/mounts": SANDBOXED_TABLE }),
    );
    expect(mounts).toHaveLength(2);
    expect(fromHostNamespace).toBe(false);
  });

  it("returns no mounts, and no crash, when neither table can be read", () => {
    const { mounts, fromHostNamespace } = parseMounts(reader({}));
    expect(mounts).toEqual([]);
    expect(fromHostNamespace).toBe(false);
  });

  it("parses device, mount, fstype and options positionally", () => {
    const { mounts } = parseMounts(reader({ "/proc/1/mounts": HOST_TABLE }));
    expect(mounts[0]).toEqual({
      device: "/dev/sdb2",
      mount: "/",
      fstype: "ext4",
      options: "rw,relatime,discard,errors=remount-ro",
    });
  });
});
