#!/usr/bin/env bash
set -euo pipefail

UNIT_NAME="glassmkr-crucible.service"
WRAPPER_PATH="/usr/local/sbin/crucible-collect"
SMOKE_UNIT="crucible-wrapper-smoke-$$"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: run this smoke test as root" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Linux" ]] || ! command -v systemd-run >/dev/null 2>&1; then
  echo "error: this smoke test requires Linux with systemd-run" >&2
  exit 2
fi
if [[ ! -x "$WRAPPER_PATH" ]]; then
  echo "error: privileged wrapper is missing or not executable: $WRAPPER_PATH" >&2
  exit 2
fi

installed_user="$(systemctl show "$UNIT_NAME" --property=User --value)"
installed_protect_system="$(systemctl show "$UNIT_NAME" --property=ProtectSystem --value)"
if [[ "$installed_user" != "glassmkr" ]] || [[ "$installed_protect_system" != "strict" ]]; then
  echo "error: $UNIT_NAME must use User=glassmkr and ProtectSystem=strict" >&2
  exit 2
fi

output="$(systemd-run \
  --quiet \
  --pipe \
  --wait \
  --collect \
  --unit="$SMOKE_UNIT" \
  --property=User=glassmkr \
  --property=ProtectHome=yes \
  --property=PrivateTmp=yes \
  --property=ProtectKernelTunables=yes \
  --property=ProtectControlGroups=yes \
  --property=LockPersonality=yes \
  --property=ProtectSystem=strict \
  --property="ReadWritePaths=/var/lib/glassmkr /var/lib/crucible" \
  /usr/bin/sudo -n "$WRAPPER_PATH" ssh-config-mtime)"

if [[ ! "$output" =~ ^[0-9]+$ ]]; then
  echo "error: hardened privileged action returned unexpected output: $output" >&2
  exit 1
fi

echo "ok: hardened privileged action returned data ($output)"
