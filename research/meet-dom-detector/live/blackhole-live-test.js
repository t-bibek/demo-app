'use strict';
// LIVE turn-wise speaking test with RECOGNIZED speech via BlackHole.
// Routing: set system input+output to "BlackHole 2ch" (a loopback device) → a guest
// Chrome uses BlackHole as its mic → we `afplay` speech WAVs to the (BlackHole)
// output, which loops into the guest's mic → Meet transmits it as real speech →
// the host observer confirms the detector tracks the guest speaking/silent.
//
// Prereq: BlackHole 2ch installed (brew cask + `sudo killall coreaudiod`) and the
// host already in the meeting on port 9222 (open-clean.js + watch-meeting.js).
//   node blackhole-live-test.js
//
// NOTE: one BlackHole device = ONE recognized-speech source, so this validates the
// real-time on/off transition (turn-wise bursts) for a single speaker. True
// multi-participant OVERLAP with independent audio needs a 2nd virtual device
// (e.g. BlackHole 16ch) — documented as a follow-up; the simulator QA covers the
// overlap LOGIC.
const fs = require('fs'); const path = require('path');
const { execSync, spawn } = require('child_process');
const { launchChrome, attachToPage, sleep } = require('./cdp-lib');

const HOST_PORT = 9222, GUEST_PORT = 9316;
const DEV = 'BlackHole 2ch';
const URL = fs.readFileSync(path.join(__dirname, '.meeting-url'), 'utf8').trim();
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const CLIPS = ['Alice', 'Bob', 'Carol'].map((n) => path.join(__dirname, 'audio', n + '.wav'));

const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const CLICK = `function(res){for(const s of res){var el=[...document.querySelectorAll('button,[role=button],span')].find(function(n){var t=(n.getAttribute('aria-label')||'')+' '+(n.textContent||'');return new RegExp(s,'i').test(t);});if(el){el.click();return s;}}return null;}`;
const PROBE = `(function(host){var out={};[...document.querySelectorAll('[data-participant-id]')].forEach(function(t){
  var n=((t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim();
  var ind=t.querySelector('[jsname="QgSmzd"]'); var bars=ind?[...ind.children].filter(function(c){return c.tagName==='DIV'}):[];
  var speaking=bars.some(function(b){var a=getComputedStyle(b).animationName;return a&&a!=='none'});
  if(n && n!==host){ out[n]=out[n]||false; out[n]=out[n]||speaking; }});return out;})`;

async function main() {
  if (!sh('SwitchAudioSource -a').includes(DEV)) { console.error(`[!] "${DEV}" not found — install BlackHole + \`sudo killall coreaudiod\` first.`); process.exit(2); }
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  console.log(`[audio] saving devices in="${origIn}" out="${origOut}" → routing both to "${DEV}"`);
  function restore() { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} }
  process.on('exit', restore); process.on('SIGINT', () => { restore(); process.exit(1); });

  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`);
  sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);

  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  const hostName = await host.evalJs(`((document.querySelector('[data-participant-id] span.notranslate')||{}).textContent||'').trim()`);
  await host.evalJs(`(${CLICK})(['Turn off microphone'])`);  // ensure host muted (its mic is also BlackHole)

  // Guest joins using the REAL default mic (= BlackHole), NOT the fake tone.
  const guest = launchChrome({ port: GUEST_PORT, headful: true, realMicGrant: true, url: URL, profileTag: 'meet-guest' });
  const g = await attachToPage(GUEST_PORT, /meet\.google\.com/);
  for (let i = 0; i < 6; i++) { await sleep(2500);
    await g.evalJs(`(function(){var i=document.querySelector('input[jsname][type="text"], input[type="text"][aria-label]');if(i&&!i.value){i.value='BH Speaker';i.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    await g.evalJs(`(${CLICK})(['Turn off camera'])`);
    const did = await g.evalJs(`(${CLICK})(['Ask to join','Join now'])`); if (did) break; }
  let pids = 1;
  for (let i = 0; i < 40 && pids < 2; i++) { await sleep(1500); await host.evalJs(`(${CLICK})(['^Admit$','Admit'])`); pids = await host.evalJs(`document.querySelectorAll('[data-participant-id]').length`); }
  if (pids < 2) { console.error('[!] guest never joined (admit it in the host window and re-run).'); process.exit(1); }
  await host.evalJs(DETECTOR); await host.evalJs('window.__ctx={vad:true}');
  console.log(`[live] host="${hostName}" + guest="BH Speaker" in call. Turn-wise speech:\n`);

  const results = [];
  for (const clip of CLIPS) {
    const label = path.basename(clip, '.wav');
    const af = spawn('afplay', [clip]);            // play recognized speech into BlackHole → guest mic
    let speakingHits = 0, n = 0; const t0 = Date.now();
    await new Promise((res) => { af.on('exit', res); (async () => { while (!af.killed && (Date.now() - t0) < 9000) { const o = JSON.parse((await host.evalJs(`JSON.stringify((${PROBE})(${JSON.stringify(hostName)}))`)) || '{}'); if (Object.values(o).some(Boolean)) speakingHits++; n++; await sleep(700); } })(); });
    const speakFrac = n ? speakingHits / n : 0;
    // silence gap
    await sleep(500); let silHits = 0, sn = 0; const s0 = Date.now();
    while ((Date.now() - s0) < 3000) { const o = JSON.parse((await host.evalJs(`JSON.stringify((${PROBE})(${JSON.stringify(hostName)}))`)) || '{}'); if (!Object.values(o).some(Boolean)) silHits++; sn++; await sleep(700); }
    const row = { clip: label, speaking_during_playback: +speakFrac.toFixed(2), silent_during_gap: +(sn ? silHits / sn : 0).toFixed(2) };
    results.push(row); console.log('  ' + JSON.stringify(row));
  }

  restore();
  const ok = results.every((r) => r.speaking_during_playback > 0.4 && r.silent_during_gap > 0.5);
  console.log('\n===== verdict =====');
  console.log(JSON.stringify({ turnwise_realtime_tracking: ok, per_clip: results,
    conclusion: ok ? 'CONFIRMED live: the structural detector tracks the guest speaking during each utterance and silent in the gaps (recognized speech via BlackHole).'
                   : 'mixed — check guest mic = BlackHole and that afplay output routed to BlackHole.' }, null, 2));
  guest.kill();
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(1); });
