'use strict';
// LOOPING live QA of STRUCTURE-ONLY speaking detection on a real 3-person Meet
// (host :9222 muted + two BlackHole guests with independent mute control).
// Per round:  A speaks (~7s)  |gap|  B speaks  |gap|  A+B OVERLAP  |gap|
// The injected detector runs with { structOnly:true, holdMs } — the jsname
// anchor is disabled, so ONLY the token-free structural signature is tested.
// Loops until PASS_STREAK consecutive clean rounds (or MAX_ROUNDS), printing a
// JSON verdict per round and a final summary.
//   node struct-live-loop.js [rounds] [holdMs]
const fs = require('fs'); const path = require('path');
const { execSync, spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');

const HOST_PORT = 9222;
const GUESTS = [
  { name: 'BH Speaker', port: 9318, clip: 'Alice.wav' },
  { name: 'BH Two', port: 9320, clip: 'Bob.wav' },
];
const OVERLAP_CLIP = 'Carol.wav';
const MAX_ROUNDS = +(process.argv[2] || 8);
const HOLD_MS = +(process.argv[3] || 600);
const PASS_STREAK = 2;
const HOST_NAME = 'Bibek Thapa';
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

// The guest page has SEVERAL /microphone/-labeled buttons: the real toggle
// ("Turn on/off microphone", data-is-muted) plus an invisible, disabled
// "You can't remotely mute <other guest>'s microphone" per remote participant.
// A first-match read hits the WRONG one — target ONLY the real toggle and
// verify via the semantic data-is-muted attribute.
// NOTE: coordinate CDP clicks do NOT land on these guest windows (scaling?);
// el.click() DOES toggle the real mic button (verified live 2026-07-03). Always
// verify via the semantic data-is-muted attribute and never re-click before
// polling for the flip (re-click = toggle thrash).
const MIC_ACT = `(function(act){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){
  if(!n.offsetParent||n.disabled)return false;
  return /^Turn (on|off) microphone/.test(n.getAttribute('aria-label')||'') && n.getAttribute('data-is-muted')!==null;});
  if(!b)return 'null';
  if(act==='click')b.click();
  return JSON.stringify({muted:b.getAttribute('data-is-muted')==='true'});})`;
async function setMic(page, on) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const st = JSON.parse(await page.evalJs(`(${MIC_ACT})('read')`));
    if (!st) { await sleep(800); continue; }
    if (st.muted === !on) return true;                    // already in the wanted state
    await page.evalJs(`(${MIC_ACT})('click')`);
    for (let w = 0; w < 10; w++) {
      await sleep(300);
      const now = JSON.parse(await page.evalJs(`(${MIC_ACT})('read')`));
      if (now && now.muted === !on) return true;
    }
  }
  const fin = JSON.parse(await page.evalJs(`(${MIC_ACT})('read')`));
  return !!fin && fin.muted === !on;
}

async function pollDetect(host, ms, everyMs) {
  const out = []; const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const d = JSON.parse((await host.evalJs(`JSON.stringify((window.__meetDetect&&window.__meetDetect())||{})`)) || '{}');
    out.push(d); await sleep(everyMs);
  }
  return out;
}
// Between turns the rig must be QUIET (the shared-BlackHole rig can briefly echo
// meeting audio back into the mic; give it time to die down after output is
// routed away from BlackHole). Waits for 3 consecutive no-name polls.
async function waitQuiet(host, maxMs) {
  const t0 = Date.now(); let streakQ = 0;
  while (Date.now() - t0 < maxMs) {
    const d = JSON.parse((await host.evalJs(`JSON.stringify((window.__meetDetect&&window.__meetDetect())||{})`)) || '{}');
    streakQ = (d.names || []).some((n) => n !== 'Someone') ? 0 : streakQ + 1;
    if (streakQ >= 3) return true;
    await sleep(400);
  }
  return false;
}
const frac = (polls, pred) => +(polls.length ? polls.filter(pred).length / polls.length : 0).toFixed(2);
const hasName = (d, n) => (d.names || []).includes(n);
const anyWrong = (d, allowed) => (d.names || []).some((n) => n !== 'Someone' && !allowed.includes(n));

// Play a clip DIRECTLY into the virtual-mic device via ffmpeg's audiotoolbox
// output with an EXPLICIT device index — no default-output switching at all.
// (afplay + default switching proved unreliable live: afplay binds a device at
// start, switches race, and leaving the default on the virtual device builds
// meeting-audio feedback loops. Explicit-device ffmpeg has none of those.)
// The index comes from `node find-audio-index.js "<device>"`, which verifies the
// device's loopback with a pure-CoreAudio record oracle and caches the result.
let AUDIO_IDX = null, AUDIO_DEV = null;
function loadAudioIndex() {
  const cache = path.join(__dirname, '.audio-device-index');
  if (!fs.existsSync(cache)) throw new Error('run `node find-audio-index.js "<virtual mic device>"` first');
  const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
  AUDIO_IDX = c.index; AUDIO_DEV = c.device;
  console.log(`[audio] "${c.device}" via audiotoolbox index ${c.index}`);
}
function playClip(clip) {
  return spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re',
    '-i', path.join(__dirname, 'audio', clip),
    '-f', 'audiotoolbox', '-audio_device_index', String(AUDIO_IDX), '-']);
}

