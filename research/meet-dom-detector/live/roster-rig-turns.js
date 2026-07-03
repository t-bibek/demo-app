'use strict';
// ============================================================================
// Scripted speech-turn sequence + 3-way cross-observation for the 3-party rig
// (roster-rig-3p.js). This is a THIN DRIVER MODULE: it operates on CDP page
// connections the rig already opened + joined, so all of the hard-won join/admit
// gotchas stay in roster-rig-3p.js and are NOT duplicated here.
//
// It reuses, verbatim in spirit, the per-seat speech gating (__fakeMicSpeak +
// the Meet mic-mute button) and the cross-observation oracle from
// fake-audio-rig.js, generalized from 2 seats (host/guest) to 3 (host + Guest
// Alpha + Guest Bravo). Cross-observation is the ONLY valid oracle: Meet renders
// no strong equalizer on your OWN self-tile, so each observer page is scored on
// how often it names each OTHER participant's tile — never itself.
//
// SEQUENCE (drives ring-moved on a real 3+ person call — the ring/kssMZb only
// exists with 3+ people):
//   SILENCE → HOST(8s) → ALPHA(8s, ring appears) → BRAVO(8s, ring MUST MOVE)
//   → RAPID SWAP Alpha(2s)→Bravo(2s)→Alpha(2s)→Bravo(2s)
//   → OVERLAP Alpha+Bravo(8s) → SILENCE
//
// Emits, into the results JSON:
//   • matrix rows      — per turn, fraction of polls each observer named each other
//   • swaps[{from,to,tSpeakStart}] — wall-clock ms at each speaker-onset, so an
//     external edge-latency check (run-live-qa.mjs) can correlate detector
//     meet_edge events against the scripted onsets.
//
// GOTCHAS PRESERVED (do not "simplify" away): __fakeMicSpeak gates the in-page
// speech gain AND the Meet mic button is toggled (setMic) — both are needed for
// Meet's VAD to flip; guest windows need el.click() (handled in the rig), host
// needs CDP mouse clicks (handled in the rig). This module only touches the mic
// button by accessible name, which works on every seat.
// ============================================================================
const fs = require('fs');
const path = require('path');

const DETECTOR_PATH = path.join(__dirname, '..', 'browser-qa', 'dom-detector.js');

// --- Turn gating: in-page speech gain + Meet mic mute button (from fake-audio-rig.js) ---
const MIC = `(function(act){var b=[...document.querySelectorAll("button,[role=button]")].find(function(n){if(!n.offsetParent||n.disabled)return false;return /^Turn (on|off) microphone/.test(n.getAttribute("aria-label")||"")&&n.getAttribute("data-is-muted")!==null;});if(!b)return "null";if(act==="click")b.click();return JSON.stringify({muted:b.getAttribute("data-is-muted")==="true"});})`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function setMic(pg, on) {
  for (let a = 0; a < 4; a++) {
    const st = JSON.parse((await pg.evalJs(`(${MIC})("read")`)) || 'null');
    if (!st) { await sleep(600); continue; }
    if (st.muted === !on) return true;
    await pg.evalJs(`(${MIC})("click")`);
    for (let w = 0; w < 10; w++) { await sleep(300); const n = JSON.parse((await pg.evalJs(`(${MIC})("read")`)) || 'null'); if (n && n.muted === !on) return true; }
  }
  return false;
}
async function setSpeak(pg, on) {
  await pg.evalJs(`window.__fakeMicSpeak&&window.__fakeMicSpeak(${on ? 'true' : 'false'})`);
  await setMic(pg, on);
}

const frac = (polls, f) => +(polls.length ? polls.filter(f).length / polls.length : 0).toFixed(2);
const has = (d, n) => (d.names || []).includes(n);

