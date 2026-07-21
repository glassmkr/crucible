import { afterEach, describe, expect, it, vi } from "vitest";
import { addResponseChunkSize, MAX_PINNED_RESPONSE_BYTES, pushToDashboard, readDashboardResponse } from "../dashboard.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pinned dashboard response limits", () => {
  it("counts response bytes across chunks", () => {
    expect(addResponseChunkSize(10, Buffer.from("hello"))).toBe(15);
  });

  it("rejects a response larger than the configured cap", () => {
    expect(() => addResponseChunkSize(MAX_PINNED_RESPONSE_BYTES, "x"))
      .toThrow(/exceeded/);
  });
});

describe("default dashboard response limits", () => {
  it("parses a bounded streamed response", async () => {
    const response = new Response(JSON.stringify({ active_alerts: 3 }));
    await expect(readDashboardResponse(response)).resolves.toEqual({ active_alerts: 3 });
  });

  it("aborts an oversized streamed response on the default fetch path", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PINNED_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(pushToDashboard("https://app.example", "key", {} as any)).resolves.toBe(false);
  });
});
