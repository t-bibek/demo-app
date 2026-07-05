#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Shared-session LIVE QA runner for the Meet event-driven ring/focus detector.
//
// ONE live session, all scenarios back-to-back (per the approved plan): pre-flight
// Accessibility trust, pre-build the Swift detector BEFORE any timed window (so
// compile time never pollutes CPU numbers), launch the 3-party rig ONCE, then run:
//
//   ax-events-live  — correlate detector meet_edge events (from the MSD_EDGE_LOG
//                     NDJSON) against the rig's scripted swaps; every speaker change
//                     matched within 800ms; >=3 of 4 rapid swaps caught.
//   cpu-compare-live— INTERLEAVED A/B: alternate short legacy/event steady
//                     GUEST1-speaks blocks (4 rounds of legacy-then-event) so ambient
//                     CPU drift on a busy interactive Mac hits both modes equally and
//                     cancels in the pooled medians (a single 90s-each back-to-back run
//                     gave 0.58 PASS then 0.83 FAIL on identical code purely from
//                     between-window drift). Sample `ps -o %cpu= -p <pid>` every 2s per
//                     block, drop each block's warmup samples, POOL per-mode samples
//                     across blocks, take the MEDIAN once; parse+sum meet_walk_stats.
//                     PASS iff eventCpu <= 0.6*pollingCpu AND event full_walks <
//                     0.5*polling full_walks. Within 10% of a threshold => REVIEW. Raw
//                     per-block samples always recorded.
//   regression-live — 3-party accuracy matrix in EVENT mode: expected speaker seen
//                     >=0.6 by others, non-speakers <=0.3, overlap both >=0.5,
//                     silence <=0.3.
//
// Writes one NDJSON verdict line per scenario to live-qa-results.ndjson and prints
// `LIVE SESSION COMPLETE` at the end (qa.live.config.mjs's live-session suite
// matches on that; the reader suites grep the last line per scenario).
//
//   node run-live-qa.mjs --all
//
// Env-var contract with the detector (owned by the Swift side, per the plan):
//   MSD_AUTOSTART=1   auto-start the engine (no UI click)
//   MSD_MODE=event|legacy   A/B switch
//   MSD_RUN_SECONDS=N       clean auto-exit after N seconds
//   MSD_EDGE_LOG=<path>     also append meet_edge NDJSON here (we read it back)
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

// cdp-lib.js + roster-rig-turns.js are CommonJS; bridge them into this ESM runner.
const require = createRequire(import.meta.url);
const ALPHA_PORT = 9226; // Guest Alpha (GUEST1) — matches roster-rig-3p.js

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const MACOS = join(REPO, 'macos');
const RESULTS_NDJSON = join(HERE, 'live-qa-results.ndjson');
const RIG_RESULTS = join(HERE, 'roster-rig-turns-results.json');
const RIG_SCRIPT = join(HERE, 'roster-rig-3p.js');
// MSD_DETECTOR_BIN overrides the sandbox SwiftPM debug binary so an EXTERNAL
// (product) detector can be gated by this live rig. When set, the swift-build
// prebuild is skipped and the binary must already exist — fail fast here,
// BEFORE any meeting/rig infrastructure is launched.
const DETECTOR_BIN = process.env.MSD_DETECTOR_BIN || join(MACOS, '.build', 'debug', 'MeetSpeakerDetector');
if (process.env.MSD_DETECTOR_BIN && !existsSync(DETECTOR_BIN)) {
  console.error(`[live-qa] FATAL: MSD_DETECTOR_BIN is set but no detector binary exists at ${DETECTOR_BIN}`);
  process.exit(1);
}
// Fixed edge-log path so the detector running DURING the rig's turns and the
// ax-events correlation afterward agree on where the meet_edge NDJSON lands.
const TURN_EDGE_LOG = join(HERE, 'live-qa-edges.ndjson');

