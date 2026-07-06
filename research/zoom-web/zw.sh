#!/bin/bash
# Send a command to the running Zoom-web sweep driver and wait for its seq-matched reply.
# Usage: zw.sh <command...>   e.g. zw.sh boot / zw.sh join / zw.sh bg
set -euo pipefail
CAP=/Users/bibekthapa/projects/work/demo-app/research/zoom-web/tabaway-captures-2026-07-07
CMD_FILE="$CAP/zw-cmd"
OUT="$CAP/driver.log"
SEQ_FILE="$CAP/.seq"
[ -f "$SEQ_FILE" ] || echo 0 > "$SEQ_FILE"
SEQ=$(( $(cat "$SEQ_FILE") + 1 ))
echo "$SEQ" > "$SEQ_FILE"
echo "$SEQ $*" >> "$CMD_FILE"
# Wait up to 150s for a reply line carrying our seq (join can take a while).
for i in $(seq 1 300); do
  if grep -q "\"seq\":$SEQ," "$OUT" 2>/dev/null || grep -q "\"seq\":$SEQ}" "$OUT" 2>/dev/null; then
    grep "\"seq\":$SEQ[,}]" "$OUT" | tail -1
    exit 0
  fi
  sleep 0.5
done
echo "{\"timeout\":true,\"seq\":$SEQ,\"cmd\":\"$*\"}"
exit 1
