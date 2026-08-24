// Tests for the host-wide PCIe AER collector. collectd parity close
// 2026-08-24.
//
// Fixture-root pattern (as in cpufreq.test.ts). Known-bad cases FIRST
// (round-5 lesson): missing root, devices without the files (AER not
// enabled), malformed contents, and the absent-vs-zero distinction.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectPcieAer, __test_only } from "../pcie-aer.js";

let root: string;

const LABELED_CLEAN = [
  "RxErr 0",
  "BadTLP 0",
  "BadDLLP 0",
  "Rollover 0",
  "Timeout 0",
  "NonFatalErr 0",
  "CorrIntErr 0",
  "HeaderOF 0",
  "TOTAL_ERR_COUNT 0",
].join("\n") + "\n";

async function writeDevice(addr: string, files: Record<string, string>): Promise<void> {
  const dir = join(root, addr);
  await fs.mkdir(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) {
    await fs.writeFile(join(dir, k), v);
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "pcie-aer-test-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("collectPcieAer: capability gate (absent means AER-not-enabled)", () => {
  it("returns null when the root does not exist", () => {
    expect(collectPcieAer(join(root, "no-such-root"))).toBeNull();
  });

  it("returns null when no device exposes any aer_dev_* file", async () => {
    await writeDevice("0000:00:01.0", { vendor: "0x8086" });
    await writeDevice("0000:00:02.0", { vendor: "0x8086" });
    expect(collectPcieAer(root)).toBeNull();
  });
});

describe("parseAerTotal: both on-disk formats", () => {
  it("takes the TOTAL_ERR_COUNT row from the labeled format", () => {
    expect(__test_only.parseAerTotal("RxErr 3\nBadTLP 2\nTOTAL_ERR_COUNT 5\n")).toBe(5);
  });

  it("takes a bare number", () => {
    expect(__test_only.parseAerTotal("7\n")).toBe(7);
  });

  it("sums labeled lines when the total row is missing", () => {
    expect(__test_only.parseAerTotal("RxErr 3\nBadTLP 2\n")).toBe(5);
  });

  it("returns null for unparsable contents, never zero", () => {
    expect(__test_only.parseAerTotal("no counters here")).toBeNull();
    expect(__test_only.parseAerTotal("")).toBeNull();
  });
});

describe("collectPcieAer: per-device entries and summary totals", () => {
  it("clean host: files exposed, zero errors, empty devices list, totals 0", async () => {
    await writeDevice("0000:00:01.0", {
      aer_dev_correctable: LABELED_CLEAN,
      aer_dev_nonfatal: LABELED_CLEAN,
      aer_dev_fatal: LABELED_CLEAN,
    });
    const r = collectPcieAer(root);
    // Present-with-zero is an ANSWER (clean host), distinct from the
    // null return when nothing exposes the files.
    expect(r).not.toBeNull();
    expect(r!.devices).toEqual([]);
    expect(r!.devices_reporting).toBe(1);
    expect(r!.correctable_total).toBe(0);
    expect(r!.nonfatal_total).toBe(0);
    expect(r!.fatal_total).toBe(0);
  });

  it("lists only nonzero devices; sums across all reporting devices", async () => {
    await writeDevice("0000:01:00.0", {
      aer_dev_correctable: "RxErr 3\nBadTLP 9\nTOTAL_ERR_COUNT 12\n",
      aer_dev_nonfatal: "TOTAL_ERR_COUNT 1\n",
      aer_dev_fatal: "TOTAL_ERR_COUNT 0\n",
    });
    await writeDevice("0000:02:00.0", {
      aer_dev_correctable: LABELED_CLEAN,
      aer_dev_nonfatal: LABELED_CLEAN,
      aer_dev_fatal: LABELED_CLEAN,
    });
    await writeDevice("0000:03:00.0", { vendor: "0x8086" }); // no AER files
    const r = collectPcieAer(root);
    expect(r!.devices_reporting).toBe(2);
    expect(r!.devices).toEqual([
      { device: "0000:01:00.0", correctable: 12, nonfatal: 1, fatal: 0 },
    ]);
    expect(r!.correctable_total).toBe(12);
    expect(r!.nonfatal_total).toBe(1);
    expect(r!.fatal_total).toBe(0);
  });

  it("bare-number format devices are handled alongside labeled ones", async () => {
    await writeDevice("0000:04:00.0", {
      aer_dev_correctable: "4\n",
      aer_dev_nonfatal: "0\n",
      aer_dev_fatal: "0\n",
    });
    const r = collectPcieAer(root);
    expect(r!.devices).toEqual([
      { device: "0000:04:00.0", correctable: 4, nonfatal: 0, fatal: 0 },
    ]);
    expect(r!.correctable_total).toBe(4);
  });

  it("a missing or malformed class file yields null for that class only", async () => {
    await writeDevice("0000:05:00.0", {
      aer_dev_correctable: "TOTAL_ERR_COUNT 2\n",
      aer_dev_fatal: "###\n", // unparsable; aer_dev_nonfatal missing
    });
    const r = collectPcieAer(root);
    expect(r!.devices_reporting).toBe(1);
    expect(r!.devices).toEqual([
      { device: "0000:05:00.0", correctable: 2, nonfatal: null, fatal: null },
    ]);
    // Null classes contribute nothing to the sums, not zero-by-lie:
    // the per-device null preserves did-not-answer.
    expect(r!.correctable_total).toBe(2);
    expect(r!.nonfatal_total).toBe(0);
    expect(r!.fatal_total).toBe(0);
  });

  it("orders nonzero devices by address", async () => {
    await writeDevice("0000:0b:00.0", { aer_dev_fatal: "1\n" });
    await writeDevice("0000:03:00.0", { aer_dev_fatal: "1\n" });
    const r = collectPcieAer(root);
    expect(r!.devices.map((d) => d.device)).toEqual(["0000:03:00.0", "0000:0b:00.0"]);
  });
});
