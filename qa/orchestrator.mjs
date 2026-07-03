#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Autonomous-QA orchestrator (engine). Generic + config-driven: it knows nothing
// about Meet or BlackHole — it just runs the phases declared in qa.config.mjs and
// enforces the exit criteria in code.
//
//   Phase 1  TOOLS   for each blocker-tool: check -> (fix + re-check) -> walk the
//                    fallback chain. Encodes the "try the fix, then fall back to
//                    the alternative, no human re-trigger" logic.
//   Phase 2  SUITES  run each QA suite; gate on exit code + match + minCount.
//   Phase 3  REVIEW  run the independent review gate (checks the checks).
//
// EXIT CRITERIA (enforced here, not in docs): exit non-zero if ANY suite fails,
// ANY required tool ends DOWN, the required review gate fails, or no suites are
// configured. A malformed config exits 2. Prints a per-item pass/fail summary.
//
//   node qa/orchestrator.mjs [--suites-only] [--skip-tools] [--skip-review]
//                            [--allow-privileged] [--json]
// ---------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
// Manifest is overridable via QA_CONFIG (absolute or cwd-relative) — for testing
// and for running an alternate suite set; defaults to the committed qa.config.mjs.
const CONFIG_PATH = process.env.QA_CONFIG ? resolve(process.cwd(), process.env.QA_CONFIG) : resolve(HERE, 'qa.config.mjs');
const config = (await import(pathToFileURL(CONFIG_PATH).href)).default;
const A = new Set(process.argv.slice(2));
const FLAGS = {
  suitesOnly: A.has('--suites-only'),
  skipTools: A.has('--skip-tools') || A.has('--suites-only'),
  skipReview: A.has('--skip-review') || A.has('--suites-only'),
  allowPrivileged: A.has('--allow-privileged'),
  json: A.has('--json'),
};

const DEFAULT_TOOL_TIMEOUT = 120_000;
const DEFAULT_SUITE_TIMEOUT = 15 * 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

// Run a shell command from a repo-relative cwd. Login shell so node/swift resolve
// off the user's PATH (matches the interactive harness + CI shells). Distinguishes
// timeout (124) and output-overflow (125) from an ordinary non-zero exit so a
// genuinely-passing suite whose output overran the buffer isn't misread as FAIL.
function run(step, defaultTimeout) {
  const r = spawnSync('bash', ['-lc', step.cmd], {
    cwd: resolve(REPO_ROOT, step.cwd || '.'),
    encoding: 'utf8',
    timeout: step.timeoutMs || defaultTimeout,
    maxBuffer: MAX_BUFFER,
  });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  const overflow = !!(r.error && r.error.code === 'ENOBUFS');
  // spawnSync: status is null when killed by signal/timeout/overflow.
  const code = r.status == null ? (timedOut ? 124 : overflow ? 125 : 1) : r.status;
  return { code, out, timedOut, overflow };
}
const tail = (out, n = 2) => (out ? out.split('\n').filter(Boolean).slice(-n).join(' / ') : '');
const probeFail = (r) => (r.timedOut ? 'timeout' : r.overflow ? 'overflow' : `fail(${r.code})`);

// --- Config validation: reject malformed tool/fallback shapes LOUDLY rather than
// silently dropping them (a fallback with a `fix` but no `check` is unverifiable —
// there's no re-check to confirm the heal). Returns a list of fatal errors. -------
function validateConfig(cfg) {
  const errs = [];
  for (const tool of cfg.tools || []) {
    let node = tool.fallback, i = 0;
    while (node) {
      if (!node.check) {
        errs.push(`tool '${tool.id}' fallback '${node.id || `#${i}`}' has a fix but no check` +
          ` — a heal with no re-check is unverifiable; give every fallback a \`check\``);
      }
      node = node.fallback; i++;
    }
    // The tool must be probeable somewhere in its chain, else it can only ever be 'skipped'.
    let hasCheck = !!tool.check;
    for (let n = tool.fallback; n; n = n.fallback) if (n.check) hasCheck = true;
    if (!hasCheck && !tool.fallback) {
      errs.push(`tool '${tool.id}' has no check and no fallback — nothing to probe`);
    }
  }
  for (const s of cfg.suites || []) {
    if (!s.id || !s.cmd) errs.push(`a suite is missing \`id\` or \`cmd\``);
  }
  return errs;
}

