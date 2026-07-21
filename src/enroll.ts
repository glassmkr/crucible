// `glassmkr-crucible enroll` subcommand: hands-off fleet onboarding.
//
// Where `init` needs a per-server collector key (gmk_cru_live_...) that a
// human already minted in the dashboard, `enroll` takes ONE account-scoped
// key (gmk_acct_live_..., write scope) that can be baked into an Ansible /
// cloud-init / post-install run and shared across the whole fleet. Each host:
//
//   1. Derives its stable machine identity (DMI product_uuid or machine-id).
//   2. POSTs it to the dashboard, which self-registers the server and returns
//      that host's own collector key. Re-running maps back to the SAME server
//      (identity dedup, migration 033) instead of creating a duplicate.
//   3. Hands the returned collector key to the exact same config + systemd
//      path as `init`.
//
// The account key is used only for that one POST and is NEVER written to disk;
// only the per-server collector key lands in /etc/glassmkr/crucible.yaml. So a
// stolen box yields one collector key (revocable, single-server), not the
// fleet-wide account key.

import {
  runInit, defaultDeps, DEFAULT_INGEST_URL, DEFAULT_CONFIG_PATH,
  type InitDeps,
} from "./init.js";
import { readMachineId, type MachineId } from "./lib/machine-id.js";

const DEFAULT_DASHBOARD_URL = "https://app.glassmkr.com";

// gmk_acct_live_<base>[_<4>]. Kept deliberately loose (prefix + min length)
// so a dashboard-side key-format tweak does not silently reject valid keys;
// the authoritative check is the dashboard rejecting a bad key with 401/403.
const ACCT_KEY_RE = /^gmk_acct_live_[A-Za-z0-9_]{8,}$/;

export interface EnrollOptions {
  accountKey: string; // raw; the literal "-" means "read from stdin"
  name?: string;
  dashboardUrl?: string; // base or full ingest URL; normalised below
  configPath?: string;
  tags?: string[];
  noStart?: boolean;
  force?: boolean;
  noVerify?: boolean;
}

export interface EnrollDeps extends InitDeps {
  // POST JSON and return the parsed body. Separate from InitDeps.fetch (which
  // is a status-only GET probe) because enroll needs the response body.
  postJson: (
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ) => Promise<{ status: number; json: any }>;
  readMachineId: () => MachineId | null;
}

// Strip a trailing slash and an accidental /api/v1/ingest suffix so callers
// can pass either the dashboard base or the ingest URL they already know.
export function normalizeDashboardBase(raw: string): string {
  return raw.replace(/\/+$/, "").replace(/\/api\/v1\/ingest$/, "");
}

