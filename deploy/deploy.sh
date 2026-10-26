#!/usr/bin/env bash
#
# PageGloss - one step deploy.
#
# Verifies the extension, runs the test suite, packs a zip and stages a ready to
# load unpacked extension directory.
#
# Usage:
#   bash deploy/deploy.sh
#   bash deploy/deploy.sh --no-tests
#   bash deploy/deploy.sh --install          # also try to open the extensions page
#
# Environment:
#   DEPLOY_TARGET   directory that receives the packaged extension
#                   (default: <repo>/build/pagegloss)
#   SKIP_TESTS      set to 1 to skip the test suite
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

TARGET_DIR="${DEPLOY_TARGET:-${ROOT_DIR}/build/pagegloss}"
RUN_TESTS=1
INSTALL_HINT=0

for arg in "$@"; do
  case "${arg}" in
    --no-tests) RUN_TESTS=0 ;;
    --install) INSTALL_HINT=1 ;;
    -h|--help)
      echo "usage: bash deploy/deploy.sh [--no-tests] [--install]"
      exit 0
      ;;
    *)
      echo "error: unknown option ${arg}" >&2
      exit 2
      ;;
  esac
done

if [ "${SKIP_TESTS:-0}" = "1" ]; then
  RUN_TESTS=0
fi

log() { printf '[deploy] %s\n' "$1"; }
fail() { printf '[deploy] ERROR: %s\n' "$1" >&2; exit 1; }

log "checking node toolchain"
if ! command -v node >/dev/null 2>&1; then
  fail "node is required to verify and pack the extension"
fi
NODE_VERSION="$(node --version)"
log "node ${NODE_VERSION}"

cd "${ROOT_DIR}"

if [ ! -f "${ROOT_DIR}/manifest.json" ]; then
  fail "manifest.json not found in ${ROOT_DIR}"
fi

log "validating manifest, locales, icons and layout rules"
node tools/check.js

if [ "${RUN_TESTS}" = "1" ]; then
  log "running the matcher test suite"
  node tests/matcher.test.js
  log "running the content script integration tests"
  node tests/integration.test.js
  log "running the service worker pipeline tests"
  node tests/service-worker.test.js
  log "running the ES module smoke test"
  node tests/esm.test.js
  log "running the content script load tests"
  node tests/content-load.test.js
else
  log "skipping the test suite"
fi

log "building the release zip"
node tools/package.js

VERSION="$(node -e "process.stdout.write(require('./manifest.json').version)")"
ZIP_PATH="${ROOT_DIR}/build/pagegloss-${VERSION}.zip"
if [ ! -f "${ZIP_PATH}" ]; then
  fail "expected archive was not created: ${ZIP_PATH}"
fi

log "staging the unpacked extension into ${TARGET_DIR}"
rm -rf "${TARGET_DIR}"
mkdir -p "${TARGET_DIR}"

for item in manifest.json src icons _locales docs; do
  if [ -e "${ROOT_DIR}/${item}" ]; then
    cp -R "${ROOT_DIR}/${item}" "${TARGET_DIR}/"
  else
    fail "missing runtime path: ${item}"
  fi
done

if [ ! -f "${TARGET_DIR}/manifest.json" ]; then
  fail "staged directory has no manifest.json"
fi

COUNT="$(find "${TARGET_DIR}" -type f | wc -l | tr -d ' ')"
log "staged ${COUNT} file(s)"

log "archive: ${ZIP_PATH}"
log "unpacked extension: ${TARGET_DIR}"

if [ "${INSTALL_HINT}" = "1" ]; then
  URL="chrome://extensions"
  log "opening ${URL} (enable Developer mode, then Load unpacked -> ${TARGET_DIR})"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "${URL}" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "${URL}" >/dev/null 2>&1 || true
  elif command -v cmd.exe >/dev/null 2>&1; then
    cmd.exe /c start "" "${URL}" >/dev/null 2>&1 || true
  fi
else
  log "next: open chrome://extensions, enable Developer mode, choose Load unpacked and pick ${TARGET_DIR}"
fi

log "done"