// Edge-latency bar, measured from scripted SPEECH ONSET (__fakeMicSpeak true).
// The pipeline is: Meet server VAD + ring render (~600-1400ms measured live on
// 2026-07-03 — dominated by Meet itself) + Chromium AX serializer batch (~150ms)
// + the detector's bounded-read tick (<=500ms). 800ms from onset is physically
// unreachable for ANY ring-reading detector; 2500ms still hard-fails the
// reconcile-only regression this suite exists to catch (edges 4s+ late), while
// admitting Meet's own latency. Raw per-swap dtMs is always recorded for audit.
const EDGE_MATCH_MS = 2500;        // a scripted onset must produce a matching edge within this
const RAPID_MIN_CAUGHT = 3;        // of 4 rapid swaps
const CPU_RATIO = 0.6;             // eventCpu <= 0.6 * pollingCpu
const WALK_RATIO = 0.5;            // event full_walks < 0.5 * polling full_walks
// INTERLEAVED A/B (methodology fix): a single 90s legacy window followed by a single
// 90s event window is fragile on a busy interactive Mac — any ambient CPU drift BETWEEN
// the two windows (the user working, a background Teams call spinning up) lands entirely
// on whichever mode ran during it and poisons the ratio (observed: two identical-code
// runs gave 0.58 PASS and 0.83 FAIL purely from between-window drift). Instead run SHORT
// alternating blocks (legacy, event, legacy, event, …) so both modes are sampled across
// the SAME ambient conditions and drift cancels in the pooled medians. Each block spawns
// a fresh detector; the first CPU_WARMUP_SAMPLES of every block are discarded (activation
// / tree-materialization transient), then per-mode samples are POOLED across all blocks
// and the median taken once. full_walks are summed per mode across blocks.
const CPU_BLOCKS = 4;              // rounds of (legacy-block, event-block)
const CPU_BLOCK_S = 22;            // steady window per block (8 blocks * ~25s wall ≈ 3.5 min total)
const CPU_SAMPLE_MS = 2000;        // ps sampling interval
const CPU_WARMUP_SAMPLES = 2;      // drop the first N samples of each block (startup transient)
const REVIEW_BAND = 0.10;          // within 10% of a threshold => REVIEW

