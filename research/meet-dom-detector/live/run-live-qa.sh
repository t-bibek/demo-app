#!/usr/bin/env bash
# Orchestrate a live multi-party Meet QA run: one observer + N speakers, all
# headful (Meet blocks headless). The observer injects the real DOM detector and
# logs a who-is-speaking timeline you diff against the known speaking order.
#
# THE ONE MANUAL STEP: you must supply a real meeting URL and admit the joiners.
#   1. In your normal browser, sign in and start a Meet; copy the URL.
#   2. MEETING_URL="https://meet.google.com/abc-defg-hij" ./run-live-qa.sh
#   3. As each headful Chrome asks to join, click "Admit" in your host window.
#
# Speakers emit the fake-device tone (the working audio source), so whichever
# speaker instance is UNMUTED/in-call registers as speaking. Control who "speaks
# when" by launching/leaving speakers in sequence (or muting via the Meet UI).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
: "${MEETING_URL:?set MEETING_URL to your meeting link}"
DUR="${DUR:-90}"

echo "[rig] launching 2 speakers (headful, fake tone)…"
node "$DIR/join-meet.js" "$MEETING_URL" "Alice QA" 9311 &  SPK1=$!
sleep 6
node "$DIR/join-meet.js" "$MEETING_URL" "Bob QA"   9312 &  SPK2=$!
sleep 6

echo "[rig] launching observer for ${DUR}s — ADMIT all three in your host window."
node "$DIR/observe-and-score.js" "$MEETING_URL" "$DUR" 9300 "$DIR/observe-timeline.jsonl" || true

echo "[rig] stopping speakers…"
kill "$SPK1" "$SPK2" 2>/dev/null || true
echo "[rig] timeline: $DIR/observe-timeline.jsonl"
echo "[rig] diff it against the order you had speakers join/leave to score detection."
