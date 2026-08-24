# Support

## Getting help

- **Bug or unexpected behavior**: open an issue using the bug template. It asks
  for distro, kernel, hardware, agent version, and the relevant collector
  output, because collector bugs are almost always hardware-shaped and those
  five fields are what make one reproducible.
- **Feature or collector request**: use the feature template. Real output from
  real hardware is the single most useful thing you can attach.
- **Security issue**: do not open a public issue. See
  [SECURITY.md](SECURITY.md).

## Release cadence

Maintained. Releases happen when there is something to release; security fixes
are prioritized. There is no fixed schedule, and no release is cut to meet one.

## Tested support matrix

Crucible aims to run on any modern Linux with a supported Node (see the
README's requirements). This table records where it has actually been
exercised, which is a narrower and more honest claim than where it should
work.

Statuses: **verified** (a validation run passed on this combination),
**expected** (same family as a verified row, not separately exercised),
**untested**.

| Distro | Version | Arch | Install path | Status |
|---|---|---|---|---|
| Debian | 13 | x86_64 | binary, npm | pending validation run |
| Ubuntu | 24.04 LTS | x86_64 | binary, npm | pending validation run |
| Rocky Linux | 9 | x86_64 | binary, npm | pending validation run |
| AlmaLinux | 9 | x86_64 | binary, npm | pending validation run |
| Ubuntu | 22.04 LTS | x86_64 | npm | expected (previously operated) |
| Debian | 12 | x86_64 | npm | expected (previously operated) |
| Other systemd Linux | - | x86_64 | npm | untested |
| Any supported distro | - | arm64 | binary | untested |

The four pending rows fill in from the validation-fleet run; each becomes
verified only when a real install on that distro passes, and stays pending
otherwise. Do not promote a row on the grounds that it "should" work.

Notes that apply regardless of row:

- The one-line `install.sh` path supports Debian and Ubuntu only. On
  RHEL-family distros use the npm package or the single-file binary.
- The agent needs systemd for the service unit. It collects fine without one,
  but nothing supervises it.
- Collectors degrade individually: a missing tool or absent device makes that
  one collector report unavailable, never crashes collection.
