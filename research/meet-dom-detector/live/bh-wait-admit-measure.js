'use strict';
// Wait for the guest (port 9318) to be ADMITTED (detected by its own Leave-call
// button = truly in the call, not knocking), then measure live turn-wise speech.
// Admit "BH Speaker" manually from the host window while this waits.
//   node bh-wait-admit-measure.js
const fs = require('fs'); const path = require('path');
const { execSync, spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222, GUEST_PORT = 9318, DEV = 'BlackHole 2ch', GUEST = 'BH Speaker';
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const CLIPS = ['Alice', 'Bob', 'Carol'].map((n) => path.join(__dirname, 'audio', n + '.wav'));
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const CLICK = `function(res){for(const s of res){var el=[...document.querySelectorAll('button,[role=button],span,div[role=button]')].find(function(n){var t=(n.getAttribute('aria-label')||'')+' '+(n.textContent||'');return new RegExp(s,'i').test(t);});if(el){el.click();return s;}}return null;}`;
const IN_CALL = `!!document.querySelector('button[aria-label*="Leave call" i]')`;
const MICLABEL = `(function(){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){return /microphone/i.test(n.getAttribute('aria-label')||'')});return b?b.getAttribute('aria-label'):null;})()`;
const GUEST_STRUCT = `(function(name){var t=[...document.querySelectorAll('[data-participant-id]')].find(function(x){return ((x.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim()===name;});if(!t)return {found:false};var ind=t.querySelector('[jsname="QgSmzd"]');var bars=ind?[...ind.children].filter(function(c){return c.tagName==='DIV'}):[];return {found:true,hasIndicator:!!ind,nBars:bars.length,anyAnim:bars.some(function(b){var a=getComputedStyle(b).animationName;return a&&a!=='none'})};})`;

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  const restore = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} };
  process.on('exit', restore); process.on('SIGINT', () => { restore(); process.exit(1); });

  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  let g; try { g = await attachToPage(GUEST_PORT, /meet\.google\.com/); } catch (e) { console.error('[!] guest gone — re-run bh-full-test.js'); process.exit(1); }

  console.log('[waiting] ADMIT "BH Speaker" in the host window now… (watching for it to enter the call)');
  let inCall = false;
  for (let i = 0; i < 45 && !inCall; i++) {
    await host.evalJs(`(${CLICK})(['^Admit$','Admit','Let in','Allow'])`);   // best-effort auto-admit too
    inCall = await g.evalJs(IN_CALL);
    if (i % 3 === 0) console.log(`  t${i*2}s guestInCall=${inCall}`);
    if (!inCall) await sleep(2000);
  }
  if (!inCall) { console.error('[!] guest still not in the call. Admit "BH Speaker" in the host window, then re-run: node bh-wait-admit-measure.js'); process.exit(1); }
  console.log('[joined] guest is IN THE CALL.');

  let ml = await g.evalJs(MICLABEL); if (ml && /turn on microphone/i.test(ml)) { await g.evalJs(`(${CLICK})(['Turn on microphone'])`); await sleep(800); }
  console.log('[guest] mic:', await g.evalJs(MICLABEL));

  await host.evalJs(`(${CLICK})(['Turn off microphone'])`);
  await host.evalJs(DETECTOR); await host.evalJs('window.__ctx={vad:true}');
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);

  console.log(`\n[live] turn-wise speech for "${GUEST}":`);
  const results = [];
  for (const clip of CLIPS) {
    const label = path.basename(clip, '.wav'); const af = spawn('afplay', [clip]);
    let sp = 0, n = 0, seenInd = false; const t0 = Date.now();
    await new Promise((res) => { af.on('exit', res); (async () => { while (!af.killed && Date.now() - t0 < 9000) { const s = JSON.parse(await host.evalJs(`JSON.stringify((${GUEST_STRUCT})(${JSON.stringify(GUEST)}))`)); if (s.hasIndicator) seenInd = true; if (s.anyAnim) sp++; n++; await sleep(600); } })(); });
    await sleep(400); let sil = 0, sn = 0; const s0 = Date.now();
    while (Date.now() - s0 < 3000) { const s = JSON.parse(await host.evalJs(`JSON.stringify((${GUEST_STRUCT})(${JSON.stringify(GUEST)}))`)); if (!s.anyAnim) sil++; sn++; await sleep(600); }
    const row = { clip: label, speaking_frac: +(n ? sp / n : 0).toFixed(2), silent_gap_frac: +(sn ? sil / sn : 0).toFixed(2), indicatorRendered: seenInd };
    results.push(row); console.log('  ' + JSON.stringify(row));
  }
  restore();
  const ok = results.every((r) => r.speaking_frac > 0.4 && r.silent_gap_frac > 0.5);
  console.log('\n===== verdict =====\n' + JSON.stringify({ live_turnwise_tracking: ok, per_clip: results,
    conclusion: ok ? 'CONFIRMED LIVE: structural detector tracks the guest speaking per utterance and silent in gaps (real speech via BlackHole).'
                   : (results.some(r=>r.indicatorRendered) ? 'indicator rendered but animation not caught — retiming may help' : 'no indicator on the guest tile — camera-off remote may not render the equalizer; try guest camera ON') }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); try { sh('SwitchAudioSource -t output -s "MacBook Pro Speakers"'); sh('SwitchAudioSource -t input -s "MacBook Pro Microphone"'); } catch (x) {} process.exit(1); });
