// Tests for the /proc/mdstat parser, focused on the resync-progress
// slice added 2026-08-24 (collectd mdevents parity close). The collector
// takes a path test hook. Known-bad cases FIRST (round-5 lesson):
// missing file, no operation running, DELAYED marker, malformed pieces.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectRaid } from "../raid.js";

let root: string;
let mdstatPath: string;

async function writeMdstat(content: string): Promise<void> {
  await fs.writeFile(mdstatPath, content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "raid-test-"));
  mdstatPath = join(root, "mdstat");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const HEALTHY = [
  "Personalities : [raid1]",
  "md0 : active raid1 sdb1[1] sda1[0]",
  "      976630336 blocks super 1.2 [2/2] [UU]",
  "      bitmap: 1/8 pages [4KB], 65536KB chunk",
  "",
  "unused devices: <none>",
].join("\n") + "\n";

describe("collectRaid: known-bad inputs", () => {
  it("returns [] when the file is missing", async () => {
    expect(await collectRaid(join(root, "no-such-file"))).toEqual([]);
  });

  it("no operation running: sync_action absent, not null-filled", async () => {
    await writeMdstat(HEALTHY);
    const r = await collectRaid(mdstatPath);
    expect(r).toHaveLength(1);
    expect(r[0].device).toBe("md0");
    expect(r[0].degraded).toBe(false);
    expect("sync_action" in r[0]).toBe(false);
  });

  it("a queued resync=DELAYED marker is not a running operation", async () => {
    await writeMdstat([
      "md1 : active raid5 sdd1[3] sdc1[1] sdb1[0]",
      "      3906764800 blocks level 5, 64k chunk, algorithm 2 [3/3] [UUU]",
      "      \tresync=DELAYED",
      "",
    ].join("\n") + "\n");
    const r = await collectRaid(mdstatPath);
    expect("sync_action" in r[0]).toBe(false);
  });

  it("malformed pieces on a matched operation line yield null per piece", async () => {
    await writeMdstat([
      "md0 : active raid1 sdb1[1] sda1[0]",
      "      976630336 blocks super 1.2 [2/2] [UU]",
      "      [=>...................]  check = garbage% (x/y) finish=?min speed=?K/sec",
      "",
    ].join("\n") + "\n");
    const r = await collectRaid(mdstatPath);
    expect(r[0].sync_action).toEqual({
      operation: "check",
      percent: null,
      finish_min: null,
      speed_kb_s: null,
    });
  });
});

describe("collectRaid: in-progress operation parsing", () => {
  it("parses a recovery line: operation, percent, finish, speed", async () => {
    await writeMdstat([
      "Personalities : [raid1]",
      "md0 : active raid1 sdb1[1] sda1[0]",
      "      976630336 blocks super 1.2 [2/1] [U_]",
      "      [==>..................]  recovery = 12.6% (123456789/976630336) finish=76.2min speed=186496K/sec",
      "      bitmap: 1/8 pages [4KB], 65536KB chunk",
      "",
      "unused devices: <none>",
    ].join("\n") + "\n");
    const r = await collectRaid(mdstatPath);
    expect(r[0].sync_action).toEqual({
      operation: "recovery",
      percent: 12.6,
      finish_min: 76.2,
      speed_kb_s: 186496,
    });
  });

  it("parses a resync line without finish/speed pieces as nulls", async () => {
    await writeMdstat([
      "md0 : active raid1 sdb1[1] sda1[0]",
      "      976630336 blocks super 1.2 [2/2] [UU]",
      "      [>....................]  resync =  0.0% (12345/976630336)",
      "",
    ].join("\n") + "\n");
    const r = await collectRaid(mdstatPath);
    expect(r[0].sync_action).toEqual({
      operation: "resync",
      percent: 0.0,
      finish_min: null,
      speed_kb_s: null,
    });
  });

  it("attaches each operation to its own array in a multi-array mdstat", async () => {
    await writeMdstat([
      "md0 : active raid1 sdb1[1] sda1[0]",
      "      976630336 blocks super 1.2 [2/2] [UU]",
      "",
      "md1 : active raid6 sdf1[3] sde1[2] sdd1[1] sdc1[0]",
      "      7813529600 blocks level 6, 512k chunk, algorithm 2 [4/4] [UUUU]",
      "      [=========>...........]  check = 45.7% (1786123456/3906764800) finish=190.1min speed=185920K/sec",
      "",
      "unused devices: <none>",
    ].join("\n") + "\n");
    const r = await collectRaid(mdstatPath);
    expect(r).toHaveLength(2);
    expect("sync_action" in r[0]).toBe(false);
    expect(r[1].sync_action!.operation).toBe("check");
    expect(r[1].sync_action!.percent).toBe(45.7);
  });

  it("existing degraded parsing is unchanged by the resync slice", async () => {
    await writeMdstat([
      "md0 : active raid1 sdb1[1] sda1[0]",
      "      976630336 blocks super 1.2 [2/1] [U_]",
      "",
    ].join("\n") + "\n");
    const r = await collectRaid(mdstatPath);
    expect(r[0].degraded).toBe(true);
    // Neither member carries (F), so neither is failed. The kernel prints (F)
    // for every faulty member still attached; an unflagged member in an
    // array with a '_' slot is the rebuild target (mdadm --detail: "spare
    // rebuilding"). This assertion read ["sdb1"] until 2026-10-03, mapping
    // the bracket number to the slot: but [1] is sdb1's DESCRIPTOR number,
    // not its role, so it named a healthy disk being rebuilt as the failure.
    expect(r[0].failed_disks).toEqual([]);
  });
});

