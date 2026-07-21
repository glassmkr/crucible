#!/usr/bin/env bash
set -euo pipefail

UNIT_NAME="glassmkr-crucible.service"
WRAPPER_PATH="/usr/local/sbin/crucible-collect"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: run this smoke test as root" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Linux" ]] || ! command -v systemctl >/dev/null 2>&1 || ! command -v journalctl >/dev/null 2>&1; then
  echo "error: this smoke test requires Linux with systemctl and journalctl" >&2
  exit 2
fi
if [[ ! -x "$WRAPPER_PATH" ]]; then
  echo "error: privileged wrapper is missing or not executable: $WRAPPER_PATH" >&2
  exit 2
fi

if ! systemctl is-active --quiet "$UNIT_NAME"; then
  echo "error: $UNIT_NAME must be installed and running" >&2
  exit 2
fi

installed_user="$(systemctl show "$UNIT_NAME" --property=User --value)"
installed_protect_system="$(systemctl show "$UNIT_NAME" --property=ProtectSystem --value)"
installed_nnp="$(systemctl show "$UNIT_NAME" --property=NoNewPrivileges --value)"
if [[ "$installed_user" != "glassmkr" ]] || [[ "$installed_protect_system" != "strict" ]]; then
  echo "error: $UNIT_NAME must use User=glassmkr and ProtectSystem=strict" >&2
  exit 2
fi
if [[ "$installed_nnp" != "no" ]]; then
  echo "error: $UNIT_NAME has effective NoNewPrivileges=$installed_nnp; classic sudo cannot escalate" >&2
  exit 1
fi

invocation_id="$(systemctl show "$UNIT_NAME" --property=InvocationID --value)"
if [[ -z "$invocation_id" ]]; then
  echo "error: could not read the current $UNIT_NAME invocation ID" >&2
  exit 2
fi

# The agent emits this marker only after the fixed ssh-config-mtime wrapper
# action exits zero with numeric output. Because the marker comes from the
# current persistent service invocation, it covers the real sandbox and SELinux
# context. A systemd-run transient unit is not equivalent on RHEL-family hosts.
wrapper_ok=false
for ((attempt = 0; attempt < 30; attempt++)); do
  if journalctl --quiet --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$invocation_id" \
    | grep -Fqx "[collector] Privileged wrapper self-check: ok"; then
    wrapper_ok=true
    break
  fi
  sleep 1
done

if [[ "$wrapper_ok" != "true" ]]; then
  echo "error: the running $UNIT_NAME did not report a successful privileged wrapper self-check" >&2
  echo "error: inspect with journalctl -u $UNIT_NAME -b" >&2
  exit 1
fi

echo "ok: the running hardened service returned privileged wrapper data with NoNewPrivileges=no"
