'use strict';
// The guest is already joined (port 9318). Ensure it's admitted + its mic is ON,
// then re-measure the live turn-wise speech, dumping the guest tile structure so we
// can see whether a camera-off speaking tile even renders the QgSmzd widget.
//   node bh-measure-only.js
const fs = require('fs'); const path = require('path');
const { execSync, spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222, GUEST_PORT = 9318, DEV = 'BlackHole 2ch', GUEST = 'BH Speaker';
const URL_FILE = path.join(__dirname, '.meeting-url');
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const CLIPS = ['Alice', 'Bob', 'Carol'].map((n) => path.join(__dirname, 'audio', n + '.wav'));
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const CLICK = `function(res){for(const s of res){var el=[...document.querySelectorAll('button,[role=button],span')].find(function(n){var t=(n.getAttribute('aria-label')||'')+' '+(n.textContent||'');return new RegExp(s,'i').test(t);});if(el){el.click();return s;}}return null;}`;
const MICLABEL = `(function(){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){return /microphone/i.test(n.getAttribute('aria-label')||'')});return b?b.getAttribute('aria-label'):null;})()`;
// full structural dump of the guest tile (does the indicator render? do bars animate?)
const GUEST_STRUCT = `(function(name){var t=[...document.querySelectorAll('[data-participant-id]')].find(function(x){return ((x.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim()===name;});if(!t)return {found:false};var ind=t.querySelector('[jsname="QgSmzd"]');var bars=ind?[...ind.children].filter(function(c){return c.tagName==='DIV'}):[];return {found:true, hasIndicator:!!ind, jsctrl:ind?ind.getAttribute('jscontroller'):null, wclass:ind?ind.className:null, nBars:bars.length, barsAnim:bars.map(function(b){return getComputedStyle(b).animationName}), anyAnim:bars.some(function(b){var a=getComputedStyle(b).animationName;return a&&a!=='none'})};})`;

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  const restore = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} };
  process.on('exit', restore); process.on('SIGINT', () => { restore(); process.exit(1); });

  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  let g; try { g = await attachToPage(GUEST_PORT, /meet\.google\.com/); } catch (e) { console.error('[!] guest on :' + GUEST_PORT + ' is gone — re-run bh-full-test.js.'); process.exit(1); }

  // Admit (in case waiting) + make sure the guest is in the call.
  for (let i = 0; i < 8; i++) { await host.evalJs(`(${CLICK})(['^Admit$','Admit'])`); await g.evalJs(`(${CLICK})(['Join now','Ask to join'])`); await sleep(1200); }
  // Ensure guest mic is ON ("Turn on microphone" label = currently muted -> click it).
  let ml = await g.evalJs(MICLABEL); console.log('[guest] mic label:', ml);
  if (ml && /turn on microphone/i.test(ml)) { await g.evalJs(`(${CLICK})(['Turn on microphone'])`); await sleep(1000); ml = await g.evalJs(MICLABEL); console.log('[guest] after unmute, mic label:', ml); }

  await host.evalJs(`(${CLICK})(['Turn off microphone'])`);  // host muted
  await host.evalJs(DETECTOR); await host.evalJs('window.__ctx={vad:true}');
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`);   // guest mic source
  sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);  // afplay -> loopback

  console.log(`\n[live] turn-wise speech for "${GUEST}" (with structure dump):`);
  const results = [];
  for (const clip of CLIPS) {
    const label = path.basename(clip, '.wav');
    const af = spawn('afplay', [clip]);
    let sp = 0, n = 0, struct = null; const t0 = Date.now();
    await new Promise((res) => { af.on('exit', res); (async () => { while (!af.killed && Date.now() - t0 < 9000) { const s = JSON.parse(await host.evalJs(`JSON.stringify((${GUEST_STRUCT})(${JSON.stringify(GUEST)}))`)); if (s.anyAnim) sp++; if (!struct && s.found) struct = s; n++; await sleep(600); } })(); });
    await sleep(400); let sil = 0, sn = 0; const s0 = Date.now();
    while (Date.now() - s0 < 3000) { const s = JSON.parse(await host.evalJs(`JSON.stringify((${GUEST_STRUCT})(${JSON.stringify(GUEST)}))`)); if (!s.anyAnim) sil++; sn++; await sleep(600); }
    const row = { clip: label, speaking_frac: +(n ? sp / n : 0).toFixed(2), silent_gap_frac: +(sn ? sil / sn : 0).toFixed(2), structDuringPlay: struct };
    results.push(row); console.log('  ' + JSON.stringify(row));
  }
  restore();
  const ok = results.every((r) => r.speaking_frac > 0.4 && r.silent_gap_frac > 0.5);
  console.log('\n===== verdict =====\n' + JSON.stringify({ live_turnwise_tracking: ok, per_clip: results.map(function(r){return {clip:r.clip,speaking_frac:r.speaking_frac,silent_gap_frac:r.silent_gap_frac,hasIndicator:r.structDuringPlay&&r.structDuringPlay.hasIndicator,nBars:r.structDuringPlay&&r.structDuringPlay.nBars};}) }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); try { sh('SwitchAudioSource -t output -s "MacBook Pro Speakers"'); sh('SwitchAudioSource -t input -s "MacBook Pro Microphone"'); } catch (x) {} process.exit(1); });
