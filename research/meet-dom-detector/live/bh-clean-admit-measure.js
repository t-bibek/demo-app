'use strict';
// Clean slate + TWO-STEP admit + measure. Kills stale guests, launches ONE guest,
// admits via toast AND the People-panel row, waits until the guest is FULLY in
// (it can see the host), verifies BlackHole audio reaches Meet, then measures.
//   node bh-clean-admit-measure.js
const fs = require('fs'); const path = require('path');
const { execSync, spawn } = require('child_process');
const { launchChrome, attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222, GUEST_PORT = 9321, DEV = 'BlackHole 2ch', GUEST = 'BH Speaker';
const URL = fs.readFileSync(path.join(__dirname, '.meeting-url'), 'utf8').trim();
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const CLIPS = ['Alice', 'Bob', 'Carol'].map((n) => path.join(__dirname, 'audio', n + '.wav'));
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

async function clickReal(page, rx) {
  const info = await page.evalJs(`(function(){var b=[...document.querySelectorAll('button,[role=button],div[role=button]')].find(function(n){var t=(n.getAttribute('aria-label')||'')+' '+(n.textContent||'');return new RegExp(${JSON.stringify(rx)},'i').test(t)&&n.offsetParent!==null;});if(!b)return null;var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),label:(b.getAttribute('aria-label')||b.textContent||'').trim().slice(0,24)};})()`);
  if (!info) return null;
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 });
  return info.label;
}
const FILL = `(function(name){var inp=[...document.querySelectorAll('input')].find(function(i){return (i.type===''||i.type==='text')&&i.offsetParent!==null;});if(!inp)return;var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;inp.focus();set.call(inp,name);inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));})`;
const SEES = `[...new Set([...document.querySelectorAll('[data-participant-id]')].map(function(t){return ((t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim();}).filter(Boolean))]`;
const MIC = `(function(){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){return /microphone/i.test(n.getAttribute('aria-label')||'')});return b?b.getAttribute('aria-label'):null;})()`;
const SELF_ANIM = `[...document.querySelectorAll('[jsname="QgSmzd"]')].some(function(ind){return [...ind.children].some(function(b){var a=getComputedStyle(b).animationName;return a&&a!=='none'});})`;
const GUEST_ANIM = `(function(name){var t=[...document.querySelectorAll('[data-participant-id]')].find(function(x){return ((x.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim()===name;});if(!t)return false;var ind=t.querySelector('[jsname="QgSmzd"]');if(!ind)return false;return [...ind.children].some(function(b){var a=getComputedStyle(b).animationName;return a&&a!=='none'});})`;

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  const restore = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} };
  process.on('exit', restore); process.on('SIGINT', () => { restore(); process.exit(1); });

  try { execSync('pkill -f meet-guest'); } catch (e) {} await sleep(1500);
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`);
  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  const guest = launchChrome({ port: GUEST_PORT, headful: true, realMicGrant: true, url: URL, profileTag: 'meet-guest' });
  const g = await attachToPage(GUEST_PORT, /meet\.google\.com/);
  const hostName = JSON.parse(await host.evalJs(`JSON.stringify(${SEES})`))[0];

  // Ask to join, then TWO-STEP admit until the GUEST can see the host (fully in).
  console.log('[admit] two-step: toast + People-panel row. (You can also click Admit in the host window.)');
  let fullyIn = false;
  for (let i = 0; i < 50 && !fullyIn; i++) {
    await sleep(2000);
    await g.evalJs(`(${FILL})(${JSON.stringify(GUEST)})`);
    await clickReal(g, 'Ask to join|Join now');
    // step 1: toast admit
    const a1 = await clickReal(host, 'Admit|Let in');
    // step 2: open People panel + admit in the row
    await clickReal(host, 'People|Show everyone|Participants');
    await sleep(400);
    const a2 = await clickReal(host, 'Admit');
    const guestSees = JSON.parse(await g.evalJs(`JSON.stringify(${SEES})`));
    fullyIn = guestSees.includes(hostName);
    if (i % 3 === 0) console.log(`  t${i*2}s admit1=${a1} admit2=${a2} | guestSees=${JSON.stringify(guestSees)} fullyIn=${fullyIn}`);
  }
  if (!fullyIn) { console.error('[!] guest still not fully admitted — please admit "BH Speaker" in the host People panel, then re-run: node bh-clean-admit-measure.js'); process.exit(1); }
  if (/turn on microphone/i.test(await g.evalJs(MIC) || '')) await clickReal(g, 'Turn on microphone');
  console.log(`[joined] guest fully in; guestMic=${await g.evalJs(MIC)}`);

  // verify audio reaches Meet
  sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);
  for (let i = 0; i < 3; i++) spawn('afplay', [CLIPS[0]]);
  let selfMoved = false; for (let i = 0; i < 12 && !selfMoved; i++) { if (await g.evalJs(SELF_ANIM)) selfMoved = true; await sleep(500); }
  console.log(`[check] audio reaches Meet (guest self meter moved): ${selfMoved}`);
  await sleep(1200);

  await clickReal(host, 'Turn off microphone');
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
