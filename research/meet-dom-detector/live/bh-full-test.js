'use strict';
// End-to-end live turn-wise test with recognized speech via BlackHole, with a
// RELIABLE guest join (React-proper name entry so "Ask to join" enables) and
// DISTINCT-participant detection (by name, since the self tile duplicates pids).
//   node bh-full-test.js
const fs = require('fs'); const path = require('path');
const { execSync, spawn } = require('child_process');
const { launchChrome, attachToPage, sleep } = require('./cdp-lib');

const HOST_PORT = 9222, GUEST_PORT = 9318, DEV = 'BlackHole 2ch';
const URL = fs.readFileSync(path.join(__dirname, '.meeting-url'), 'utf8').trim();
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const CLIPS = ['Alice', 'Bob', 'Carol'].map((n) => path.join(__dirname, 'audio', n + '.wav'));
const GUEST = 'BH Speaker';
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

const CLICK = `function(res){for(const s of res){var el=[...document.querySelectorAll('button,[role=button],span')].find(function(n){var t=(n.getAttribute('aria-label')||'')+' '+(n.textContent||'');return new RegExp(s,'i').test(t);});if(el){el.click();return s;}}return null;}`;
const FILL_NAME = `(function(name){var inp=[...document.querySelectorAll('input')].find(function(i){return (i.type===''||i.type==='text')&&i.offsetParent!==null;});if(!inp)return 'no-input';var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;inp.focus();set.call(inp,name);inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));return 'filled:'+inp.value;})`;
const JOIN_BTN = `(function(){var b=[...document.querySelectorAll('button')].find(function(x){var t=(x.getAttribute('aria-label')||'')+' '+(x.textContent||'');return /ask to join|join now/i.test(t)&&!x.disabled;});if(b){b.click();return 'clicked';}return 'no-enabled-btn';})`;
const NAMES = `(function(){return [...new Set([...document.querySelectorAll('[data-participant-id]')].map(function(t){return ((t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim();}).filter(Boolean))];})`;
// speaking state of a NAMED tile via the class-independent bar-animation read
const SPEAKING_OF = `(function(name){var tiles=[...document.querySelectorAll('[data-participant-id]')].filter(function(t){return ((t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim()===name;});return tiles.some(function(t){var ind=t.querySelector('[jsname="QgSmzd"]');var bars=ind?[...ind.children].filter(function(c){return c.tagName==='DIV'}):[];return bars.some(function(b){var a=getComputedStyle(b).animationName;return a&&a!=='none'});});})`;

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  const restore = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} };
  process.on('exit', restore); process.on('SIGINT', () => { restore(); process.exit(1); });

  // Guest's mic must be BlackHole from the first getUserMedia -> set INPUT now
  // (leave OUTPUT on speakers so you still hear during the join).
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`);

  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  const hostName = JSON.parse(await host.evalJs(`JSON.stringify((${NAMES})())`))[0];
  console.log(`[host] "${hostName}" — launching guest "${GUEST}" (mic=${DEV}).`);
  console.log('>>> In the GUEST window click "Ask to join" if it doesn\'t auto-advance; in the HOST window click "Admit".');

  const guest = launchChrome({ port: GUEST_PORT, headful: true, realMicGrant: true, url: URL, profileTag: 'meet-guest' });
  const g = await attachToPage(GUEST_PORT, /meet\.google\.com/);

  let names = [hostName];
  for (let i = 0; i < 50 && !names.includes(GUEST); i++) {
    await sleep(2000);
    const f = await g.evalJs(`(${FILL_NAME})(${JSON.stringify(GUEST)})`);
    await g.evalJs(`(${CLICK})(['Turn off camera'])`);
    const j = await g.evalJs(`(${JOIN_BTN})()`);
    await host.evalJs(`(${CLICK})(['^Admit$','Admit'])`);
    names = JSON.parse(await host.evalJs(`JSON.stringify((${NAMES})())`));
    if (i % 3 === 0) console.log(`  t${i*2}s guestFill=${f} join=${j} | host sees: ${JSON.stringify(names)}`);
  }
  if (!names.includes(GUEST)) { console.error(`[!] "${GUEST}" never joined. Guest left open on :${GUEST_PORT}; click Ask to join + Admit, then re-run.`); process.exit(1); }
  console.log(`[joined] participants: ${JSON.stringify(names)}`);

  // Now measure. Mute host, inject detector, route OUTPUT to BlackHole for afplay.
  await host.evalJs(`(${CLICK})(['Turn off microphone'])`);
  await host.evalJs(DETECTOR); await host.evalJs('window.__ctx={vad:true}');
  sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);
  console.log(`\n[live] turn-wise speech for "${GUEST}":`);
  const results = [];
  for (const clip of CLIPS) {
    const label = path.basename(clip, '.wav');
    const af = spawn('afplay', [clip]);
    let sp = 0, n = 0; const t0 = Date.now();
    await new Promise((res) => { af.on('exit', res); (async () => { while (!af.killed && Date.now() - t0 < 9000) { if (await host.evalJs(`(${SPEAKING_OF})(${JSON.stringify(GUEST)})`)) sp++; n++; await sleep(600); } })(); });
    await sleep(400);
    let sil = 0, sn = 0; const s0 = Date.now();
    while (Date.now() - s0 < 3000) { if (!(await host.evalJs(`(${SPEAKING_OF})(${JSON.stringify(GUEST)})`))) sil++; sn++; await sleep(600); }
    const row = { clip: label, speaking_during_playback: +(n ? sp / n : 0).toFixed(2), silent_during_gap: +(sn ? sil / sn : 0).toFixed(2) };
    results.push(row); console.log('  ' + JSON.stringify(row));
  }
  restore();
  const ok = results.every((r) => r.speaking_during_playback > 0.4 && r.silent_during_gap > 0.5);
  console.log('\n===== verdict =====\n' + JSON.stringify({ live_turnwise_tracking: ok, guest: GUEST, per_clip: results,
    conclusion: ok ? 'CONFIRMED LIVE: the class-independent structural detector tracks the guest speaking during each real-speech utterance and silent in the gaps.'
                   : 'guest present but speech not detected — verify the guest mic is BlackHole and unmuted in Meet.' }, null, 2));
  console.log('\n[note] guest left running on :' + GUEST_PORT + ' (pkill -f meet-guest to remove).');
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); try { sh('SwitchAudioSource -t output -s "MacBook Pro Speakers"'); sh('SwitchAudioSource -t input -s "MacBook Pro Microphone"'); } catch (x) {} process.exit(1); });
