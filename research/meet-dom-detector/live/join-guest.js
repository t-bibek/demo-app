'use strict';
// Reusable guest-join: launch a headful guest Chrome whose PINNED Meet mic is
// BlackHole (system input is switched to BlackHole BEFORE the first getUserMedia,
// which is when Meet pins the device), fill the name React-properly, click
// "Ask to join", then run the robust two-step admit (admit-guest.js).
//   node join-guest.js [name] [port]
const fs = require('fs'); const path = require('path');
const { execSync } = require('child_process');
const { launchChrome, attachToPage, sleep } = require('./cdp-lib');
const { admit } = require('./admit-guest');

const NAME = process.argv[2] || 'BH Speaker';
const PORT = +(process.argv[3] || 9318);
// Virtual-mic device. BlackHole 2ch is the default, but its driver loopback can
// WEDGE system-wide (observed 2026-07-03: playback into BlackHole stopped
// arriving at its capture side for every player; only `sudo killall coreaudiod`
// clears it). "Microsoft Teams Audio" is a working drop-in when present.
const DEV = process.env.VIRT_MIC || 'BlackHole 2ch';
const URL = fs.readFileSync(path.join(__dirname, '.meeting-url'), 'utf8').trim();
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

const FILL_NAME = `(function(name){var inp=[...document.querySelectorAll('input')].find(function(i){return (i.type===''||i.type==='text')&&i.offsetParent!==null;});if(!inp)return 'no-input';var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;inp.focus();set.call(inp,name);inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));return 'filled:'+inp.value;})`;
const CLICK = `function(res){for(const s of res){var el=[...document.querySelectorAll('button,[role=button],span')].find(function(n){var t=(n.getAttribute('aria-label')||'')+' '+(n.textContent||'');return new RegExp(s,'i').test(t);});if(el){el.click();return s;}}return null;}`;
const JOIN_BTN = `(function(){var b=[...document.querySelectorAll('button')].find(function(x){var t=(x.getAttribute('aria-label')||'')+' '+(x.textContent||'');return /ask to join|join now/i.test(t)&&!x.disabled;});if(b){b.click();return 'clicked';}return 'no-enabled-btn';})`;

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input');
  // Guest mic must be BlackHole from the FIRST getUserMedia (Meet pins at that
  // point). Input restored after the join; output untouched.
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`);
  const restoreIn = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); } catch (e) {} };
  process.on('exit', restoreIn);

  console.log(`[join] launching guest "${NAME}" on :${PORT} (mic=${DEV})`);
  launchChrome({ port: PORT, headful: true, realMicGrant: true, url: URL, profileTag: 'meet-guest' });
  const g = await attachToPage(PORT, /meet\.google\.com/);

  let asked = false;
  for (let i = 0; i < 40 && !asked; i++) {
    await sleep(2000);
    const f = await g.evalJs(`(${FILL_NAME})(${JSON.stringify(NAME)})`);
    await g.evalJs(`(${CLICK})(['Turn off camera'])`);
    const j = await g.evalJs(`(${JOIN_BTN})()`);
    if (j === 'clicked') asked = true;
    if (i % 3 === 0) console.log(`  t${i * 2}s fill=${f} join=${j}`);
  }
  if (!asked) { console.error('[join] never got an enabled join button'); process.exit(1); }
  console.log('[join] asked to join; running admit flow on the host…');
  const ok = await admit({ guestPorts: [PORT], guestName: NAME, timeoutSec: 90 });
  restoreIn();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(1); });
