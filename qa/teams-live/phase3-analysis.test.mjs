#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Offline unit test for the Phase-3 Teams-live ANALYSIS helpers (no live session).
// Proves each parser/analyzer classifies synthesized PRODUCT-format logs correctly,
// with a POSITIVE and a NEGATIVE case per assertion. The stderr parsers are also
// run against on-disk fixture logs (fixtures/*.stderr.log) that carry the EXACT
// product line formats pinned from bubbles-dev d8a87b8da6 — so a format drift in
// the product (or a typo in a regex) fails HERE, offline, not live. Run:
//   TEAMS_GUEST_NAME="QA Guest" node qa/teams-live/phase3-analysis.test.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseKeepaliveLines, parseWakeLines, parseTitleWakeLines,
  ringLitSamples, firstRingLit, longestDarkGap, teamsEdgesTo,
  analyzeThrottle, analyzeRingContinuity, analyzeWakeAccel, analyzeWakeControl,
  analyzeWebColdStart, abaAdjudicate,
} from './run-teams-live-qa.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUEST = process.env.TEAMS_GUEST_NAME || 'QA Guest';
const KEY = 'Microsoft Teams|com.microsoft.teams2';
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok   -', msg); } else { fail++; console.log('  FAIL -', msg); } };

// Load a fixture stderr log into the {ts,line} shape the parsers consume. Each line
// gets a synthetic monotonically-increasing ts (the parsers key on the line text;
// ts is only carried through for correlation, so any increasing sequence is fine).
function loadStderr(name, t0 = 1_000_000, step = 1000) {
  const lines = readFileSync(join(HERE, 'fixtures', name), 'utf8').split('\n').filter(Boolean);
  return lines.map((line, i) => ({ ts: t0 + i * step, line }));
}
// Ring sample every 250ms in [t0,t1); lit(ts) decides whether GUEST is in ring_names.
function ring(t0, t1, lit, step = 250) {
  const out = [];
  for (let ts = t0; ts < t1; ts += step) out.push({ ts, ring_names: lit(ts) ? [GUEST] : [] });
  return out;
}
const edge = (to, wall) => ({ type: 'teams_edge', kind: 'ring-gained', to, wall_ts: wall, ts: wall, confidence: 0.9 });

// === 1. parseKeepaliveLines (fixture-backed) ================================
console.log('parseKeepaliveLines:');
{
  const { engage, release } = parseKeepaliveLines(loadStderr('keepalive.stderr.log'));
  ok(engage.length === 2, 'POS: two engage lines parsed from fixture');
  ok(engage[0].key === KEY && engage[0].ageMs === 1240 && engage[0].pid === 4321, 'POS: engage fields (key/age_ms/pid) parsed');
  ok(release.length === 2 && release[0].reason === 'recovered' && release[1].reason === 'ttl-expired', 'POS: release reasons parsed');
  const neg = parseKeepaliveLines([{ ts: 1, line: 'teams-keepalive: something-else key=x' }, { ts: 2, line: 'noise' }]);
  ok(neg.engage.length === 0 && neg.release.length === 0, 'NEG: non-matching keepalive lines yield nothing');
}

// === 2. parseWakeLines (fixture-backed) =====================================
console.log('parseWakeLines:');
{
  const w = parseWakeLines(loadStderr('wake.stderr.log'));
  ok(w.attached.length === 1 && w.attached[0].pid === 4321, 'POS: attached parsed');
  ok(w.consumed.length === 2 && w.consumed[0].dtMs === 180 && w.consumed[1].dtMs === 95, 'POS: consumed dt_ms parsed');
  ok(w.released.length === 1 && w.released[0].pid === 4321, 'POS: released parsed');
  ok(w.createFail.length === 1 && w.createFail[0].pid === 9999 && w.createFail[0].err === -25211, 'POS: observer-create-fail parsed');
  // register-fail lines must NOT be miscounted as attached/consumed/etc.
  ok(w.attached.length + w.consumed.length + w.released.length + w.createFail.length === 5,
    'POS: app/window-register-fail lines are not miscounted');
  const neg = parseWakeLines([{ ts: 1, line: 'teams-wake: attached but no pid field' }]);
  ok(neg.attached.length === 0, 'NEG: malformed attached (no pid) not parsed');
}