// --- Phase 1: a single blocker-tool, with fix + fallback-chain recovery. ----
function resolveTool(tool) {
  const attempts = [];
  const probe = (node, label) => {
    const r = run(node.check, DEFAULT_TOOL_TIMEOUT);
    attempts.push(`${label} check -> ${r.code === 0 ? 'ok' : probeFail(r)}`);
    return r;
  };
  const runFix = (node, label) => {
    if (node.fix.needsPrivilege && !FLAGS.allowPrivileged) {
      attempts.push(`${label} fix SKIPPED (needs --allow-privileged)`);
      return false;
    }
    const f = run(node.fix, DEFAULT_TOOL_TIMEOUT);
    attempts.push(`${label} fix -> exit ${f.code}`);
    return true;
  };

  // Nothing probeable anywhere in the chain -> genuinely skipped (not "down").
  let chainHasCheck = !!tool.check;
  for (let n = tool.fallback; n; n = n.fallback) if (n.check) chainHasCheck = true;
  if (!chainHasCheck) return { id: tool.id, status: 'skipped', via: null, detail: 'no check in the tool/fallback chain', attempts };

  // Primary: check (+ fix + re-check). Skipped when the tool itself has no check
  // (a fallback-only capability) — we fall straight through to the fallback walk.
  if (tool.check) {
    if (probe(tool, tool.id).code === 0) return { id: tool.id, status: 'healthy', via: tool.id, attempts };
    if (tool.fix && runFix(tool, tool.id) && probe(tool, `${tool.id} re`).code === 0) {
      return { id: tool.id, status: 'fixed', via: tool.id, attempts };
    }
  }

  // Fallback chain — each node needs a check (validateConfig guarantees it).
  for (let fb = tool.fallback; fb; fb = fb.fallback) {
    if (probe(fb, fb.id).code === 0) return { id: tool.id, status: 'fallback', via: fb.id, attempts };
    if (fb.fix && runFix(fb, fb.id) && probe(fb, `${fb.id} re`).code === 0) {
      return { id: tool.id, status: 'fallback', via: fb.id, attempts };
    }
  }
  return { id: tool.id, status: 'down', via: null, detail: 'primary + all fallbacks unavailable', attempts };
}

// --- Phase 2: a single QA suite. --------------------------------------------
function runSuite(s) {
  const r = run(s, s.timeoutMs || DEFAULT_SUITE_TIMEOUT);
  let ok = r.code === 0 && !r.timedOut && !r.overflow;
  let count = null;
  const reasons = [];
  if (r.overflow) reasons.push(`output exceeded ${MAX_BUFFER / 1048576 | 0}MB buffer — raise maxBuffer or stream to a file`);
  else if (!ok) reasons.push(r.timedOut ? 'timed out' : `exit ${r.code}`);
  if (ok && s.match) {
    // LAST occurrence — the final summary line, not an earlier per-step/banner line.
    const ms = [...r.out.matchAll(new RegExp(s.match, 'g'))];
    const m = ms.at(-1);
    if (!m) { ok = false; reasons.push(`expected /${s.match}/ not found`); }
    else if (m[1] != null && /^\d+$/.test(m[1])) count = Number(m[1]);
  }
  if (ok && s.minCount != null) {
    if (count == null) {
      // minCount set but the match produced no numeric group -> can't verify the
      // count. Fail LOUDLY instead of silently skipping the floor.
      ok = false;
      reasons.push(`minCount ${s.minCount} set but match /${s.match}/ has no numeric capture group — scenario count unverifiable`);
    } else if (count < s.minCount) {
      ok = false;
      reasons.push(`only ${count} scenarios (< baseline ${s.minCount}); scenarios may have been silently dropped`);
    }
  }
  return { id: s.id, ok, code: r.code, count, reason: reasons.join('; '), tail: tail(r.out) };
}

