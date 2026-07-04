#!/usr/bin/env node
// Offline unit test for the Teams ring-probe ANALYSIS math (no live session). Proves
// guestRingFraction / measureLinger / analyzeProbe classify a synthetic ring trace
// correctly — the load-bearing logic that turns raw ring samples into PASS/FAIL. Run:
//   TEAMS_GUEST_NAME="QA Guest" node qa/teams-live/probe-analysis.test.mjs
import { guestRingFraction, measureLinger, analyzeProbe, measureThrottle } from './run-teams-live-qa.mjs';

const GUEST = process.env.TEAMS_GUEST_NAME || 'QA Guest';
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok   -', msg); } else { fail++; console.log('  FAIL -', msg); } };
const near = (a, b, tol, msg) => ok(a != null && Math.abs(a - b) <= tol, `${msg} (got ${a}, want ~${b})`);

// A sample every 150ms in [t0,t1); `lit(ts)` decides whether the guest ring is on.
function samples(t0, t1, lit) {
  const out = [];
  for (let ts = t0; ts < t1; ts += 150) out.push({ ts, ring_names: lit(ts) ? [GUEST] : [] });
  return out;
}
const marks = [
  { phase: 'A_silent_start', ts: 1_000 }, { phase: 'A_silent_end', ts: 46_000 },
  { phase: 'B_speak_start', ts: 46_000 }, { phase: 'B_speak_end', ts: 76_000 },
  { phase: 'C_stop', ts: 96_000 },
  { phase: 'D_tone_start', ts: 116_000 }, { phase: 'D_tone_end', ts: 156_000 },
  { phase: 'E_mute', ts: 176_000 },
];

// --- guestRingFraction ---
const litAll = samples(0, 3_000, () => true);
const darkAll = samples(0, 3_000, () => false);
ok(guestRingFraction(litAll, 0, 3_000).frac === 1, 'all-lit window -> frac 1');
ok(guestRingFraction(darkAll, 0, 3_000).frac === 0, 'all-dark window -> frac 0');
ok(guestRingFraction([], 0, 3_000).frac === null, 'no samples -> frac null');
ok(guestRingFraction(samples(0, 3_000, (t) => t >= 1_500), 0, 3_000).frac === 0.5, 'half-lit window -> frac 0.5');

// --- measureLinger: ring stays lit 900ms past stop, then clears ---
const lingerTrace = samples(96_000, 111_000, (t) => t < 96_900);
near(measureLinger(lingerTrace, 96_000), 900, 200, 'linger ~= last-lit minus stop');
ok(measureLinger(samples(96_000, 111_000, () => false), 96_000) === 0, 'already dark at stop -> linger 0');

// --- analyzeProbe: the GOOD outcome (dark when silent, lit when speaking) -> PASS ---
{
  const trace = [
    ...samples(1_000, 46_000, () => false),       // A silent -> dark
    ...samples(46_000, 76_000, () => true),        // B speak  -> lit
    ...samples(96_000, 100_000, (t) => t < 97_200),// C linger ~1.2s
    ...samples(116_000, 156_000, () => false),     // D tone   -> dark (content-VAD)
    ...samples(176_000, 178_000, () => false),     // E post-mute dark
  ];
  const v = analyzeProbe(trace, marks);
  ok(v.pass === true, 'GOOD: dark-when-silent + lit-when-speaking -> PASS');
  ok(v.rigDroveRing === true, 'GOOD: rig drove the ring in B');
  ok(v.stayedDarkSilent === true, 'GOOD: ring dark through silent A');
  near(v.lingerMs, 1_200, 300, 'GOOD: linger-L measured');
}

// --- analyzeProbe: the BUG (ring lit while unmuted-but-silent) -> FAIL ---
{
  const trace = [
    ...samples(1_000, 46_000, () => true),   // A silent but ring LIT -> the bug
    ...samples(46_000, 76_000, () => true),   // B speak lit
  ];
  const v = analyzeProbe(trace, marks);
  ok(v.pass === false, 'BUG: ring lit during silent A -> FAIL (not a pass)');
  ok(v.stayedDarkSilent === false, 'BUG: stayedDarkSilent is false');
  ok(v.silentWindow.frac >= 0.9, 'BUG: silent-window fraction high');
}

// --- analyzeProbe: rig never moved the ring in B -> REVIEW (inconclusive), not PASS ---
{
  const trace = [...samples(1_000, 46_000, () => false), ...samples(46_000, 76_000, () => false)];
  const v = analyzeProbe(trace, marks);
  ok(v.rigDroveRing === false, 'INCONCLUSIVE: ring never lit in B -> rigDroveRing false');
  ok(v.pass === false, 'INCONCLUSIVE: not a PASS when the rig proved nothing');
}

// --- measureThrottle: tree goes empty 1s after the backgrounding action, PIP survives ---
{
  const t0 = 200_000;
  const trace = [
    { ts: t0 + 250, readable: true, tile_count: 3, pip: null, keep_alive: false },
    { ts: t0 + 500, readable: true, tile_count: 3, pip: null, keep_alive: false },
    { ts: t0 + 1_000, readable: false, tile_count: 0, pip: 'Alice Kumar', keep_alive: true },
    { ts: t0 + 1_250, readable: false, tile_count: 0, pip: 'Alice Kumar', keep_alive: true },
  ];
  const m = measureThrottle(trace, t0);
  near(m.latencyMs, 1_000, 1, 'throttle: tree-empty latency measured from action');
  ok(m.pipSurvived === true, 'throttle: PIP note present while unreadable -> pipSurvived true');
  ok(m.keptAlive === true, 'throttle: keep-alive engaged while unreadable');
}
// --- measureThrottle: never throttles within the window -> latency null (not 0) ---
{
  const t0 = 300_000;
  const trace = [
    { ts: t0 + 250, readable: true, tile_count: 3, pip: null, keep_alive: false },
    { ts: t0 + 5_000, readable: true, tile_count: 2, pip: null, keep_alive: false },
  ];
  const m = measureThrottle(trace, t0, 10_000);
  ok(m.latencyMs === null, 'throttle: readable throughout -> latencyMs null (never emptied)');
  ok(m.pipSurvived === false, 'throttle: never empty -> pipSurvived false');
}

console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILED'} — ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
