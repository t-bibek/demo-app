#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Reader for a single live-QA scenario verdict. Reads the LAST NDJSON line whose
// `scenario` matches argv[1] from research/meet-dom-detector/live/live-qa-results.ndjson
// (written by run-live-qa.mjs), prints it, and exits 0 ONLY when its verdict is PASS.
//
// The live manifest (qa/qa.live.config.mjs) points one reader suite per scenario at
// this script and gates on match '"verdict":"PASS"' + exit code. REVIEW/FAIL/missing
// all exit non-zero so the orchestrator flags them.
//
//   node qa/live-scenario-verdict.mjs <scenario>
// ---------------------------------------------------------------------------
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const NDJSON = join(REPO, 'research', 'meet-dom-detector', 'live', 'live-qa-results.ndjson');

const scenario = process.argv[2];
if (!scenario) { console.error('usage: node qa/live-scenario-verdict.mjs <scenario>'); process.exit(2); }

if (!existsSync(NDJSON)) {
  console.error(`live results NDJSON missing: ${NDJSON} — run the live-session suite first`);
  process.exit(1);
}

let last = null;
for (const ln of readFileSync(NDJSON, 'utf8').split('\n')) {
  const t = ln.trim();
  if (!t) continue;
  try { const o = JSON.parse(t); if (o && o.scenario === scenario) last = o; } catch (e) { /* skip malformed */ }
}

if (!last) {
  console.error(`no verdict line found for scenario '${scenario}' in ${NDJSON}`);
  process.exit(1);
}

// Print the raw line so the orchestrator's `match` ('"verdict":"PASS"') can assert it.
console.log(JSON.stringify(last));
if (last.verdict === 'PASS') {
  console.log(`${scenario}: PASS`);
  process.exit(0);
}
console.error(`${scenario}: verdict is '${last.verdict}' (not PASS)`);
process.exit(1);
