<!-- Thanks for contributing to Crucible! See CONTRIBUTING.md. -->

## What

<!-- What does this PR change, in one or two sentences? -->

## Why

<!-- The motivation: bug being fixed, collector/rule being added, etc. Link any issue. -->

## Testing

<!-- How was this verified? Which distro(s)/hardware, if relevant. -->

- [ ] `npm run build` passes (type-check)
- [ ] `npx vitest run` passes
- [ ] Tested on real hardware / a representative host (describe), or n/a

## Checklist

- [ ] One focused change; no unrelated reformatting
- [ ] New collectors/rules degrade safely (no crash when a tool/device/systemd is absent)
- [ ] New alert rule IDs added to `rule-ids.json` (kept in sync with `src/alerts/rules.ts`)
- [ ] No em-dashes in code, comments, or output copy
- [ ] Docs/CHANGELOG updated if user-facing
