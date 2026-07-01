#!/bin/bash
# Builds MeetSpeakerDetector.app -- a runnable, ad-hoc-signed macOS app bundle.
#
#   ./scripts/build-app.sh          # release build
#   ./scripts/build-app.sh debug    # debug build
#
# The bundle is NOT sandboxed on purpose: reading other apps' accessibility
# trees and capturing system audio do not work inside the App Sandbox.
set -euo pipefail

CONFIG="${1:-release}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="MeetSpeakerDetector"
BUNDLE="${ROOT}/build/${APP_NAME}.app"

# The Swift package lives here (macos/), so build from ROOT regardless of the
# caller's working directory.
cd "${ROOT}"

echo "==> Building (${CONFIG})"
swift build -c "${CONFIG}" --product "${APP_NAME}"

BIN_DIR="$(swift build -c "${CONFIG}" --product "${APP_NAME}" --show-bin-path)"
BIN="${BIN_DIR}/${APP_NAME}"
if [[ ! -f "${BIN}" ]]; then
  echo "error: built binary not found at ${BIN}" >&2
  exit 1
fi

echo "==> Assembling bundle at ${BUNDLE}"
rm -rf "${BUNDLE}"
mkdir -p "${BUNDLE}/Contents/MacOS" "${BUNDLE}/Contents/Resources"
cp "${BIN}" "${BUNDLE}/Contents/MacOS/${APP_NAME}"
cp "${ROOT}/Resources/Info.plist" "${BUNDLE}/Contents/Info.plist"
printf 'APPL????' > "${BUNDLE}/Contents/PkgInfo"

# Signing identity. Set MSD_SIGN_ID to a stable self-signed code-signing
# identity (see scripts/make-dev-cert.sh) so macOS remembers Accessibility /
# Screen Recording / Microphone grants ACROSS rebuilds. With the default
# ad-hoc identity ("-") every rebuild changes the code hash, so TCC treats each
# build as a new app and you must re-grant every time.
SIGN_ID="${MSD_SIGN_ID:--}"
if [[ "${SIGN_ID}" != "-" ]] && ! security find-identity -v -p codesigning 2>/dev/null | grep -q "${SIGN_ID}"; then
  echo "    warning: identity '${SIGN_ID}' not found; falling back to ad-hoc. Run scripts/make-dev-cert.sh first."
  SIGN_ID="-"
fi
echo "==> Code signing (identity: ${SIGN_ID})"
codesign --force --sign "${SIGN_ID}" "${BUNDLE}"
codesign --verify --verbose "${BUNDLE}" || true

echo ""
echo "Built: ${BUNDLE}"
echo "Run:   open \"${BUNDLE}\""
