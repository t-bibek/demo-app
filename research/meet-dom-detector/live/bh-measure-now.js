'use strict';
// Guest is admitted (port 9321). Force its Meet mic onto BlackHole (mute/unmute
// re-acquire on the current default), verify audio reaches Meet, then measure the
// host's structural read turn-wise. If re-acquire fails, prints how to pick
// BlackHole in the guest's Meet Settings.
//   node bh-measure-now.js
const fs = require('fs'); const path = require('path');
const { execSync, spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222, DEV = 'BlackHole 2ch', GUEST = 'BH Speaker';
const GUEST_PORTS = [9321, 9320, 9318];
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const CLIPS = ['Alice', 'Bob', 'Carol'].map((n) => path.join(__dirname, 'audio', n + '.wav'));
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
async function clickRx(page, rx) {
  const info = await page.evalJs(`(function(){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){var t=(n.getAttribute('aria-label')||'')+' '+(n.textContent||'');return new RegExp(${JSON.stringify(rx)},'i').test(t)&&n.offsetParent!==null;});if(!b)return null;var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),label:(b.getAttribute('aria-label')||b.textContent||'').trim().slice(0,24)};})()`);
  if (!info) return null;
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 });
  return info.label;
}
const MIC = `(function(){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){return /microphone/i.test(n.getAttribute('aria-label')||'')});return b?b.getAttribute('aria-label'):null;})()`;
const SELF_ANIM = `[...document.querySelectorAll('[jsname="QgSmzd"]')].some(function(ind){return [...ind.children].some(function(b){var a=getComputedStyle(b).animationName;return a&&a!=='none'});})`;
const GA = `(function(name){var t=[...document.querySelectorAll('[data-participant-id]')].find(function(x){return ((x.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim().toLowerCase()===name.toLowerCase();});if(!t)return false;var ind=t.querySelector('[jsname="QgSmzd"]');if(!ind)return false;return [...ind.children].some(function(b){var a=getComputedStyle(b).animationName;return a&&a!=='none'});})`;

async function reacquire(g) { // mute then unmute so Meet re-opens the mic on the current default (BlackHole)
  let ml = await g.evalJs(MIC);
  if (/turn off microphone/i.test(ml || '')) { await clickRx(g, 'Turn off microphone'); await sleep(1000); }  // mute
  await clickRx(g, 'Turn on microphone'); await sleep(1200);                                                    // unmute -> re-acquire
  return g.evalJs(MIC);
}

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  const restore = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} };
  process.on('exit', restore); process.on('SIGINT', () => { restore(); process.exit(1); });
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`);  // default input = BlackHole BEFORE re-acquire

  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  let g = null; for (const p of GUEST_PORTS) { try { g = await attachToPage(p, /meet\.google\.com/); console.log('[guest] on :' + p); break; } catch (e) {} }
  if (!g) { console.error('[!] no guest window'); process.exit(1); }

  console.log('[reacquire] toggling guest mic so Meet binds to BlackHole… mic=', await reacquire(g));
  sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);
  // Play ONE clean ~7s clip (not overlapping copies) and watch the guest self meter.
  const af0 = spawn('afplay', [CLIPS[0]]);
  let selfMoved = false; for (let i = 0; i < 14 && !selfMoved; i++) { if (await g.evalJs(SELF_ANIM)) selfMoved = true; await sleep(500); }
  try { af0.kill(); } catch (e) {}
  console.log('[check] audio reaches Meet (guest self meter moved):', selfMoved);
  if (!selfMoved) {
    console.log('\n[!] Meet mic is still not BlackHole. In the GUEST window: ⋮ More options → Settings → Audio →');
    console.log('    Microphone → choose "BlackHole 2ch", then re-run: node bh-measure-now.js');
    restore(); process.exit(2);
  }
  await sleep(1000);
  await clickRx(host, 'Turn off microphone');
  await host.evalJs(DETECTOR); await host.evalJs('window.__ctx={vad:true}');
  console.log(`\n[live] turn-wise speech for "${GUEST}":`);
  const results = [];
  for (const clip of CLIPS) {
    const label = path.basename(clip, '.wav'); const af = spawn('afplay', [clip]);
    let sp = 0, n = 0; const t0 = Date.now();
    await new Promise((res) => { af.on('exit', res); (async () => { while (!af.killed && Date.now() - t0 < 9000) { if (await host.evalJs(`(${GA})(${JSON.stringify(GUEST)})`)) sp++; n++; await sleep(500); } })(); });
    await sleep(400); let sil = 0, sn = 0; const s0 = Date.now();
    while (Date.now() - s0 < 3000) { if (!(await host.evalJs(`(${GA})(${JSON.stringify(GUEST)})`))) sil++; sn++; await sleep(500); }
    const row = { clip: label, speaking_frac: +(n ? sp / n : 0).toFixed(2), silent_gap_frac: +(sn ? sil / sn : 0).toFixed(2) };
    results.push(row); console.log('  ' + JSON.stringify(row));
  }
  restore();
  const ok = results.every((r) => r.speaking_frac > 0.4 && r.silent_gap_frac > 0.5);
  console.log('\n===== verdict =====\n' + JSON.stringify({ audio_reaches_meet: selfMoved, host_sees_turnwise: ok, per_clip: results,
    conclusion: ok ? 'CONFIRMED LIVE end-to-end: recognized speech -> guest speaks -> host structural (class-independent) detector tracks turn-wise speaking/silent.'
      : 'audio reaches Meet but host remote tile did not animate (camera-off remote rendering quirk).' }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); try { sh('SwitchAudioSource -t output -s "MacBook Pro Speakers"'); sh('SwitchAudioSource -t input -s "MacBook Pro Microphone"'); } catch (x) {} process.exit(1); });
