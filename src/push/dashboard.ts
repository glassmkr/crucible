import https from "https";
import tls from "tls";
import crypto from "crypto";
import type { Snapshot } from "../lib/types.js";

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

export async function pushToDashboard(url: string, apiKey: string, snapshot: Snapshot): Promise<boolean> {
  // If TLS pinning is enabled, use https.request (fetch doesn't support custom agents)
  if (agent) {
    return pushWithAgent(url, apiKey, snapshot);
  }

  // Default: use fetch (no pinning)
  try {
    const controller = new AbortController();
    const response = await fetch(`${url}/api/v1/ingest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    });
    if (response.ok) {
      const data = await readDashboardResponse(response, () => controller.abort());
      console.log(`[dashboard] Push successful. Active alerts: ${data.active_alerts ?? 0}`);
    } else {
      console.error(`[dashboard] Push failed: ${response.status} ${response.statusText}`);
    }
    return response.ok;
  } catch (err) {
    console.error("[dashboard] Push failed, will retry next cycle");
    return false;
  }
}

function pushWithAgent(url: string, apiKey: string, snapshot: Snapshot): Promise<boolean> {
  return new Promise((resolve) => {
    const parsed = new URL(`${url}/api/v1/ingest`);
    const body = JSON.stringify(snapshot);
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(ok);
    };

    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port) : 443,
      path: parsed.pathname,
      method: "POST",
      agent,
      headers: {
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
