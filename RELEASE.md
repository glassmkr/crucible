# Releasing @glassmkr/crucible

Single source of truth for cutting a Crucible release. Lives here (the release-trigger repo) so it is findable at release time. Some steps touch the **dashboard repo** (`glassmkr/glassmkr`); they are called out as `[dashboard]`. Established by the 0.13.6 release (2026-05-29); update this file whenever the process changes.

## Release shape

- **Patch** (`0.13.5 -> 0.13.6`): bug fix, no API/feature change. Default for fixes.
- **Minor** (`0.13.x -> 0.14.0`): new collector / feature / behavior change. Pre-1.0, minor bumps may include breaking changes; call them out under `### Breaking` in the CHANGELOG.
- Founder approval is required before cutting any release (the agent prepares + merges the code fix, then surfaces "ready for release vX.Y.Z" and waits for explicit go).

## Steps (in order)

1. **Land the fix on `main`** via a normal PR, merged + green. Do NOT cut the release in the same step.

2. **CHANGELOG.md**: add a `## [X.Y.Z] - YYYY-MM-DD` entry at the top with `### Fixed` / `### Added` / `### Changed` / `### Breaking` as applicable. Customer-readable; this text seeds the GitHub Release notes and the marketing changelog.

3. **Bump `package.json` `version`** to `X.Y.Z`.

4. **Build + test locally before tagging** (a tag triggers the publish workflow; do not waste a publish run on a broken build):
   ```
   npm run build && npx vitest run
   ```

5. **Commit** `chore(release): vX.Y.Z - <short summary>` (CHANGELOG + package.json) **on a release branch**, e.g. `release/vX.Y.Z`. Use a plain hyphen, not an em-dash, per the no-em-dash convention.

