#!/bin/bash
# Send a command to the running sweep driver and wait for its seq-matched reply.
# Usage: tw.sh <command...>   e.g. tw.sh boot / tw.sh join / tw.sh bg
set -euo pipefail
CAP=/Users/bibekthapa/projects/work/demo-app/research/teams-web/tabaway-captures-2026-07-07
CMD_FILE="$CAP/tw-cmd"
OUT="$CAP/driver.log"
SEQ_FILE="$CAP/.seq"
[ -f "$SEQ_FILE" ] || echo 0 > "$SEQ_FILE"
SEQ=$(( $(cat "$SEQ_FILE") + 1 ))
echo "$SEQ" > "$SEQ_FILE"
echo "$SEQ $*" >> "$CMD_FILE"
# Wait up to 90s for a reply line carrying our seq.
for i in $(seq 1 180); do
  if grep -q "\"seq\":$SEQ," "$OUT" 2>/dev/null || grep -q "\"seq\":$SEQ}" "$OUT" 2>/dev/null; then
    grep "\"seq\":$SEQ[,}]" "$OUT" | tail -1
    exit 0
  fi
  sleep 0.5
done
echo "{\"timeout\":true,\"seq\":$SEQ,\"cmd\":\"$*\"}"
exit 1
