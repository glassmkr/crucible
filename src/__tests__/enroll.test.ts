import { describe, it, expect } from "vitest";
import { runEnroll, normalizeDashboardBase, type EnrollDeps } from "../enroll.js";
import { DEFAULT_CONFIG_PATH } from "../init.js";
import type { MachineId } from "../lib/machine-id.js";

// Obviously-fake fixtures (low-entropy patterned suffix so the secret scanner
// does not treat them as live keys); still valid per the enroll/init regexes.
const ACCT_KEY = "gmk_acct_live_EXAMPLEEXAMPLE0000_ex01"; // gitleaks:allow
const COLLECTOR_KEY = "gmk_cru_live_EXAMPLEEXAMPLE000000_ex02"; // gitleaks:allow
const MACHINE: MachineId = { id: "4c4c4544-0042-3010-8058-b4c04f584a33", source: "product_uuid" };

interface Harness {
  deps: EnrollDeps;
  files: Map<string, { data: string; mode: number }>;
  logs: string[];
  warns: string[];
  errors: string[];
  posts: { url: string; body: any; headers: Record<string, string> }[];
}

function makeDeps(opts?: {
  preExisting?: string[];
  machine?: MachineId | null;
  postStatus?: number;
  postJson?: any;
  postThrows?: boolean;
  stdin?: string;
}): Harness {
  const files = new Map<string, { data: string; mode: number; uid?: number; gid?: number; symlink?: boolean }>();
  for (const f of opts?.preExisting ?? []) files.set(f, { data: "stale", mode: 0o600 });
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const posts: Harness["posts"] = [];

  const deps: EnrollDeps = {
    fs: {
      existsSync: (p) => files.has(p),
      mkdirSync: () => {},
      writeFileSync: (p, data, o) => { files.set(p, { data, mode: o?.mode ?? 0o644, uid: 0, gid: 0 }); },
      chmodSync: (p, mode) => { const f = files.get(p); if (f) f.mode = mode; },
      chownSync: (p, uid, gid) => { const f = files.get(p); if (!f) throw new Error(`ENOENT: ${p}`); f.uid = uid; f.gid = gid; },
      lstatSync: (p) => {
        const f = files.get(p);
        // Untracked path (e.g. the wrapper's parent dir): a normal root-owned 0755 dir.
        if (!f) return { isSymbolicLink: false, uid: 0, gid: 0, mode: 0o755 };
        return { isSymbolicLink: !!f.symlink, uid: f.uid ?? 0, gid: f.gid ?? 0, mode: f.mode };
      },
      renameSync: (from, to) => { const f = files.get(from); if (f) { files.set(to, f); files.delete(from); } },
      unlinkSync: (p) => { files.delete(p); },
    },
    exec: (cmd) => {
      if (cmd === "command" || cmd === "which") return { stdout: "/usr/local/bin/glassmkr-crucible\n", status: 0 };
      return { stdout: "", status: 0 };
    },
    hostname: () => "web-01",
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    fetch: async () => ({ status: 200 }),
    readStdin: async () => opts?.stdin ?? "",
    postJson: async (url, body, headers) => {
      posts.push({ url, body, headers });
      if (opts?.postThrows) throw new Error("network down");
      return {
        status: opts?.postStatus ?? 201,
        json: opts?.postJson ?? { success: true, server: { id: "srv_abc123", collector_key: COLLECTOR_KEY }, ingest_url: "https://app.glassmkr.com/api/v1/ingest" },
      };
    },
    readMachineId: () => (opts?.machine === undefined ? MACHINE : opts.machine),
  };
  return { deps, files, logs, warns, errors, posts };
}

describe("normalizeDashboardBase", () => {
  it("strips a trailing slash", () => {
    expect(normalizeDashboardBase("https://app.glassmkr.com/")).toBe("https://app.glassmkr.com");
  });
  it("strips an accidental /api/v1/ingest suffix", () => {
    expect(normalizeDashboardBase("https://app.glassmkr.com/api/v1/ingest")).toBe("https://app.glassmkr.com");
  });
});