const log = (...a) => console.log('[live-qa]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

// One NDJSON verdict line per scenario. Every line self-identifies its scenario so
// the reader suites can grep the LAST line for their scenario.
function record(scenario, verdict, detail) {
  const line = JSON.stringify({ scenario, verdict, ts: nowSec(), ...detail });
  appendFileSync(RESULTS_NDJSON, line + '\n');
  log(`RESULT ${scenario}: ${verdict}`);
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(3);
};

// --- Accessibility trust pre-flight: fail fast with an actionable message. -------
function preflightAxTrust() {
  const probe = join(mkdtempSync(join(tmpdir(), 'axtrust-')), 'probe.swift');
  writeFileSync(probe, 'import ApplicationServices\nprint(AXIsProcessTrusted() ? "TRUSTED" : "UNTRUSTED")\n');
  const r = spawnSync('swift', [probe], { encoding: 'utf8', timeout: 120_000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (!out.includes('TRUSTED') || out.includes('UNTRUSTED')) {
    console.error('\n[live-qa] FATAL: Accessibility permission is NOT granted for this process.');
    console.error('[live-qa] The detector reads the Meet window via the macOS Accessibility API and');
    console.error('[live-qa] will produce EMPTY results without it.');
    console.error('[live-qa] Fix: System Settings → Privacy & Security → Accessibility → enable the terminal');
    console.error('[live-qa] (or the app) running this, then re-run. Probe output: ' + JSON.stringify(out));
    return false;
  }
  log('Accessibility trust: OK');
  return true;
}

// --- Pre-build the detector BEFORE any timed window (compile time must not
// pollute the CPU numbers). Runs the built binary directly so `ps` sees the
// detector PID, not a `swift run` wrapper. --------------------------------------
function prebuildDetector() {
  if (process.env.MSD_DETECTOR_BIN) {
    log(`using external detector: ${DETECTOR_BIN} (prebuild skipped)`);
    return true;
  }
  log('swift build --package-path macos (pre-build; may take minutes on a cold cache)…');
  const r = spawnSync('swift', ['build', '--package-path', MACOS], { encoding: 'utf8', timeout: 20 * 60_000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.status !== 0) {
    console.error('[live-qa] swift build FAILED:\n' + out.split('\n').slice(-30).join('\n'));
    return false;
  }
  if (!existsSync(DETECTOR_BIN)) {
    console.error(`[live-qa] build succeeded but detector binary missing at ${DETECTOR_BIN}`);
    return false;
  }
  log('detector built: ' + DETECTOR_BIN);
  return true;
}

// --- Launch the 3-party rig with scripted turns (once). It writes swaps + the
// cross-observation matrix to roster-rig-turns-results.json and leaves the Chrome
// windows OPEN. Returns the child process so we can tear it down. ----------------
function launchRig() {
  log('launching 3-party rig (roster-rig-3p.js new --turns)…');
  const proc = spawn('node', [RIG_SCRIPT, 'new', 'Guest Alpha', 'Guest Bravo', '--turns'], {
    cwd: HERE, stdio: ['ignore', 'inherit', 'inherit'],
  });
  proc.on('error', (e) => console.error('[live-qa] rig spawn error', e));
  return proc;
}

// Wait until the rig has written .roster-rig-state.json (guests admitted, turns about
// to start). Returns true if it appeared, false on timeout OR if the rig process
// died first — a crashed rig can never produce the file, so waiting out the full
// timeout just burns the suite budget (observed: 10 min of waiting on a rig that
// threw during host join).
async function waitStateFile(timeoutMs, rigProc) {
  const statePath = join(HERE, '.roster-rig-state.json');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (rigProc && rigProc.exitCode !== null) {
      log(`rig process exited early (code ${rigProc.exitCode}) before writing state — bailing`);
      return false;
    }
    if (existsSync(statePath)) {
      try { const s = JSON.parse(readFileSync(statePath, 'utf8')); if (s && s.hostAdmittedA) return true; } catch (e) {}
    }
    await sleep(3000);
  }
  return false;
}

// Wait until the rig has written its results JSON with a `rows` array (turns done),
// or time out. Returns the parsed results or null. Bails early if the rig died.
async function waitRigResults(timeoutMs, rigProc) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(RIG_RESULTS)) {
      try {
        const r = JSON.parse(readFileSync(RIG_RESULTS, 'utf8'));
        if (r && Array.isArray(r.rows) && r.rows.length) return r;
      } catch (e) { /* partial write; keep waiting */ }
    }
    if (rigProc && rigProc.exitCode !== null) {
      log(`rig process exited early (code ${rigProc.exitCode}) before writing results — bailing`);
      return null;
    }
    await sleep(3000);
  }
  return null;
}

// --- Launch the detector as a child, sampling its CPU every CPU_SAMPLE_MS. Returns
// { cpuSamples[], walkStats, stdout, exitCode }. The detector auto-exits after
// MSD_RUN_SECONDS; we also hard-kill on our own timeout as a backstop. -----------
async function runDetector({ mode, seconds, edgeLog }) {
  const env = { ...process.env, MSD_AUTOSTART: '1', MSD_MODE: mode, MSD_RUN_SECONDS: String(seconds) };
  if (edgeLog) env.MSD_EDGE_LOG = edgeLog;
  log(`detector MSD_MODE=${mode} MSD_RUN_SECONDS=${seconds}${edgeLog ? ' (edge log)' : ''}`);
  const proc = spawn(DETECTOR_BIN, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });

  const cpuSamples = [];
  let sampling = true;
  const sampler = (async () => {
    // small settle before first sample so startup/activate cost isn't over-counted
    await sleep(3000);
    while (sampling && !proc.killed) {
      const r = spawnSync('ps', ['-o', '%cpu=', '-p', String(proc.pid)], { encoding: 'utf8' });
      const v = parseFloat((r.stdout || '').trim());
      if (Number.isFinite(v)) cpuSamples.push(v);
      await sleep(CPU_SAMPLE_MS);
    }
  })();

  const exitCode = await new Promise((res) => {
    const hardKill = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, (seconds + 30) * 1000);
    proc.on('exit', (code) => { clearTimeout(hardKill); res(code); });
  });
  sampling = false;
  await sampler;

  // Parse the LAST meet_walk_stats line (emitted on stop) for full_walks etc.
  let walkStats = null;
  for (const ln of out.split('\n')) {
    const i = ln.indexOf('{');
    if (i < 0) continue;
    try { const o = JSON.parse(ln.slice(i)); if (o && o.type === 'meet_walk_stats') walkStats = o; } catch (e) {}
  }
  return { cpuSamples, walkStats, stdout: out, exitCode };
}

