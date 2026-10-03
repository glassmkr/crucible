// Tests for the dmesg-errcrit action + OOM kill count (2026-10-03).
//
// The action ran `dmesg --level=err,crit --since "5 min ago"`. util-linux
// added --since in 2.35, so on older dmesg (RHEL 8, Debian 10, Ubuntu 20.04)
// the call exited 1 with empty stdout and os_alerts.oom_kills_recent was
// silently 0 on every snapshot: the dashboard's oom_kills rule never fired
// there. busybox dmesg rejects both --level and --since. These tests run the
// REAL wrapper script and the root-direct command against fake `dmesg`
// binaries for each case, then check that the 5-minute window and the
// err,crit level filter still hold on the fallbacks' output.
//
// Known-bad first (round-5 lesson): the rejection cases, then the windowing.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WRAPPER_SCRIPT, directCommand } from "../../lib/privileged.js";
import { countRecentOomKills } from "../os-alerts.js";

const execFileAsync = promisify(execFile);

let root: string;

// Uptime the fake ring buffer is read at: 10000 s since boot. The 5-minute
// window starts at 9700.
const UPTIME = 10000;

// util-linux 2.32 - 2.34: "--since" is an unknown option (stderr, exit 1),
// but --level works. Prints raw "[seconds since boot]" stamps, as plain
// `dmesg` does, across the whole ring buffer.
const OLD_DMESG = `#!/bin/sh
level=0
for a in "$@"; do
  case "$a" in
    --since)
      echo "dmesg: unrecognized option '--since'" >&2
      echo "Try 'dmesg --help' for more information." >&2
      exit 1 ;;
    --level=err,crit) level=1 ;;
  esac
done
echo "[  100.000000] Out of memory: Killed process 812 (java) total-vm:1048576kB, anon-rss:524288kB"
echo "[ 9650.000000] Out of memory: Killed process 777 (redis-server) total-vm:65536kB, anon-rss:32768kB"
if [ "$level" = 0 ]; then
  echo "[ 9800.000000] ixgbe 0000:01:00.0 eth2: out of memory, dropping rx buffers"
fi
echo "[ 9900.250000] Memory cgroup out of memory: Killed process 4242 (node) total-vm:4194304kB, anon-rss:2097152kB"
echo "[ 9950.500000] Out of memory: Killed process 5151 (postgres) total-vm:2097152kB, anon-rss:1048576kB"
echo "[ 9960.000000] EXT4-fs error (device sda1): ext4_find_entry:1455: inode #2: comm ls: reading directory lblock 0"
`;

// busybox: no long options at all (usage on stderr, exit 1). `dmesg -r`
// prints the raw syslog buffer, every level, each line led by its "<N>"
// priority; with printk.time=0 the kernel adds no stamp after it.
const BUSYBOX_DMESG = `#!/bin/sh
for a in "$@"; do
  case "$a" in
    --*)
      echo "dmesg: unrecognized option '$a'" >&2
      echo "BusyBox v1.36.1 (2024-06-10 07:11:47 UTC) multi-call binary." >&2
      exit 1 ;;
  esac
done
if [ "$#" -gt 0 ] && [ "$1" = "-r" ]; then
  echo "<6>[    0.000000] Linux version 6.6.32-0-lts (buildozer@build-3-20-x86_64)"
  echo "<3>[  100.000000] Out of memory: Killed process 812 (java) total-vm:1048576kB, anon-rss:524288kB"
  echo "<3>[ 9650.000000] Out of memory: Killed process 777 (redis-server) total-vm:65536kB, anon-rss:32768kB"
  echo "<4>[ 9800.000000] ixgbe 0000:01:00.0 eth2: out of memory, dropping rx buffers"
  echo "<3>[ 9950.500000] Out of memory: Killed process 5151 (postgres) total-vm:2097152kB, anon-rss:1048576kB"
  echo "<3>Out of memory: Killed process 9 (unstamped) total-vm:4096kB, anon-rss:2048kB"
  exit 0
fi
echo "[    0.000000] Linux version 6.6.32-0-lts (buildozer@build-3-20-x86_64)"
echo "[ 9950.500000] Out of memory: Killed process 5151 (postgres) total-vm:2097152kB, anon-rss:1048576kB"
`;