describe("runEnroll", () => {
  it("posts machine_id + Idempotency-Key + Bearer account key, then writes the collector key", async () => {
    const h = makeDeps();
    const code = await runEnroll({ accountKey: ACCT_KEY, name: "web-01" }, h.deps);
    expect(code).toBe(0);
    expect(h.posts).toHaveLength(1);
    const post = h.posts[0];
    expect(post.url).toBe("https://app.glassmkr.com/api/v1/servers");
    expect(post.body.machine_id).toBe(MACHINE.id);
    expect(post.body.hostname).toBe("web-01");
    expect(post.headers.Authorization).toBe(`Bearer ${ACCT_KEY}`);
    expect(post.headers["Idempotency-Key"]).toBe(`enroll-${MACHINE.id}`);
    const config = h.files.get(DEFAULT_CONFIG_PATH);
    expect(config?.data).toContain(`api_key: "${COLLECTOR_KEY}"`);
  });

  it("NEVER writes the account key to disk", async () => {
    const h = makeDeps();
    await runEnroll({ accountKey: ACCT_KEY }, h.deps);
    for (const [, f] of h.files) {
      expect(f.data).not.toContain(ACCT_KEY);
    }
  });

  it("is a no-op when already configured (no POST, no key rotation)", async () => {
    const h = makeDeps({ preExisting: [DEFAULT_CONFIG_PATH] });
    const code = await runEnroll({ accountKey: ACCT_KEY }, h.deps);
    expect(code).toBe(0);
    expect(h.posts).toHaveLength(0);
    expect(h.logs.join("\n")).toContain("already configured");
  });

  it("re-enrolls with --force even when configured", async () => {
    const h = makeDeps({ preExisting: [DEFAULT_CONFIG_PATH] });
    const code = await runEnroll({ accountKey: ACCT_KEY, force: true }, h.deps);
    expect(code).toBe(0);
    expect(h.posts).toHaveLength(1);
  });

  it("rejects a malformed account key before any network call", async () => {
    const h = makeDeps();
    const code = await runEnroll({ accountKey: "gmk_cru_live_not_an_account_key" }, h.deps);
    expect(code).toBe(2);
    expect(h.posts).toHaveLength(0);
  });

  it("surfaces a 401 as a clear account-key error", async () => {
    const h = makeDeps({ postStatus: 401, postJson: { error: "unauthorized" } });
    const code = await runEnroll({ accountKey: ACCT_KEY }, h.deps);
    expect(code).toBe(3);
    expect(h.errors.join("\n")).toContain("rejected");
  });

  it("surfaces a 402 quota/suspended message", async () => {
    const h = makeDeps({ postStatus: 402, postJson: { message: "Server limit reached (3 on your plan)." } });
    const code = await runEnroll({ accountKey: ACCT_KEY }, h.deps);
    expect(code).toBe(10);
    expect(h.errors.join("\n")).toContain("Server limit reached");
  });

  it("enrolls without machine_id (and without Idempotency-Key) when none is available", async () => {
    const h = makeDeps({ machine: null });
    const code = await runEnroll({ accountKey: ACCT_KEY }, h.deps);
    expect(code).toBe(0);
    expect(h.posts[0].body.machine_id).toBeUndefined();
    expect(h.posts[0].headers["Idempotency-Key"]).toBeUndefined();
    expect(h.warns.join("\n")).toContain("without dedup");
  });

  it("accepts the re-enroll (200) response and uses the rotated key", async () => {
    const h = makeDeps({ postStatus: 200, postJson: { success: true, reenrolled: true, server: { id: "srv_abc123", collector_key: COLLECTOR_KEY }, ingest_url: "https://app.glassmkr.com/api/v1/ingest" } });
    const code = await runEnroll({ accountKey: ACCT_KEY }, h.deps);
    expect(code).toBe(0);
    expect(h.logs.join("\n")).toContain("collector key rotated");
  });

  it("reads the account key from stdin when passed '-'", async () => {
    const h = makeDeps({ stdin: ACCT_KEY + "\n" });
    const code = await runEnroll({ accountKey: "-" }, h.deps);
    expect(code).toBe(0);
    expect(h.posts[0].headers.Authorization).toBe(`Bearer ${ACCT_KEY}`);
  });
});