// ===========================================================================
// Scenario 1 — ax-events-live
// ===========================================================================
async function scenarioAxEvents(rig) {
  log('=== ax-events-live ===');
  // Edges were captured by the detector running in EVENT mode CONCURRENTLY with the
  // rig's scripted turns (see main → detectorDuringTurns), appended to TURN_EDGE_LOG.
  // We correlate the rig's recorded swap wall-times against those edges. Guest ring
  // moves are the signal (kssMZb is on the guest tiles in this rig).
  const swaps = (rig.swaps || []).filter((s) => s.to && s.to !== 'host');
  if (!swaps.length) {
    record('ax-events-live', 'FAIL', { reason: 'rig recorded no guest speaker-onset swaps (rig may have degraded to 2-party or failed)' });
    return;
  }
  let edges = [];
  if (existsSync(TURN_EDGE_LOG)) {
    for (const ln of readFileSync(TURN_EDGE_LOG, 'utf8').split('\n')) {
      const i = ln.indexOf('{'); if (i < 0) continue;
      try { const o = JSON.parse(ln.slice(i)); if (o && (o.type === 'meet_edge' || o.kind)) edges.push(o); } catch (e) {}
    }
  }
  if (!edges.length) {
    record('ax-events-live', 'FAIL', { reason: 'no meet_edge events captured in MSD_EDGE_LOG (observer produced no edges — vacuous)', swaps: swaps.length });
    return;
  }
  // Match each swap to the nearest edge naming its target within EDGE_MATCH_MS.
  const targetName = (key) => (rig.participants.find((p) => p.key === key) || {}).name;
  const perSwap = swaps.map((s) => {
    const want = targetName(s.to);
    const near = edges.filter((e) => e.to === want && Math.abs((e.wall_ts || e.ts || 0) - s.tSpeakStart) <= EDGE_MATCH_MS);
    return { from: s.from, to: s.to, want, matched: near.length > 0, dtMs: near.length ? Math.min(...near.map((e) => Math.abs((e.wall_ts || e.ts || 0) - s.tSpeakStart))) : null };
  });
  const allMatched = perSwap.every((p) => p.matched);
  // Rapid-swap block: the 4 rapid onsets are the swaps where from∈{guestA,guestB} && to∈{guestA,guestB}.
  const rapid = perSwap.filter((p) => (p.from === 'guestA' || p.from === 'guestB') && (p.to === 'guestA' || p.to === 'guestB'));
  const rapidCaught = rapid.filter((p) => p.matched).length;
  const rapidOk = rapid.length < 4 ? false : rapidCaught >= RAPID_MIN_CAUGHT;
  const verdict = allMatched && rapidOk ? 'PASS' : 'FAIL';
  record('ax-events-live', verdict, {
    swapsTotal: perSwap.length, allMatched, rapidCaught, rapidTotal: rapid.length, edgeMatchMs: EDGE_MATCH_MS, perSwap,
  });
}

