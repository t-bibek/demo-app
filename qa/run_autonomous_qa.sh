#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Autonomous-QA entrypoint. Runs the full sequence — blocker-tool health (with
# automatic fix -> fallback recovery) → QA suites → independent review gate — and
# exits non-zero if any exit criterion fails, printing a per-item pass/fail
# summary.
#
# All logic lives in qa/orchestrator.mjs (engine) + qa/qa.config.mjs (manifest);
# this is a thin, CI-friendly wrapper so the flow has a stable shell entrypoint.
#
#   qa/run_autonomous_qa.sh                 # full run (skips privileged fixes)
#   qa/run_autonomous_qa.sh --suites-only   # just the suites + exit gate (CI-fast)
#   qa/run_autonomous_qa.sh --allow-privileged   # permit sudo-y tool fixes
#   qa/run_autonomous_qa.sh --json          # machine-readable report
#
# See QA_AUTOMATION_FLOW.md.
# ---------------------------------------------------------------------------
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "run_autonomous_qa: node is required but not on PATH" >&2
  exit 127
fi

# exec so node's exit code (0 pass / 1 fail) becomes this script's exit code.
exec node "$DIR/orchestrator.mjs" "$@"
