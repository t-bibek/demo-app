#!/bin/bash
# Capture an AXSnapshot dump and copy the relevant root(s) into the captures dir with a cell label.
# Usage:
#   cap.sh <cell-label> tabstrip           # chrome-window --skip-webarea (tab strip); copies ALL chrome-window roots
#   cap.sh <cell-label> tabstrip-nowake    # same + --no-wake
#   cap.sh <cell-label> webarea            # chrome --url app.zoom.us (paired web-area readability)
set -euo pipefail
CAP=/Users/bibekthapa/projects/work/demo-app/research/zoom-web/tabaway-captures-2026-07-07
AX=/Users/bibekthapa/projects/work/demo-app/macos/.build/debug/AXSnapshot
SCRATCH=$(mktemp -d)
LABEL="$1"; MODE="$2"
cd "$SCRATCH"
case "$MODE" in
  tabstrip)         "$AX" chrome-window --skip-webarea > "$SCRATCH/stdout.txt" 2>&1 ;;
  tabstrip-nowake)  "$AX" chrome-window --skip-webarea --no-wake > "$SCRATCH/stdout.txt" 2>&1 ;;
  webarea)          "$AX" chrome --url app.zoom.us > "$SCRATCH/stdout.txt" 2>&1 ;;
  *) echo "unknown mode $MODE"; exit 2 ;;
esac
DUMPDIR=$(ls -td "$SCRATCH"/ax-dumps/*/ 2>/dev/null | head -1)
echo "== cap $LABEL ($MODE) =="
cat "$SCRATCH/stdout.txt"
# Copy every produced root json/txt with the cell label prefix.
if [ -n "${DUMPDIR:-}" ]; then
  for f in "$DUMPDIR"*.json "$DUMPDIR"*.txt; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    cp "$f" "$CAP/${LABEL}--${base}"
  done
fi
# Always keep the STDOUT (the blindness verdict text for webarea mode).
cp "$SCRATCH/stdout.txt" "$CAP/${LABEL}--STDOUT.txt"
echo "-> copied to $CAP as ${LABEL}--*"
rm -rf "$SCRATCH"
