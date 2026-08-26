# Contributing to Crucible

Thanks for your interest in Crucible, the open-source (MIT) monitoring agent
behind [Glassmkr](https://glassmkr.com). Bug reports, fixes, and new collectors
are all welcome.

## Ways to contribute

- **Report a bug** or request a collector/rule via a GitHub issue (templates
  are provided). Include your OS/distro, `@glassmkr/crucible` version, and the
  relevant `journalctl -u glassmkr-crucible` output where possible.
- **Send a pull request** for a fix or improvement (see below).
- **Report a security issue** privately: see [SECURITY.md](SECURITY.md). Do not
  open a public issue for vulnerabilities.

## Developer Certificate of Origin (DCO)

Every commit must carry a `Signed-off-by:` line (`git commit -s` adds it).
By signing off you certify the [Developer Certificate of Origin](https://developercertificate.org/):
in plain words, that you wrote the change or otherwise have the right to
submit it under this repository's MIT license, and that you understand the
contribution is public and recorded permanently. That is the whole
agreement; there is no CLA and no copyright assignment. CI rejects
unsigned commits on pull requests.

## Development setup

Crucible is a TypeScript project (Node 20+). No hardware is required to work on
most of it; collectors degrade gracefully when a tool or device is absent.

```bash
npm install
npm run build        # tsc -> dist/
npx vitest run       # unit tests (fast; no hardware needed)
```

To try the built agent locally: `node dist/index.js` (add `--help` for flags).

## Pull request guidelines

- **One focused change per PR.** Keep diffs surgical; avoid unrelated
  reformatting.
- **Add or update tests.** New alert rules and collectors need unit coverage;
  `npx vitest run` must pass. Type-check with `npm run build`.
- **Keep collectors degrade-safe.** A missing binary, absent device, or
  non-systemd host must never crash collection: return "capability
  unavailable" (null/empty), not an exception.
- **Match the surrounding style.** No em-dashes in code, comments, or output
  copy (use a colon or a plain hyphen).
- **Rules are data.** Alert rule IDs live in `rule-ids.json` and must stay in
  sync with `src/alerts/rules.ts` (CI checks this).
- Fill out the PR template (what/why, testing, and the checklist).

## Releases

Maintainers cut releases; contributors do not need to. The full process
(CHANGELOG, version bump, tag-triggered Trusted Publishing to npm, fleet roll)
is documented in [RELEASE.md](RELEASE.md). Founder approval is required before
any release is tagged.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating you agree to uphold it.
