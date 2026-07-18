import https from "https";
import tls from "tls";
import crypto from "crypto";
import type { Snapshot } from "../lib/types.js";
import {
  assertEndpointResolution,
  fetchPinnedEndpoint,
  normalizeAllowedOrigins,
  validateEndpoint,
  type EndpointPolicy,
  type PinnedFetchResult,
  type ResolvedEndpointAddress,
  selectPinnedAddress,
} from "../lib/endpoint-policy.js";

let agent: https.Agent | undefined;
export const MAX_PINNED_RESPONSE_BYTES = 64 * 1024;
export const PINNED_RESPONSE_DEADLINE_MS = 10_000;

export function addResponseChunkSize(current: number, chunk: Buffer | string): number {
  const next = current + (Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk));
  if (next > MAX_PINNED_RESPONSE_BYTES) {
    throw new Error(`Dashboard response exceeded ${MAX_PINNED_RESPONSE_BYTES} bytes`);
  }
  return next;
}

export async function readDashboardResponse(response: Response, abort?: () => void): Promise<{ active_alerts?: number }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_PINNED_RESPONSE_BYTES) {
    abort?.();
    throw new Error(`Dashboard response exceeded ${MAX_PINNED_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) return {};

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let responseBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBytes = addResponseChunkSize(responseBytes, Buffer.from(value));
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    abort?.();
    await reader.cancel().catch(() => {});
    throw err;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function initDashboardAgent(tlsPin?: string): void {
  if (!tlsPin) {
    agent = undefined; // Use default (Node built-in fetch)
    return;
  }

  agent = new https.Agent({
    rejectUnauthorized: true,
    checkServerIdentity: (hostname: string, cert: any) => {
      const err = tls.checkServerIdentity(hostname, cert);
      if (err) return err;

      const pubkey = cert.pubkey;
      if (!pubkey) return new Error("Certificate has no public key");

      const hash = crypto.createHash("sha256").update(pubkey).digest("base64");
      if (hash !== tlsPin) {
        return new Error(
          `TLS pin mismatch for ${hostname}. ` +
          `Expected: ${tlsPin}, Got: ${hash}. ` +
          `If the server certificate was rotated with a new key, update tls_pin in crucible.yaml.`
        );
      }

      return undefined;
    },
  });
}

export interface DashboardEndpointOptions {
  allowInsecure?: boolean;
  allowedOrigins?: string[];
}

export async function postDashboardWithPolicy(
  rawUrl: string,
  init: RequestInit,
  policy: EndpointPolicy,
  fetchImpl: typeof fetch = fetch,
  resolveEndpoint: typeof assertEndpointResolution = assertEndpointResolution,
): Promise<PinnedFetchResult> {
  const initialOrigin = validateEndpoint(rawUrl, policy).origin;
  let current = validateEndpoint(rawUrl, policy);
  for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
    const pinned = await fetchPinnedEndpoint(current, { ...init, redirect: "manual" }, policy, fetchImpl, resolveEndpoint);
    const { response, dispatcher } = pinned;
    if (response.status === 307 || response.status === 308) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      await dispatcher.close();
      if (!location) throw new Error("dashboard redirect did not include a location");
      current = validateEndpoint(new URL(location, current).toString(), policy, initialOrigin);
      continue;
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      await dispatcher.close();
      throw new Error(`refusing dashboard redirect that does not preserve POST (HTTP ${response.status})`);
    }
    return pinned;
  }
  throw new Error("too many dashboard redirects");
}

export async function pushToDashboard(
  url: string,
  apiKey: string,
  snapshot: Snapshot,
  endpointOptions: DashboardEndpointOptions = {},
): Promise<boolean> {
  let target: URL;
  let policy: EndpointPolicy;
  let targetAddresses: ResolvedEndpointAddress[];
  try {
    policy = {
      allowInsecure: endpointOptions.allowInsecure ?? false,
      allowedOrigins: normalizeAllowedOrigins(endpointOptions.allowedOrigins),
    };
    target = validateEndpoint(`${url.replace(/\/+$/, "")}/api/v1/ingest`, policy);
    targetAddresses = await assertEndpointResolution(target, policy);
  } catch (err) {
    console.error(`[dashboard] Refusing endpoint: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  // If TLS pinning is enabled, use https.request (fetch doesn't support custom agents)
  if (agent) {
    if (target.protocol !== "https:") {
      console.error("[dashboard] TLS pinning requires an HTTPS endpoint");
      return false;
    }
    return pushWithAgent(target, apiKey, snapshot, targetAddresses, policy);
  }

  // Default: use fetch (no pinning)
  try {
    const controller = new AbortController();
    const { response, dispatcher } = await postDashboardWithPolicy(target.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    }, policy);
    try {
      if (response.ok) {
        const data = await readDashboardResponse(response, () => controller.abort());
        console.log(`[dashboard] Push successful. Active alerts: ${data.active_alerts ?? 0}`);
      } else {
        await response.body?.cancel();
        console.error(`[dashboard] Push failed: ${response.status} ${response.statusText}`);
      }
      return response.ok;
    } finally {
      await dispatcher.close();
    }
  } catch (err) {
    console.error("[dashboard] Push failed, will retry next cycle");
    return false;
  }
}

function pushWithAgent(
  parsed: URL,
  apiKey: string,
  snapshot: Snapshot,
  validatedAddresses: ResolvedEndpointAddress[],
  policy: EndpointPolicy,
): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify(snapshot);
    const selected = selectPinnedAddress(parsed, validatedAddresses, policy);
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(ok);
    };

    const req = https.request({
      hostname: selected.address,
      family: selected.family,
      servername: parsed.hostname.replace(/^\[|\]$/g, ""),
      port: parsed.port ? parseInt(parsed.port) : 443,
      path: parsed.pathname,
      method: "POST",
      agent,
      headers: {
        Host: parsed.host,
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: PINNED_RESPONSE_DEADLINE_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      let responseBytes = 0;
      res.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        try {
          responseBytes = addResponseChunkSize(responseBytes, chunk);
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        } catch (err) {
          console.error(`[dashboard] Push failed (pinned): ${(err as Error).message}`);
          res.destroy();
          req.destroy();
          finish(false);
        }
      });
      res.on("end", () => {
        if (settled) return;
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            console.log(`[dashboard] Push successful (pinned). Active alerts: ${parsed.active_alerts ?? 0}`);
          } catch { /* ignore parse errors */ }
          finish(true);
        } else {
          console.error(`[dashboard] Push failed (pinned): ${res.statusCode}`);
          finish(false);
        }
      });
    });

    req.on("error", (err) => {
      console.error(`[dashboard] Push failed (pinned): ${err.message}`);
      finish(false);
    });
    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
      finish(false);
    });
    deadline = setTimeout(() => {
      req.destroy(new Error("Request deadline exceeded"));
      finish(false);
    }, PINNED_RESPONSE_DEADLINE_MS);
    req.write(body);
    req.end();
  });
}
