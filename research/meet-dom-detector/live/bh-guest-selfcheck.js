'use strict';
// Decisive diagnostic: is the BlackHole speech reaching the GUEST's Meet mic and
// being recognized? Probe the GUEST's OWN page (its self mic indicator + any
// QgSmzd bar animation) while a clip plays. If the guest's own indicator animates,
// audio+recognition works and the host-side remote tile just isn't rendering the
// equalizer (camera-off). If not, the audio isn't reaching Meet's mic pipeline.
//   node bh-guest-selfcheck.js
const path = require('path'); const { execSync, spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');
const GUEST_PORT = 9318, DEV = 'BlackHole 2ch';
const CLIP = path.join(__dirname, 'audio', 'Alice.wav');
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

// All QgSmzd indicators on this page + their bar animation state.
const SELF = `(function(){var inds=[...document.querySelectorAll('[jsname="QgSmzd"]')];return inds.map(function(ind){var bars=[...ind.children].filter(function(c){return c.tagName==='DIV'});return {jsctrl:ind.getAttribute('jscontroller'),nBars:bars.length,anim:bars.map(function(b){return getComputedStyle(b).animationName}),anyAnim:bars.some(function(b){var a=getComputedStyle(b).animationName;return a&&a!=='none'}),cls:ind.className.split(' ').slice(0,3)};});})`;

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  process.on('exit', () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} });
  const g = await attachToPage(GUEST_PORT, /meet\.google\.com/);

  // ensure unmuted (real click via a quick helper)
  const info = await g.evalJs(`(function(){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){return /turn on microphone/i.test(n.getAttribute('aria-label')||'')});if(!b)return null;var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  if (info) { await g.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 }); await g.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 }); await sleep(800); }
  console.log('[guest] mic:', await g.evalJs(`(function(){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){return /microphone/i.test(n.getAttribute('aria-label')||'')});return b?b.getAttribute('aria-label'):null;})()`));

  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);
  console.log('[guest] self indicators BEFORE audio:', await g.evalJs(`JSON.stringify((${SELF})())`));

  console.log('[playing] Alice.wav x3 into BlackHole; watching the GUEST self indicator…');
  for (let i = 0; i < 3; i++) spawn('afplay', [CLIP]);
  let anyAnimSeen = false;
  for (let i = 0; i < 12; i++) { const s = JSON.parse(await g.evalJs(`JSON.stringify((${SELF})())`)); const anim = s.some(function (x) { return x.anyAnim; }); if (anim) { anyAnimSeen = true; console.log(`  t${(i*0.7).toFixed(1)}s SELF ANIMATING:`, JSON.stringify(s)); break; } await sleep(700); }
  if (!anyAnimSeen) console.log('  (no self-indicator animation observed during playback)');

  sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`);
  console.log('\n===== verdict =====\n' + JSON.stringify({
    guest_self_indicator_animated: anyAnimSeen,
    meaning: anyAnimSeen ? 'Audio REACHES Meet + is recognized as speech (guest self meter moved). The host-side REMOTE tile not rendering the equalizer is the camera-off rendering quirk — give the guest a camera (or read the roster/geometry for remotes).'
                         : 'Audio is NOT reaching Meet\'s mic pipeline (guest self meter never moved) — the guest\'s Meet mic is not the BlackHole device. Fix the device binding (re-join with BlackHole as default input).',
  }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); try { sh('SwitchAudioSource -t output -s "MacBook Pro Speakers"'); sh('SwitchAudioSource -t input -s "MacBook Pro Microphone"'); } catch (x) {} process.exit(1); });