// ===========================================================================
// Scenario 2 — cpu-compare-live
// ===========================================================================
async function scenarioCpuCompare(rig) {
  log('=== cpu-compare-live ===');
  // Drive a steady GUEST1(=Alpha)-speaks window so the detector has real work in every
  // block. The rig windows are OPEN; re-assert Alpha speaking via its page override.
  await driveSteadyAlpha(true);

  // INTERLEAVED A/B: alternate short legacy/event blocks so ambient drift hits both
  // modes equally. Pool each mode's post-warmup samples across all blocks, then take one
  // median per mode; sum full_walks per mode across blocks. Keep every block's raw
  // samples + walk-stats for audit.
  const pollingSamples = [];   // pooled legacy CPU samples (warmup dropped)
  const eventSamples = [];     // pooled event CPU samples (warmup dropped)
  const blocks = [];           // per-block audit records
  let pollWalks = 0, eventWalks = 0;
  let pollWalksSeen = false, eventWalksSeen = false;
  let lastPollWalkStats = null, lastEventWalkStats = null;

  for (let b = 0; b < CPU_BLOCKS; b++) {
    for (const mode of ['legacy', 'event']) {
      const run = await runDetector({ mode, seconds: CPU_BLOCK_S });
      // Drop the block's warmup samples (activation / tree-materialization transient)
      // BEFORE pooling, so no mode is charged for its own startup cost.
      const kept = run.cpuSamples.slice(CPU_WARMUP_SAMPLES);
      const fw = run.walkStats ? run.walkStats.full_walks : null;
      if (mode === 'legacy') {
        pollingSamples.push(...kept);
        if (fw != null) { pollWalks += fw; pollWalksSeen = true; lastPollWalkStats = run.walkStats; }
      } else {
        eventSamples.push(...kept);
        if (fw != null) { eventWalks += fw; eventWalksSeen = true; lastEventWalkStats = run.walkStats; }
      }
      blocks.push({ block: b, mode, samples: run.cpuSamples, kept, blockMedian: median(kept), fullWalks: fw });
    }
  }

  await driveSteadyAlpha(false);

  const pollingCpu = median(pollingSamples);
  const eventCpu = median(eventSamples);

  const raw = {
    pollingCpu, eventCpu, pollingCpuSamples: pollingSamples, eventCpuSamples: eventSamples,
    pollingFullWalks: pollWalksSeen ? pollWalks : null, eventFullWalks: eventWalksSeen ? eventWalks : null,
    pollingWalkStats: lastPollWalkStats, eventWalkStats: lastEventWalkStats,
    blocks, cpuBlocks: CPU_BLOCKS, cpuBlockSeconds: CPU_BLOCK_S, cpuWarmupSamplesDropped: CPU_WARMUP_SAMPLES,
    method: 'interleaved-ab',
  };

  if (pollingCpu == null || eventCpu == null) {
    record('cpu-compare-live', 'FAIL', { reason: 'no CPU samples for one/both modes (detector never ran?)', ...raw });
    return;
  }
  if (!pollWalksSeen || !eventWalksSeen) {
    record('cpu-compare-live', 'FAIL', { reason: 'meet_walk_stats missing for one/both modes (instrumentation not emitted)', ...raw });
    return;
  }
  const cpuThresh = CPU_RATIO * pollingCpu;
  const walkThresh = WALK_RATIO * pollWalks;
  const cpuPass = eventCpu <= cpuThresh;
  const walkPass = eventWalks < walkThresh;
  // REVIEW band applies to NEAR-MISS FAILURES only (failing by <10%): a marginal
  // miss goes to the reviewer instead of hard-failing the loop. A result that MET
  // the threshold is a PASS even when close — otherwise the gate can never pass
  // near the bar it was designed around.
  const cpuNearMiss = !cpuPass && eventCpu <= (1 + REVIEW_BAND) * cpuThresh;
  const walkNearMiss = !walkPass && walkThresh > 0 && eventWalks <= (1 + REVIEW_BAND) * walkThresh;

  let verdict;
  if (cpuPass && walkPass) verdict = 'PASS';
  else verdict = (cpuNearMiss || walkNearMiss) && (cpuPass || cpuNearMiss) && (walkPass || walkNearMiss) ? 'REVIEW' : 'FAIL';

  record('cpu-compare-live', verdict, {
    cpuRatio: +(eventCpu / pollingCpu).toFixed(3), cpuThreshold: +cpuThresh.toFixed(3),
    walkRatio: pollWalks ? +(eventWalks / pollWalks).toFixed(3) : null, walkThreshold: walkThresh,
    cpuPass, walkPass, ...raw,
  });
}

