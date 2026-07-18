import { describe, it, expect, beforeEach } from "vitest";
import { runInit, isValidApiKey, buildCollectorYaml, buildSystemdUnit, setupPrivilegeSeparation, type InitDeps, SYSTEMD_UNIT_PATH, DEFAULT_CONFIG_PATH, LEGACY_CONFIG_PATH, ROOT_FALLBACK_ENV } from "../init.js";
import { WRAPPER_PATH, SUDOERS_PATH } from "../lib/privileged.js";

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
  fetchLocation?: string;
  resolveThrows?: boolean;
  resolveAddresses?: Array<{ address: string; family: 4 | 6 }>;
  stdin?: string;
  privilegeSetupFails?: boolean;
  serviceUserCreateFails?: boolean;
  rootFallbackEnv?: string;
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
      writeSecureFileSync: (p, data, mode) => {
        if (fs.files.has(p)) throw new Error(`EEXIST: ${p}`);
        fs.files.set(p, { data, mode, uid: 0, gid: 0 });
      },
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
        const expectedBin = opts?.binPath ?? "/usr/local/bin/glassmkr-crucible";
        // Untracked path (e.g. the wrapper's parent dir): model a normal
        // root-owned 0755 directory so the parent-dir trust check passes.
        if (!f) return p === expectedBin
          ? { isSymbolicLink: false, isFile: true, isDirectory: false, uid: 0, gid: 0, mode: 0o755 }
          : { isSymbolicLink: false, isFile: false, isDirectory: true, uid: 0, gid: 0, mode: 0o755 };
        return { isSymbolicLink: !!f.symlink, isFile: !f.symlink, isDirectory: false, uid: f.uid ?? 0, gid: f.gid ?? 0, mode: f.mode };
      },
      realpathSync: (p) => p,
      renameSync: (from, to) => {
        const f = fs.files.get(from);
        if (!f) throw new Error(`ENOENT: ${from}`);
        fs.files.set(to, f);
        fs.files.delete(from);
      },
      unlinkSync: (p) => { fs.files.delete(p); },
    },
    exec: (cmd, args) => {
      if (opts?.serviceUserCreateFails && cmd === "id" && args[0] === "-u") return { stdout: "", status: 1 };
      if (opts?.serviceUserCreateFails && cmd === "useradd") return { stdout: "", status: 1 };
      if (cmd === "command" && args[0] === "-v" && args[1] === "glassmkr-crucible") {
        return { stdout: opts?.binPath === null ? "" : `${opts?.binPath ?? "/usr/local/bin/glassmkr-crucible"}\n`, status: 0 };
      }
      if (cmd === "which" && args[0] === "glassmkr-crucible") {
        return { stdout: opts?.binPath === null ? "" : `${opts?.binPath ?? "/usr/local/bin/glassmkr-crucible"}\n`, status: 0 };
      }
      if (cmd === "id" && args[0] === "-G") return { stdout: "1000\n", status: 0 };
      if (cmd === "id" && args[0] === "-u") return { stdout: "1000\n", status: 0 };
      if (cmd === "systemctl") {
        systemctlCalls.push(args);
        return { stdout: "", status: opts?.systemctlExitCode ?? 0 };
      }
      if (cmd === "visudo" && opts?.privilegeSetupFails) return { stdout: "", status: 1 };
      return { stdout: "", status: 0 };
    },
    hostname: () => "test-host-01",
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    fetch: async () => {
      if (opts?.fetchThrows) throw new Error("network down");
      return new Response(null, {
        status: opts?.fetchStatus ?? 200,
        headers: opts?.fetchLocation ? { location: opts.fetchLocation } : undefined,
      });
    },
    resolveEndpoint: async () => {
      if (opts?.resolveThrows) throw new Error("endpoint resolved to a private address");
      return opts?.resolveAddresses ?? [{ address: "203.0.113.10", family: 4 }];
    },
    readStdin: async () => opts?.stdin ?? "",
    env: opts?.rootFallbackEnv === undefined ? {} : { [ROOT_FALLBACK_ENV]: opts.rootFallbackEnv },
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
  it("persists endpoint policy exceptions for runtime pushes", () => {
    const y = buildCollectorYaml("h", "http://10.0.0.5/api/v1/ingest", VALID_NEW_KEY, {
      allowInsecure: true,
      allowedOrigins: ["https://ingest.internal.example"],
    });
    expect(y).toContain("allow_insecure_endpoint: true");
    expect(y).toContain('- "https://ingest.internal.example"');
  });
});

