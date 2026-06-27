// Tests for parseWtmp: the clean-shutdown detection that feeds the dashboard's
// unexpected_reboot rule. Regression for the round-3 false positive where a
// deliberate `sudo reboot` was reported as an unclean shutdown because the old
// `last shutdown -F` command returns nothing on modern systemd/util-linux.

import { describe, expect, it } from "vitest";
import { parseWtmp } from "../reboot-evidence.js";

// Real `last -x -F` shapes (most-recent-first).
const CLEAN = `reboot   system boot  6.17.0-35-generic Sat Jun 27 19:22:28 2026   still running
shutdown system down  6.17.0-23-generic Sat Jun 27 19:20:39 2026 - Sat Jun 27 19:22:28 2026  (00:01)
reboot   system boot  6.17.0-23-generic Wed May 20 21:32:36 2026 - Sat Jun 27 19:20:39 2026 (37+21:48)

wtmp begins Tue Apr  7 22:14:51 2026`;

const UNCLEAN = `reboot   system boot  6.17.0-35-generic Sat Jun 27 19:22:28 2026   still running
reboot   system boot  6.17.0-23-generic Wed May 20 21:32:36 2026 - Sat Jun 27 19:22:00 2026 (37+21:49)

wtmp begins Tue Apr  7 22:14:51 2026`;

// runlevel + user-login records interleave in real output; the parser must
// filter to reboot/shutdown system lines before checking adjacency.
const CLEAN_INTERLEAVED = `simon    pts/0        198.51.100.4     Sat Jun 27 20:00:00 2026   still logged in
runlevel (to lvl 5)   6.17.0-35-generic Sat Jun 27 19:22:30 2026   still running
reboot   system boot  6.17.0-35-generic Sat Jun 27 19:22:28 2026   still running
shutdown system down  6.17.0-23-generic Sat Jun 27 19:20:39 2026 - Sat Jun 27 19:22:28 2026  (00:01)
reboot   system boot  6.17.0-23-generic Wed May 20 21:32:36 2026 - Sat Jun 27 19:20:39 2026 (37+21:48)`;

describe("parseWtmp", () => {
  it("clean: a shutdown record immediately before the most recent boot", () => {
    const r = parseWtmp(CLEAN);
    expect(r.prior_shutdown_clean).toBe(true);
    expect(r.last_reboot_raw).toContain("reboot");
    expect(r.last_reboot_raw).toContain("6.17.0-35");
  });

  it("unclean: two boots back-to-back with no shutdown between (hard reset)", () => {
    const r = parseWtmp(UNCLEAN);
    expect(r.prior_shutdown_clean).toBe(false);
    expect(r.last_reboot_raw).toContain("6.17.0-35");
  });

  it("clean even when runlevel and login records interleave", () => {
    expect(parseWtmp(CLEAN_INTERLEAVED).prior_shutdown_clean).toBe(true);
  });

  it("empty / no system records: not clean, null reboot", () => {
    expect(parseWtmp("")).toEqual({ last_reboot_raw: null, prior_shutdown_clean: false });
    expect(parseWtmp("wtmp begins Tue Apr  7 22:14:51 2026").prior_shutdown_clean).toBe(false);
  });

  it("first boot ever (single reboot, no prior shutdown) is not clean", () => {
    const r = parseWtmp("reboot   system boot  6.17.0-35-generic Sat Jun 27 19:22:28 2026   still running");
    expect(r.prior_shutdown_clean).toBe(false);
    expect(r.last_reboot_raw).toContain("reboot");
  });
});