// util-linux >= 2.35: --since works and limits output to the window; -T
// prints ctime stamps instead of raw ones. Must never fall through to a
// full ring-buffer read.
const NEW_DMESG = `#!/bin/sh
since=0; level=0; ctime=0
for a in "$@"; do
  case "$a" in
    --since) since=1 ;;
    --level=err,crit) level=1 ;;
    -T) ctime=1 ;;
  esac
done
if [ "$since" = 0 ]; then
  echo "[  100.000000] Out of memory: Killed process 812 (java) total-vm:1048576kB, anon-rss:524288kB"
  exit 0
fi
if [ "$ctime" = 1 ]; then stamp="[Sat Oct  3 12:00:01 2026]"; else stamp="[ 9950.500000]"; fi
echo "$stamp Out of memory: Killed process 5151 (postgres) total-vm:2097152kB, anon-rss:1048576kB"
if [ "$level" = 0 ]; then
  echo "$stamp ixgbe 0000:01:00.0 eth2: out of memory, dropping rx buffers"
fi
`;

// util-linux >= 2.35 with nothing in the window: exits 0 with no output.
const NEW_DMESG_QUIET = `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "--since" ]; then exit 0; fi
done
echo "[  100.000000] Out of memory: Killed process 812 (java) total-vm:1048576kB, anon-rss:524288kB"
echo "<3>[  100.000000] Out of memory: Killed process 812 (java) total-vm:1048576kB, anon-rss:524288kB"
`;

async function makeBin(name: string, dmesgScript: string): Promise<string> {
  const dir = join(root, name);
  await fs.mkdir(dir);
  await fs.writeFile(join(dir, "dmesg"), dmesgScript, { mode: 0o755 });
  return dir;
}

/** Run the installed wrapper's dmesg-errcrit action with `bin` first on PATH. */
async function runWrapper(bin: string): Promise<string> {
  const wrapper = join(root, "crucible-collect");
  await fs.writeFile(wrapper, WRAPPER_SCRIPT, { mode: 0o755 });
  try {
    const { stdout } = await execFileAsync("sh", [wrapper, "dmesg-errcrit"], { env: { PATH: `${bin}:/usr/bin:/bin` } });
    return stdout;
  } catch (err: any) {
    return typeof err.stdout === "string" ? err.stdout : "";
  }
}

/** Run the root-direct (no wrapper) command for dmesg-errcrit. */
async function runDirect(bin: string): Promise<string> {
  const cmd = directCommand("dmesg-errcrit", [])!;
  try {
    const { stdout } = await execFileAsync(cmd.cmd, cmd.args, { env: { PATH: `${bin}:/usr/bin:/bin` } });
    return stdout;
  } catch (err: any) {
    return typeof err.stdout === "string" ? err.stdout : "";
  }
}

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "os-alerts-test-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("dmesg-errcrit on a dmesg without --since (util-linux 2.32 - 2.34)", () => {
  it("the wrapper falls back to a --level read instead of returning nothing", async () => {
    const out = await runWrapper(await makeBin("old-wrapper", OLD_DMESG));
    expect(out).toContain("Killed process 5151 (postgres)");
    expect(out).not.toContain("dropping rx buffers"); // still err,crit only
  });

  it("the root-direct command falls back the same way", async () => {
    const out = await runDirect(await makeBin("old-direct", OLD_DMESG));
    expect(out).toContain("Killed process 5151 (postgres)");
    expect(out).not.toContain("dropping rx buffers");
  });

  it("keeps the 5-minute window: only OOM kills stamped in the last 300 s count", async () => {
    const out = await runWrapper(await makeBin("old-window", OLD_DMESG));
    // [100] and [9650] are older than UPTIME - 300 = 9700; [9900.25] and
    // [9950.5] are inside.
    expect(countRecentOomKills(out, UPTIME)).toBe(2);
  });

  it("counts nothing when uptime is unknown rather than count the whole boot", async () => {
    const out = await runWrapper(await makeBin("old-no-uptime", OLD_DMESG));
    expect(countRecentOomKills(out, null)).toBe(0);
  });
});

