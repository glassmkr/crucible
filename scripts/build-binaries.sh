#!/bin/bash
# Build single-file Crucible binaries with Bun.
#
# Usage: ./scripts/build-binaries.sh [outdir]   (default: dist-bin)
#
# Produces one self-contained executable per target; no Node.js required on
# the installing host. Targets: Linux x64 and arm64 (the platforms agents run
# on; glibc "baseline" x64 for older CPUs without AVX2 would be -baseline,
# which we skip until someone needs it).
#
# The version string is injected at compile time via --define because a
# compiled binary has no package.json on disk (src/lib/version.ts would
# otherwise fall back to "0.0.0"). This script FAILS if the built binary
# does not report the package.json version: the known-bad case (0.0.0) is
# asserted against explicitly, on the one target we can execute locally.
set -euo pipefail

cd "$(dirname "$0")/.."
OUTDIR="${1:-dist-bin}"
VERSION=$(node -p 'require("./package.json").version')

command -v bun >/dev/null || { echo "ERROR: bun is required (https://bun.sh)"; exit 1; }

echo "Building Crucible ${VERSION} binaries into ${OUTDIR}/"
npm run build >/dev/null
mkdir -p "$OUTDIR"

TARGETS=(
  "bun-linux-x64:glassmkr-crucible-linux-x64"
  "bun-linux-arm64:glassmkr-crucible-linux-arm64"
)

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  outfile="${entry##*:}"
  echo "  ${target} -> ${OUTDIR}/${outfile}"
  bun build --compile dist/preflight.js \
    --target="$target" \
    --define "CRUCIBLE_INJECTED_VERSION=\"${VERSION}\"" \
    --outfile "$OUTDIR/$outfile" >/dev/null
done

# Version smoke test on a natively runnable build. Cross-compiled Linux
# binaries cannot execute here; compile one for the host platform and assert
# the injected version took (guards the 0.0.0 known-bad case).
HOST_SMOKE="$OUTDIR/.smoke-host"
bun build --compile dist/preflight.js \
  --define "CRUCIBLE_INJECTED_VERSION=\"${VERSION}\"" \
  --outfile "$HOST_SMOKE" >/dev/null
REPORTED=$("$HOST_SMOKE" --version)
rm -f "$HOST_SMOKE"
case "$REPORTED" in
  *"v${VERSION}"*) echo "  version smoke: OK (${REPORTED})" ;;
  *)
    echo "ERROR: binary reports '${REPORTED}', expected v${VERSION}."
    echo "The --define injection did not take; do NOT release these artifacts."
    exit 1
    ;;
esac

(cd "$OUTDIR" && shasum -a 256 glassmkr-crucible-* > SHA256SUMS 2>/dev/null \
  || sha256sum glassmkr-crucible-* > SHA256SUMS)
echo "Done:"
ls -lh "$OUTDIR"
