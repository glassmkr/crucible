import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAvailabilityLogsForTests,
  collectOptional,
  staleAvailability,
  type CollectionStatusMap,
} from "../availability.js";

beforeEach(() => __resetAvailabilityLogsForTests());

describe("collector availability", () => {
  it("records success and unavailable results in one shared shape", async () => {
    const statuses: CollectionStatusMap = {};
    expect(await collectOptional("ok", () => ({ value: 1 }), statuses)).toEqual({ value: 1 });
    expect(await collectOptional("missing", () => null, statuses)).toBeUndefined();
    expect(statuses.ok).toEqual({ available: true });
    expect(statuses.missing).toMatchObject({ available: false, error: "collector returned no data" });
    expect(JSON.parse(JSON.stringify({ collection_status: statuses })).collection_status.missing.available).toBe(false);
  });

  it("turns exceptions into available false and rate-limits logs", async () => {
    const statuses: CollectionStatusMap = {};
    const log = vi.fn();
    await collectOptional("thermal", () => { throw new Error("sensor read failed"); }, statuses, log, 400_000);
    await collectOptional("thermal", () => { throw new Error("sensor read failed"); }, statuses, log, 400_001);
    expect(statuses.thermal).toEqual({ available: false, error: "sensor read failed" });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("omits healthy null results when null means absent", async () => {
    const statuses: CollectionStatusMap = {
      zfs: { available: false, error: "stale failure" },
    };
    const result = await collectOptional(
      "zfs",
      () => null,
      statuses,
      undefined,
      undefined,
      { nullMeansAbsent: true },
    );
    expect(result).toBeUndefined();
    expect(statuses).not.toHaveProperty("zfs");
  });

  it("still records explicit unavailable payloads in absent mode", async () => {
    const statuses: CollectionStatusMap = {};
    await collectOptional(
      "zfs",
      () => ({ available: false, error: "zpool probe failed" }),
      statuses,
      undefined,
      undefined,
      { nullMeansAbsent: true },
    );
    expect(statuses.zfs).toEqual({ available: false, error: "zpool probe failed" });
  });

  it("marks stale data unavailable with age and last-success evidence", () => {
    const stale = staleAvailability(
      { firewall: { active: true } },
      new Error("probe failed"),
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:02:03Z"),
    );
    expect(stale).toMatchObject({
      available: false,
      error: "probe failed",
      last_success_at: "2026-01-01T00:00:00.000Z",
      data_age_seconds: 123,
    });
  });
});
