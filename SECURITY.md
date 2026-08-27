# Security Policy

Crucible is a monitoring agent that runs on your servers, so we take its
security posture seriously. This document covers how to report a vulnerability
and how the project is hardened.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately through either channel:

- **GitHub private vulnerability reporting** (preferred): the repository's
  **Security** tab -> **Report a vulnerability**. This opens a private advisory
  visible only to you and the maintainers.
- **Email**: `security@glassmkr.com`.

Please include: affected version(s), a description of the issue, reproduction
steps or a proof of concept, and the impact you foresee. We aim to acknowledge
reports within 3 business days and to ship a fix or mitigation for confirmed
issues in the next patch release.

We will credit reporters in the release notes unless you prefer to remain
anonymous.

## Supported versions

Crucible is 1.x and ships from a single release line. The config schema, the CLI
flags and exit codes, the privileged wrapper's action set, and the dashboard API
contract are the frozen compatibility surface; breaking any of them is a major
version. Security fixes land in
the latest published version on npm (`@glassmkr/crucible`); please upgrade to the
latest before reporting, in case the issue is already fixed:

```
sudo npm i -g @glassmkr/crucible@latest
sudo glassmkr-crucible init
sudo systemctl restart glassmkr-crucible
```

## How Crucible is hardened

- **Least privilege.** The agent runs as an unprivileged `glassmkr` service
  user, not root. It gains the hardware/kernel read access it needs through a
  single fixed-argv `sudo` wrapper (`/usr/local/sbin/crucible-collect`) with no
  argument passthrough; the two parameterized actions (SMART device, ethtool
  interface) validate their argument against a strict allowlist before exec.
- **Outbound only.** The agent opens no inbound ports. It pushes snapshots to
  your dashboard over HTTPS; it does not listen for commands.
- **Supply chain.** Releases are published to npm from GitHub Actions via
  [Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers) with
  `--provenance` attestation and no long-lived npm token. Every published
  version is traceable to the tagged commit and workflow that built it.
- **Data scope.** What Crucible does and does not collect is documented at
  [glassmkr.com/trust](https://glassmkr.com/trust).

## Scope

In scope: the agent code in this repository, its install script, and the
privileged-collection wrapper. The hosted dashboard/API is a separate service;
report issues there through the same channels and we will route them.
