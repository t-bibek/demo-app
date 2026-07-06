#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Shared-session LIVE QA runner for the ZOOM WEB (app.zoom.us / Chromium)
// event-driven speaker detector — the web half of the two-surface Zoom harness
// (native half: qa/zoom-live/run-zoom-live-qa.mjs; deterministic tier: the
// zoom-web fixture replay in SpeakerCoreSelfTest).
//
// TOPOLOGY (no signed-in Zoom web-host profile exists — verified gap):
//   • HOST natively (us.zoom.xos) via the proven ZoomDrive bootstrap / invite-
//     harvest / waiting-room-admit flow (qa/zoom-live/zoom-host-lib.mjs).
//   • "Web Observer" — a Chrome web participant that is the OBSERVED surface the
//     detector reads (the AXWebArea of app.zoom.us). View switching is driven on
//     THIS client (view is client-local).
//   • Guest Alpha / Guest Bravo — two more web guests for 3-party dynamics.
//   ALL web guests join with SPEECH-GAIN GATING (fake-mic-override __fakeMicSpeak):
//   mute state and speech content are INDEPENDENTLY controllable (the
//   discriminator between unmuted-silent and speaking). NEVER tone+mute-toggle.
//
//   Web-scenario assertions are SCOPED to web-sourced signals (zoom.web_active*
//   sources, zoomweb_edge NDJSON) so the co-present native-Zoom host surface
//   cannot contaminate the verdicts.
//
// Scenarios (each → one {scenario,verdict,ts,…detail} line, appended):
//   zoomweb-events-live  — every scripted speaker change produces a matching
//                          zoomweb_edge; a rapid ~2.7s swap block of 4 → >=3/4
//                          caught. Records raw per-swap dts AND measured active-
//                          class linger durations (the latency bar + halfLife get
//                          calibrated from these; Meet's 2500ms bar as precedent).
//   zoomweb-views-live   — detection correct in speaker view / gallery view /
//                          screen-share filmstrip, view switched on the OBSERVER.
//                          The share sub-block may degrade to REVIEW with evidence.
//   cpu-compare-live     — INTERLEAVED legacy/event A/B (4× ~22s, warmup dropped,
//                          pooled per-mode samples): the CPU ratio gates on the pooled
//                          MEAN (eventCpuMean <= 0.6× pollingCpuMean) — medians floor-
//                          saturate on the fast binary, so they are reported but not
//                          gated (idle-floor guard: both medians at the idle floor =>
//                          walkRatio alone gates). AND event full walks < 0.5× legacy
//                          (from zoomweb_walk_stats). REVIEW band = near-miss only. Raw
//                          samples always recorded. (Ported from Meet 2149a92.)
//   zoomweb-silence-live — an unmuted-but-SILENT guest for 60s → ZERO web speaker
//                          attribution (the falsification scenario).
//   zoomweb-legacy-silent— the default-flip probe: explicit legacy byte-silent +
//                          no-env runs event mode (default flipped 2026-07-05)
//
//   node qa/zoomweb-live/run-zoomweb-live-qa.mjs --all
//
// Env: ZOOM_MEETING_URL (skip harvest), ZOOMWEB_SKIP_GUESTS=1 (observer only),
//      ZOOMWEB_CAPTURE_FIXTURES=1 (AXSnapshot gallery/speaker/share into
//      macos/Fixtures/zoom-web/), ZOOM_EXPECT_SELF.
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import {
  PATHS, makeLog, drive, panelToggle, rosterCount, meetingWindowPresent,
  prebuild, preflightAxTrust, preflightSignedIn, bootstrapMeeting, harvestInvite,
  admitLoop, endMeeting, sleep, nowSec,
} from '../zoom-live/zoom-host-lib.mjs';
import {
  joinZoomWebGuest, setGuestSpeak, setGuestTone, setGuestMuted,
  setObserverView, startGuestShare,
} from './zoomweb-guest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const RESULTS_NDJSON = join(HERE, 'zoomweb-live-results.ndjson');
const EDGE_LOG = join(HERE, 'zoomweb-edges.ndjson');
const EVENTS_NDJSON = join(HERE, 'detector-events.ndjson');
const FIXTURES_DIR = join(REPO, 'macos', 'Fixtures', 'zoom-web');

// FRESH CDP ports — the native rig uses 9350 and the Meet rig 9224-9227, so we
// pick a distinct block (9360+) to avoid colliding with a leftover rig Chrome.
const OBSERVER_PORT = 9360;
const ALPHA_PORT = 9361;
const BRAVO_PORT = 9362;

const SCENARIOS = ['zoomweb-events-live', 'zoomweb-views-live', 'cpu-compare-live', 'zoomweb-silence-live', 'zoomweb-legacy-silent'];
const log = makeLog('zoomweb');

// --- Calibration constants (justified from LIVE-measured data recorded by this rig) --
// EDGE_MATCH_MS: a scripted speech onset must produce a matching zoomweb_edge within
// this. Physics (mirrors the Meet bar, docs §edge-latency): Zoom server VAD + web
// active-class render + Chromium AX serializer batch (~150ms) + the detector's
// bounded-read tick (<=500ms). The Zoom active class ALSO LINGERS on silence, so
// the true onset→edge latency is dominated by Zoom's own render, not the reader.
// 2500ms is the Meet-proven precedent that still hard-fails a reconcile-only
// regression (edges 4s+ late). This rig RECORDS the raw per-swap dts + measured
// linger so the fix agent can retighten with justification — do not weaken it
// without recording the distribution that justifies the new number.
const EDGE_MATCH_MS = 2500;
const RAPID_MIN_CAUGHT = 3;        // of 4 rapid ~2.7s swaps
const RAPID_STEP_MS = 2700;        // ~2.7s per rapid step (Zoom active-class linger swamps a shorter window)

