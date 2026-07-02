'use strict';
// Robustly ADMIT + UNMUTE the guest using REAL CDP input events (Meet's controls
// don't always respond to el.click()), then measure live turn-wise speech.
//   node bh-unmute-measure.js
const fs = require('fs'); const path = require('path');
const { execSync, spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222, GUEST_PORT = 9318, DEV = 'BlackHole 2ch', GUEST = 'BH Speaker';
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const CLIPS = ['Alice', 'Bob', 'Carol'].map((n) => path.join(__dirname, 'audio', n + '.wav'));
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

// Real mouse click at an element matched by aria/text regex; returns the label it clicked.
async function clickReal(page, rx) {
  const info = await page.evalJs(`(function(){var b=[...document.querySelectorAll('button,[role=button],div[role=button]')].find(function(n){var t=(n.getAttribute('aria-label')||'')+' '+(n.textContent||'');return new RegExp(${JSON.stringify(rx)},'i').test(t)&&n.offsetParent!==null;});if(!b)return null;var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),label:(b.getAttribute('aria-label')||b.textContent||'').trim().slice(0,30)};})()`);
  if (!info) return null;
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 });
  return info.label;
}
async function cmdD(page) { // ⌘+D toggles mic in Meet
  for (const type of ['keyDown', 'keyUp']) await page.cmd('Input.dispatchKeyEvent', { type, modifiers: 4, key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68 });
}
const MICLABEL = `(function(){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){return /microphone/i.test(n.getAttribute('aria-label')||'')});return b?b.getAttribute('aria-label'):null;})()`;
const GUEST_STRUCT = `(function(name){var t=[...document.querySelectorAll('[data-participant-id]')].find(function(x){return ((x.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim()===name;});if(!t)return {found:false};var ind=t.querySelector('[jsname="QgSmzd"]');var bars=ind?[...ind.children].filter(function(c){return c.tagName==='DIV'}):[];return {found:true,hasIndicator:!!ind,nBars:bars.length,anyAnim:bars.some(function(b){var a=getComputedStyle(b).animationName;return a&&a!=='none'})};})`;

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  const restore = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} };
  process.on('exit', restore); process.on('SIGINT', () => { restore(); process.exit(1); });

  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  let g; try { g = await attachToPage(GUEST_PORT, /meet\.google\.com/); } catch (e) { console.error('[!] guest gone — re-run bh-full-test.js'); process.exit(1); }

  // Admit anyone waiting (real click), a few tries.
  for (let i = 0; i < 6; i++) { const a = await clickReal(host, 'Admit|Let in'); if (a) console.log('[host] admitted via', a); await sleep(1000); }
  // Make sure the guest is in the call.
  if (!(await g.evalJs(`!!document.querySelector('button[aria-label*="Leave call" i]')`))) { await clickReal(g, 'Join now|Ask to join'); await sleep(2500); }

  // UNMUTE the guest — real click, then ⌘+D fallback, verify the label flips.
  let ml = await g.evalJs(MICLABEL); console.log('[guest] mic before:', ml);
  for (let i = 0; i < 4 && /turn on microphone/i.test(ml || ''); i++) {
    const lbl = await clickReal(g, 'Turn on microphone'); await sleep(800);
    ml = await g.evalJs(MICLABEL);
    if (/turn on microphone/i.test(ml || '')) { await cmdD(g); await sleep(800); ml = await g.evalJs(MICLABEL); }
    console.log(`  unmute try ${i + 1}: clicked=${lbl} -> mic now: ${ml}`);
  }
  if (/turn on microphone/i.test(ml || '')) { console.error('[!] could not unmute the guest.'); }

  // Host muted, detector in, route audio.
  await clickReal(host, 'Turn off microphone');
  await host.evalJs(DETECTOR); await host.evalJs('window.__ctx={vad:true}');
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);

  console.log(`\n[live] turn-wise speech for "${GUEST}" (mic=${ml}):`);
  const results = [];
  for (const clip of CLIPS) {
    const label = path.basename(clip, '.wav'); const af = spawn('afplay', [clip]);
    let sp = 0, n = 0, seenInd = false; const t0 = Date.now();
    await new Promise((res) => { af.on('exit', res); (async () => { while (!af.killed && Date.now() - t0 < 9000) { const s = JSON.parse(await host.evalJs(`JSON.stringify((${GUEST_STRUCT})(${JSON.stringify(GUEST)}))`)); if (s.hasIndicator) seenInd = true; if (s.anyAnim) sp++; n++; await sleep(500); } })(); });
    await sleep(400); let sil = 0, sn = 0; const s0 = Date.now();
    while (Date.now() - s0 < 3000) { const s = JSON.parse(await host.evalJs(`JSON.stringify((${GUEST_STRUCT})(${JSON.stringify(GUEST)}))`)); if (!s.anyAnim) sil++; sn++; await sleep(500); }
    const row = { clip: label, speaking_frac: +(n ? sp / n : 0).toFixed(2), silent_gap_frac: +(sn ? sil / sn : 0).toFixed(2), indicatorRendered: seenInd };
    results.push(row); console.log('  ' + JSON.stringify(row));
  }
  restore();
  const ok = results.every((r) => r.speaking_frac > 0.4 && r.silent_gap_frac > 0.5);
  console.log('\n===== verdict =====\n' + JSON.stringify({ live_turnwise_tracking: ok, guest_mic: ml, per_clip: results,
    conclusion: ok ? 'CONFIRMED LIVE: structural detector tracks the guest speaking per utterance, silent in gaps (real speech via BlackHole).'
                   : (results.some(r=>r.indicatorRendered) ? 'indicator rendered but not caught as animating — retime/tune' : 'no equalizer on the guest tile even unmuted — camera-off avatar tile may not render it; next: give the guest a fake camera') }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); try { sh('SwitchAudioSource -t output -s "MacBook Pro Speakers"'); sh('SwitchAudioSource -t input -s "MacBook Pro Microphone"'); } catch (x) {} process.exit(1); });