6. **Open a release PR, merge it, then tag the merged commit.** Direct push to `main` is blocked on this repo, so the release commit lands through a PR like any other change (every recent release commit carries its squash-merge PR number: v0.14.7 = #95, v0.14.8 = #97):
   ```
   git push -u origin release/vX.Y.Z
   gh pr create --title "chore(release): vX.Y.Z - <short summary>" --body "<summary of the release>"
   gh pr checks <pr-number>        # poll until every check reports pass, NOT pending
   gh pr merge <pr-number> --squash
   git checkout main && git pull
   git tag vX.Y.Z                 # MUST be the squash-merged commit on main
   git push origin vX.Y.Z
   ```
   **The tag must point at the squash-merged commit on `main`.** `publish.yml` refuses to publish a tag whose SHA is not an ancestor of `origin/main`, so tagging your local pre-squash branch commit burns the publish run. Always check out and pull `main` before tagging.

   The tag push triggers `.github/workflows/publish.yml` (npm publish via Trusted Publishing / OIDC, `--provenance`; **no npm token needed**).

   PR-level CI does run here: `ci.yml` ("Build, test, and audit") and `secret-scan.yml` ("gitleaks secret scan") both fire on every PR to `main`. The repo has no required status checks, so `gh pr merge` succeeds against pending or red CI; poll `gh pr checks` for actual PASS first. The local build+test in step 4 remains the pre-tag gate.

7. **Verify the publish landed:**
   ```
   npm view @glassmkr/crucible version    # should print X.Y.Z
   ```
   (Watch the `Publish to npm` workflow run with `gh run watch <id> --exit-status` if you want to block on it.)

8. **Verify the GitHub Release appeared.** `publish.yml` creates it automatically after a successful publish, from the tag plus its `## [X.Y.Z]` CHANGELOG section (titled `vX.Y.Z`, marked `--latest`). That step is idempotent (it skips when the release already exists) and falls back to `--generate-notes` when CHANGELOG.md has no matching section, which is another reason step 2's heading format matters. Just confirm it:
   ```
   gh release view vX.Y.Z
   ```
   Only create it by hand (`gh release create vX.Y.Z --title "vX.Y.Z" --notes "<customer-facing notes>"`) if the workflow's Release step failed.

   **8a. Verify the binaries attached.** After the Release exists, the workflow's `binaries` job builds single-file Linux x64/arm64 executables with bun (`scripts/build-binaries.sh`; the script itself asserts the injected version took, guarding the 0.0.0 case) and uploads them plus `SHA256SUMS` as release assets. Confirm with `gh release view vX.Y.Z` (assets listed at the bottom). GPG-signing `SHA256SUMS` remains a manual maintainer step via `scripts/sign-release.sh`; the signing key never lives in CI.

9. **Fleet / customer roll.** The fix only takes effect once a host runs the new version. Roll per host **sequentially** (verify each before the next), do not parallelize across shared hosts.

   **9a. Check the host's Node version BEFORE installing.** `package.json` declares `engines: node >= 22.19.0` and that floor is enforced at runtime: since 0.14.7 `src/preflight.ts` exits with a clear message on an older Node, and 0.14.6 (no preflight yet) died at import inside `undici` and then crash-looped forever on the unit's `Restart=always`. Either way the host silently stops reporting and the dashboard shows only `server_unreachable`. Upgrade Node first, never after.

   The floor is **not ours to pick**: it is `undici@8`'s own `engines.node`, because undici is the only thing here needing a modern Node (it calls `markAsUncloneable` at import). If undici is bumped, re-read its `engines.node` and move `MIN_NODE_VERSION` with it. It was 24 until 2026-07-30, which was a major-only guess written from a crash seen on Node 20; that refused Node 22 LTS, which works fine and was verified on real hardware. Do not raise it again without measuring on the Node you intend to exclude.
   ```
   node -v                        # must be >= v22.19.0
   ```

   **9b. Install, repair config, restart:**
   ```
   sudo npm install -g @glassmkr/crucible@X.Y.Z
   sudo glassmkr-crucible init    # keyless, idempotent config repair (root:glassmkr 0640)
   sudo systemctl restart glassmkr-crucible
   ```

   **9c. Verify ON THE BOX. Do not trust the command having been issued** (a roll that was believed done but never applied left a host blind for 23 hours):
   ```
   systemctl is-active glassmkr-crucible    # want "active"; "activating" + auto-restart = crash-looping
   node -e "console.log(require(require('child_process').execSync('npm root -g').toString().trim()+'/@glassmkr/crucible/package.json').version)"
   ```
   Then confirm the dashboard side: the server record's `collector_version` shows X.Y.Z and `last_seen` is advancing.

   **9d. Wrapper refresh**, required on any host that ran `glassmkr-crucible init` (the agent runs unprivileged behind a sudo wrapper) whenever the release ADDS a privileged action. Skip it and the new collector silently returns null:
   ```
   sudo node -e "const cp=require('child_process');const p=require(cp.execSync('npm root -g').toString().trim()+'/@glassmkr/crucible/dist/lib/privileged.js');require('fs').writeFileSync(p.WRAPPER_PATH,p.WRAPPER_SCRIPT,{mode:0o755})"
   grep -c <new-action-name> /usr/local/sbin/crucible-collect    # expect >= 1
   ```

10. **[dashboard] Bump ALL THREE version-fallback constants in lockstep** (only after npm publish is live; they must always point at a real, published release). This is the step most easily missed, the dashboard one was 7 minor releases stale (0.6.6) before the 0.13.6 release caught it:
    - `apps/site/src/lib/crucible-version.ts` -> `FALLBACK_CRUCIBLE_VERSION`
    - `apps/site/scripts/gen-rules.mjs` -> its own mirror of that value (it runs at prebuild, outside the module graph)
    - `apps/dashboard/src/lib/server/version.ts` -> `FALLBACK_LATEST`

    `apps/site/src/lib/server/version.ts` needs **no** edit: it imports `FALLBACK_CRUCIBLE_VERSION` from `$lib/crucible-version` and re-exports it as `FALLBACK_LATEST`, so it derives its value from the first constant above. Do not hardcode a version there.

    **This is now CI-enforced** (glassmkr #595, `pnpm lint:fallback-version`): the dashboard repo fails the build if the three literals disagree, or if that re-export file grows a hardcoded literal. So a half-done bump is caught by the glassmkr PR rather than shipping silently. The gate deliberately checks the literals against EACH OTHER and not against npm, because a fallback legitimately trails the CHANGELOG while a release is mid-flight.

11. **[dashboard] Customer-facing changelog surface**: add a dated section + sidebar link to `apps/site/src/routes/docs/changelog/+page.svelte`, and move the "Current." marker to the new version. Add a `sitemap.xml` entry only if a new URL is introduced (changelog edits reuse the existing `/docs/changelog` URL). US English, no em-dashes (the `scripts/lint-no-emdash.mjs` CI guard scans `apps/site/src`, `apps/dashboard/src/lib/server/alerts`, and `apps/site/scripts`).

12. **[dashboard] If the release ADDS OR REMOVES AN ALERT RULE, the advertised rule count moves too**, and it is claimed in far more places than anyone expects: 83 sites across 26 files as of 2026-07-30, including all 8 `/vs/*` and all 4 `/for-*` pages. CI-enforced since glassmkr #603 (`pnpm lint:rule-count`), which checks the site copy against the length of the generated `rules.json` and skips an explicit list of dated pages (`/blog/*`, `/docs/changelog`) whose numbers were true at publication.
    - Read the canonical count from `apps/dashboard/src/lib/server/alerts/fix-workflow/__tests__/coverage.test.ts`; never trust a number quoted in prose, including one quoted here.
    - The matcher is easy to make too STRICT, and that direction fails silently: two attempts during #603 under-matched and looked green, and a stale `62` had survived two prior hand reconciles on `/docs/rules` itself. If you touch the matcher, plant a known-bad fixture and confirm it FAILS.
    - The gate also fails on ZERO matches, so a broken matcher cannot report OK.
    - Rule additions have their own checklist beyond the count: see the `glassmkr-rule-change` skill, notably the `gen-rules.mjs` CATEGORY map, which is enforced by `pnpm lint:rule-category` since glassmkr #599 (before that it failed at DEPLOY, not at PR CI).
    - `pnpm validate:rules` now loads the PRODUCTION `RuleMetadataSchema` and validates every rule YAML against it, not merely that the YAML parses (glassmkr #621, adversarial review round 5 finding #4). Before that a syntactically valid but schema-invalid rule, such as `priority: P9`, passed the gate and then threw `Invalid enum value` at dashboard boot. Its known-bad fixture is `pnpm validate:rules:test`.
    - `pnpm test:nginx-prune` pins the deploy-time nginx symlink prune (glassmkr #621). It is not a lint, but it is the only automated check on logic that runs `sudo rm` against production nginx, so treat a failure as release-blocking rather than cosmetic.

## Checklist (copy into the release PR / issue)

- [ ] Fix merged to main, green
- [ ] CHANGELOG.md entry added
- [ ] package.json version bumped
- [ ] `npm run build && npx vitest run` clean
- [ ] release PR opened, both checks PASS, squash-merged
- [ ] tag created on the squash-merged `main` commit and pushed
- [ ] `npm view @glassmkr/crucible version` shows the new version
- [ ] GitHub Release verified with `gh release view vX.Y.Z` (auto-created by publish.yml)
- [ ] target hosts confirmed on Node >= 22.19.0 BEFORE any install
- [ ] fleet/customers rolled (or roll scheduled), each verified on the box
- [ ] wrapper refreshed on wrapper hosts (only if the release added a privileged action)
- [ ] [dashboard] all three fallback constants bumped in lockstep
- [ ] [dashboard] /docs/changelog entry + "Current." marker moved