export async function runEnroll(opts: EnrollOptions, deps: EnrollDeps): Promise<number> {
  let accountKey = opts.accountKey;
  if (accountKey !== "-") {
    deps.warn("[enroll] WARNING: literal --account-key values are visible in process listings and shell history. Prefer --account-key - and provide the key on stdin.");
  }
  if (accountKey === "-") {
    try {
      accountKey = (await deps.readStdin()).replace(/\r?\n$/, "").trim();
    } catch (err: any) {
      deps.error(`[enroll] failed to read account key from stdin: ${err?.message ?? err}`);
      return 1;
    }
  }
  if (!ACCT_KEY_RE.test(accountKey)) {
    deps.error(`[enroll] invalid --account-key: must look like "gmk_acct_live_<...>". Create a write-scoped account key in Settings -> API keys.`);
    return 2;
  }

  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;

  // Client-side idempotency: if the host is already configured, do nothing
  // (and do NOT call the API, so a re-run of the playbook never needlessly
  // rotates the collector key). --force re-enrolls and rotates.
  if (deps.fs.existsSync(configPath) && !opts.force) {
    deps.log(`[enroll] already configured at ${configPath}; nothing to do. Use --force to re-enroll (rotates the collector key).`);
    return 0;
  }

  const machine = deps.readMachineId();
  if (machine) {
    deps.log(`[enroll] machine identity: ${machine.id} (source: ${machine.source})`);
  } else {
    deps.warn(`[enroll] no stable machine id (no readable product_uuid or /etc/machine-id); enrolling without dedup. A re-run may create a duplicate server.`);
  }

  const base = normalizeDashboardBase(opts.dashboardUrl ?? DEFAULT_DASHBOARD_URL);
  const serversUrl = `${base}/api/v1/servers`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accountKey}`,
    "Content-Type": "application/json",
  };
  // A stable Idempotency-Key gives a second, short-window guard on top of the
  // durable machine_id dedup (protects a burst of retries within 24h).
  if (machine) headers["Idempotency-Key"] = `enroll-${machine.id}`;

  const body: Record<string, unknown> = { hostname: deps.hostname() };
  if (machine) body.machine_id = machine.id;
  if (opts.name && opts.name.trim()) body.name = opts.name.trim();
  if (opts.tags && opts.tags.length) body.tags = opts.tags;

  deps.log(`[enroll] registering with ${serversUrl} ...`);
  let resp: { status: number; json: any };
  try {
    resp = await deps.postJson(serversUrl, body, headers);
  } catch (err: any) {
    deps.error(`[enroll] could not reach ${serversUrl}: ${err?.message ?? err}`);
    return 8;
  }

  if (resp.status === 401 || resp.status === 403) {
    deps.error(`[enroll] account key rejected (HTTP ${resp.status}). Check the key and that it has 'write' scope.`);
    return 3;
  }
  if (resp.status === 402) {
    deps.error(`[enroll] ${resp.json?.message ?? "server limit reached or server suspended"} (HTTP 402).`);
    return 10;
  }
  if (resp.status === 409) {
    deps.error(`[enroll] concurrent enrollment for this machine (HTTP 409). Re-run to pick up the existing registration.`);
    return 11;
  }
  if (resp.status === 429) {
    deps.error(`[enroll] rate limited (HTTP 429). Wait and re-run.`);
    return 13;
  }
  if (resp.status !== 200 && resp.status !== 201) {
    deps.error(`[enroll] server registration failed (HTTP ${resp.status}): ${JSON.stringify(resp.json).slice(0, 200)}`);
    return 12;
  }

  const collectorKey: string | undefined = resp.json?.server?.collector_key ?? resp.json?.server?.api_key;
  const ingestUrl: string = resp.json?.ingest_url ?? DEFAULT_INGEST_URL;
  if (!collectorKey) {
    deps.error(`[enroll] registration succeeded (HTTP ${resp.status}) but no collector key in the response.`);
    return 12;
  }
  deps.log(
    resp.json?.reenrolled
      ? `[enroll] machine already registered as ${resp.json?.server?.id}; collector key rotated.`
      : `[enroll] registered new server ${resp.json?.server?.id}.`,
  );

  // Hand the freshly-issued collector key to the shared init path (config +
  // privilege separation + systemd unit + start). The account key is not
  // passed on and never touches disk. The key was just accepted by the API,
  // so the connectivity probe is redundant -> default to skipping it.
  return runInit(
    {
      apiKey: collectorKey,
      name: opts.name,
      ingestUrl,
      configPath: opts.configPath,
      noStart: opts.noStart,
      force: opts.force,
      noVerify: opts.noVerify ?? true,
      apiKeyFromArgv: false,
    },
    deps,
  );
}

/**
 * Default IO bindings for enroll: the real init deps plus a JSON POST helper
 * and the real machine-id reader.
 */
export function defaultEnrollDeps(): EnrollDeps {
  return {
    ...defaultDeps(),
    postJson: async (url, body, headers) => {
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      let json: any = null;
      try {
        json = await r.json();
      } catch {
        json = null;
      }
      return { status: r.status, json };
    },
    readMachineId: () => readMachineId(),
  };
}
