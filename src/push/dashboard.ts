import https from "https";
import tls from "tls";
import crypto from "crypto";
import type { Snapshot } from "../lib/types.js";

let agent: https.Agent | undefined;

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
    const response = await fetch(`${url}/api/v1/ingest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      const data = await response.json() as { active_alerts?: number };
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
      timeout: 10000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            console.log(`[dashboard] Push successful (pinned). Active alerts: ${parsed.active_alerts ?? 0}`);
          } catch { /* ignore parse errors */ }
          resolve(true);
        } else {
          console.error(`[dashboard] Push failed (pinned): ${res.statusCode}`);
          resolve(false);
        }
      });
    });

    req.on("error", (err) => {
      console.error(`[dashboard] Push failed (pinned): ${err.message}`);
      resolve(false);
    });
    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}
