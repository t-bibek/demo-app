#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Offline unit test for the zoomweb cpu-compare GATE (no live session, no spawn).
// Exercises the PURE `adjudicateCpuCompare` verdict math imported from the rig with
// SYNTHETIC pooled-sample arrays, one POSITIVE and one NEGATIVE per assertion —
// mirroring qa/teams-live/phase3-analysis.test.mjs. This pins the Meet-2149a92
// methodology port: the fast-binary idle-floor case must FLIP from a false median
// FAIL to the walkRatio-only (cpuSignal:'low') path, and a genuine event-vs-legacy
// regression must still FAIL. Import-only (the rig's live main() is guarded), so this
// runs during the TEST EMBARGO: pure JS, no detector, no rig. Run:
//   node qa/zoomweb-live/cpu-compare.test.mjs
// ---------------------------------------------------------------------------
import { adjudicateCpuCompare } from './run-zoomweb-live-qa.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok   -', msg); } else { fail++; console.log('  FAIL -', msg); } };

// A pooled-sample array of `n` copies of `v` (a mode that measured a steady %cpu).
const arr = (v, n) => Array.from({ length: n }, () => v);
// Mix `hi` above-floor samples with `lo` idle-floor samples (median lands at the
// mode's majority; the fast-binary regime is >50% at the floor).
const mix = (floor, hiVal, floorCount, hiCount) => [...arr(floor, floorCount), ...arr(hiVal, hiCount)];
// Standard walk counts for a HEALTHY event tier: event does far fewer full walks.
const HEALTHY_WALKS = { pollWalks: 28, eventWalks: 12, pollWalksSeen: true, eventWalksSeen: true }; // ratio 0.429 < 0.5

// === 1. FAST-BINARY IDLE-FLOOR CASE — the ported-fix flip ====================
// >50% of the 2s ps samples land at the ~0.4% idle floor in BOTH modes, so the
// MEDIANS saturate at the floor. The OLD median gate (eventCpu <= 0.6*pollingCpu)
// would read a floor/floor ratio of ~1.0 => a deterministic false FAIL. The ported
// gate must detect cpuSignal:'low', drop the CPU gate, and let walkRatio decide.
console.log('fast-binary idle-floor (the 2149a92 flip):');
{
  // Both modes: 6 samples at the 0.4% floor + 2 tiny above-floor blips => median 0.4.
  const pollingSamples = mix(0.4, 0.9, 6, 2);   // median 0.4, mean ~0.525
  const eventSamples   = mix(0.4, 0.8, 6, 2);   // median 0.4, mean ~0.500
  // Sanity: the OLD median gate would have FAILED this identical-work data.
  const oldPollingMed = 0.4, oldEventMed = 0.4;
  ok(oldEventMed / oldPollingMed > 0.6, 'PRECONDITION: median ratio (0.4/0.4=1.0) > 0.6 bar => OLD gate FALSE-FAILs');

  const { verdict, detail } = adjudicateCpuCompare({ pollingSamples, eventSamples, ...HEALTHY_WALKS });
  ok(detail.cpuSignal === 'low', 'POS: both medians at 2x idle baseline => cpuSignal:"low"');
  ok(detail.cpuPass === null, 'POS: CPU gate not adjudicated when signal is low (cpuPass null)');
  ok(detail.walkPass === true, 'POS: walkRatio 0.429 < 0.5 => walkPass');
  ok(verdict === 'PASS', 'POS: low-signal + walkPass => PASS (was a false FAIL under the median gate)');
  ok(detail.meanRatio != null && detail.cpuRatio != null, 'POS: both meanRatio (gated) and median cpuRatio (continuity) reported');

  // Same idle-floor regime but the EVENT tier regressed on WALKS (28 vs 28) => the
  // walk-only path must still FAIL, proving the guard is not a blanket pass.
  const bad = adjudicateCpuCompare({ pollingSamples, eventSamples, pollWalks: 28, eventWalks: 28, pollWalksSeen: true, eventWalksSeen: true });
  ok(bad.detail.cpuSignal === 'low' && bad.verdict === 'FAIL', 'NEG: low-signal but event walks NOT < 0.5*polling => walk-only path FAILs');
}

