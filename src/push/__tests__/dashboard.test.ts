import { describe, expect, it, vi } from "vitest";
import {
  addResponseChunkSize,
  MAX_PINNED_RESPONSE_BYTES,
  postDashboardWithPolicy,
  readDashboardResponse,
} from "../dashboard.js";
import type { EndpointPolicy } from "../../lib/endpoint-policy.js";

const STRICT: EndpointPolicy = { allowInsecure: false, allowedOrigins: [] };
const NO_RESOLVE = async () => [{ address: "203.0.113.10", family: 4 as const }];

describe("dashboard response limits", () => {
  it("counts response bytes across chunks", () => {
    expect(addResponseChunkSize(10, Buffer.from("hello"))).toBe(15);
  });

  it("rejects a response larger than the configured cap", () => {
    expect(() => addResponseChunkSize(MAX_PINNED_RESPONSE_BYTES, "x"))
      .toThrow(/exceeded/);
  });

  it("parses a bounded streamed response", async () => {
    const response = new Response(JSON.stringify({ active_alerts: 3 }));
    await expect(readDashboardResponse(response)).resolves.toEqual({ active_alerts: 3 });
  });

  it("aborts an oversized streamed response", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PINNED_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const abort = vi.fn();
    await expect(readDashboardResponse(new Response(stream), abort)).rejects.toThrow(/exceeded/);
    expect(abort).toHaveBeenCalledOnce();
  });
});

describe("postDashboardWithPolicy", () => {
  it("follows a same-origin 307 with manual validation", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/api/v2/ingest" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const { response, dispatcher } = await postDashboardWithPolicy(
      "https://app.example.com/api/v1/ingest",
      { method: "POST", body: "{}" },
      STRICT,
      fetchImpl,
      NO_RESOLVE,
    );
    expect(response.status).toBe(200);
    await dispatcher.close();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0].toString()).toBe("https://app.example.com/api/v2/ingest");
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("manual");
    expect(fetchImpl.mock.calls[0][1].dispatcher).toBeTruthy();
  });

  it("rejects a cross-origin redirect before forwarding credentials", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://evil.example/ingest" } }));
    await expect(postDashboardWithPolicy(
      "https://app.example.com/api/v1/ingest",
      { method: "POST", headers: { Authorization: "Bearer fixture" } },
      STRICT,
      fetchImpl,
      NO_RESOLVE,
    )).rejects.toThrow("cross-origin");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects redirect statuses that can rewrite POST", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "https://app.example.com/other" },
    }));
    await expect(postDashboardWithPolicy(
      "https://app.example.com/api/v1/ingest",
      { method: "POST" },
      STRICT,
      fetchImpl,
      NO_RESOLVE,
    )).rejects.toThrow("does not preserve POST");
  });

  it("allows a cross-origin redirect only when the destination is allowlisted", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { location: "https://ingest.example.com/v1" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 202 }));
    const { response, dispatcher } = await postDashboardWithPolicy(
      "https://app.example.com/api/v1/ingest",
      { method: "POST" },
      { ...STRICT, allowedOrigins: ["https://ingest.example.com"] },
      fetchImpl,
      NO_RESOLVE,
    );
    expect(response.status).toBe(202);
    await dispatcher.close();
  });
});
