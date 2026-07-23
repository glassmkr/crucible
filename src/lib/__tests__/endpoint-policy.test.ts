import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  assertEndpointResolution,
  fetchPinnedEndpoint,
  isPrivateAddress,
  normalizeAllowedOrigins,
  selectPinnedAddress,
  validateEndpoint,
  type EndpointPolicy,
} from "../endpoint-policy.js";

const STRICT: EndpointPolicy = { allowInsecure: false, allowedOrigins: [] };

describe("endpoint policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::7f00:1",
    "fec0::1",
    "0:0:0:0:0:ffff:a9fe:a9fe",
  ])("classifies %s as non-public", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows public address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it("requires HTTPS and forbids URL credentials", () => {
    expect(() => validateEndpoint("http://example.com", STRICT)).toThrow("HTTPS");
    expect(() => validateEndpoint("https://user:pass@example.com", STRICT)).toThrow("credentials");
  });

  it("requires cross-origin endpoints to be explicitly allowlisted", () => {
    expect(() => validateEndpoint("https://ingest.example.com/a", STRICT, "https://app.example.com")).toThrow("cross-origin");
    expect(validateEndpoint("https://ingest.example.com/a", {
      ...STRICT,
      allowedOrigins: ["https://ingest.example.com"],
    }, "https://app.example.com").origin).toBe("https://ingest.example.com");
  });

  it("accepts only canonical origins in the allowlist", () => {
    expect(normalizeAllowedOrigins(["https://example.com"])).toEqual(["https://example.com"]);
    expect(() => normalizeAllowedOrigins(["https://example.com/path"])).toThrow("origins");
  });

  it("rejects a public hostname if any DNS answer is private", async () => {
    const resolve = vi.fn(async () => [
      { address: "203.0.113.4", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const },
    ]);
    await expect(assertEndpointResolution(new URL("https://example.com"), STRICT, resolve as any)).rejects.toThrow("private");
  });

  it("permits private resolution only for an explicitly allowed origin", async () => {
    const resolve = vi.fn(async () => [{ address: "10.0.0.2", family: 4 as const }]);
    await expect(assertEndpointResolution(new URL("https://internal.example.com"), {
      ...STRICT,
      allowedOrigins: ["https://internal.example.com"],
    }, resolve as any)).resolves.toEqual([{ address: "10.0.0.2", family: 4 }]);
    expect(resolve).toHaveBeenCalled();
  });

  it("rejects a private address selected after a public DNS validation", () => {
    const url = new URL("https://example.com");
    expect(() => selectPinnedAddress(
      url,
      [{ address: "203.0.113.10", family: 4 }],
      STRICT,
      4,
      () => ({ address: "127.0.0.1", family: 4 }),
    )).toThrow("private address selected");
  });

  it("completes a real round trip through the pinned dispatcher", async () => {
    let remoteAddress = "";
    let hostHeader = "";
    const server = createServer((request, response) => {
      remoteAddress = request.socket.remoteAddress ?? "";
      hostHeader = request.headers.host ?? "";
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("pinned round trip");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const url = new URL(`http://pinned.test:${address.port}/probe`);
      const { response, dispatcher } = await fetchPinnedEndpoint(
        url,
        { signal: AbortSignal.timeout(2000) },
        { allowInsecure: true, allowedOrigins: [] },
        undefined,
        async () => [{ address: "127.0.0.1", family: 4 }],
      );
      try {
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("pinned round trip");
        expect(remoteAddress).toBe("127.0.0.1");
        expect(hostHeader).toBe(`pinned.test:${address.port}`);
      } finally {
        await dispatcher.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