// ---------------------------------------------------------------------------
function main() {
  const cfgErrs = validateConfig(config);
  if (cfgErrs.length) {
    console.error('QA config invalid — refusing to run:');
    for (const e of cfgErrs) console.error(`  ✗ ${e}`);
    process.exit(2);
  }

  const started = process.hrtime.bigint();
  const report = { scope: '', tools: [], suites: [], review: null, blockers: [], warnings: [] };
  const log = (...a) => { if (!FLAGS.json) console.log(...a); };

  // Label reflects what ACTUALLY runs (not just --suites-only).
  const phases = ['tools', 'suites', 'review']
    .filter((p) => !(p === 'tools' && FLAGS.skipTools) && !(p === 'review' && FLAGS.skipReview));
  report.scope = FLAGS.suitesOnly ? 'suites-only' : phases.join('+');

  log('\n╭─ Autonomous QA ' + '─'.repeat(56));
  log(`│ repo: ${REPO_ROOT}`);
  log(`│ mode: ${report.scope}${FLAGS.allowPrivileged ? ' +privileged-fixes' : ''}`);
  log('╰' + '─'.repeat(72));

  // Phase 1 — TOOLS
  if (!FLAGS.skipTools && config.tools?.length) {
    log('\n▸ TOOLS  (blocker capability: check → fix → fallback)');
    for (const tool of config.tools) {
      const res = resolveTool(tool);
      report.tools.push(res);
      const up = res.status !== 'down' && res.status !== 'skipped';
      const badge = { healthy: 'HEALTHY', fixed: 'FIXED', fallback: 'FALLBACK', down: 'DOWN', skipped: 'SKIP' }[res.status];
      log(`  ${badge.padEnd(9)} ${tool.id}${res.via && res.via !== tool.id ? `  via ${res.via}` : ''}`);
      for (const a of res.attempts) log(`            · ${a}`);
      if (!up) {
        if (tool.required) { report.blockers.push(`tool ${tool.id} DOWN (required)`); log('            ✗ REQUIRED — blocks the run'); }
        else { report.warnings.push(`tool ${tool.id} unavailable (not required)`); log('            ⚠ not required — WARN only'); }
      }
    }
  } else if (!FLAGS.suitesOnly) {
    log('\n▸ TOOLS  skipped (--skip-tools)');
  }

  // Phase 2 — SUITES
  log('\n▸ SUITES  (gate: exit code + match + minCount)');
  if (!config.suites?.length) {
    report.blockers.push('no QA suites configured — nothing was verified');
    log('  FAIL      (none configured)');
  }
  for (const s of config.suites || []) {
    const res = runSuite(s);
    report.suites.push(res);
    log(`  ${(res.ok ? 'PASS' : 'FAIL').padEnd(9)} ${s.id.padEnd(16)} ${res.ok ? (res.count != null ? `${res.count}/${res.count}` : 'ok') : res.reason}`);
    if (!res.ok) { report.blockers.push(`suite ${s.id} failed: ${res.reason}`); if (res.tail) log(`            tail: ${res.tail}`); }
  }

  // Phase 3 — REVIEW
  if (!FLAGS.skipReview && config.review) {
    log('\n▸ REVIEW  (independent check of the checks)');
    const r = run(config.review, DEFAULT_TOOL_TIMEOUT);
    report.review = { id: config.review.id, ok: r.code === 0, code: r.code };
    log(`  ${(r.code === 0 ? 'PASS' : 'FAIL').padEnd(9)} ${config.review.id}`);
    if (r.out) for (const line of r.out.split('\n')) log(`            ${line}`);
    if (r.code !== 0 && config.review.required) report.blockers.push(`review ${config.review.id} failed`);
  } else if (!FLAGS.suitesOnly) {
    log('\n▸ REVIEW  skipped (--skip-review)');
  }

  // Verdict
  const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
  const passed = report.blockers.length === 0;
  if (FLAGS.json) {
    console.log(JSON.stringify({ ...report, passed, ms }, null, 2));
  } else {
    log('\n╭─ VERDICT ' + '─'.repeat(62));
    log(`│ suites : ${report.suites.filter((s) => s.ok).length}/${report.suites.length} passed`);
    if (report.tools.length) log(`│ tools  : ${report.tools.filter((t) => t.status !== 'down' && t.status !== 'skipped').length}/${report.tools.length} available`);
    if (report.review) log(`│ review : ${report.review.ok ? 'passed' : 'FAILED'}`);
    for (const w of report.warnings) log(`│ ⚠ ${w}`);
    for (const b of report.blockers) log(`│ ✗ ${b}`);
    log(`│ ${passed ? '✅ PASS — all exit criteria met' : '❌ FAIL — ' + report.blockers.length + ' blocker(s)'}  (${ms}ms)`);
    log('╰' + '─'.repeat(72) + '\n');
  }
  process.exit(passed ? 0 : 1);
}

main();
