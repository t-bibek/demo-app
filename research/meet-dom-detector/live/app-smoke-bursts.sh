#!/bin/bash
# app-smoke-bursts.sh — drive 3 guest-alpha speech bursts (~8s on, ~5s off)
# for the APP-LEVEL live smoke of the Meet active-speaker integration.
# Scratch script for the 2026-07-05 app smoke; safe to delete.
cd "$(dirname "$0")" || exit 1
for i in 1 2 3; do
  echo "[bursts] burst $i ON  $(date -u +%FT%TZ)"
  node p8-ctl.js speak alpha on
  sleep 8
  echo "[bursts] burst $i OFF $(date -u +%FT%TZ)"
  node p8-ctl.js speak alpha off
  sleep 5
done
echo "[bursts] complete $(date -u +%FT%TZ)"