describe("buildSystemdUnit", () => {
  it("references the dynamic binary path with the config path", () => {
    const u = buildSystemdUnit("/usr/local/bin/glassmkr-crucible", "/etc/glassmkr/crucible.yaml");
    expect(u).toContain("ExecStart=/usr/local/bin/glassmkr-crucible /etc/glassmkr/crucible.yaml");
    expect(u).toContain("Type=simple");
    expect(u).toContain("Restart=always");
    expect(u).toContain("User=glassmkr");
    expect(u).toContain("ProtectHome=yes");
    expect(u).toContain("PrivateTmp=yes");
    expect(u).toContain("ProtectKernelTunables=yes");
    expect(u).toContain("ProtectControlGroups=yes");
    expect(u).toContain("LockPersonality=yes");
    expect(u).toContain("ProtectSystem=strict");
    expect(u).toContain("ReadWritePaths=/var/lib/glassmkr /var/lib/crucible");
    expect(u).not.toContain("NoNewPrivileges=");
    expect(u).not.toContain("RestrictSUIDSGID=");
  });

  it.each([
    ["/usr/local/bin/glassmkr-crucible\nExecStart=/bin/sh", "/etc/glassmkr/crucible.yaml"],
    ["/usr/local/bin/glassmkr-crucible", "/etc/glassmkr/%n.yaml"],
    ["/usr/local/bin/glassmkr-crucible", "relative.yaml"],
  ])("rejects unsafe binary or config paths", (binPath, configPath) => {
    expect(() => buildSystemdUnit(binPath, configPath)).toThrow(/unsafe/);
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

  it("warns when a literal API key is passed in argv", async () => {
    const { deps, warns } = makeDeps();
    await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true, noStart: true }, deps);
    expect(warns.some((message) => message.includes("process listings") && message.includes("--api-key -"))).toBe(true);
  });

  it("does not emit the argv warning when the API key is read from stdin", async () => {
    const { deps, warns } = makeDeps({ stdin: VALID_NEW_KEY });
    await runInit({ apiKey: "-", configPath, noVerify: true, noStart: true }, deps);
    expect(warns.some((message) => message.includes("process listings"))).toBe(false);
  });

  it("happy path: writes root-owned config (0640) + systemd unit (0644), enables service", async () => {
    const { deps, fs, systemctlCalls } = makeDeps();
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true }, deps);
    expect(code).toBe(0);
    const yaml = fs.files.get(configPath);
    expect(yaml?.mode).toBe(0o640);
    expect(yaml?.uid).toBe(0);
    expect(yaml?.gid).toBe(1000);
    expect(yaml?.data).toContain(VALID_NEW_KEY);
    const unit = fs.files.get(SYSTEMD_UNIT_PATH);
    expect(unit?.mode).toBe(0o644);
    expect(unit?.data).toContain("ExecStart=/usr/local/bin/glassmkr-crucible /tmp/init-test-collector.yaml");
    expect(systemctlCalls).toContainEqual(["daemon-reload"]);
    // enable persists across boot; a separate restart (not `enable --now`, which
    // only starts a stopped unit) applies unit changes even when the service is
    // already running (Codex 2026-07-18 #2).
    expect(systemctlCalls).toContainEqual(["enable", "glassmkr-crucible"]);
    expect(systemctlCalls).toContainEqual(["restart", "glassmkr-crucible"]);
    expect(systemctlCalls).not.toContainEqual(["enable", "--now", "glassmkr-crucible"]);
  });

  it("--no-start: skips enable but still daemon-reloads", async () => {
    const { deps, systemctlCalls } = makeDeps();
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true, noStart: true }, deps);
    expect(code).toBe(0);
    expect(systemctlCalls).toContainEqual(["daemon-reload"]);
    expect(systemctlCalls.find((c) => c[0] === "enable")).toBeUndefined();
  });

  it("repairs an existing service-owned config without a key and preserves content", async () => {
    const original = "# preserve exactly\nserver_name: old\n";
    const { deps, fs, logs } = makeDeps({
      preExistingFiles: [configPath],
      preExistingFileData: { [configPath]: original },
      resolveThrows: true,
    });
    const file = fs.files.get(configPath)!;
    file.uid = 1000;
    file.gid = 1000;
    file.mode = 0o600;

    const code = await runInit({ configPath, noVerify: true }, deps);
    expect(code).toBe(0);
    expect(fs.files.get(configPath)).toMatchObject({ data: original, uid: 0, gid: 1000, mode: 0o640 });
    expect(logs.some((message) => message.includes("preserving existing config"))).toBe(true);
  });

  it("still requires an api key when no config exists", async () => {
    const { deps, errors } = makeDeps();
    const code = await runInit({ configPath, noVerify: true }, deps);
    expect(code).toBe(2);
    expect(errors[0]).toContain("invalid --api-key");
  });

  it("refuses an existing group-writable config", async () => {
    const { deps, fs, errors } = makeDeps({ preExistingFiles: [configPath] });
    fs.files.get(configPath)!.mode = 0o620;
    const code = await runInit({ configPath, noVerify: true }, deps);
    expect(code).toBe(4);
    expect(errors.some((message) => message.includes("unsafe config target"))).toBe(true);
  });

  it("fails closed to the unprivileged service user when wrapper setup fails", async () => {
    const { deps, fs, errors } = makeDeps({ privilegeSetupFails: true });
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true, noStart: true }, deps);
    expect(code).toBe(0);
    expect(fs.files.get(SYSTEMD_UNIT_PATH)?.data).toContain("User=glassmkr");
    expect(errors.join("\n")).toContain("privileged collectors are unavailable");
  });

  it("uses root fallback only for the exact explicit environment override", async () => {
    const enabled = makeDeps({ privilegeSetupFails: true, rootFallbackEnv: "1" });
    expect(await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true, noStart: true }, enabled.deps)).toBe(0);
    expect(enabled.fs.files.get(SYSTEMD_UNIT_PATH)?.data).toContain("User=root");
    expect(enabled.warns.join("\n")).toContain("SECURITY OVERRIDE");

    const rejected = makeDeps({ privilegeSetupFails: true, rootFallbackEnv: "true" });
    expect(await runInit({ apiKey: VALID_NEW_KEY, configPath: `${configPath}.strict`, noVerify: true, noStart: true }, rejected.deps)).toBe(0);
    expect(rejected.fs.files.get(SYSTEMD_UNIT_PATH)?.data).toContain("User=glassmkr");
  });

  it("aborts when the unprivileged baseline cannot be created, even with the override", async () => {
    const { deps, fs, errors } = makeDeps({ serviceUserCreateFails: true, rootFallbackEnv: "1" });
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true, noStart: true }, deps);
    expect(code).toBe(10);
    expect(fs.files.has(SYSTEMD_UNIT_PATH)).toBe(false);
    expect(errors.join("\n")).toContain("failed closed");
  });

  it("--force overwrites an existing config", async () => {
    const { deps, fs } = makeDeps({ preExistingFiles: [configPath] });
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true, force: true }, deps);
    expect(code).toBe(0);
    expect(fs.files.get(configPath)?.data).toContain(VALID_NEW_KEY);
  });

  it("refuses a symlink config target even with --force", async () => {
    const { deps, fs, errors } = makeDeps({ preExistingFiles: [configPath] });
    const existing = fs.files.get(configPath)!;
    existing.symlink = true;
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true, force: true }, deps);
    expect(code).toBe(4);
    expect(errors.some((message) => message.includes("unsafe config target"))).toBe(true);
  });

  it("rejects systemd metacharacters in the config path", async () => {
    const { deps, errors } = makeDeps();
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath: "/etc/glassmkr/%n.yaml", noVerify: true }, deps);
    expect(code).toBe(5);
    expect(errors[0]).toContain("unsafe config path");
  });

  it("rejects a group-writable binary", async () => {
    const { deps, errors } = makeDeps();
    const original = deps.fs.lstatSync;
    deps.fs.lstatSync = (p) => p === "/usr/local/bin/glassmkr-crucible"
      ? { isSymbolicLink: false, isFile: true, isDirectory: false, uid: 0, gid: 0, mode: 0o775 }
      : original(p);
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true }, deps);
    expect(code).toBe(7);
    expect(errors.some((message) => message.includes("unsafe glassmkr-crucible binary"))).toBe(true);
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

  it("fails before writing when a private ingest endpoint is not allowed", async () => {
    const { deps, fs, errors } = makeDeps();
    const code = await runInit({ apiKey: VALID_NEW_KEY, ingestUrl: "http://10.0.0.5/api/v1/ingest", configPath, noVerify: true }, deps);
    expect(code).toBe(14);
    expect(fs.files.has(configPath)).toBe(false);
    expect(errors[0]).toContain("--allow-insecure-endpoint");
  });

  it("allows and persists an explicitly insecure private ingest endpoint", async () => {
    const { deps, fs } = makeDeps();
    const code = await runInit({
      apiKey: VALID_NEW_KEY,
      ingestUrl: "http://10.0.0.5/api/v1/ingest",
      configPath,
      noVerify: true,
      allowInsecureEndpoint: true,
    }, deps);
    expect(code).toBe(0);
    expect(fs.files.get(configPath)?.data).toContain("allow_insecure_endpoint: true");
  });

  it("rejects a probe redirect to a private endpoint before writing config", async () => {
    const { deps, fs, errors } = makeDeps({
      fetchStatus: 302,
      fetchLocation: "https://127.0.0.1/api/v1/ingest",
    });
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath }, deps);
    expect(code).toBe(14);
    expect(fs.files.has(configPath)).toBe(false);
    expect(errors.some((message) => message.includes("refusing ingest redirect"))).toBe(true);
  });

  it("systemctl restart failure surfaces as exit code 9", async () => {
    const { deps, errors } = makeDeps({ systemctlExitCode: 1 });
    const code = await runInit({ apiKey: VALID_NEW_KEY, configPath, noVerify: true }, deps);
    expect(code).toBe(9);
    expect(errors[errors.length - 1]).toContain("systemctl restart");
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
    const code = await runInit({ configPath: DEFAULT_CONFIG_PATH, noVerify: true }, deps);
    expect(code).toBe(0);
    expect(fs.files.has(LEGACY_CONFIG_PATH)).toBe(true);
    expect(fs.files.get(DEFAULT_CONFIG_PATH)).toMatchObject({ uid: 0, gid: 1000, mode: 0o640 });
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
    fs.files.set(DEFAULT_CONFIG_PATH, { data: "config", mode: 0o600, uid: 0, gid: 0 });
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
    fs.files.set(DEFAULT_CONFIG_PATH, { data: "config", mode: 0o600, uid: 0, gid: 0 });
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

  it("stays unprivileged (returns false) when the wrapper cannot be made root-owned", () => {
    const { deps, fs, warns } = makeDeps();
    fs.files.set(DEFAULT_CONFIG_PATH, { data: "config", mode: 0o600, uid: 0, gid: 0 });
    const realChown = deps.fs.chownSync;
    (deps.fs as { chownSync: (p: string, u: number, g: number) => void }).chownSync = (p, uid, gid) => {
      if (p === `${WRAPPER_PATH}.tmp`) throw new Error("EPERM");
      realChown(p, uid, gid);
    };
    const ok = setupPrivilegeSeparation(deps, DEFAULT_CONFIG_PATH);
    expect(ok).toBe(false);
    expect(warns.some((w) => w.includes("could not install wrapper"))).toBe(true);
  });

  it("rejects a wrapper that verifies as a symlink (returns false)", () => {
    const { deps, fs, warns } = makeDeps();
    fs.files.set(DEFAULT_CONFIG_PATH, { data: "config", mode: 0o600, uid: 0, gid: 0 });
    const realLstat = deps.fs.lstatSync;
    (deps.fs as { lstatSync: (p: string) => { isSymbolicLink: boolean; uid: number; gid: number; mode: number } }).lstatSync =
      (p) => p === WRAPPER_PATH
        ? { isSymbolicLink: true, uid: 0, gid: 0, mode: 0o755 }
        : realLstat(p);
    const ok = setupPrivilegeSeparation(deps, DEFAULT_CONFIG_PATH);
    expect(ok).toBe(false);
    expect(warns.some((w) => w.includes("failed its post-install safety check"))).toBe(true);
  });

  it("rejects a group/world-writable wrapper file (returns false)", () => {
    const { deps, fs, warns } = makeDeps();
    fs.files.set(DEFAULT_CONFIG_PATH, { data: "config", mode: 0o600, uid: 0, gid: 0 });
    const realLstat = deps.fs.lstatSync;
    // Dirs safe; only the wrapper FILE is group/world-writable, so the file-mode
    // check (not the parent-dir check) is what rejects it.
    (deps.fs as { lstatSync: (p: string) => { isSymbolicLink: boolean; uid: number; gid: number; mode: number } }).lstatSync =
      (p) => p === WRAPPER_PATH
        ? { isSymbolicLink: false, uid: 0, gid: 0, mode: 0o777 }
        : realLstat(p);
    const ok = setupPrivilegeSeparation(deps, DEFAULT_CONFIG_PATH);
    expect(ok).toBe(false);
    expect(warns.some((w) => w.includes("failed its post-install safety check"))).toBe(true);
  });

  it("surfaces a loud error (not a clean warn) when the sudo grant cannot be revoked on a fail-safe (Codex #1)", () => {
    const { deps, fs } = makeDeps();
    const WRAPPER_DIR = WRAPPER_PATH.replace(/\/[^/]+$/, "");
    // Upgrade precondition: a prior install left a LIVE sudoers grant.
    fs.files.set(SUDOERS_PATH, { data: "glassmkr ALL=(ALL) NOPASSWD: ...\n", mode: 0o440, uid: 0, gid: 0 });
    // The wrapper directory has since become world-writable, so the trust check
    // fails and forces the fail-safe revoke path.
    const realLstat = deps.fs.lstatSync;
    (deps.fs as { lstatSync: (p: string) => { isSymbolicLink: boolean; uid: number; gid: number; mode: number } }).lstatSync =
      (p) => (p === WRAPPER_DIR ? { isSymbolicLink: false, uid: 0, gid: 0, mode: 0o777 } : realLstat(p));
    // Both removal strategies fail (an immutable file: unlink AND overwrite error).
    const realUnlink = deps.fs.unlinkSync;
    (deps.fs as { unlinkSync: (p: string) => void }).unlinkSync =
      (p) => { if (p === SUDOERS_PATH) throw new Error("EPERM immutable"); realUnlink(p); };
    const realWrite = deps.fs.writeFileSync;
    (deps.fs as { writeFileSync: (p: string, d: string, o?: { mode?: number; flag?: string }) => void }).writeFileSync =
      (p, d, o) => { if (p === SUDOERS_PATH) throw new Error("EPERM immutable"); realWrite(p, d, o); };
    expect(() => setupPrivilegeSeparation(deps, DEFAULT_CONFIG_PATH)).toThrow("escalation path may remain");
  });
});