// INTERLEAVED CPU A/B (methodology mirror of research/.../run-live-qa.mjs): short
// alternating legacy/event blocks so ambient CPU drift on a busy Mac hits both
// modes equally and cancels in the pooled per-mode statistics. Each block spawns a
// fresh detector; the first CPU_WARMUP_SAMPLES of every block are discarded, then
// per-mode samples are POOLED across all blocks. full_walks are summed per mode.
//
// MEAN-GATED CPU RATIO + IDLE-FLOOR GUARD (ported from research/.../run-live-qa.mjs
// @ 2149a92 — the Meet fix; the SAME defect lives here). The -O bounded-read binary
// is fast enough that >50% of the 2s ps samples land at the ~0.4% idle floor in BOTH
// modes, so the pooled MEDIANS saturate at the floor and the median ratio measures
// scheduler noise, not work — a deterministic false FAIL/PASS on identical code.
// Therefore:
//   * the CPU ratio gates on the pooled MEAN — floor-robust: above-floor work still
//     moves it when >50% of samples idle — while medians stay in the verdict JSON for
//     continuity with historical lines;
//   * when BOTH modes' medians sit within 2x the observed idle baseline (the minimum
//     kept sample across both modes — the process's measured do-nothing floor for THIS
//     run, derived from block data, not a hardcoded absolute; 2x = "indistinguishable
//     from idle" given ps's ~0.4% granularity at the floor), the CPU ratio is declared
//     LOW-SIGNAL (cpuSignal:'low') and walkRatio ALONE gates — full-walk counts are the
//     direct event-vs-legacy work metric and stay meaningful at any speed. The guard
//     only engages when that baseline is itself in the idle regime (IDLE_FLOOR_CAP_PCT):
//     a run whose MINIMUM sample is real work (e.g. a uniform 6%) has genuine CPU signal
//     even with median==min, and must still be mean-gated.
// Thresholds are UNCHANGED (0.6 CPU bar, 0.5 walk bar, 10% REVIEW band): this repairs
// the statistic, it does not move a bar.
// Sanity cap for the idle-floor guard: the guard may only engage when the observed
// baseline (min kept sample) is itself an IDLE-regime value. Do-nothing 2s ps windows
// measured 0.0-0.5% on the Meet control runs; 1.0% gives 2x headroom for machine
// variance while staying an order of magnitude below real work levels (6-33% observed).
// Without this cap a mode that is UNIFORMLY busy (median == min at, say, 6%) would
// wrongly zero out the CPU gate despite carrying real signal.
const CPU_BLOCKS = 4;
const CPU_BLOCK_S = 22;
const CPU_SAMPLE_MS = 2000;
const CPU_WARMUP_SAMPLES = 2;
const CPU_RATIO = 0.6;             // eventCpuMean <= 0.6 * pollingCpuMean
const WALK_RATIO = 0.5;            // event full_walks < 0.5 * legacy full_walks
const IDLE_FLOOR_CAP_PCT = 1.0;    // idle-floor guard engages only when baseline <= this
const REVIEW_BAND = 0.10;          // within 10% of a threshold => REVIEW (near-miss only)

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(3);
};
const mean = (xs) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null);

function record(scenario, verdict, detail) {
  appendFileSync(RESULTS_NDJSON, JSON.stringify({ scenario, verdict, ts: nowSec(), ...detail }) + '\n');
  log(`RESULT ${scenario}: ${verdict}`);
}

