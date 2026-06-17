#!/bin/bash
# Clears this app's TCC permission grants so you get a clean re-prompt.
# Useful after ad-hoc rebuilds leave stale/orphaned entries that no longer
# match the running binary's signature.
#
#   ./scripts/reset-permissions.sh
set -euo pipefail

BUNDLE_ID="com.usebubbles.meetspeakerdetector"

for svc in Accessibility Microphone ScreenCapture; do
  if tccutil reset "${svc}" "${BUNDLE_ID}" 2>/dev/null; then
    echo "reset ${svc} for ${BUNDLE_ID}"
  else
    echo "skip  ${svc} (nothing to reset)"
  fi
done

echo ""
echo "Done. Relaunch the app and grant permissions again."
echo "Tip: build with a stable identity so grants survive future rebuilds:"
echo "  ./scripts/make-dev-cert.sh && MSD_SIGN_ID=\"MeetSpeakerDetector Dev\" ./scripts/build-app.sh"