// --- 2026-08-30: role-index vs listing-order failed-member bug (Grok red-team,
// data-loss-grade: the RAID-degraded alert named the SURVIVING disk). mdstat
// lists members in an arbitrary order while [U_] is ordered by RAID role [N];
// mapping the bitmap by listing order misidentifies the failed member. ---
describe("collectRaid: failed member is identified by ROLE index, not listing order", () => {
  it("names the actually-failed member when mdstat lists it out of role order (Grok val-debian case)", async () => {
    // Operator ran `mdadm --fail /dev/sdb2`. sdb2 is role 1 (down); sda2 is
    // role 0 (up). mdstat lists sdb2 FIRST. Bitmap [U_] => role1 down => sdb2.
    await writeMdstat([
      "Personalities : [raid1]",
      "md126 : active raid1 sdb2[1](F) sda2[0]",
      "      523200 blocks super 1.2 [2/1] [U_]",
      "      bitmap: 1/1 pages [4KB], 65536KB chunk",
      "",
      "unused devices: <none>",
    ].join("\n") + "\n");
    const r = await collectRaid(mdstatPath);
    expect(r[0].degraded).toBe(true);
    expect(r[0].failed_disks).toEqual(["sdb2"]); // NOT sda2 (the healthy one)
  });

  it("never names an unflagged member from a '_' slot, even when its bracket number matches", async () => {
    // Was "still works when listing order happens to match role order" and
    // expected ["sda1"]. sda1 has no (F): it is attached and resyncing into
    // the empty slot, so it is not the failed disk (2026-10-03).
    await writeMdstat([
      "Personalities : [raid1]",
      "md1 : active raid1 sda1[0] sdb1[1]",
      "      976630336 blocks super 1.2 [2/1] [_U]",
      "",
      "unused devices: <none>",
    ].join("\n") + "\n");
    const r = await collectRaid(mdstatPath);
    expect(r[0].degraded).toBe(true);
    expect(r[0].failed_disks).toEqual([]);
  });

  it("a removed member (gone from the listing) leaves degraded true and does not misname a survivor", async () => {
    await writeMdstat([
      "Personalities : [raid1]",
      "md126 : active raid1 sda2[0]",
      "      523200 blocks super 1.2 [2/1] [U_]",
      "",
      "unused devices: <none>",
    ].join("\n") + "\n");
    const r = await collectRaid(mdstatPath);
    expect(r[0].degraded).toBe(true);
    expect(r[0].failed_disks).not.toContain("sda2"); // must never name the survivor
  });
});

