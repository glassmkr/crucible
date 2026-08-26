# v1.0 surface freeze

Review date: 2026-08-23. The 1.0.0 version is a promise; this document records
exactly what is being promised, what got fixed before the promise, and what
was deliberately frozen as-is with the reasoning, so nobody relitigates a
"wart" that was in fact a decision.

## The frozen surface

Four things constitute the compatibility contract from 1.0.0 on. Breaking any
of them is a major version:

1. **The config file schema** (`/etc/glassmkr/crucible.yaml`): every key,
   type, and default documented in
   [config/crucible.example.yaml](../config/crucible.example.yaml). Unknown
   keys warn and are ignored; that leniency is itself part of the contract
   (a config that throws takes monitoring down, the worse failure).
2. **CLI commands, flags, and exit codes**: `init`, `enroll`, `doctor ipmi`,
   `mark-reboot`/`reboot`, the run mode, and the codes in
   [EXIT_CODES.md](EXIT_CODES.md).
3. **The privileged wrapper action set**: the 27 fixed-argv actions of
   `/usr/local/sbin/crucible-collect` and its two exit codes (64/65).
4. **The dashboard API contract the agent speaks**: `POST /api/v1/ingest`
   (Bearer auth, Snapshot JSON, 429 as expected throttle), `POST
   /api/v1/servers` (enrollment statuses 402/409/429 and the
   `server.collector_key` response), `GET /api/v1/version`
   (`crucible.latest`, `crucible.min_supported`, `crucible.changelog_url`).
   New OPTIONAL snapshot fields are minor; changing or removing existing
   fields, statuses, or auth is major.

## Fixed before the freeze (this review's diff)

- **Unknown `init`/`enroll` arguments are now errors.** They were silently
  ignored; a typo'd `--forse` or an unquoted key fragment was a no-op the
  operator believed was in effect.
- **`--config`/`-c` work on every subcommand.** `init`/`enroll` accepted only
  `--config-path` while run/doctor accepted only `--config`; both now take
  both, `--config` is canonical, `--config-path` stays as a compat alias.
- **The unknown-key config warning covers the whole file.** It covered only
  `collection:`; the same typo trap existed under every other block, and a
  stale 0.9.x `forge:` block was stripped without a word, silently disabling
  the push. The `forge:` case now gets a pointed message.
- **`--ingest-url` accepts a bare base URL.** `http://host:3000` gets
  `/api/v1/ingest` appended (with a log line) instead of POSTing to `/` and
  failing only at push time. Explicit non-root paths are respected.
- **`min_supported` in the version contract is honoured.** It was declared
  and never read; the daemon now warns when it runs below the dashboard's
  floor. A warn, not an exit: an old agent that keeps reporting beats a
  floor that silences a host.
- **Programmatic `enroll` verifies by default.** `noVerify` defaulted true
  for direct API callers (the CLI always passed an explicit value); the safe
  value is now the default.
- **`DEFAULT_CONFIG_PATH`/`LEGACY_CONFIG_PATH` have one definition** (cli.ts;
  init.ts re-exports). They were defined twice.
- **`config/crucible.example.yaml`** replaces the legacy-named
  `collector.example.yaml` and now documents every key in the schema.
- **Exit codes documented** in [EXIT_CODES.md](EXIT_CODES.md); there was no
  table anywhere.
- **install.sh** (served from glassmkr.com, not this repo's npm artifact)
  gained `--ingest-url`/`GLASSMKR_INGEST_URL` passthrough for self-hosted
  dashboards.

## Deliberately frozen as-is (do not "fix" these)

- **`--ingest-url` (init) vs `--dashboard-url` (enroll).** They take
  different shapes for a reason: init talks to the ingest endpoint, enroll
  talks to the dashboard base. Both write `dashboard.url`; each side
  compensates. Renaming would break every published install command for a
  cosmetic gain, and the bare-base normalization removed the practical
  footgun.
- **The `dashboard:` config block naming.** "dashboard.url holds the ingest
  base" is a third name for one concept, inherited from the 0.10 forge
  rename. An on-disk config key rename means migration code on every
  existing host; cosmetic gain, real risk.
- **Two state directories** (`/var/lib/glassmkr` and `/var/lib/crucible`).
  The product-rename seam frozen into on-disk paths. Consolidating means
  migrating alert state and reboot markers on upgrade; a botched migration
  loses alert dedupe state fleet-wide. Documented, not worth it.
- **The wrapper name `crucible-collect` and its action names** (the
  `ipmi-*`/`raid-*` prefixes vs bare `iptables`/`nft`/`zpool`/`sshd`, and
  `sshd` meaning "sshd -T config dump"). Renaming wrapper actions is the one
  rename with a real failure mode: the wrapper is only rewritten by `init`,
  not by npm upgrade, so an upgraded agent calling renamed actions against
  an un-rerun wrapper loses collection until the operator re-runs init. The
  sh/TS dual mirror is also this codebase's most drift-prone seam (the
  ipmitool gate shipped broken three times on exactly this kind of skew).
  Internal inconsistency, invisible to operators, zero-risk to keep.
- **`thresholds.swap_alert` and `thresholds.acknowledge_disabled_detection`**
  are not numeric thresholds but live in `thresholds:`. Config key renames
  cost operator migration; both are documented in the example file.
- **`collector_key ?? api_key` in the enrollment response.** Liberal in what
  the agent accepts; self-hosted dashboards of different vintages may send
  either. `collector_key` is canonical.
- **Exit-code overlap between subcommands** (init 10 vs enroll 10, etc.).
  Unix convention scopes exit codes per command; renumbering now would break
  any existing automation for zero information gain. The one combined space
  (enroll delegating to init) is documented in EXIT_CODES.md.

## Semver policy from 1.0.0

- **Major**: any break in the four frozen surfaces above.
- **Minor**: new collectors, new optional snapshot fields, new CLI flags,
  new wrapper actions, new config keys with safe defaults.
- **Patch**: fixes that change no surface.
- Pre-1.0 the convention was "minor may break, called out under
  `### Breaking`"; that ends at 1.0.0.

1.0.0 itself lands at the public flip: tagged only after the validation
fleet (sprint workstream E) passes against these exact artifacts, published
to npm via the existing OIDC Trusted Publishing flow plus the first binary
release.
