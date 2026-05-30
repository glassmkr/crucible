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

5. **Commit** `chore(release): vX.Y.Z - <short summary>` (CHANGELOG + package.json). Use a plain hyphen, not an em-dash, per the no-em-dash convention.

6. **Tag + push:**
   ```
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```
   The tag push triggers `.github/workflows/publish.yml` (npm publish via Trusted Publishing / OIDC, `--provenance`; **no npm token needed**) and `docker.yml` (image build). There is no PR-level CI in this repo; local build+test in step 4 is the gate.

7. **Verify the publish landed:**
   ```
   npm view @glassmkr/crucible version    # should print X.Y.Z
   ```
   (Watch the `Publish to npm` workflow run with `gh run watch <id> --exit-status` if you want to block on it.)

8. **GitHub Release**: `publish.yml` does NOT create a GitHub Release, only npm. Create one on the tag with customer-facing notes:
   ```
   gh release create vX.Y.Z --title "vX.Y.Z - <summary>" --notes "<customer-facing notes; affected hosts; upgrade command>"
   ```

9. **Fleet / customer roll.** The fix only takes effect once a host runs the new version. Roll per host **sequentially** (verify each before the next), do not parallelize across shared hosts:
   ```
   sudo npm install -g @glassmkr/crucible@X.Y.Z
   sudo systemctl restart glassmkr-crucible
   systemctl is-active glassmkr-crucible && npm ls -g @glassmkr/crucible | grep crucible
   ```

10. **[dashboard] Bump ALL THREE version-fallback constants in lockstep** (only after npm publish is live; they must always point at a real, published release). This is the step most easily missed, the dashboard one was 7 minor releases stale (0.6.6) before the 0.13.6 release caught it:
    - `apps/site/src/lib/server/version.ts` -> `FALLBACK_LATEST`
    - `apps/site/scripts/gen-rules.mjs` -> `FALLBACK_CRUCIBLE_VERSION`
    - `apps/dashboard/src/lib/server/version.ts` -> `FALLBACK_LATEST`

11. **[dashboard] Customer-facing changelog surface**: add a dated section + sidebar link to `apps/site/src/routes/docs/changelog/+page.svelte`, and move the "Current." marker to the new version. Add a `sitemap.xml` entry only if a new URL is introduced (changelog edits reuse the existing `/docs/changelog` URL). US English, no em-dashes (the `scripts/lint-no-emdash.mjs` CI guard scans `apps/site/src`).

## Checklist (copy into the release PR / issue)

- [ ] Fix merged to main, green
- [ ] CHANGELOG.md entry added
- [ ] package.json version bumped
- [ ] `npm run build && npx vitest run` clean
- [ ] release commit + tag pushed
- [ ] `npm view @glassmkr/crucible version` shows the new version
- [ ] GitHub Release created with customer-facing notes
- [ ] fleet/customers rolled (or roll scheduled)
- [ ] [dashboard] all three fallback constants bumped in lockstep
- [ ] [dashboard] /docs/changelog entry + "Current." marker moved