describe("dmesg-errcrit on busybox dmesg (no --since, no --level)", () => {
  it("the wrapper falls back to a raw read carrying each line's priority", async () => {
    const out = await runWrapper(await makeBin("bb-wrapper", BUSYBOX_DMESG));
    expect(out).toContain("<3>[ 9950.500000] Out of memory: Killed process 5151 (postgres)");
  });

  it("the root-direct command falls back the same way", async () => {
    const out = await runDirect(await makeBin("bb-direct", BUSYBOX_DMESG));
    expect(out).toContain("<3>[ 9950.500000] Out of memory: Killed process 5151 (postgres)");
  });

  it("applies the err,crit level and the 5-minute window to the raw read", async () => {
    const out = await runWrapper(await makeBin("bb-window", BUSYBOX_DMESG));
    // Only <3>[9950.5] counts: [100] and [9650] are too old, the <4> line is a
    // warning, and the unstamped <3> line cannot be placed in time.
    expect(countRecentOomKills(out, UPTIME)).toBe(1);
    expect(countRecentOomKills(out, null)).toBe(0);
  });
});

describe("dmesg-errcrit on a dmesg with --since (util-linux >= 2.35)", () => {
  it("uses the --since read with --level=err,crit and never adds the full ring buffer", async () => {
    for (const out of [
      await runWrapper(await makeBin("new-wrapper", NEW_DMESG)),
      await runDirect(await makeBin("new-direct", NEW_DMESG)),
    ]) {
      expect(out).toContain("Killed process 5151 (postgres)");
      expect(out).not.toContain("(java)");
      expect(out).not.toContain("dropping rx buffers");
      // ctime-stamped lines were windowed by dmesg itself and count as they
      // did before, with or without a readable uptime.
      expect(countRecentOomKills(out, UPTIME)).toBe(1);
      expect(countRecentOomKills(out, null)).toBe(1);
    }
  });

  it("an empty window stays empty: a successful --since read is never followed by a fallback", async () => {
    expect(await runWrapper(await makeBin("quiet-wrapper", NEW_DMESG_QUIET))).toBe("");
    expect(await runDirect(await makeBin("quiet-direct", NEW_DMESG_QUIET))).toBe("");
  });
});

describe("countRecentOomKills", () => {
  it("returns 0 for empty output", () => {
    expect(countRecentOomKills("", UPTIME)).toBe(0);
    expect(countRecentOomKills("\n\n", UPTIME)).toBe(0);
  });

  it("reads the level from the low 3 bits of <N>, whatever the facility, as --level does", () => {
    const out = [
      "<2>[ 9950.000000] Out of memory: Killed process 1 (a) total-vm:4096kB", // kern.crit
      "<11>[ 9951.000000] oomd[311]: Out of memory in app.slice", // user.err
      "<12>[ 9952.000000] oomd[311]: Out of memory warning for app.slice", // user.warning
      "<1>[ 9953.000000] Out of memory: Killed process 2 (b) total-vm:4096kB", // kern.alert
    ].join("\n");
    expect(countRecentOomKills(out, UPTIME)).toBe(2);
  });

  it("does not count a line that carries no stamp at all", () => {
    expect(countRecentOomKills("Out of memory: Killed process 1 (a) total-vm:4096kB\n", UPTIME)).toBe(0);
  });

  it("counts a raw-stamped line at the window's start and drops one just before it", () => {
    const out = [
      "[ 9700.000000] Out of memory: Killed process 1 (a) total-vm:4096kB",
      "[ 9699.999999] Out of memory: Killed process 2 (b) total-vm:4096kB",
    ].join("\n");
    expect(countRecentOomKills(out, UPTIME)).toBe(1);
  });
});
