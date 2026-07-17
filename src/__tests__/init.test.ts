import { describe, it, expect, beforeEach } from "vitest";
import { runInit, isValidApiKey, buildCollectorYaml, buildSystemdUnit, setupPrivilegeSeparation, type InitDeps, SYSTEMD_UNIT_PATH, DEFAULT_CONFIG_PATH, LEGACY_CONFIG_PATH } from "../init.js";
import { WRAPPER_PATH } from "../lib/privileged.js";

const VALID_NEW_KEY = "gmk_cru_live_abcdefghijklmnopqrstuvwx_a1b2";
const VALID_LEGACY_KEY = "col_abcdef0123456789abcdef0123456789ab";

interface FakeFs {
  files: Map<string, { data: string; mode: number; uid?: number; gid?: number; symlink?: boolean }>;
  dirs: Set<string>;
}

function makeDeps(opts?: {
  preExistingFiles?: string[];
  preExistingFileData?: Record<string, string>;
  binPath?: string | null;
  systemctlExitCode?: number | null;
  fetchStatus?: number;
  fetchThrows?: boolean;
  stdin?: string;
}): { deps: InitDeps; fs: FakeFs; logs: string[]; warns: string[]; errors: string[]; systemctlCalls: string[][] } {
  const fs: FakeFs = { files: new Map(), dirs: new Set() };
  for (const f of opts?.preExistingFiles ?? []) fs.files.set(f, { data: opts?.preExistingFileData?.[f] ?? "stale", mode: 0o600 });

  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const systemctlCalls: string[][] = [];

  const deps: InitDeps = {
    fs: {
      existsSync: (p) => fs.files.has(p),
      mkdirSync: (p) => { fs.dirs.add(p); },
      // A freshly written file is owned by the writing process (root, in the
      // real install), so default uid/gid to 0.
      writeFileSync: (p, data, o) => { fs.files.set(p, { data, mode: o?.mode ?? 0o644, uid: 0, gid: 0 }); },
      chmodSync: (p, mode) => {
        const f = fs.files.get(p);
        if (f) f.mode = mode;
      },
      chownSync: (p, uid, gid) => {
        const f = fs.files.get(p);
        if (!f) throw new Error(`ENOENT: ${p}`);
        f.uid = uid; f.gid = gid;
      },
      lstatSync: (p) => {
        const f = fs.files.get(p);
        if (!f) throw new Error(`ENOENT: ${p}`);
        return { isSymbolicLink: !!f.symlink, uid: f.uid ?? 0, gid: f.gid ?? 0, mode: f.mode };
      },
      renameSync: (from, to) => {
        const f = fs.files.get(from);
        if (!f) throw new Error(`ENOENT: ${from}`);
        fs.files.set(to, f);
        fs.files.delete(from);
      },
    },
    exec: (cmd, args) => {
      if (cmd === "command" && args[0] === "-v" && args[1] === "glassmkr-crucible") {
        return { stdout: opts?.binPath === null ? "" : `${opts?.binPath ?? "/usr/local/bin/glassmkr-crucible"}\n`, status: 0 };
      }
      if (cmd === "which" && args[0] === "glassmkr-crucible") {
        return { stdout: opts?.binPath === null ? "" : `${opts?.binPath ?? "/usr/local/bin/glassmkr-crucible"}\n`, status: 0 };
      }
      if (cmd === "systemctl") {
        systemctlCalls.push(args);
        return { stdout: "", status: opts?.systemctlExitCode ?? 0 };
      }
      return { stdout: "", status: 0 };
    },
    hostname: () => "test-host-01",
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    fetch: async () => {
      if (opts?.fetchThrows) throw new Error("network down");
      return { status: opts?.fetchStatus ?? 200 };
    },
    readStdin: async () => opts?.stdin ?? "",
  };
  return { deps, fs, logs, warns, errors, systemctlCalls };
}

describe("isValidApiKey", () => {
  it("accepts the new gmk_cru_live_<...>_<4> format", () => {
    expect(isValidApiKey(VALID_NEW_KEY)).toBe(true);
  });
  it("accepts the legacy col_<hex> format", () => {
    expect(isValidApiKey(VALID_LEGACY_KEY)).toBe(true);
  });
  it("rejects forge_ session tokens", () => {
    expect(isValidApiKey("forge_abc123")).toBe(false);
  });
  it("rejects random strings", () => {
    expect(isValidApiKey("just-some-string")).toBe(false);
  });
  it("rejects empty / whitespace", () => {
    expect(isValidApiKey("")).toBe(false);
    expect(isValidApiKey("   ")).toBe(false);
    expect(isValidApiKey("gmk_cru_live_abc def_1234")).toBe(false);
  });
});

