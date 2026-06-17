#!/bin/bash
# Dev loop: rebuild + relaunch the app whenever a source file changes.
#
#   ./scripts/dev.sh
#
# This is "save -> auto-reload", not state-preserving hot reload (in-app state
# resets each reload). It rebuilds the signed .app bundle so Microphone /
# Screen Recording / Accessibility grants persist across reloads.
#
# Uses fswatch if installed (instant), otherwise a 1s polling fallback.
# For instant detection:  brew install fswatch
# For true hot reload, see the "Hot reload" section of README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="MeetSpeakerDetector"
BUNDLE="${ROOT}/build/${APP_NAME}.app"

rebuild_and_run() {
  printf '==> rebuild %s\n' "$(date +%H:%M:%S)"
  if "${ROOT}/scripts/build-app.sh" debug >/tmp/msd-dev.log 2>&1; then
    pkill -x "${APP_NAME}" 2>/dev/null || true
    sleep 0.3
    # Launch the binary inside the bundle directly (not `open`) to avoid the
    # LaunchServices race that returns error -600 right after re-signing. The
    # binary still resolves Bundle.main to the .app, so the Info.plist and TCC
    # identity are unchanged. `|| true` keeps the watch loop alive on a hiccup.
    ( "${BUNDLE}/Contents/MacOS/${APP_NAME}" >/tmp/msd-app.log 2>&1 & ) || true
    echo "    relaunched"
  else
    echo "    BUILD FAILED -- last lines:"
    tail -n 25 /tmp/msd-dev.log
  fi
}

rebuild_and_run

if command -v fswatch >/dev/null 2>&1; then
  echo "==> watching Sources/ + Resources/ with fswatch (Ctrl-C to stop)"
  fswatch -o "${ROOT}/Sources" "${ROOT}/Resources" | while read -r _; do
    rebuild_and_run
  done
else
  echo "==> watching Sources/ + Resources/ by polling (Ctrl-C to stop)"
  LAST=""
  while true; do
    SIG="$(find "${ROOT}/Sources" "${ROOT}/Resources" -type f \( -name '*.swift' -o -name '*.plist' \) \
            -exec stat -f '%m %N' {} + 2>/dev/null | sort | shasum)"
    if [[ "${SIG}" != "${LAST}" ]]; then
      [[ -n "${LAST}" ]] && rebuild_and_run
      LAST="${SIG}"
    fi
    sleep 1
  done
fi