// === 3. parseTitleWakeLines (fixture-backed) ================================
console.log('parseTitleWakeLines:');
{
  const t = parseTitleWakeLines(loadStderr('title-wake.stderr.log'));
  ok(t.length === 2 && t[0].bundle === 'com.google.Chrome' && t[0].pid === 7777, 'POS: title-wake bundle+pid parsed');
  ok(/Microsoft Teams/.test(t[0].title), 'POS: title snippet captured');
  const neg = parseTitleWakeLines([{ ts: 1, line: 'title-wake without the expected shape' }]);
  ok(neg.length === 0, 'NEG: malformed title-wake not parsed');
}

// === 4. ring helpers ========================================================
console.log('ring helpers:');
{
  const lit = ring(0, 2000, () => true);
  const dark = ring(0, 2000, () => false);
  ok(ringLitSamples(lit, GUEST, 0, 2000).length > 0, 'POS: lit ring yields lit samples');
  ok(ringLitSamples(dark, GUEST, 0, 2000).length === 0, 'NEG: dark ring yields no lit samples');
  ok(firstRingLit(ring(0, 4000, (t) => t >= 1000), GUEST, 0, 4000) === 1000, 'POS: firstRingLit finds onset ts');
  ok(firstRingLit(dark, GUEST, 0, 2000, 2000) === null, 'NEG: firstRingLit null when never lit');
  // longestDarkGap: a 1.2s dark span in the middle of a lit window.
  const withGap = [...ring(0, 1000, () => true), ...ring(1000, 2200, () => false), ...ring(2200, 3000, () => true)];
  const g = longestDarkGap(withGap, GUEST, 0, 3000);
  ok(g.gapMs >= 1000 && g.gapMs <= 1400, `POS: longestDarkGap ~1.2s (got ${g.gapMs})`);
  ok(longestDarkGap(ring(0, 3000, () => true), GUEST, 0, 3000).gapMs === 0, 'NEG: continuously-lit ring -> gap 0');
}

// === 5. analyzeThrottle =====================================================
console.log('analyzeThrottle:');
{
  const minimizeTs = 100_000, restoreTs = 100_000 + 130_000; // 130s throttle
  // GOOD: engage during throttle, no idle, ring dark in the tail, re-lights on restore.
  const keepalive = { engage: [{ ts: minimizeTs + 500, key: KEY, ageMs: 10, pid: 1 }], release: [] };
  const wire = [{ rxTs: minimizeTs + 1000, event: 'speaking', key: KEY }];
  const rt = [
    ...ring(minimizeTs, minimizeTs + 4000, () => true),      // still lit right after minimize
    ...ring(minimizeTs + 4000, restoreTs, () => false),      // throttled: ring dark
    ...ring(restoreTs, restoreTs + 6000, (t) => t >= restoreTs + 2000), // recovers +2s
  ];
  const good = analyzeThrottle({ keepalive, wire, ringTrace: rt, meetingKey: KEY, guestName: GUEST, minimizeTs, restoreTs });
  ok(good.pass === true, 'POS: engage+no-idle+released+recovered -> PASS');
  ok(good.recoverMs >= 1500 && good.recoverMs <= 2500, `POS: recovery latency measured (~2s, got ${good.recoverMs})`);

  // NEG a: session IDLED during throttle -> keptSession false -> FAIL.
  const idledWire = [{ rxTs: minimizeTs + 5000, event: 'meet-idle', key: KEY }];
  const nIdle = analyzeThrottle({ keepalive, wire: idledWire, ringTrace: rt, meetingKey: KEY, guestName: GUEST, minimizeTs, restoreTs });
  ok(nIdle.pass === false && nIdle.keptSession === false, 'NEG: meet-idle during throttle -> keptSession false, FAIL');

  // NEG b: PHANTOM speaker — ring stayed lit through the throttle tail -> FAIL.
  const phantomRt = ring(minimizeTs, restoreTs + 6000, () => true);
  const nPhantom = analyzeThrottle({ keepalive, wire, ringTrace: phantomRt, meetingKey: KEY, guestName: GUEST, minimizeTs, restoreTs });
  ok(nPhantom.pass === false && nPhantom.releasedToEmpty === false, 'NEG: phantom lit ring in tail -> releasedToEmpty false, FAIL');

  // NEG c: no keepalive engage -> FAIL.
  const nNoEngage = analyzeThrottle({ keepalive: { engage: [], release: [] }, wire, ringTrace: rt, meetingKey: KEY, guestName: GUEST, minimizeTs, restoreTs });
  ok(nNoEngage.pass === false && nNoEngage.keepaliveEngaged === false, 'NEG: no keepalive engage -> FAIL');
}