// Inject the DOM detector on every observer page so window.__meetDetect() names the
// currently-speaking tiles (same detector the fast browser-qa suite validates).
//
// CRITICAL (3-window headful rig): only ONE Chrome window can be OS-frontmost at a
// time, so the other two are OCCLUDED — and Chrome PAUSES CSS animations +
// requestAnimationFrame in occluded/hidden windows. The detector's speaking read is
// animation-based (indicatorSpeaking → getComputedStyle(bar).animationName /
// getAnimations()), so on the two backgrounded observer windows every equalizer reads
// as SILENT and the cross-observation matrix collapses to all-zeros (each observer only
// ever names "Someone", never a specific tile) — even though the speech + ring ARE live
// (the Swift AX reader, which is animation-independent, sees them fine). Force each
// observer page's visibilityState to `visible` over CDP so its animations keep running
// regardless of OS window focus. This is the QA-rig realization of the plan's mandate to
// "keep the Meet window visible during timed windows"; it changes NOTHING the detector
// itself does — only whether Chrome renders the animation the detector already reads.
async function keepPageVisible(pg) {
  if (!pg || typeof pg.cmd !== 'function') return;
  try {
    await pg.cmd('Emulation.setPageVisibilityState', { visibilityState: 'visible' });
  } catch (e) { /* older Chrome / method absent → best-effort */ }
}

async function injectDetector(pages) {
  const detector = fs.readFileSync(DETECTOR_PATH, 'utf8');
  for (const pg of pages) {
    await keepPageVisible(pg);
    await pg.evalJs(detector);
    await pg.evalJs('window.__ctx={vad:true,structOnly:false,holdMs:400};window.__meetHoldState={};');
  }
}