describe("buildCollectorYaml", () => {
  it("emits a parseable YAML with name, url, key", () => {
    const y = buildCollectorYaml("web-01", "https://app.glassmkr.com/api/v1/ingest", VALID_NEW_KEY);
    expect(y).toContain('server_name: "web-01"');
    expect(y).toContain('url: "https://app.glassmkr.com"');
    expect(y).toContain(`api_key: "${VALID_NEW_KEY}"`);
  });
  it("strips /api/v1/ingest from the URL when present", () => {
    const y = buildCollectorYaml("h", "https://dashboard.example.com/api/v1/ingest", VALID_NEW_KEY);
    expect(y).toContain('url: "https://dashboard.example.com"');
    expect(y).not.toContain("/api/v1/ingest");
  });
  it("escapes embedded double quotes in name", () => {
    const y = buildCollectorYaml('we"ird', "https://x", VALID_NEW_KEY);
    expect(y).toContain('server_name: "we\\"ird"');
  });
});

describe("buildSystemdUnit", () => {
  it("references the dynamic binary path with the config path", () => {
    const u = buildSystemdUnit("/usr/local/bin/glassmkr-crucible", "/etc/glassmkr/crucible.yaml");
    expect(u).toContain("ExecStart=/usr/local/bin/glassmkr-crucible /etc/glassmkr/crucible.yaml");
    expect(u).toContain("Type=simple");
    expect(u).toContain("Restart=always");
  });
});

describe("runInit", () => {
  let configPath: string;
  beforeEach(() => { configPath = "/tmp/init-test-collector.yaml"; });

  it("rejects malformed --api-key with exit code 2", async () => {
    const { deps, errors } = makeDeps();
    const code = await runInit({ apiKey: "nope", configPath, noVerify: true }, deps);
    expect(code).toBe(2);
    expect(errors[0]).toContain("invalid --api-key");
  });

  it("happy path: writes config (0600) + systemd unit (0644), enables service", async () => {
    const { deps, fs, systemctlCalls } = makeDeps();
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true }, deps);
    expect(code).toBe(0);
    const yaml = fs.files.get(configPath);
    expect(yaml?.mode).toBe(0o600);
    expect(yaml?.data).toContain(VALID_NEW_KEY);
    const unit = fs.files.get(SYSTEMD_UNIT_PATH);
    expect(unit?.mode).toBe(0o644);
    expect(unit?.data).toContain("ExecStart=/usr/local/bin/glassmkr-crucible /tmp/init-test-collector.yaml");
    expect(systemctlCalls).toContainEqual(["daemon-reload"]);
    expect(systemctlCalls).toContainEqual(["enable", "--now", "glassmkr-crucible"]);
  });

  it("--no-start: skips enable but still daemon-reloads", async () => {
    const { deps, systemctlCalls } = makeDeps();
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true, noStart: true }, deps);
    expect(code).toBe(0);
    expect(systemctlCalls).toContainEqual(["daemon-reload"]);
    expect(systemctlCalls.find((c) => c[0] === "enable")).toBeUndefined();
  });

  it("refuses to overwrite an existing config without --force", async () => {
    const { deps, errors } = makeDeps({ preExistingFiles: [configPath] });
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true }, deps);
    expect(code).toBe(4);
    expect(errors[0]).toContain("config already exists");
  });

  it("--force overwrites an existing config", async () => {
    const { deps, fs } = makeDeps({ preExistingFiles: [configPath] });
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true, force: true }, deps);
    expect(code).toBe(0);
    expect(fs.files.get(configPath)?.data).toContain(VALID_NEW_KEY);
  });

  it("reads --api-key from stdin when value is '-'", async () => {
    const { deps, fs } = makeDeps({ stdin: VALID_LEGACY_KEY + "\n" });
    const code = await runInit({ apiKey: "-", configPath, noVerify: true }, deps);
    expect(code).toBe(0);
    expect(fs.files.get(configPath)?.data).toContain(VALID_LEGACY_KEY);
  });

  it("aborts when binary not on PATH (exit code 7)", async () => {
    const { deps, errors } = makeDeps({ binPath: null });
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true }, deps);
    expect(code).toBe(7);
    expect(errors[errors.length - 1]).toContain("could not locate the glassmkr-crucible binary");
  });

  it("connectivity probe: 401 from ingest endpoint -> exit code 3", async () => {
    const { deps, errors } = makeDeps({ fetchStatus: 401 });
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath }, deps);
    expect(code).toBe(3);
    expect(errors[0]).toContain("api key rejected");
  });

  it("connectivity probe: 5xx warns but continues", async () => {
    const { deps, warns } = makeDeps({ fetchStatus: 502 });
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath }, deps);
    expect(code).toBe(0);
    expect(warns.some((w) => w.includes("502"))).toBe(true);
  });

  it("connectivity probe: network error warns and continues", async () => {
    const { deps, warns } = makeDeps({ fetchThrows: true });
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath }, deps);
    expect(code).toBe(0);
    expect(warns.some((w) => w.includes("connectivity probe failed"))).toBe(true);
  });

  it("--name overrides hostname", async () => {
    const { deps, fs } = makeDeps();
    await runInit({ apiKey: VALID_NEW_KEY, name: "custom-name", configPath, noVerify: true }, deps);
    expect(fs.files.get(configPath)?.data).toContain('server_name: "custom-name"');
  });

  it("falls back to hostname when --name not provided", async () => {
    const { deps, fs } = makeDeps();
    await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true }, deps);
    expect(fs.files.get(configPath)?.data).toContain('server_name: "test-host-01"');
  });

  it("--ingest-url override is reflected in collector.yaml", async () => {
    const { deps, fs } = makeDeps();
    await runInit({ apiKey: VALID_NEW_KEY, ingestUrl: "https://dashboard.example.com/api/v1/ingest", configPath, noVerify: true }, deps);
    expect(fs.files.get(configPath)?.data).toContain('url: "https://dashboard.example.com"');
  });

  it("systemctl enable failure surfaces as exit code 9", async () => {
    const { deps, errors } = makeDeps({ systemctlExitCode: 1 });
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true }, deps);
    expect(code).toBe(9);
    expect(errors[errors.length - 1]).toContain("systemctl enable --now");
  });
});

