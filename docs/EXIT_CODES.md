# Exit codes

Frozen as part of the v1.0 surface (see [V1_FREEZE.md](V1_FREEZE.md)). Codes
are scoped per subcommand, Unix-style: `init`'s 10 and `enroll`'s 10 are
different conditions. One overlap to know when scripting: `enroll` finishes by
delegating to `init` internals, so a failing `enroll` can also surface any
`init` code; in that combined space, 3 always means "key rejected (401/403)"
either way, with identical operator action.

## `init`

| Code | Meaning |
|---|---|
| 0 | Success (including `--no-start`) |
| 1 | Reading the API key from stdin failed |
| 2 | Invalid or missing `--api-key`; unknown argument |
| 3 | API key rejected by the endpoint (HTTP 401/403) |
| 4 | Existing config target is unsafe or uninspectable |
| 5 | Unsafe config path or untrusted directory chain |
| 6 | Legacy config migration or config write failed |
| 7 | `glassmkr-crucible` binary not found on PATH, or unsafe binary path |
| 8 | systemd unit write failed |
| 9 | `systemctl restart` failed |
| 10 | Privileged-wrapper setup failed (failed closed; see `GLASSMKR_ALLOW_ROOT_FALLBACK` in the README) |
| 14 | Ingest endpoint refused: policy, DNS resolution, bad redirect, or too many redirects |

## `enroll`

| Code | Meaning |
|---|---|
| 0 | Success, or already configured (no-op) |
| 1 | Reading the account key from stdin failed |
| 2 | Invalid or missing `--account-key`; unknown argument |
| 3 | Account key rejected (HTTP 401/403) |
| 8 | Transport failure reaching `/api/v1/servers` |
| 10 | HTTP 402: server limit reached or account suspended |
| 11 | HTTP 409: concurrent enrollment in flight |
| 12 | Unexpected response: other non-2xx, missing collector key, or unusable returned ingest URL |
| 13 | HTTP 429: rate limited, retry later |
| 14 | Dashboard endpoint refused by endpoint policy |
| (init codes) | Any `init` code can follow, from the delegated config/systemd setup |

## `doctor ipmi`

| Code | Meaning |
|---|---|
| 0 | Probe ran; see the printed report |
| 3 | Named `--config` unreadable; probe not run |

## Daemon and reboot commands

| Code | Meaning |
|---|---|
| 0 | `--version`/`--help`; `mark-reboot` marker written |
| 1 | Unsupported Node version (preflight); marker write or `systemctl reboot` failed |
| 2 | Invalid `--ttl` value |
| 11 | Config failed integrity or schema validation at daemon start |

## Privileged wrapper (`crucible-collect`)

| Code | Meaning |
|---|---|
| 64 | Missing or unknown action |
| 65 | Argument rejected by the allowlist |