// ----------------------------------------------------------------------------
// runScriptedTurns — drives the sequence over already-joined seats.
//
//   seats: { host, guestA, guestB }         CDP page connections (guestB may be null in degraded 2-party)
//   names: { host, guestA, guestB }          display names to score against (guestB name unused if degraded)
//   opts:  { resultsPath, log, degraded }    degraded=true → 2-party (host + Alpha), verdict forced REVIEW
//
// Returns the results object (also written to resultsPath as JSON).
// ----------------------------------------------------------------------------
async function runScriptedTurns(seats, names, opts = {}) {
  const log = opts.log || console.log;
  const degraded = !!opts.degraded || !seats.guestB;
  const resultsPath = opts.resultsPath || path.join(__dirname, 'roster-rig-turns-results.json');
  const t0Wall = Date.now(); // session origin; swap tSpeakStart values are ms since epoch (absolute)

  // The set of observer pages + who each is (so we score each observer on the OTHERS).
  const observers = [
    { key: 'host', page: seats.host, name: names.host },
    { key: 'guestA', page: seats.guestA, name: names.guestA },
  ];
  if (!degraded) observers.push({ key: 'guestB', page: seats.guestB, name: names.guestB });
  const participants = observers.map((o) => ({ key: o.key, name: o.name }));

  await injectDetector(observers.map((o) => o.page));
  log('[turns] detector injected on ' + observers.map((o) => o.key).join(', '));
  for (const o of observers) {
    const ready = await o.page.evalJs('window.__fakeMicReady');
    log(`[turns] fake-mic ready ${o.key}: ${ready}`);
  }

  const det = async (page) => JSON.parse((await page.evalJs('JSON.stringify((window.__meetDetect&&window.__meetDetect())||{})')) || '{}');

  // Poll all observers for `ms`, then build the 3-way (or 2-way) cross-observation
  // matrix: matrix[observerKey][participantKey] = fraction of polls the observer
  // named that participant's tile. Self cells are recorded too (expected ~0) for
  // transparency, but the accuracy bars only consider observer≠participant cells.
  async function turn(label, ms) {
    const samples = Object.fromEntries(observers.map((o) => [o.key, []]));
    const tStart = Date.now();
    while (Date.now() - tStart < ms) {
      for (const o of observers) samples[o.key].push(await det(o.page));
      await sleep(300);
    }
    const matrix = {};
    for (const o of observers) {
      matrix[o.key] = {};
      for (const p of participants) matrix[o.key][p.key] = frac(samples[o.key], (d) => has(d, p.name));
    }
    const row = { turn: label, ms, matrix };
    log('  ' + JSON.stringify(row));
    return row;
  }

  // Speaker onset helper: silence everyone, then turn ON exactly `speakers` (keys).
  // Records a swap {from,to,tSpeakStart} for the single-speaker onsets so an external
  // edge-latency check can correlate detector meet_edge events. `prev` = previous
  // sole speaker key (or null); `to` = new sole speaker key (or null for overlap/silence).
  const swaps = [];
  async function speak(speakerKeys, { swapTo = undefined, swapFrom = undefined } = {}) {
    const set = new Set(speakerKeys);
    // Toggle each seat to its target state. Order: turn OFF first, then ON, so a
    // rapid swap doesn't briefly leave two speakers on (which would blur the ring move).
    for (const o of observers) if (!set.has(o.key)) await setSpeak(o.page, false);
    for (const o of observers) if (set.has(o.key)) await setSpeak(o.page, true);
    if (swapTo !== undefined) {
      swaps.push({ from: swapFrom === undefined ? null : swapFrom, to: swapTo, tSpeakStart: Date.now() });
    }
  }

  const rows = [];
  log('\n[turns] SCRIPTED SEQUENCE (3-way cross-observed)' + (degraded ? ' [DEGRADED 2-party]' : ''));

  // SILENCE (settle)
  await speak([]);
  await sleep(4000);
  rows.push(await turn('SILENCE', 3000));

  // HOST speaks 8s
  await speak(['host'], { swapTo: 'host', swapFrom: null });
  await sleep(2500); // let Meet's ring render before scoring
  rows.push(await turn('HOST', 8000));

  // ALPHA speaks 8s — ring appears (first non-self ring in a 3+ call)
  await speak(['guestA'], { swapTo: 'guestA', swapFrom: 'host' });
  await sleep(2500);
  rows.push(await turn('ALPHA', 8000));

  if (!degraded) {
    // BRAVO speaks 8s — ring MUST MOVE off Alpha onto Bravo
    await speak(['guestB'], { swapTo: 'guestB', swapFrom: 'guestA' });
    await sleep(2500);
    rows.push(await turn('BRAVO', 8000));

    // RAPID SWAP Alpha(2s)→Bravo(2s)→Alpha(2s)→Bravo(2s) — 4 fast ring moves.
    // Each onset records a swap; scored as one aggregate RAPID row (short windows).
    const rapidRows = [];
    const rapidSeq = [
      { key: 'guestA', from: 'guestB' },
      { key: 'guestB', from: 'guestA' },
      { key: 'guestA', from: 'guestB' },
      { key: 'guestB', from: 'guestA' },
    ];
    for (const step of rapidSeq) {
      await speak([step.key], { swapTo: step.key, swapFrom: step.from });
      rapidRows.push(await turn(`RAPID_${step.key}`, 2000));
    }
    rows.push({ turn: 'RAPID_SWAP', ms: 8000, matrix: null, steps: rapidRows });

    // OVERLAP Alpha+Bravo 8s — both should be seen by the others
    await speak(['guestA', 'guestB']);
    await sleep(2000);
    rows.push(await turn('OVERLAP', 8000));
  } else {
    // Degraded 2-party: overlap is host+Alpha so the OVERLAP accuracy bar still means something.
    await speak(['host', 'guestA']);
    await sleep(2000);
    rows.push(await turn('OVERLAP', 8000));
  }

  // SILENCE
  await speak([]);
  await sleep(4000);
  rows.push(await turn('SILENCE_END', 3000));

  const results = {
    startedWall: t0Wall,
    degraded,
    participants,
    swaps,
    rows,
    note: 'matrix[observer][participant] = fraction of polls the observer detector named that participant tile. '
      + 'Self cells (~0 by design) are recorded but excluded from accuracy bars. swaps[].tSpeakStart is wall-clock ms '
      + 'at each single-speaker onset — correlate detector meet_edge events against these for edge latency.',
  };
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  log(`\n[turns] wrote ${resultsPath} (${swaps.length} swaps, ${rows.length} turns)`);
  return results;
}

module.exports = { runScriptedTurns, setSpeak, setMic, injectDetector };