describe("runInit legacy config migration", () => {
  it("renames /etc/glassmkr/collector.yaml -> crucible.yaml when initing into the canonical path and the new file is absent", async () => {
    const LEGACY_CONTENT = '# user-edited\nserver_name: "preserved-by-rename"\ntelegram:\n  bot_token: "secret-do-not-rewrite"\n';
    const { deps, fs, logs, systemctlCalls } = makeDeps({
      preExistingFiles: [LEGACY_CONFIG_PATH],
      preExistingFileData: { [LEGACY_CONFIG_PATH]: LEGACY_CONTENT },
    });
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath: DEFAULT_CONFIG_PATH, noVerify: true }, deps);
    expect(code).toBe(0);
    // Legacy file moved.
    expect(fs.files.has(LEGACY_CONFIG_PATH)).toBe(false);
    // New file holds the exact original content (no rewrite preserves operator edits).
    const moved = fs.files.get(DEFAULT_CONFIG_PATH);
    expect(moved?.data).toBe(LEGACY_CONTENT);
    // Migration log line surfaced.
    expect(logs.some((l) => l.includes("migrated legacy config"))).toBe(true);
    // Systemd unit was still written and points at the new path; daemon-reload ran.
    const unit = fs.files.get(SYSTEMD_UNIT_PATH);
    expect(unit?.data).toContain(`ExecStart=/usr/local/bin/glassmkr-crucible ${DEFAULT_CONFIG_PATH}`);
    expect(systemctlCalls).toContainEqual(["daemon-reload"]);
  });

  it("--force after a legacy migration regenerates the config from scratch", async () => {
    const LEGACY_CONTENT = '# user-edited\nserver_name: "old"\n';
    const { deps, fs } = makeDeps({
      preExistingFiles: [LEGACY_CONFIG_PATH],
      preExistingFileData: { [LEGACY_CONFIG_PATH]: LEGACY_CONTENT },
    });
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath: DEFAULT_CONFIG_PATH, noVerify: true, force: true }, deps);
    expect(code).toBe(0);
    expect(fs.files.has(LEGACY_CONFIG_PATH)).toBe(false);
    // --force overrides preservation: file was rewritten with the freshly-generated YAML.
    const after = fs.files.get(DEFAULT_CONFIG_PATH);
    expect(after?.data).toContain(VALID_NEW_KEY);
    expect(after?.data).not.toBe(LEGACY_CONTENT);
  });

  it("warns and leaves the legacy file alone when both files exist", async () => {
    const { deps, fs, warns } = makeDeps({
      preExistingFiles: [LEGACY_CONFIG_PATH, DEFAULT_CONFIG_PATH],
    });
    // The existing-without-force guard kicks in next, so exit 4. The warn must already have fired.
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath: DEFAULT_CONFIG_PATH, noVerify: true }, deps);
    expect(code).toBe(4);
    expect(fs.files.has(LEGACY_CONFIG_PATH)).toBe(true);
    expect(warns.some((w) => w.includes("both") && w.includes(LEGACY_CONFIG_PATH))).toBe(true);
  });

  it("does not migrate when --config-path points somewhere other than the canonical path", async () => {
    // Operator using a non-default config path: legacy file at /etc/glassmkr/collector.yaml
    // is none of our business; leave it alone.
    const { deps, fs } = makeDeps({
      preExistingFiles: [LEGACY_CONFIG_PATH],
      preExistingFileData: { [LEGACY_CONFIG_PATH]: "# legacy content" },
    });
    const customPath = "/etc/custom/path.yaml";
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath: customPath, noVerify: true }, deps);
    expect(code).toBe(0);
    // Legacy still in place, untouched.
    expect(fs.files.get(LEGACY_CONFIG_PATH)?.data).toBe("# legacy content");
    expect(fs.files.has(customPath)).toBe(true);
  });
});