// Re-assert Alpha (GUEST1) speaking on its rig page, via the rig's own cdp-lib +
// the turns module's setSpeak (in-page speech gain + Meet mic button — both needed
// for Meet's VAD to flip). If the rig page is gone this degrades to a no-op so the
// detector still runs and CPU is measured against whatever is live.
async function driveSteadyAlpha(on) {
  try {
    const { attachToPage } = require('./cdp-lib.js');
    const { setSpeak } = require('./roster-rig-turns.js');
    const page = await attachToPage(ALPHA_PORT, /meet\.google\.com/);
    await setSpeak(page, on);
    log(`Alpha steady-speak ${on ? 'ON' : 'OFF'}`);
    return true;
  } catch (e) {
    log(`driveSteadyAlpha(${on}) skipped: ${e.message}`);
    return false;
  }
}

// ===========================================================================
// Scenario 3 — regression-live (accuracy matrix in event mode)
// ===========================================================================
function scenarioRegression(rig) {
  log('=== regression-live ===');
  // The rig already produced the cross-observation matrix under its scripted turns.
  // (The rig injects the SAME DOM detector the browser-qa suite validates; running
  // it live in a real 3-party call is the regression proof.) Assert the accuracy bars.
  const rows = rig.rows || [];
  const byTurn = Object.fromEntries(rows.filter((r) => r.matrix).map((r) => [r.turn, r]));
  const partKeys = (rig.participants || []).map((p) => p.key);
  const cell = (turn, observer, participant) => {
    const r = byTurn[turn]; if (!r || !r.matrix || !r.matrix[observer]) return null;
    return r.matrix[observer][participant];
  };
  // For a given speaker turn, "others" = every observer except the speaker.
  const othersSee = (turn, speaker) => partKeys.filter((k) => k !== speaker).map((obs) => cell(turn, obs, speaker)).filter((v) => v != null);
  const nonSpeakersSeen = (turn, speaker) => {
    const out = [];
    for (const obs of partKeys) for (const p of partKeys) if (p !== speaker && p !== obs) { const v = cell(turn, obs, p); if (v != null) out.push(v); }
    return out;
  };

  const checks = [];
  const degraded = !!rig.degraded;

  // ALPHA turn: others see Alpha >= 0.6; non-speakers <= 0.3
  if (byTurn.ALPHA) {
    const seen = othersSee('ALPHA', 'guestA');
    checks.push({ name: 'alpha-seen>=0.6', ok: seen.length > 0 && seen.every((v) => v >= 0.6), values: seen });
    const ns = nonSpeakersSeen('ALPHA', 'guestA');
    checks.push({ name: 'alpha-nonspeakers<=0.3', ok: ns.every((v) => v <= 0.3), values: ns });
  }
  // BRAVO turn (3-party only): others see Bravo >= 0.6 (ring MOVED)
  if (!degraded && byTurn.BRAVO) {
    const seen = othersSee('BRAVO', 'guestB');
    checks.push({ name: 'bravo-seen>=0.6', ok: seen.length > 0 && seen.every((v) => v >= 0.6), values: seen });
    const ns = nonSpeakersSeen('BRAVO', 'guestB');
    checks.push({ name: 'bravo-nonspeakers<=0.3', ok: ns.every((v) => v <= 0.3), values: ns });
  }
  // OVERLAP: both active speakers seen >= 0.5 by the others.
  if (byTurn.OVERLAP) {
    const active = degraded ? ['host', 'guestA'] : ['guestA', 'guestB'];
    const overlapVals = [];
    for (const sp of active) overlapVals.push(...othersSee('OVERLAP', sp));
    checks.push({ name: 'overlap-both>=0.5', ok: overlapVals.length > 0 && overlapVals.every((v) => v >= 0.5), values: overlapVals });
  }
  // SILENCE: everything <= 0.3.
  for (const st of ['SILENCE', 'SILENCE_END']) {
    if (!byTurn[st]) continue;
    const vals = [];
    for (const obs of partKeys) for (const p of partKeys) if (p !== obs) { const v = cell(st, obs, p); if (v != null) vals.push(v); }
    checks.push({ name: `${st}<=0.3`, ok: vals.every((v) => v <= 0.3), values: vals });
  }

  const allOk = checks.length > 0 && checks.every((c) => c.ok);
  // Degraded 2-party runs are advisory only — verdict REVIEW so a Meet throttle
  // doesn't hard-fail the gate (the reviewer agent adjudicates).
  const verdict = degraded ? 'REVIEW' : (allOk ? 'PASS' : 'FAIL');
  record('regression-live', verdict, { degraded, checks });
}