async function measureTurn(host, label, clip, expectNames, absentNames, micStates) {
  const af = playClip(clip);
  const polls = [];
  const done = new Promise((res) => af.on('exit', res));
  const t0 = Date.now();
  while (af.exitCode === null && Date.now() - t0 < 9000) {
    const d = JSON.parse((await host.evalJs(`JSON.stringify((window.__meetDetect&&window.__meetDetect())||{})`)) || '{}');
    polls.push(d); await sleep(300);
  }
  await done;
  // settle past the animation tail + hold, then measure the gap
  await sleep(1500 + HOLD_MS);
  const gap = await pollDetect(host, 2500, 300);
  const row = {
    turn: label,
    mics: micStates,
    detect: Object.fromEntries(expectNames.map((n) => [n, frac(polls, (d) => hasName(d, n))])),
    all_expected_together: frac(polls, (d) => expectNames.every((n) => hasName(d, n))),
    wrong_name: frac(polls, (d) => anyWrong(d, expectNames)),
    leak: Object.fromEntries(absentNames.map((n) => [n, frac(polls, (d) => hasName(d, n))])),
    gap_quiet: frac(gap, (d) => !(d.names || []).some((n) => n !== 'Someone')),
    via: [...new Set(polls.map((d) => d.via))],
  };
  return row;
}
// Set + VERIFY both guests' mic states, then wait for rig quiescence. Returns
// the audit string ("A:on B:off") so each row records the proven mic state.
async function setTurnMics(host, pages, wantOn) {
  const audit = [];
  for (const [name, on] of wantOn) {
    const ok = await setMic(pages[name], on);
    audit.push(`${name}:${on ? 'on' : 'off'}${ok ? '' : '(FAILED)'}`);
    if (!ok) console.log(`  [!] mic set FAILED for ${name}`);
  }
  await waitQuiet(host, 8000);
  return audit.join(' ');
}

function turnOk(row, expectNames, overlap) {
  const each = expectNames.every((n) => row.detect[n] >= 0.7);
  const together = overlap ? row.all_expected_together >= 0.5 : true;
  const clean = row.wrong_name <= 0.05 && Object.values(row.leak).every((v) => v <= 0.1);
  return each && together && clean && row.gap_quiet >= 0.7;
}

async function main() {
  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  const pages = {};
  for (const g of GUESTS) pages[g.name] = await attachToPage(g.port, /meet\.google\.com/);

  // host stays muted; detector injected STRUCT-ONLY with hold
  await host.evalJs(DETECTOR);
  await host.evalJs(`window.__ctx={vad:true, structOnly:true, holdMs:${HOLD_MS}}; window.__meetHoldState={};`);
  // Playback goes to the device EXPLICITLY (ffmpeg audiotoolbox index). The
  // system default INPUT must ALSO stay pinned to the virtual device for the
  // whole run: Chrome captures the "default" ALIAS device (seen in
  // enumerateDevices: "Default - ..."), so the guests' effective mic FOLLOWS the
  // OS default input — a script restoring the input mid-run silently yanks every
  // guest's mic back to the MacBook microphone (this killed three loop runs
  // before it was understood; the handoff's "Meet pins the mic at admit" only
  // holds for concretely-selected devices, not the default alias).
  loadAudioIndex();
  const origIn = sh('SwitchAudioSource -c -t input');
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(AUDIO_DEV)}`);
  process.on('exit', () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); } catch (e) {} });
  process.on('SIGINT', () => process.exit(1));
  console.log(`[loop] struct-only + holdMs=${HOLD_MS}; up to ${MAX_ROUNDS} rounds, need ${PASS_STREAK} consecutive clean\n`);

  const A = GUESTS[0], B = GUESTS[1];
  let streak = 0; const history = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`--- ROUND ${round} ---`);
    const rows = [];

    let mics = await setTurnMics(host, pages, [[A.name, true], [B.name, false]]);
    rows.push(await measureTurn(host, `${A.name} solo`, A.clip, [A.name], [B.name, HOST_NAME], mics));

    mics = await setTurnMics(host, pages, [[A.name, false], [B.name, true]]);
    rows.push(await measureTurn(host, `${B.name} solo`, B.clip, [B.name], [A.name, HOST_NAME], mics));

    mics = await setTurnMics(host, pages, [[A.name, true], [B.name, true]]);
    rows.push(await measureTurn(host, 'OVERLAP A+B', OVERLAP_CLIP, [A.name, B.name], [HOST_NAME], mics));

    const ok = turnOk(rows[0], [A.name]) && turnOk(rows[1], [B.name]) && turnOk(rows[2], [A.name, B.name], true);
    rows.forEach((r) => console.log('  ' + JSON.stringify(r)));
    console.log(`  ROUND ${round}: ${ok ? 'PASS' : 'FAIL'}\n`);
    history.push({ round, ok, rows });
    streak = ok ? streak + 1 : 0;
    if (streak >= PASS_STREAK) break;
  }
  // leave both guests muted
  await setMic(pages[A.name], false); await setMic(pages[B.name], false);

  const passed = streak >= PASS_STREAK;
  console.log('===== VERDICT =====');
  console.log(JSON.stringify({
    structure_only_detection: passed ? 'CONFIRMED' : 'NOT YET',
    rounds_run: history.length, consecutive_clean: streak, holdMs: HOLD_MS,
    conclusion: passed
      ? 'Token-free STRUCTURAL detection (jsname disabled) named each solo speaker and BOTH overlapping speakers on a real 3-person Meet, staying quiet in gaps, across consecutive rounds.'
      : 'See failing rows above — tune predicate/hold and re-run.',
  }, null, 2));
  fs.writeFileSync(path.join(__dirname, 'struct-loop-results.json'), JSON.stringify(history, null, 2));
  process.exit(passed ? 0 : 1);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(1); });
