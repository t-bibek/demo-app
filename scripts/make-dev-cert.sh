#!/bin/bash
# Creates a STABLE self-signed code-signing identity in your login keychain so
# TCC permission grants (Accessibility / Screen Recording / Microphone) survive
# rebuilds. Ad-hoc signing ("-") changes the code hash every build, so macOS
# treats each rebuild as a new app and forgets the grant.
#
#   ./scripts/make-dev-cert.sh
#   MSD_SIGN_ID="MeetSpeakerDetector Dev" ./scripts/build-app.sh
#
# Note: the trust step may prompt for your login/keychain password once. That
# is expected and only happens the first time.
set -euo pipefail

NAME="MeetSpeakerDetector Dev"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning | grep -q "${NAME}"; then
  echo "Identity '${NAME}' already exists — nothing to do."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "==> Generating self-signed code-signing certificate"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "${TMP}/key.pem" -out "${TMP}/cert.pem" \
  -subj "/CN=${NAME}" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning"

openssl pkcs12 -export -out "${TMP}/id.p12" \
  -inkey "${TMP}/key.pem" -in "${TMP}/cert.pem" -passout pass:

echo "==> Importing into login keychain (pre-authorizing codesign)"
security import "${TMP}/id.p12" -k "${KEYCHAIN}" -P "" -T /usr/bin/codesign

echo "==> Trusting the certificate for code signing (may prompt for your password)"
security add-trusted-cert -r trustRoot -p codeSign -k "${KEYCHAIN}" "${TMP}/cert.pem" || \
  echo "    note: automatic trust failed. Open Keychain Access, find '${NAME}', and set 'Code Signing' to 'Always Trust' if codesign reports an untrusted chain."

echo ""
echo "Created identity: ${NAME}"
echo "Build with it:    MSD_SIGN_ID=\"${NAME}\" ./scripts/build-app.sh"