// ===========================================================================
async function main() {
  if (!process.argv.includes('--all')) {
    console.error('[live-qa] usage: node run-live-qa.mjs --all');
    process.exit(2);
  }
  // Fresh results file each session. Clear stale rig outputs so the wait helpers
  // only trip on THIS session's fresh writes (not a previous run's leftovers).
  writeFileSync(RESULTS_NDJSON, '');
  for (const stale of [RIG_RESULTS, join(HERE, '.roster-rig-state.json'), TURN_EDGE_LOG]) {
    try { if (existsSync(stale)) rmSync(stale); } catch (e) {}
  }

  if (!preflightAxTrust()) {
    record('ax-events-live', 'FAIL', { reason: 'Accessibility permission not granted' });
    record('cpu-compare-live', 'FAIL', { reason: 'Accessibility permission not granted' });
    record('regression-live', 'FAIL', { reason: 'Accessibility permission not granted' });
    console.log('LIVE SESSION COMPLETE');
    process.exit(1);
  }
  if (!prebuildDetector()) {
    record('ax-events-live', 'FAIL', { reason: 'swift build failed' });
    record('cpu-compare-live', 'FAIL', { reason: 'swift build failed' });
    record('regression-live', 'FAIL', { reason: 'swift build failed' });
    console.log('LIVE SESSION COMPLETE');
    process.exit(1);
  }

  const rigProc = launchRig();
  let rig = null;
  let detDuringTurns = null;
  try {
    // Wait for the rig to finish join+admit (it writes .roster-rig-state.json right
    // before starting the scripted turns), THEN launch a long event-mode detector
    // window with a fixed edge log so meet_edge events are captured DURING the turns
    // for the ax-events correlation. Fire-and-forget; awaited in `finally`.
    const stateReady = await waitStateFile(10 * 60_000, rigProc);
    if (stateReady) {
      log('rig admitted guests — launching concurrent event-mode detector for turn window');
      try { writeFileSync(TURN_EDGE_LOG, ''); } catch (e) {}
      // Cover the full scripted turn window (~55s speech + settles). Auto-exits.
      detDuringTurns = runDetector({ mode: 'event', seconds: 150, edgeLog: TURN_EDGE_LOG });
    } else {
      log('WARN: rig state file never appeared — ax-events may see no edges');
    }

    // Rig: join + admit both guests + run the full scripted turn sequence. Generous
    // timeout: 3 anonymous joins + admits + ~55s of scripted turns.
    rig = await waitRigResults(12 * 60_000, rigProc);
    if (detDuringTurns) { try { await detDuringTurns; } catch (e) {} }
    if (!rig) {
      record('ax-events-live', 'FAIL', { reason: 'rig produced no results (join/admit/turns failed within timeout)' });
      record('cpu-compare-live', 'FAIL', { reason: 'rig produced no results' });
      record('regression-live', 'FAIL', { reason: 'rig produced no results' });
      console.log('LIVE SESSION COMPLETE');
      process.exit(1);
    }
    log(`rig results: degraded=${rig.degraded} swaps=${(rig.swaps || []).length} turns=${(rig.rows || []).length}`);

    // Scenarios back-to-back in the one live session.
    await scenarioAxEvents(rig);
    await scenarioCpuCompare(rig);
    scenarioRegression(rig);
  } finally {
    try { rigProc.kill('SIGINT'); } catch (e) {}
    await sleep(1500);
    try { rigProc.kill('SIGKILL'); } catch (e) {}
  }

  console.log('LIVE SESSION COMPLETE');
  process.exit(0);
}

main().catch((e) => {
  console.error('[live-qa] FATAL', e && e.stack ? e.stack : e);
  // Still emit COMPLETE so the orchestrator's live-session suite matches; reader
  // suites will FAIL on the missing/incomplete verdict lines.
  console.log('LIVE SESSION COMPLETE');
  process.exit(1);
});