// === 2. GENUINE REGRESSION (real CPU signal) — must still FAIL ===============
// Both modes carry real above-floor work (median well above 2x the baseline), so the
// guard does NOT engage: the MEAN gate applies. The event tier burns MORE cpu than
// 0.6*polling AND does not beat the walk bar => a genuine regression must hard-FAIL.
console.log('genuine regression (real CPU signal, mean-gated):');
{
  const pollingSamples = arr(20.0, 8);          // steady 20% work, median 20
  const eventSamples   = arr(18.0, 8);          // steady 18% => mean ratio 0.9 >> 0.6 bar
  const { verdict, detail } = adjudicateCpuCompare({
    pollingSamples, eventSamples, pollWalks: 28, eventWalks: 26, pollWalksSeen: true, eventWalksSeen: true, // walks barely down => walkPass false
  });
  ok(detail.cpuSignal === 'ok', 'POS: above-floor medians => cpuSignal:"ok" (guard does NOT engage)');
  ok(detail.cpuPass === false, 'POS: eventCpuMean 18 > 0.6*20=12 => cpuPass false (mean-gated)');
  ok(detail.walkPass === false, 'POS: event walks 26 not < 14 => walkPass false');
  ok(verdict === 'FAIL', 'POS: real signal + both gates fail (beyond REVIEW band) => FAIL stands');
}

// === 3. HEALTHY EVENT TIER (real signal, event genuinely cheaper) => PASS ====
console.log('healthy event tier (mean-gated PASS):');
{
  const pollingSamples = arr(20.0, 8);          // 20% legacy
  const eventSamples   = arr(8.0, 8);           // 8% event => mean ratio 0.4 <= 0.6
  const { verdict, detail } = adjudicateCpuCompare({ pollingSamples, eventSamples, ...HEALTHY_WALKS });
  ok(detail.cpuSignal === 'ok' && detail.cpuPass === true, 'POS: eventCpuMean 8 <= 0.6*20=12 => cpuPass under mean gate');
  ok(detail.walkPass === true, 'POS: walkRatio 0.429 < 0.5 => walkPass');
  ok(verdict === 'PASS', 'POS: real signal, both gates pass => PASS');
}

// === 4. IDLE-FLOOR CAP — uniformly-busy mode is NOT zeroed out ===============
// A mode whose MINIMUM sample is itself real work (uniform 6%, median==min) has genuine
// CPU signal even though median==min. The cap (IDLE_FLOOR_CAP_PCT=1.0) must keep the
// guard OFF so this is mean-gated, not falsely passed via the low-signal walk path.
console.log('idle-floor cap (uniformly-busy min is real work):');
{
  const pollingSamples = arr(6.0, 8);           // uniform 6% => median==min==6 (> 1.0 cap)
  const eventSamples   = arr(6.0, 8);           // uniform 6% => mean ratio 1.0 > 0.6
  const { detail, verdict } = adjudicateCpuCompare({ pollingSamples, eventSamples, pollWalks: 28, eventWalks: 27, pollWalksSeen: true, eventWalksSeen: true });
  ok(detail.idleBaseline === 6.0 && detail.cpuSignal === 'ok', 'POS: baseline 6% > 1.0 cap => guard OFF, cpuSignal:"ok" (NOT falsely low)');
  ok(verdict === 'FAIL', 'POS: uniformly-busy same-cost regression is mean-gated and FAILs (cap prevents false low-signal pass)');
}

// === 5. REVIEW band — a near-miss on the mean CPU gate ========================
console.log('REVIEW band (near-miss on the mean gate):');
{
  const pollingSamples = arr(20.0, 8);          // legacy 20 => cpuThresh 12
  const eventSamples   = arr(13.0, 8);          // 13 > 12 but <= 1.1*12=13.2 => near-miss
  const { verdict, detail } = adjudicateCpuCompare({ pollingSamples, eventSamples, ...HEALTHY_WALKS }); // walkPass true
  ok(detail.cpuPass === false, 'POS: eventCpuMean 13 > 12 => cpuPass false');
  ok(verdict === 'REVIEW', 'POS: CPU near-miss (<=10% over) + walkPass => REVIEW, not FAIL');
}

// === 6. INSTRUMENTATION-MISSING guard rails ==================================
console.log('missing-input guards:');
{
  const noSamples = adjudicateCpuCompare({ pollingSamples: [], eventSamples: [], ...HEALTHY_WALKS });
  ok(noSamples.verdict === 'FAIL' && /no CPU samples/.test(noSamples.detail.reason), 'NEG: empty sample arrays => FAIL (no CPU samples)');
  const noWalks = adjudicateCpuCompare({ pollingSamples: arr(5, 4), eventSamples: arr(5, 4), pollWalks: 0, eventWalks: 0, pollWalksSeen: false, eventWalksSeen: false });
  ok(noWalks.verdict === 'FAIL' && /walk_stats missing/.test(noWalks.detail.reason), 'NEG: walk-stats not emitted => FAIL (instrumentation missing)');
}

console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILED'} — ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
