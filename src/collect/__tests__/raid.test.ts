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
    // sdb1 is role 1; bitmap [U_] means role 1 is down => sdb1 failed. This
    // assertion previously read ["sda1"] (the SURVIVOR), which enshrined the
    // listing-order bug fixed 2026-08-30; corrected to the real failed member.
    expect(r[0].failed_disks).toEqual(["sdb1"]);
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

  it("still works when listing order happens to match role order", async () => {
    await writeMdstat([
      "Personalities : [raid1]",
      "md1 : active raid1 sda1[0] sdb1[1]",
      "      976630336 blocks super 1.2 [2/1] [_U]",
      "",
      "unused devices: <none>",
    ].join("\n") + "\n");
    const r = await collectRaid(mdstatPath);
    expect(r[0].failed_disks).toEqual(["sda1"]); // role 0 is down
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