// === 6. analyzeRingContinuity ===============================================
console.log('analyzeRingContinuity:');
{
  const s0 = 200_000, s1 = 200_000 + 20_000;
  // GOOD: ring stays lit across the switch (a couple of one-sample blips < 2.5s).
  const goodRt = ring(s0, s1, (t) => !(t >= s0 + 5000 && t < s0 + 5250)); // 250ms blip only
  const good = analyzeRingContinuity({ ringTrace: goodRt, events: [], guestName: GUEST, switchStart: s0, switchEnd: s1 });
  ok(good.pass === true && good.longestDarkGapMs <= 2500, `POS: continuous ring survives switch (gap ${good.longestDarkGapMs})`);
  // NEG: a 4s release+reopen gap during the switch -> FAIL, and a reopen edge inside.
  const badRt = [
    ...ring(s0, s0 + 6000, () => true),
    ...ring(s0 + 6000, s0 + 10_000, () => false), // 4s dark
    ...ring(s0 + 10_000, s1, () => true),
  ];
  const events = [edge(GUEST, s0 + 10_100)];
  const bad = analyzeRingContinuity({ ringTrace: badRt, events, guestName: GUEST, switchStart: s0, switchEnd: s1 });
  ok(bad.pass === false && bad.longestDarkGapMs >= 3500, `NEG: 4s release gap -> FAIL (gap ${bad.longestDarkGapMs})`);
  ok(bad.reopenEdges === 1, 'NEG: reopen teams_edge inside the window counted');
}

// === 7. analyzeWakeAccel + analyzeWakeControl ===============================
console.log('analyzeWakeAccel / analyzeWakeControl:');
{
  // Six onsets; a consumed lands within 2s of each (main leg). Silence window later.
  const onsets = [10_000, 20_000, 30_000, 40_000, 50_000, 60_000];
  const events = onsets.map((t) => edge(GUEST, t));
  const wake = {
    attached: [{ ts: 5_000, pid: 1 }],
    consumed: onsets.map((t) => ({ ts: t + 150, dtMs: 150 })),  // one consume ~150ms after each onset
    released: [], createFail: [],
  };
  const walkStats = { type: 'meet_walk_stats', full_walks: 20, subtree_reads: 40, teams_wakes: 6 };
  const silenceWindow = { start: 70_000, end: 100_000 }; // >=30s, no consumes there
  const acc = analyzeWakeAccel({ wake, events, walkStats, onsetName: GUEST, silenceWindow });
  ok(acc.pass === true, 'POS: attached + consumes near each onset + quiet silence + teams_wakes>0 -> PASS');
  ok(acc.onsetsCovered === 6, 'POS: all six onsets covered');

  // NEG a: allow <=1 miss — 2 misses fails.
  const wakeMiss = { ...wake, consumed: onsets.slice(0, 4).map((t) => ({ ts: t + 150, dtMs: 150 })) };
  const accMiss = analyzeWakeAccel({ wake: wakeMiss, events, walkStats, onsetName: GUEST, silenceWindow });
  ok(accMiss.pass === false && accMiss.onsetsOk === false, 'NEG: 2 uncovered onsets (>1 allowed miss) -> FAIL');

  // NEG b: a consume DURING the silence window -> silenceQuiet false -> FAIL.
  const wakeNoisySilence = { ...wake, consumed: [...wake.consumed, { ts: 85_000, dtMs: 200 }] };
  const accNoisy = analyzeWakeAccel({ wake: wakeNoisySilence, events, walkStats, onsetName: GUEST, silenceWindow });
  ok(accNoisy.pass === false && accNoisy.silenceQuiet === false, 'NEG: consume in silence window -> FAIL');

  // NEG c: teams_wakes==0 in walk-stats -> counterOk false -> FAIL.
  const accNoCounter = analyzeWakeAccel({ wake, events, walkStats: { ...walkStats, teams_wakes: 0 }, onsetName: GUEST, silenceWindow });
  ok(accNoCounter.pass === false && accNoCounter.counterOk === false, 'NEG: teams_wakes==0 -> FAIL');

  // CONTROL leg: zero wake lines, detection still works, counter 0 -> PASS.
  const ctrl = analyzeWakeControl({
    wake: { attached: [], consumed: [], released: [], createFail: [] },
    events, walkStats: { ...walkStats, teams_wakes: 0 }, onsetName: GUEST,
  });
  ok(ctrl.pass === true, 'POS(control): no wake lines + detection works + counter 0 -> PASS (additive proven)');
  // NEG (control): a stray wake line means the kill switch did not take -> FAIL.
  const ctrlBad = analyzeWakeControl({
    wake: { attached: [{ ts: 1, pid: 1 }], consumed: [], released: [], createFail: [] },
    events, walkStats: { ...walkStats, teams_wakes: 0 }, onsetName: GUEST,
  });
  ok(ctrlBad.pass === false && ctrlBad.noWakeLines === false, 'NEG(control): stray wake line with kill switch -> FAIL');
  // NEG (control): detection stopped working (no edges) -> FAIL even with 0 wakes.
  const ctrlNoDetect = analyzeWakeControl({
    wake: { attached: [], consumed: [], released: [], createFail: [] },
    events: [], walkStats: { ...walkStats, teams_wakes: 0 }, onsetName: GUEST,
  });
  ok(ctrlNoDetect.pass === false && ctrlNoDetect.detectionWorks === false, 'NEG(control): no detection at poll floor -> FAIL');
}

