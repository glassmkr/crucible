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

9. **Fleet / customer roll.** The fix only takes effect once a host runs the new version. Roll per host **sequentially** (verify each before the next), do not parallelize across shared hosts:
   ```
   sudo npm install -g @glassmkr/crucible@X.Y.Z
   sudo glassmkr-crucible init
   sudo systemctl restart glassmkr-crucible
   systemctl is-active glassmkr-crucible && npm ls -g @glassmkr/crucible | grep crucible
   ```

10. **[dashboard] Bump ALL THREE version-fallback constants in lockstep** (only after npm publish is live; they must always point at a real, published release). This is the step most easily missed, the dashboard one was 7 minor releases stale (0.6.6) before the 0.13.6 release caught it:
    - `apps/site/src/lib/crucible-version.ts` -> `FALLBACK_CRUCIBLE_VERSION`
    - `apps/site/scripts/gen-rules.mjs` -> its own mirror of that value (it runs at prebuild, outside the module graph)
    - `apps/dashboard/src/lib/server/version.ts` -> `FALLBACK_LATEST`

    `apps/site/src/lib/server/version.ts` needs **no** edit: it imports `FALLBACK_CRUCIBLE_VERSION` from `$lib/crucible-version` and re-exports it as `FALLBACK_LATEST`, so it derives its value from the first constant above. Do not hardcode a version there.

11. **[dashboard] Customer-facing changelog surface**: add a dated section + sidebar link to `apps/site/src/routes/docs/changelog/+page.svelte`, and move the "Current." marker to the new version. Add a `sitemap.xml` entry only if a new URL is introduced (changelog edits reuse the existing `/docs/changelog` URL). US English, no em-dashes (the `scripts/lint-no-emdash.mjs` CI guard scans `apps/site/src`).

## Checklist (copy into the release PR / issue)

- [ ] Fix merged to main, green
- [ ] CHANGELOG.md entry added
- [ ] package.json version bumped
- [ ] `npm run build && npx vitest run` clean
- [ ] release PR opened, both checks PASS, squash-merged
- [ ] tag created on the squash-merged `main` commit and pushed
- [ ] `npm view @glassmkr/crucible version` shows the new version
- [ ] GitHub Release verified with `gh release view vX.Y.Z` (auto-created by publish.yml)
- [ ] fleet/customers rolled (or roll scheduled)
- [ ] [dashboard] all three fallback constants bumped in lockstep
- [ ] [dashboard] /docs/changelog entry + "Current." marker moved