// --- 2026-10-03: mdstat forms the parser skipped or misread (ported from the
// dashboard paste-triage parser). The [N] after a member is its descriptor
// number, which stops matching the slot once a disk has been replaced, so a
// member is named failed only from its own (F) flag. ---
describe("collectRaid: member flags, names and array states", () => {
  async function parse(lines: string[]) {
    await writeMdstat(lines.join("\n") + "\n");
    return collectRaid(mdstatPath);
  }

  it("a replacement disk being rebuilt into the empty slot is not named failed", async () => {
    const r = await parse([
      "md0 : active raid1 sdc1[2] sda1[0]",
      "      976630336 blocks super 1.2 [2/1] [U_]",
      "      [==>..................]  recovery = 12.6% (123456789/976630336) finish=76.2min speed=186496K/sec",
      "",
    ]);
    expect(r[0]).toMatchObject({ device: "md0", degraded: true, disks: ["sdc1", "sda1"], failed_disks: [] });
  });

  it("a spare whose bracket number matches the empty slot is never named failed", async () => {
    const r = await parse([
      "md0 : active raid1 sdc1[1](S) sda1[0]",
      "      976630336 blocks super 1.2 [2/1] [U_]",
      "",
    ]);
    expect(r[0].degraded).toBe(true);
    expect(r[0].failed_disks).toEqual([]);
  });

  it("reads (F) after (W): a write-mostly member that failed", async () => {
    const r = await parse([
      "md4 : active raid1 nvme1n1p3[2](W)(F) nvme0n1p3[0]",
      "      937560064 blocks super 1.2 [2/1] [U_]",
      "",
    ]);
    expect(r[0]).toMatchObject({ degraded: true, disks: ["nvme1n1p3", "nvme0n1p3"], failed_disks: ["nvme1n1p3"] });
  });

  it("keeps member names that contain '-' (device-mapper members)", async () => {
    const r = await parse([
      "md0 : active raid1 dm-1[1](F) dm-0[0]",
      "      976630336 blocks super 1.2 [2/1] [U_]",
      "",
    ]);
    expect(r[0].disks).toEqual(["dm-1", "dm-0"]);
    expect(r[0].failed_disks).toEqual(["dm-1"]);
  });

  it("reads an array shown 'active (auto-read-only)'", async () => {
    const r = await parse([
      "md0 : active (auto-read-only) raid1 sdb2[1] sda2[0]",
      "      523200 blocks super 1.2 [2/2] [UU]",
      "",
    ]);
    expect(r).toEqual([
      { device: "md0", level: "raid1", status: "active", degraded: false, disks: ["sdb2", "sda2"], failed_disks: [] },
    ]);
  });

  it("reads named arrays (md_<name>)", async () => {
    const r = await parse([
      "md_home : active raid1 sdb1[1](F) sda1[0]",
      "      976630336 blocks super 1.2 [2/1] [U_]",
      "",
    ]);
    expect(r[0]).toMatchObject({ device: "md_home", level: "raid1", degraded: true, failed_disks: ["sdb1"] });
  });

  it("reports inactive arrays instead of dropping them; an IMSM container is level 'container'", async () => {
    const r = await parse([
      "Personalities : [raid1]",
      "md127 : inactive sdk[1](S) sdj[0](S)",
      "      10402 blocks super external:imsm",
      "",
      "md2 : inactive sdm1[1](S) sdl1[0](S)",
      "      3906764800 blocks super 1.2",
      "",
      "unused devices: <none>",
    ]);
    expect(r).toEqual([
      { device: "md127", level: "container", status: "inactive", degraded: false, disks: ["sdk", "sdj"], failed_disks: [] },
      { device: "md2", level: "unknown", status: "inactive", degraded: false, disks: ["sdm1", "sdl1"], failed_disks: [] },
    ]);
  });

  it("treats a 'broken' raid0 (a member is gone) as degraded", async () => {
    const r = await parse([
      "md9 : broken raid0 sdq1[1] sdp1[0]",
      "      3906764800 blocks super 1.2 512k chunks",
      "",
    ]);
    expect(r).toEqual([
      { device: "md9", level: "raid0", status: "broken", degraded: true, disks: ["sdq1", "sdp1"], failed_disks: [] },
    ]);
  });

  it("raid6 with two holes names only the (F) member", async () => {
    const r = await parse([
      "md1 : active raid6 sde1[4](F) sdd1[3] sdc1[2] sdb1[1]",
      "      5860147200 blocks super 1.2 level 6, 512k chunk, algorithm 2 [5/3] [_UUU_]",
      "",
    ]);
    expect(r[0]).toMatchObject({ degraded: true, disks: ["sde1", "sdd1", "sdc1", "sdb1"], failed_disks: ["sde1"] });
  });

  it("attaches a progress line to a named array that follows another array", async () => {
    const r = await parse([
      "md0 : active raid1 sdb1[1] sda1[0]",
      "      976630336 blocks super 1.2 [2/2] [UU]",
      "md_data : active raid1 sdd1[1] sdc1[0]",
      "      976630336 blocks super 1.2 [2/2] [UU]",
      "      [=>...................]  check = 5.0% (1/2) finish=10.0min speed=1000K/sec",
      "",
    ]);
    expect(r.map((a) => a.device)).toEqual(["md0", "md_data"]);
    expect("sync_action" in r[0]).toBe(false);
    expect(r[1].sync_action?.operation).toBe("check");
  });
});