// === 8. analyzeWebColdStart =================================================
console.log('analyzeWebColdStart:');
{
  const detectStartTs = 500_000;
  const titleWakes = [{ ts: detectStartTs + 100, bundle: 'com.google.Chrome', pid: 7777, title: 'Sync | Microsoft Teams' }];
  const events = [{ type: 'meeting_initialized', platform: 'teams', ts: detectStartTs + 1800, meeting_id: 'teams::x' }];
  const good = analyzeWebColdStart({ titleWakes, events, detectStartTs, chromePids: [7777] });
  ok(good.pass === true && good.detectLatencyMs === 1800, 'POS: title-wake + teams meeting detected within budget -> PASS');

  // NEG a: no title-wake for the chrome pid -> FAIL.
  const nNoWake = analyzeWebColdStart({ titleWakes: [], events, detectStartTs, chromePids: [7777] });
  ok(nNoWake.pass === false && nNoWake.wakeFired === false, 'NEG: no title-wake -> FAIL');
  // NEG b: detected too late (> budget) -> withinBudget false -> FAIL.
  const lateEvents = [{ type: 'meeting_initialized', platform: 'teams', ts: detectStartTs + 9000 }];
  const nLate = analyzeWebColdStart({ titleWakes, events: lateEvents, detectStartTs, chromePids: [7777] });
  ok(nLate.pass === false && nLate.withinBudget === false, 'NEG: detected after budget -> FAIL');
  // NEG c: a Meet meeting_initialized (wrong platform) must not count as detected.
  const nWrongPlat = analyzeWebColdStart({ titleWakes, events: [{ type: 'meeting_initialized', platform: 'meet', ts: detectStartTs + 500 }], detectStartTs, chromePids: [7777] });
  ok(nWrongPlat.pass === false && nWrongPlat.detected === false, 'NEG: non-teams platform -> not detected');
}

// === 9. abaAdjudicate =======================================================
console.log('abaAdjudicate:');
{
  ok(abaAdjudicate({ originalVerdict: 'PASS' }).verdict === 'PASS', 'POS: non-FAIL verdict passes through untouched (no ABA)');
  // Environmental: subtree_reads==0 on BOTH legs -> ENVIRONMENTAL-RETRY, not FAIL.
  const envR = abaAdjudicate({ originalVerdict: 'FAIL',
    suspectStats: { subtree_reads: 0, full_walks: 5 }, referenceStats: { subtree_reads: 0, full_walks: 5 } });
  ok(envR.verdict === 'ENVIRONMENTAL-RETRY', 'POS: subtree_reads==0 on both legs -> ENVIRONMENTAL-RETRY');
  // Confirmed regression: suspect genuinely does more full_walks than the reference.
  const confirmed = abaAdjudicate({ originalVerdict: 'FAIL',
    suspectStats: { subtree_reads: 30, full_walks: 40 }, referenceStats: { subtree_reads: 30, full_walks: 12 } });
  ok(confirmed.verdict === 'FAIL', 'POS: suspect full_walks > reference -> FAIL stands');
  // Flake: ABA does not reproduce (suspect <= reference) -> REVIEW.
  const flake = abaAdjudicate({ originalVerdict: 'FAIL',
    suspectStats: { subtree_reads: 30, full_walks: 10 }, referenceStats: { subtree_reads: 30, full_walks: 12 } });
  ok(flake.verdict === 'REVIEW', 'NEG: FAIL not reproduced by ABA -> REVIEW (flake, human-gate)');
}

console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILED'} — ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