describe("setupPrivilegeSeparation wrapper hardening (Codex #6)", () => {
  it("installs the wrapper root-owned (0:0), mode 0755, and returns true on a clean host", () => {
    const { deps, fs } = makeDeps();
    const ok = setupPrivilegeSeparation(deps, DEFAULT_CONFIG_PATH);
    expect(ok).toBe(true);
    const w = fs.files.get(WRAPPER_PATH);
    expect(w?.uid).toBe(0);
    expect(w?.gid).toBe(0);
    expect(w?.mode).toBe(0o755);
    expect(w?.data).toContain("Glassmkr Crucible privileged-collection facade");
    // The temp file was renamed away, not left behind.
    expect(fs.files.has(`${WRAPPER_PATH}.tmp`)).toBe(false);
  });

  it("forces root ownership even when a service-user-owned wrapper pre-exists (privesc vector)", () => {
    const { deps, fs } = makeDeps();
    // Simulate the attack precondition: WRAPPER_PATH already exists owned by the
    // unprivileged service user (uid 999). The old code writeFileSync'd over it,
    // preserving that ownership, while still installing the NOPASSWD sudo rule.
    fs.files.set(WRAPPER_PATH, { data: "#!/bin/sh\nmalicious\n", mode: 0o755, uid: 999, gid: 999 });
    const ok = setupPrivilegeSeparation(deps, DEFAULT_CONFIG_PATH);
    expect(ok).toBe(true);
    const w = fs.files.get(WRAPPER_PATH);
    expect(w?.uid).toBe(0); // ownership forced back to root by the rename
    expect(w?.data).not.toContain("malicious");
  });

  it("stays on User=root (returns false) when the wrapper cannot be made root-owned", () => {
    const { deps, warns } = makeDeps();
    (deps.fs as { chownSync: (p: string, u: number, g: number) => void }).chownSync = () => {
      throw new Error("EPERM"); // e.g. init not actually running as root
    };
    const ok = setupPrivilegeSeparation(deps, DEFAULT_CONFIG_PATH);
    expect(ok).toBe(false);
    expect(warns.some((w) => w.includes("could not install wrapper"))).toBe(true);
  });

  it("rejects a wrapper that verifies as a symlink (returns false)", () => {
    const { deps, warns } = makeDeps();
    (deps.fs as { lstatSync: (p: string) => { isSymbolicLink: boolean; uid: number; gid: number; mode: number } }).lstatSync =
      () => ({ isSymbolicLink: true, uid: 0, gid: 0, mode: 0o755 });
    const ok = setupPrivilegeSeparation(deps, DEFAULT_CONFIG_PATH);
    expect(ok).toBe(false);
    expect(warns.some((w) => w.includes("failed its post-install safety check"))).toBe(true);
  });

  it("rejects a group/world-writable wrapper (returns false)", () => {
    const { deps, warns } = makeDeps();
    (deps.fs as { lstatSync: (p: string) => { isSymbolicLink: boolean; uid: number; gid: number; mode: number } }).lstatSync =
      () => ({ isSymbolicLink: false, uid: 0, gid: 0, mode: 0o777 });
    const ok = setupPrivilegeSeparation(deps, DEFAULT_CONFIG_PATH);
    expect(ok).toBe(false);
    expect(warns.some((w) => w.includes("failed its post-install safety check"))).toBe(true);
  });
});
