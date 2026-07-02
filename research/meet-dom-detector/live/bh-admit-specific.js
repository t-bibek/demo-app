'use strict';
// Admit using the SPECIFIC participants-row button (jsname="OYykWd",
// aria-label="Admit <name>") — not the toast "Admit 1 guest" — then measure.
//   node bh-admit-specific.js
const fs = require('fs'); const path = require('path');
const { execSync, spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222, DEV = 'BlackHole 2ch', GUEST = 'BH Speaker';
const GUEST_PORTS = [9321, 9320, 9318, 9316, 9315, 9314, 9313];
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const CLIPS = ['Alice', 'Bob', 'Carol'].map((n) => path.join(__dirname, 'audio', n + '.wav'));
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

async function clickInfo(page, info) {
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 });
}
async function clickSel(page, sel) {
  const info = await page.evalJs(`(function(){var b=document.querySelector(${JSON.stringify(sel)});if(!b||b.offsetParent===null)return null;b.scrollIntoView&&b.scrollIntoView({block:'center'});var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),label:(b.getAttribute('aria-label')||'').slice(0,30)};})()`);
  if (!info) return null; await clickInfo(page, info); return info.label;
}
async function clickRx(page, rx) {
  const info = await page.evalJs(`(function(){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){var t=(n.getAttribute('aria-label')||'')+' '+(n.textContent||'');return new RegExp(${JSON.stringify(rx)},'i').test(t)&&n.offsetParent!==null;});if(!b)return null;var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),label:(b.getAttribute('aria-label')||b.textContent||'').trim().slice(0,24)};})()`);
  if (!info) return null; await clickInfo(page, info); return info.label;
}
const SEES = `[...new Set([...document.querySelectorAll('[data-participant-id]')].map(function(t){return ((t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim();}).filter(Boolean))]`;
const MIC = `(function(){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){return /microphone/i.test(n.getAttribute('aria-label')||'')});return b?b.getAttribute('aria-label'):null;})()`;
const SELF_ANIM = `[...document.querySelectorAll('[jsname="QgSmzd"]')].some(function(ind){return [...ind.children].some(function(b){var a=getComputedStyle(b).animationName;return a&&a!=='none'});})`;
const GUEST_ANIM = `(function(name){var t=[...document.querySelectorAll('[data-participant-id]')].find(function(x){return ((x.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim()===name;});if(!t)return false;var ind=t.querySelector('[jsname="QgSmzd"]');if(!ind)return false;return [...ind.children].some(function(b){var a=getComputedStyle(b).animationName;return a&&a!=='none'});})`;

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  const restore = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} };
  process.on('exit', restore); process.on('SIGINT', () => { restore(); process.exit(1); });
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`);

  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  let g = null; for (const p of GUEST_PORTS) { try { g = await attachToPage(p, /meet\.google\.com/); console.log('[guest] attached on :' + p); break; } catch (e) {} }
  if (!g) { console.error('[!] no guest window found — re-run bh-full-test.js'); process.exit(1); }
  const hostName = JSON.parse(await host.evalJs(`JSON.stringify(${SEES})`))[0];

  // Open the People panel, then click the SPECIFIC row admit button.
  console.log('[admit] targeting button[jsname="OYykWd"] (aria-label "Admit <name>")…');
  let fullyIn = false;
  for (let i = 0; i < 40 && !fullyIn; i++) {
    await clickRx(g, 'Ask to join|Join now');
    await clickRx(host, 'People|Show everyone|Participants|View all');   // open panel
    await sleep(500);
    const a = (await clickSel(host, 'button[jsname="OYykWd"]'))
           || (await clickSel(host, 'button[aria-label^="Admit "]:not([aria-label*="guest"])'))
           || (await clickRx(host, 'Admit ' + GUEST));
    const guestSees = JSON.parse(await g.evalJs(`JSON.stringify(${SEES})`));
    fullyIn = guestSees.includes(hostName);
    if (i % 2 === 0) console.log(`  try${i} rowAdmit=${a} | guestSees=${JSON.stringify(guestSees)} fullyIn=${fullyIn}`);
    if (!fullyIn) await sleep(1500);
  }
  if (!fullyIn) { console.error('[!] still not admitted — click "Admit BH Speaker" in the People panel; then: node bh-admit-specific.js'); process.exit(1); }
  if (/turn on microphone/i.test(await g.evalJs(MIC) || '')) await clickRx(g, 'Turn on microphone');
  console.log(`[joined] guest fully in; mic=${await g.evalJs(MIC)}`);

  sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);
  for (let i = 0; i < 3; i++) spawn('afplay', [CLIPS[0]]);
  let selfMoved = false; for (let i = 0; i < 12 && !selfMoved; i++) { if (await g.evalJs(SELF_ANIM)) selfMoved = true; await sleep(500); }
  console.log(`[check] audio reaches Meet (guest self meter moved): ${selfMoved}`);
  await sleep(1200);

  await clickRx(host, 'Turn off microphone');
  await host.evalJs(DETECTOR); await host.evalJs('window.__ctx={vad:true}');
  console.log(`\n[live] turn-wise speech for "${GUEST}":`);
  const results = [];
  for (const clip of CLIPS) {
    const label = path.basename(clip, '.wav'); const af = spawn('afplay', [clip]);
    let sp = 0, n = 0; const t0 = Date.now();
    await new Promise((res) => { af.on('exit', res); (async () => { while (!af.killed && Date.now() - t0 < 9000) { if (await host.evalJs(`(${GUEST_ANIM})(${JSON.stringify(GUEST)})`)) sp++; n++; await sleep(500); } })(); });
    await sleep(400); let sil = 0, sn = 0; const s0 = Date.now();
    while (Date.now() - s0 < 3000) { if (!(await host.evalJs(`(${GUEST_ANIM})(${JSON.stringify(GUEST)})`))) sil++; sn++; await sleep(500); }
    const row = { clip: label, speaking_frac: +(n ? sp / n : 0).toFixed(2), silent_gap_frac: +(sn ? sil / sn : 0).toFixed(2) };
    results.push(row); console.log('  ' + JSON.stringify(row));
  }
  restore();
  const hostOk = results.every((r) => r.speaking_frac > 0.4 && r.silent_gap_frac > 0.5);
  console.log('\n===== verdict =====\n' + JSON.stringify({ audio_reaches_meet: selfMoved, host_sees_turnwise: hostOk, per_clip: results,
    conclusion: hostOk ? 'CONFIRMED LIVE end-to-end: recognized speech -> guest speaks -> host structural detector tracks turn-wise speaking/silent.'
      : selfMoved ? 'audio reaches Meet but host remote tile did not animate (camera-off remote rendering).' : 'audio still not reaching Meet mic.' }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); try { sh('SwitchAudioSource -t output -s "MacBook Pro Speakers"'); sh('SwitchAudioSource -t input -s "MacBook Pro Microphone"'); } catch (x) {} process.exit(1); });
