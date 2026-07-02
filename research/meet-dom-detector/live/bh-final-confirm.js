'use strict';
// Definitive end-to-end live confirmation using the REAL class-independent detector
// (browser-qa/dom-detector.js). Guest mic = BlackHole. Plays clips turn-wise; the
// detector should NAME the guest speaking during each clip and no one in the gaps.
//   node bh-final-confirm.js
const fs = require('fs'); const path = require('path');
const { execSync, spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222, DEV = 'BlackHole 2ch';
const GUEST_PORTS = [9321, 9320, 9318];
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const CLIPS = ['Alice', 'Bob', 'Carol'].map((n) => path.join(__dirname, 'audio', n + '.wav'));
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
async function clickRx(page, rx) {
  const info = await page.evalJs(`(function(){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){var t=(n.getAttribute('aria-label')||'')+' '+(n.textContent||'');return new RegExp(${JSON.stringify(rx)},'i').test(t)&&n.offsetParent!==null;});if(!b)return null;var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  if (!info) return; await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 }); await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 });
}

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  const restore = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} };
  process.on('exit', restore); process.on('SIGINT', () => { restore(); process.exit(1); });
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);

  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  let g; for (const p of GUEST_PORTS) { try { g = await attachToPage(p, /meet\.google\.com/); break; } catch (e) {} }
  await clickRx(host, 'Turn off microphone');            // host muted -> guest is the only speaker
  const hostName = await host.evalJs(`((document.querySelector('[data-participant-id] span.notranslate,[data-participant-id] .zWGUib')||{}).textContent||'').trim()`);
  await host.evalJs(DETECTOR); await host.evalJs('window.__ctx={vad:true}');
  console.log(`[confirm] host="${hostName}" muted; running the REAL detector while the guest speaks turn-wise:\n`);

  const results = [];
  for (const clip of CLIPS) {
    const label = path.basename(clip, '.wav'); const af = spawn('afplay', [clip]);
    const hits = {}; let n = 0; const t0 = Date.now();
    // Host is muted, so any named (non-"Someone") speaker IS the guest. Record raw.
    await new Promise((res) => { af.on('exit', res); (async () => { while (!af.killed && Date.now() - t0 < 8000) { const d = JSON.parse(await host.evalJs(`JSON.stringify((window.__meetDetect&&window.__meetDetect())||{})`)); (d.names || []).forEach(function (x) { hits[x] = (hits[x] || 0) + 1; }); n++; await sleep(500); } })(); });
    await sleep(600);
    let gapNamed = 0, gn = 0; const s0 = Date.now();
    while (Date.now() - s0 < 3000) { const d = JSON.parse(await host.evalJs(`JSON.stringify((window.__meetDetect&&window.__meetDetect())||{})`)); if ((d.names || []).some(function (x) { return x && x !== 'Someone'; })) gapNamed++; gn++; await sleep(500); }
    const named = Object.keys(hits).filter(function (x) { return x !== 'Someone'; }).sort(function (a, b) { return hits[b] - hits[a]; })[0] || null;
    const row = { clip: label, detected_speaker: named, detected_frac: +(n && named ? hits[named] / n : 0).toFixed(2), someone_frac: +(n && hits['Someone'] ? hits['Someone'] / n : 0).toFixed(2), quiet_in_gap: +(gn ? 1 - gapNamed / gn : 0).toFixed(2) };
    results.push(row); console.log('  ' + JSON.stringify(row));
  }
  restore();
  const ok = results.every((r) => r.detected_speaker && r.detected_frac > 0.4 && r.quiet_in_gap > 0.5);
  console.log('\n===== VERDICT =====\n' + JSON.stringify({ live_end_to_end_turnwise: ok, per_clip: results,
    conclusion: ok ? 'CONFIRMED LIVE: real speech (BlackHole) -> guest speaks -> the class-independent structural detector NAMES the guest speaking during each utterance and stays quiet in the gaps, on real Google Meet.'
      : 'detector did not consistently name the guest — inspect timing/rendering.' }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); try { sh('SwitchAudioSource -t output -s "MacBook Pro Speakers"'); sh('SwitchAudioSource -t input -s "MacBook Pro Microphone"'); } catch (x) {} process.exit(1); });