// ===================================================================== detector
// Streaming detector child. Parses `[event] {json}` product events AND the raw
// zoomweb_* NDJSON lines (which arrive on stdout, mirrored to MSD_EDGE_LOG for
// edges). `mode` null ⇒ NO MSD_MODE env (the legacy byte-silence probe).
function startDetector({ seconds, mode, edgeLog, tag }) {
  const env = { ...process.env, MSD_AUTOSTART: '1', MSD_RUN_SECONDS: String(seconds) };
  if (mode) env.MSD_MODE = mode;
  if (edgeLog) { env.MSD_EDGE_LOG = edgeLog; try { writeFileSync(edgeLog, ''); } catch (e) {} }
  const proc = spawn(PATHS.DETECTOR_BIN, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = [];   // product events (participant_joined / speech_on / meeting_initialized / …)
  const raw = [];      // instrumentation NDJSON (zoomweb_edge/_walk_stats/_observer/_selector_dump, zoom_edge, …)
  let out = '';
  let buf = '';
  // NOTE: the detector emits BOTH product events AND instrumentation lines on stdout
  // with the SAME `[event] {json}` prefix (record() injects `type`). We split them by
  // TYPE, not by prefix: an instrumentation type (…_edge/…_walk_stats/…_observer/…
  // _selector_dump, or a bare `kind` edge) goes to `raw`; everything else to `events`.
  const isInstrumentation = (o) => /(_edge|_walk_stats|_observer|_selector_dump|_menu_probe)$/.test(o.type || '')
    || o.kind === 'active-moved' || o.kind === 'talking-changed';
  const onData = (d) => {
    const s = d.toString(); out += s; buf += s;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ln = buf.slice(0, i); buf = buf.slice(i + 1);
      const j = ln.indexOf('{');
      if (j < 0) continue;
      let o; try { o = JSON.parse(ln.slice(j)); } catch (e) { continue; }
      if (!o || typeof o !== 'object' || !o.type) continue;
      if (isInstrumentation(o)) raw.push(o);
      else events.push(o);
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const done = new Promise((res) => {
    const hardKill = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, (seconds + 30) * 1000);
    proc.on('exit', (code) => { clearTimeout(hardKill); res(code); });
  });
  return { proc, events, raw, done, getOut: () => out, kill: () => { try { proc.kill('SIGKILL'); } catch (e) {} } };
}

const isZoom = (e) => typeof e.meeting_id === 'string' && e.meeting_id.startsWith('zoom::');
// A web-sourced speaker attribution (scoped so the co-present native surface can't leak).
const isWebSpeech = (e) => isZoom(e) && e.type === 'speech_on' && /zoom\.web_active/.test(e.source || '');

async function waitEvent(det, pred, timeoutMs, label) {
  const t0 = Date.now();
  let seen = 0;
  while (Date.now() - t0 < timeoutMs) {
    if (det.proc && det.proc.exitCode != null) { log(`detector exited early (${det.proc.exitCode}) while waiting: ${label}`); return null; }
    for (; seen < det.events.length; seen++) if (pred(det.events[seen])) return det.events[seen];
    await sleep(400);
  }
  log(`waitEvent timeout: ${label}`);
  return null;
}

// --- CPU-sampled detector run (for the interleaved A/B). Samples ps %cpu on the
// detector PID; parses the LAST zoomweb_walk_stats line for full_walks. ----------
async function runDetectorCpu({ mode, seconds }) {
  const env = { ...process.env, MSD_AUTOSTART: '1', MSD_MODE: mode, MSD_RUN_SECONDS: String(seconds) };
  const proc = spawn(PATHS.DETECTOR_BIN, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });
  const cpuSamples = [];
  let sampling = true;
  const sampler = (async () => {
    await sleep(3000); // settle before the first sample (startup/activate transient)
    while (sampling && proc.exitCode == null) {
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
  let walkStats = null;
  for (const ln of out.split('\n')) {
    const i = ln.indexOf('{'); if (i < 0) continue;
    try { const o = JSON.parse(ln.slice(i)); if (o && o.type === 'zoomweb_walk_stats') walkStats = o; } catch (e) {}
  }
  return { cpuSamples, walkStats, stdout: out, exitCode };
}

// Read all zoomweb_edge lines from the fixed edge log (active-moved edges).
function readEdges(path) {
  const edges = [];
  if (!existsSync(path)) return edges;
  for (const ln of readFileSync(path, 'utf8').split('\n')) {
    const i = ln.indexOf('{'); if (i < 0) continue;
    try { const o = JSON.parse(ln.slice(i)); if (o && (o.type === 'zoomweb_edge' || o.kind === 'active-moved')) edges.push(o); } catch (e) {}
  }
  return edges;
}

// ===================================================================== rig state
// The rig object threaded through scenarios. `guests` maps seat→{page,name}; a
// missing seat degrades the dependent scenarios to REVIEW, never a false FAIL.
const rig = {
  observer: null, alpha: null, bravo: null,
  swaps: [],           // {from, to, name, tSpeakStart} recorded on each single-speaker onset
  chromes: [],         // for teardown
};

// Silence everyone, then turn ON exactly `speakerSeats`. Records a swap on a
// single-speaker onset so the events scenario can correlate zoomweb_edge lines.
async function speak(speakerSeats, { swapTo, swapFrom } = {}) {
  const want = new Set(speakerSeats);
  const all = ['observer', 'alpha', 'bravo'];
  for (const seat of all) { const g = rig[seat]; if (g && !want.has(seat)) await setGuestSpeak(g.page, false); }
  for (const seat of all) { const g = rig[seat]; if (g && want.has(seat)) await setGuestSpeak(g.page, true); }
  if (swapTo !== undefined) {
    const g = rig[swapTo];
    rig.swaps.push({ from: swapFrom ?? null, to: swapTo, name: g ? g.name : null, tSpeakStart: Date.now() });
  }
}

// ===================================================================== scenario 1
// zoomweb-events-live: scripted turns + a rapid swap block; correlate zoomweb_edge
// lines against the recorded onsets. Also measures the active-class LINGER (how
// long after an onset a NEW onset's edge stops being confused with the prior
// holder) — recorded raw so the halfLife + latency bar are calibrated from data.
async function scenarioEvents() {
  log('=== zoomweb-events-live ===');
  const observed = rig.observer && rig.alpha; // need the observer to read + >=1 remote to speak
  if (!observed) { record('zoomweb-events-live', 'REVIEW', { reason: 'observer or a remote guest never joined (rig no-show)' }); return; }

  // Run a dedicated event-mode detector across the scripted turn window, edges → EDGE_LOG.
  const det = startDetector({ seconds: 130, mode: 'event', edgeLog: EDGE_LOG, tag: 'events' });
  await sleep(4000);
  rig.swaps.length = 0;

  // SILENCE settle
  await speak([]); await sleep(4000);
  // ALPHA speaks (first non-self active-class on a remote tile)
  await speak(['alpha'], { swapTo: 'alpha', swapFrom: null }); await sleep(8000);
  // BRAVO speaks — active class MUST MOVE off Alpha (3-party only)
  if (rig.bravo) { await speak(['bravo'], { swapTo: 'bravo', swapFrom: 'alpha' }); await sleep(8000); }
  // RAPID SWAP: 4 onsets at ~2.7s each between Alpha/Bravo (or Alpha/observer if no Bravo)
  const other = rig.bravo ? 'bravo' : 'observer';
  const rapidSeq = [
    { to: 'alpha', from: other }, { to: other, from: 'alpha' },
    { to: 'alpha', from: other }, { to: other, from: 'alpha' },
  ];
  for (const step of rapidSeq) { await speak([step.to], { swapTo: step.to, swapFrom: step.from }); await sleep(RAPID_STEP_MS); }
  await speak([]); await sleep(4000);

  // Let the detector finish + flush its edge log.
  await det.done;
  const edges = readEdges(EDGE_LOG);

  // Correlate each recorded onset to the nearest edge naming its target within EDGE_MATCH_MS.
  const perSwap = rig.swaps.filter((s) => s.name).map((s) => {
    const near = edges.filter((e) => e.to === s.name && Math.abs((e.wall_ts || e.ts || 0) - s.tSpeakStart) <= EDGE_MATCH_MS);
    const dt = near.length ? Math.min(...near.map((e) => Math.abs((e.wall_ts || e.ts || 0) - s.tSpeakStart))) : null;
    return { from: s.from, to: s.to, name: s.name, matched: near.length > 0, dtMs: dt };
  });
  // Measured active-class linger proxy: consecutive same-target edges' inter-arrival
  // times (how long a holder's active class kept re-emitting) — recorded for halfLife
  // calibration. Also the min inter-onset dt in the rapid block bounds the linger.
  const lingerSamples = [];
  const byTo = {};
  for (const e of edges) { const t = e.wall_ts || e.ts || 0; (byTo[e.to] = byTo[e.to] || []).push(t); }
  for (const arr of Object.values(byTo)) { arr.sort((a, b) => a - b); for (let i = 1; i < arr.length; i++) lingerSamples.push(arr[i] - arr[i - 1]); }

  const allMatched = perSwap.length > 0 && perSwap.every((p) => p.matched);
  const rapid = perSwap.slice(-4); // the rapid block is the last 4 onsets
  const rapidCaught = rapid.filter((p) => p.matched).length;
  const rapidOk = rapid.length >= 4 ? rapidCaught >= RAPID_MIN_CAUGHT : false;
  const verdict = (edges.length && allMatched && rapidOk) ? 'PASS' : 'FAIL';
  record('zoomweb-events-live', verdict, {
    edgesCaptured: edges.length, swapsTotal: perSwap.length, allMatched,
    rapidCaught, rapidTotal: rapid.length, rapidStepMs: RAPID_STEP_MS, edgeMatchMs: EDGE_MATCH_MS,
    rawSwapDts: perSwap.map((p) => p.dtMs), measuredLingerSamples: lingerSamples,
    lingerMedianMs: median(lingerSamples), perSwap, edgeLog: EDGE_LOG,
  });
}

// ===================================================================== scenario 2
// zoomweb-views-live: drive speaker view, gallery view, and (best-effort) a
// screen-share filmstrip on the OBSERVER client; assert a web-sourced attribution
// names the speaker in each. The share sub-block degrades to REVIEW with evidence.
async function scenarioViews() {
  log('=== zoomweb-views-live ===');
  if (!rig.observer || !rig.alpha) { record('zoomweb-views-live', 'REVIEW', { reason: 'observer or remote guest never joined' }); return; }
  const det = startDetector({ seconds: 120, mode: 'event', edgeLog: null, tag: 'views' });
  await sleep(4000);

  const blocks = {};
  const runBlock = async (view) => {
    const applied = await setObserverView(rig.observer.page, view);
    await sleep(3000);
    await speak(['alpha'], { swapTo: 'alpha', swapFrom: null });
    const idx = det.events.length;
    const named = await waitEvent(det, (e) => isWebSpeech(e) && e.name === rig.alpha.name, 20_000, `${view}-alpha-named`);
    await speak([]);
    blocks[view] = { viewApplied: applied, alphaNamed: !!named, source: named?.source || null, sinceIdx: idx };
    return !!named;
  };

  const speakerOk = await runBlock('speaker');
  const galleryOk = await runBlock('gallery');

  // GALLERY sub-verdict — UNVERIFIED-REMOVED (W3). The shipped gallery selector
  // (`gallery-video-container__video-frame`) is documented UNVERIFIED-REMOVED in
  // bubbles-dev zoom/ZoomWebEdgeEvents.swift:33 + ZoomWebActive.swift:10 (the W3 fresh
  // capture was BLOCKED — a free/basic account renders NO real web gallery tree, only a
  // shell), so it MUST NOT gate a PASS/FAIL: a free-tier account cannot render web
  // gallery, so `galleryOk` is expected FALSE for a licensed-account reason, not a
  // detection bug. Record the sub-verdict LOUDLY (never silent-pass, never a false
  // product FAIL): PASS only if a licensed account genuinely rendered gallery tiles AND
  // the speaker was named there; otherwise REVIEW with the W3 caveat. The scenario
  // itself gates on SPEAKER VIEW (the verified prefix) only.
  const galleryViewApplied = !!(blocks.gallery && blocks.gallery.viewApplied);
  const galleryVerdict = (galleryViewApplied && galleryOk) ? 'PASS' : 'REVIEW';
  const galleryNote = galleryOk
    ? 'gallery named the speaker (licensed account rendered a real gallery tree — verifies W3)'
    : 'gallery UNVERIFIED-REMOVED (W3): free/basic account renders no real web gallery tree; the selector is documented untrusted in bubbles-dev ZoomWebEdgeEvents.swift:33 — REVIEW, not FAIL (licensed-account dependency), and NOT silent-passed';

  // Screen-share filmstrip: a guest shares; the observer reads the small filmstrip
  // tiles. Best-effort — if the share never starts, this sub-block is REVIEW.
  let shareStarted = false, shareNamed = false, shareVerdict = 'REVIEW';
  try {
    const sharer = rig.bravo || rig.alpha;
    shareStarted = await startGuestShare(sharer.page);
    if (shareStarted) {
      await sleep(4000);
      await speak(['alpha'], { swapTo: 'alpha', swapFrom: null });
      const named = await waitEvent(det, (e) => isWebSpeech(e) && e.name === rig.alpha.name, 20_000, 'share-alpha-named');
      shareNamed = !!named;
      shareVerdict = named ? 'PASS' : 'REVIEW';
      await speak([]);
      try { await sharer.page.evalJs(`(()=>{const b=[...document.querySelectorAll('button,[role=button]')].find(e=>/stop share/i.test((e.getAttribute('aria-label')||e.innerText||'').trim()));if(b)b.click();})()`); } catch (e) {}
    }
  } catch (e) { blocks.shareError = e.message; }
  blocks.share = { started: shareStarted, alphaNamed: shareNamed, verdict: shareVerdict };

  det.kill(); await det.done.catch(() => {});

  // SPEAKER VIEW is the hard gate (the verified prefix). Gallery is UNVERIFIED-REMOVED
  // (W3) and filmstrip/share is advisory — both recorded as loud sub-verdicts, never
  // dragging the scenario to a false FAIL on a free-tier-unrenderable surface.
  const verdict = speakerOk ? 'PASS' : 'FAIL';
  record('zoomweb-views-live', verdict, {
    speakerOk, galleryOk, galleryVerdict, galleryViewApplied, galleryNote,
    shareVerdict, blocks,
    note: 'gate = SPEAKER VIEW only (verified prefix). gallery = W3 UNVERIFIED-REMOVED loud REVIEW (licensed-account dependency); share = advisory REVIEW.',
  });
}

// ===================================================================== scenario 3
// cpu-compare-live: interleaved legacy/event A/B, pooled medians. Keep Alpha
// speaking so the detector has real work in every block.
async function scenarioCpuCompare() {
  log('=== cpu-compare-live ===');
  if (rig.alpha) await speak(['alpha']); // steady work
  const pollingSamples = [], eventSamples = [], blocks = [];
  let pollWalks = 0, eventWalks = 0, pollWalksSeen = false, eventWalksSeen = false;
  let lastPollWalk = null, lastEventWalk = null;

  for (let b = 0; b < CPU_BLOCKS; b++) {
    for (const mode of ['legacy', 'event']) {
      const run = await runDetectorCpu({ mode, seconds: CPU_BLOCK_S });
      const kept = run.cpuSamples.slice(CPU_WARMUP_SAMPLES);
      const fw = run.walkStats ? run.walkStats.full_walks : null;
      if (mode === 'legacy') { pollingSamples.push(...kept); if (fw != null) { pollWalks += fw; pollWalksSeen = true; lastPollWalk = run.walkStats; } }
      else { eventSamples.push(...kept); if (fw != null) { eventWalks += fw; eventWalksSeen = true; lastEventWalk = run.walkStats; } }
      blocks.push({ block: b, mode, samples: run.cpuSamples, kept, blockMedian: median(kept), fullWalks: fw });
    }
  }
  if (rig.alpha) await speak([]);

  // Adjudicate with the PURE mean-gated + idle-floor gate (ported from Meet 2149a92,
  // offline-tested in cpu-compare.test.mjs). All the sampling/spawning above is live-
  // only; the verdict math is factored out so it can be exercised with synthetic arrays.
  const { verdict, detail } = adjudicateCpuCompare({
    pollingSamples, eventSamples,
    pollWalks, eventWalks, pollWalksSeen, eventWalksSeen,
    lastPollWalk, lastEventWalk, blocks,
  });
  record('cpu-compare-live', verdict, detail);
}

// ===================================================================== pure gate
// adjudicateCpuCompare — the PURE cpu-compare verdict math, ported from the Meet
// fix (research/meet-dom-detector/live/run-live-qa.mjs @ 2149a92). No I/O, no spawn:
// takes the pooled per-mode ps %cpu sample arrays + summed full_walks and returns
// { verdict, detail }. Factored out of scenarioCpuCompare so the offline test can
// exercise every branch with synthetic sample arrays (see cpu-compare.test.mjs).
//
// Gate (methodology identical to Meet 2149a92):
//   - MEDIANS are reported (continuity with historical verdict lines);
//   - the CPU ratio GATES on the pooled MEAN (floor-robust);
//   - idle-floor guard: when BOTH modes' medians sit within 2x the observed idle
//     baseline (min kept sample across both modes) AND that baseline is itself
//     idle-regime (<= IDLE_FLOOR_CAP_PCT), the CPU ratio is LOW-SIGNAL (cpuSignal:'low')
//     and walkRatio ALONE gates.
function adjudicateCpuCompare({
  pollingSamples, eventSamples,
  pollWalks, eventWalks, pollWalksSeen, eventWalksSeen,
  lastPollWalk = null, lastEventWalk = null, blocks = [],
}) {
  // Medians are REPORTED (continuity with historical verdict lines); the CPU gate
  // itself runs on the pooled MEAN — see the calibration note at CPU_RATIO.
  const pollingCpu = median(pollingSamples);
  const eventCpu = median(eventSamples);
  const pollingCpuMean = mean(pollingSamples);
  const eventCpuMean = mean(eventSamples);
  // Idle-floor guard input: the smallest kept sample across BOTH modes is this run's
  // observed do-nothing floor (derived from the block data, not a magic constant).
  const allKept = pollingSamples.concat(eventSamples);
  const idleBaseline = allKept.length ? Math.min(...allKept) : null;
  const idleFloorThresh = idleBaseline == null ? null : +(2 * idleBaseline).toFixed(3);

  const raw = {
    pollingCpu, eventCpu, pollingCpuMean, eventCpuMean,
    idleBaseline, idleFloorThresh, idleFloorCapPct: IDLE_FLOOR_CAP_PCT,
    pollingCpuSamples: pollingSamples, eventCpuSamples: eventSamples,
    pollingFullWalks: pollWalksSeen ? pollWalks : null, eventFullWalks: eventWalksSeen ? eventWalks : null,
    pollingWalkStats: lastPollWalk, eventWalkStats: lastEventWalk,
    blocks, cpuBlocks: CPU_BLOCKS, cpuBlockSeconds: CPU_BLOCK_S, cpuWarmupSamplesDropped: CPU_WARMUP_SAMPLES,
    method: 'interleaved-ab-mean-gated',
  };

  if (pollingCpu == null || eventCpu == null) {
    return { verdict: 'FAIL', detail: { reason: 'no CPU samples for one/both modes', ...raw } };
  }
  if (!pollWalksSeen || !eventWalksSeen) {
    return { verdict: 'FAIL', detail: { reason: 'zoomweb_walk_stats missing for one/both modes (instrumentation not emitted?)', ...raw } };
  }

  // LOW-SIGNAL detection: both modes' medians at/near the idle floor => the CPU ratio
  // (median OR mean) is dominated by the floor; walkRatio alone gates the scenario.
  // The baseline must itself be idle-regime (IDLE_FLOOR_CAP_PCT) for the guard to engage.
  const cpuSignal = (idleFloorThresh != null && idleBaseline <= IDLE_FLOOR_CAP_PCT
    && pollingCpu <= idleFloorThresh && eventCpu <= idleFloorThresh) ? 'low' : 'ok';
  const cpuThresh = CPU_RATIO * pollingCpuMean;
  const walkThresh = WALK_RATIO * pollWalks;
  // cpuPass is null (not adjudicated) when the CPU signal is low.
  const cpuPass = cpuSignal === 'ok' ? eventCpuMean <= cpuThresh : null;
  const walkPass = eventWalks < walkThresh;
  const cpuNearMiss = cpuPass === false && eventCpuMean <= (1 + REVIEW_BAND) * cpuThresh;
  const walkNearMiss = !walkPass && walkThresh > 0 && eventWalks <= (1 + REVIEW_BAND) * walkThresh;

  let verdict;
  if (cpuSignal === 'low') verdict = walkPass ? 'PASS' : walkNearMiss ? 'REVIEW' : 'FAIL';
  else if (cpuPass && walkPass) verdict = 'PASS';
  else verdict = (cpuNearMiss || walkNearMiss) && (cpuPass || cpuNearMiss) && (walkPass || walkNearMiss) ? 'REVIEW' : 'FAIL';

  return {
    verdict,
    detail: {
      cpuRatio: pollingCpu ? +(eventCpu / pollingCpu).toFixed(3) : null,              // median ratio (reported for continuity)
      meanRatio: pollingCpuMean ? +(eventCpuMean / pollingCpuMean).toFixed(3) : null, // the gated statistic
      cpuSignal, cpuThreshold: +cpuThresh.toFixed(3),
      walkRatio: pollWalks ? +(eventWalks / pollWalks).toFixed(3) : null, walkThreshold: walkThresh,
      cpuPass, walkPass, ...raw,
    },
  };
}

// ===================================================================== scenario 4
// zoomweb-silence-live: an unmuted-but-SILENT guest for 60s → ZERO web speaker
// attribution. This is the falsification scenario: the active class must not light
// (and thus no edge/name) for an open mic that isn't speaking.
async function scenarioSilence() {
  log('=== zoomweb-silence-live ===');
  const g = rig.alpha || rig.observer;
  if (!g) { record('zoomweb-silence-live', 'REVIEW', { reason: 'no guest to hold unmuted-silent' }); return; }
  // Unmute the guest but keep SPEECH OFF (the discriminator). Speech gain is the
  // independent axis from mute, so unmuted+silent is a real state here.
  await setGuestSpeak(g.page, false);
  const unmuted = await setGuestMuted(g.page, false);
  const det = startDetector({ seconds: 75, mode: 'event', edgeLog: null, tag: 'silence' });
  await sleep(4000);
  const idx = det.events.length;
  await sleep(60_000); // 60s of unmuted silence
  if (det.proc.exitCode != null && det.proc.exitCode !== 0) { /* fast-fail handled below */ }
  const webSpeech = det.events.slice(idx).filter((e) => isWebSpeech(e) && e.name === g.name);
  const edges = det.raw.filter((r) => (r.type === 'zoomweb_edge' || r.kind === 'active-moved') && r.to === g.name);
  det.kill(); await det.done.catch(() => {});
  // ZERO web attribution naming the silent guest. If audio never reached the tap the
  // scenario would pass vacuously, so we ALSO record whether the guest ever emitted
  // in other scenarios (the reviewer cross-checks) — here we only require silence.
  const verdict = (webSpeech.length === 0 && edges.length === 0) ? 'PASS' : 'FAIL';
  record('zoomweb-silence-live', verdict, {
    guest: g.name, unmuted, webSpeechCount: webSpeech.length, edgeCount: edges.length,
    webSpeechNames: [...new Set(webSpeech.map((e) => e.name))],
  });
}

// ===================================================================== scenario 5
// zoomweb-legacy-silent: the DEFAULT-FLIP probe (2026-07-05: event-driven is the
// default on every platform; MSD_MODE=legacy is the explicit opt-out). Two parts:
//   A) explicit MSD_MODE=legacy → byte-silent observer (zero edge/observer/selector
//      lines; only the single closing all-zero walk_stats baseline line allowed)
//   B) NO env at all → the observer MUST run (default = event): observer/edge or
//      event_mode:true walk-stats lines present while the meeting is detected.
async function scenarioLegacySilent() {
  log('=== zoomweb-legacy-silent (default-flip probe) ===');
  if (!rig.observer) { record('zoomweb-legacy-silent', 'REVIEW', { reason: 'observer never joined — no web surface to probe' }); return; }
  // Have Alpha speak so the meeting is genuinely active during both probes.
  if (rig.alpha) await speak(['alpha']);

  // Part A — explicit legacy opt-out must be byte-silent.
  const legacy = startDetector({ seconds: 22, mode: 'legacy', edgeLog: null, tag: 'legacy-optout' });
  await sleep(24_000);
  const legacyMeetingSeen = legacy.events.some((e) => isZoom(e) && (e.type === 'meeting_initialized' || e.type === 'participant_joined'));
  legacy.kill(); await legacy.done.catch(() => {});
  const legacyObserverLines = legacy.raw.filter((r) => /^zoomweb_(edge|observer|selector_dump)$/.test(r.type || '') || r.kind === 'active-moved');
  const legacyWalkLines = legacy.raw.filter((r) => r.type === 'zoomweb_walk_stats');
  const walkSilent = legacyWalkLines.every((w) => w.event_mode === false && !w.full_walks_event && !w.subtree_reads && !w.edges);
  const walkCountOk = legacyWalkLines.length <= 1;

  // Part B — no env: default must be EVENT (observer runs).
  const dflt = startDetector({ seconds: 22, mode: null, edgeLog: null, tag: 'default-event' }); // NO MSD_MODE
  await sleep(24_000);
  const defaultMeetingSeen = dflt.events.some((e) => isZoom(e) && (e.type === 'meeting_initialized' || e.type === 'participant_joined'));
  dflt.kill(); await dflt.done.catch(() => {});
  if (rig.alpha) await speak([]);
  const defaultEventLines = dflt.raw.filter((r) =>
    /^zoomweb_(edge|observer)$/.test(r.type || '') || r.kind === 'active-moved' ||
    (r.type === 'zoomweb_walk_stats' && r.event_mode === true));
  const defaultIsEvent = defaultEventLines.length > 0;

  const verdict = (legacyMeetingSeen && legacyObserverLines.length === 0 && walkSilent && walkCountOk
    && defaultMeetingSeen && defaultIsEvent) ? 'PASS' : 'FAIL';
  record('zoomweb-legacy-silent', verdict, {
    legacyMeetingSeen, legacyObserverLineCount: legacyObserverLines.length,
    legacyWalkStatsLineCount: legacyWalkLines.length, walkSilent,
    defaultMeetingSeen, defaultIsEvent, defaultEventLineCount: defaultEventLines.length,
    note: 'default-flip probe: MSD_MODE=legacy byte-silent; NO env => event mode active (observer/edge or event_mode:true walk-stats present).',
  });
}

// ===================================================================== fixtures
// ZOOMWEB_CAPTURE_FIXTURES=1: AXSnapshot the OBSERVER Chrome in each view + a share
// into macos/Fixtures/zoom-web/ (the Swift self-tests replay these). Targets the
// observer's app.zoom.us web area by --url so the co-present native Zoom + other
// guest Chromes aren't captured.
async function captureFixtures() {
  if (process.env.ZOOMWEB_CAPTURE_FIXTURES !== '1') return;
  if (!rig.observer) { log('fixture capture skipped — no observer'); return; }
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const snap = (label, viewSetup) => new Promise(async (res) => {
    try { await viewSetup(); } catch (e) {}
    await sleep(2500);
    const outDir = join(HERE, 'ax-dumps', `${label}-${Date.now()}`);
    // AXSnapshot writes to ./ax-dumps/<ts>/ relative to CWD; run in a scratch cwd.
    const r = spawnSync(PATHS.AXSNAPSHOT_BIN, ['chrome', '--url', 'app.zoom.us'], { cwd: join(HERE, 'ax-dumps-cwd'), encoding: 'utf8', timeout: 60_000 });
    log(`AXSnapshot ${label}: ${(r.stdout || '').split('\n').slice(-2).join(' ')}`);
    // Find the produced chrome-zoom-web.json under ax-dumps-cwd/ax-dumps/*/ and copy it.
    try {
      const base = join(HERE, 'ax-dumps-cwd', 'ax-dumps');
      if (existsSync(base)) {
        const dirs = readdirSync(base).map((d) => join(base, d)).sort();
        const latest = dirs[dirs.length - 1];
        if (latest) {
          for (const f of readdirSync(latest)) {
            if (f === 'chrome-zoom-web.json' || (f.startsWith('chrome-zoom-web') && f.endsWith('.json'))) {
              copyFileSync(join(latest, f), join(FIXTURES_DIR, `zoom-web-${label}.json`));
              log(`fixture captured: zoom-web-${label}.json`);
            }
          }
        }
      }
    } catch (e) { log(`fixture copy ${label} failed: ${e.message}`); }
    res();
  });
  try { mkdirSync(join(HERE, 'ax-dumps-cwd'), { recursive: true }); } catch (e) {}
  if (rig.alpha) await speak(['alpha']);
  await snap('gallery', () => setObserverView(rig.observer.page, 'gallery'));
  await snap('speaker', () => setObserverView(rig.observer.page, 'speaker'));
  await snap('share', async () => { const s = rig.bravo || rig.alpha; await startGuestShare(s.page); });
  if (rig.alpha) await speak([]);
}

// ===================================================================== main
function failAll(reason) {
  for (const s of SCENARIOS) record(s, 'FAIL', { reason });
  console.log('ZOOMWEB LIVE SESSION COMPLETE');
  process.exit(1);
}

// Kill any leftover rig Chrome by remote-debugging-port pattern BEFORE starting, so
// a crashed previous run's Chrome can't steal our fresh ports.
function killLeftoverChromes() {
  for (const port of [OBSERVER_PORT, ALPHA_PORT, BRAVO_PORT]) {
    spawnSync('bash', ['-lc', `pkill -f 'remote-debugging-port=${port}' || true`]);
  }
}

async function main() {
  if (!process.argv.includes('--all')) { console.error('usage: run-zoomweb-live-qa.mjs --all'); process.exit(2); }
  writeFileSync(RESULTS_NDJSON, '');
  killLeftoverChromes();

  // caffeinate for the whole session so the display/system doesn't sleep mid-run.
  const caffeinate = spawn('caffeinate', ['-d', '-u'], { stdio: 'ignore' });

  if (!prebuild(log)) return failAll('swift build failed');
  if (!preflightAxTrust()) return failAll('Accessibility not granted to this process');
  preflightSignedIn();

  const skipGuests = process.env.ZOOMWEB_SKIP_GUESTS === '1';
  try {
    if (!await bootstrapMeeting(log)) return failAll('could not start a native Zoom host meeting (signed in?)');
    const invite = process.env.ZOOM_MEETING_URL || await harvestInvite(log);
    if (!invite) return failAll('no invite URL harvested — cannot join web observer/guests');

    // Join the OBSERVER first (the observed surface), then Alpha + Bravo.
    try {
      rig.observer = await joinZoomWebGuest({ port: OBSERVER_PORT, name: 'Web Observer', seat: 'observer', inviteUrl: invite });
      rig.chromes.push(rig.observer.chrome);
      log(`observer joined (overrideReady=${rig.observer.overrideReady})`);
    } catch (e) { log('observer join failed: ' + e.message); }

    if (!skipGuests && rig.observer) {
      try { rig.alpha = await joinZoomWebGuest({ port: ALPHA_PORT, name: 'Guest Alpha', seat: 'alpha', inviteUrl: invite }); rig.chromes.push(rig.alpha.chrome); }
      catch (e) { log('alpha join failed: ' + e.message); }
      try { rig.bravo = await joinZoomWebGuest({ port: BRAVO_PORT, name: 'Guest Bravo', seat: 'bravo', inviteUrl: invite }); rig.chromes.push(rig.bravo.chrome); }
      catch (e) { log('bravo join failed: ' + e.message); }
    }

    if (!rig.observer) return failAll('web observer never joined — no observed surface (host-only run)');

    // Admit everyone from the waiting room. Target = host + however many web clients joined.
    const joinedWeb = [rig.observer, rig.alpha, rig.bravo].filter(Boolean).length;
    const admitted = await admitLoop({ targetCount: 1 + joinedWeb, waitMs: 120_000 }, log);
    log(`admit: roster=${rosterCount()} (wanted ${1 + joinedWeb}) admitted=${admitted}`);
    await sleep(5000);

    // Scenarios back-to-back in the ONE live session.
    await scenarioEvents();
    await scenarioViews();
    await scenarioCpuCompare();
    await scenarioSilence();
    await scenarioLegacySilent();
    await captureFixtures();
  } catch (e) {
    log('FATAL ' + (e && e.stack ? e.stack : e));
    for (const s of SCENARIOS) record(s, 'FAIL', { reason: 'runner exception: ' + (e && e.message) });
  } finally {
    try { await endMeeting(log); } catch (e) {}
    for (const c of rig.chromes) { try { c.kill(); } catch (e) {} }
    try { caffeinate.kill(); } catch (e) {}
    killLeftoverChromes();
  }
  console.log('ZOOMWEB LIVE SESSION COMPLETE');
  process.exit(0);
}

// Pure adjudicator exported for the offline unit test (cpu-compare.test.mjs).
export { adjudicateCpuCompare };

// Only drive a live session when RUN directly (so the test can import the pure gate
// above without spawning Chrome / the detector / a native Zoom host).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
