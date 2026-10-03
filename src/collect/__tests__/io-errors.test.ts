// Tests for the dmesg-io action + io_errors parser (2026-10-03).
//
// The action ran `dmesg -T --since "10 minutes ago"` with stderr discarded.
// util-linux added --since in 2.35, so on older dmesg (RHEL 8, Debian 10,
// Ubuntu 20.04) the call failed, grep saw nothing, and io_errors was
// silently absent on every snapshot. These tests run the REAL wrapper script
// and the root-direct command against a fake `dmesg` that rejects --since
// the way util-linux < 2.35 does, then check that the 10-minute window still
// holds on the fallback's raw "[seconds since boot]" stamps.
//
// Known-bad first (round-5 lesson): the rejection case, then the windowing.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WRAPPER_SCRIPT, directCommand } from "../../lib/privileged.js";
import { parseIoErrorLines } from "../io-errors.js";

const execFileAsync = promisify(execFile);

let root: string;

// Uptime the fake ring buffer is read at: 10000 s since boot.
const UPTIME = 10000;

// util-linux < 2.35: "--since" is an unknown option (stderr, exit 1). Without
// it, prints the ring buffer with raw monotonic stamps, as plain `dmesg` does.
const OLD_DMESG = `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "--since" ]; then
    echo "dmesg: unrecognized option '--since'" >&2
    echo "Try 'dmesg --help' for more information." >&2
    exit 1
  fi
done
echo "[  100.000000] blk_update_request: I/O error, dev sda, sector 2048 op 0x0:(READ) flags 0x0 phys_seg 1 prio class 0"
echo "[ 9300.000000] Buffer I/O error on device sdc1, logical block 12"
echo "[ 9500.123456] e1000e 0000:00:1f.6 eno1: NIC Link is Up 1000 Mbps Full Duplex"
echo "[ 9950.500000] blk_update_request: I/O error, dev sdb, sector 4096 op 0x1:(WRITE) flags 0x0 phys_seg 1 prio class 0"
`;

// util-linux >= 2.35: --since works and -T prints ctime stamps already
// limited to the window. Must never fall through to the raw read.
const NEW_DMESG = `#!/bin/sh
case " $* " in
  *" --since "*)
    echo "[Fri Oct  3 12:00:01 2026] blk_update_request: I/O error, dev sdd, sector 8 op 0x0:(READ) flags 0x0 phys_seg 1 prio class 0"
    exit 0 ;;
esac
echo "[  100.000000] blk_update_request: I/O error, dev sda, sector 2048 op 0x0:(READ) flags 0x0 phys_seg 1 prio class 0"
`;

async function makeBin(name: string, dmesgScript: string): Promise<string> {
  const dir = join(root, name);
  await fs.mkdir(dir);
  await fs.writeFile(join(dir, "dmesg"), dmesgScript, { mode: 0o755 });
  return dir;
}

/** Run the installed wrapper's dmesg-io action with `bin` first on PATH. */
async function runWrapper(bin: string): Promise<string> {
  const wrapper = join(root, "crucible-collect");
  await fs.writeFile(wrapper, WRAPPER_SCRIPT, { mode: 0o755 });
  try {
    const { stdout } = await execFileAsync("sh", [wrapper, "dmesg-io"], { env: { PATH: `${bin}:/usr/bin:/bin` } });
    return stdout;
  } catch (err: any) {
    return typeof err.stdout === "string" ? err.stdout : ""; // grep exits 1 on no match
  }
}

/** Run the root-direct (no wrapper) command for dmesg-io. */
async function runDirect(bin: string): Promise<string> {
  const cmd = directCommand("dmesg-io", [])!;
  try {
    const { stdout } = await execFileAsync(cmd.cmd, cmd.args, { env: { PATH: `${bin}:/usr/bin:/bin` } });
    return stdout;
  } catch (err: any) {
    return typeof err.stdout === "string" ? err.stdout : "";
  }
}

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "io-errors-test-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("dmesg-io on a dmesg without --since (util-linux < 2.35)", () => {
  it("the wrapper falls back to a plain read instead of returning nothing", async () => {
    const out = await runWrapper(await makeBin("old-wrapper", OLD_DMESG));
    expect(out).toContain("I/O error, dev sdb");
    expect(out).toContain("Buffer I/O error on device sdc1");
    expect(out).not.toContain("NIC Link is Up"); // still grep-filtered
  });

  it("the root-direct command falls back the same way", async () => {
    const out = await runDirect(await makeBin("old-direct", OLD_DMESG));
    expect(out).toContain("I/O error, dev sdb");
  });

  it("keeps the 10-minute window: only errors stamped in the last 600 s count", async () => {
    const out = await runWrapper(await makeBin("old-window", OLD_DMESG));
    // [100] and [9300] are older than UPTIME - 600 = 9400; [9950] is inside.
    expect(parseIoErrorLines(out, UPTIME)).toEqual({ count: 1, devices: ["sdb"] });
  });
});

describe("dmesg-io on a dmesg with --since (util-linux >= 2.35)", () => {
  it("uses the --since read and never adds the full ring buffer", async () => {
    const out = await runWrapper(await makeBin("new-wrapper", NEW_DMESG));
    expect(out).toContain("dev sdd");
    expect(out).not.toContain("dev sda");
    // ctime-stamped lines were windowed by dmesg itself and all count.
    expect(parseIoErrorLines(out, UPTIME)).toEqual({ count: 1, devices: ["sdd"] });
  });
});

describe("parseIoErrorLines", () => {
  it("returns null for empty output", () => {
    expect(parseIoErrorLines("", UPTIME)).toBeNull();
    expect(parseIoErrorLines("\n\n", UPTIME)).toBeNull();
  });

  it("returns null when every fallback line is older than the window", () => {
    const out = "[  100.000000] blk_update_request: I/O error, dev sda, sector 1\n";
    expect(parseIoErrorLines(out, UPTIME)).toBeNull();
  });

  it("drops raw-stamped lines when uptime is unknown rather than count the whole boot", () => {
    const out = "[ 9950.000000] blk_update_request: I/O error, dev sdb, sector 1\n";
    expect(parseIoErrorLines(out, null)).toBeNull();
  });

  it("counts lines without a raw stamp exactly as before (ctime from --since)", () => {
    const out = [
      "[Fri Oct  3 12:00:01 2026] blk_update_request: I/O error, dev sda, sector 1",
      "[Fri Oct  3 12:00:02 2026] Buffer I/O error on device sda1, logical block 7",
    ].join("\n");
    expect(parseIoErrorLines(out, UPTIME)).toEqual({ count: 2, devices: ["sda", "sda1"] });
  });
});
