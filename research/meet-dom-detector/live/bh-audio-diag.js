'use strict';
// Audio-path diagnostic: is the guest's speech actually reaching Meet?
// Watches BOTH sides while a clip plays into BlackHole:
//   guest page: mic button label + its OWN QgSmzd widget classes (self meter);
//   host page: the remote (guest) tile's QgSmzd count + full class states.
//   node bh-audio-diag.js
const path = require('path');
const { execSync, spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222, GUEST_PORTS = [9318, 9320, 9321], DEV = 'BlackHole 2ch';
const CLIP = path.join(__dirname, 'audio', 'Alice.wav');
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

const GUEST_SELF = `(function(){
  var mic=[...document.querySelectorAll('button,[role=button]')].find(function(n){return /microphone/i.test(n.getAttribute('aria-label')||'')});
  var ws=[...document.querySelectorAll('[jsname="QgSmzd"]')].map(function(w){return w.className;});
  return JSON.stringify({mic:mic?mic.getAttribute('aria-label'):null, widgets:ws});})()`;
const HOST_REMOTE = `(function(){
  var tiles=[...document.querySelectorAll('[data-participant-id]')].filter(function(t){
    return ((t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim()==='BH Speaker';});
  return JSON.stringify(tiles.map(function(t){
    return {nQg:t.querySelectorAll('[jsname=QgSmzd]').length,
      qgCls:[...t.querySelectorAll('[jsname=QgSmzd]')].map(function(w){return w.className}),
      html:(t.innerHTML||'').length};}));})()`;

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  const restore = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} };
  process.on('exit', restore);

  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  let g = null, gp = null;
  for (const p of GUEST_PORTS) { try { g = await attachToPage(p, /meet\.google\.com/); gp = p; break; } catch (e) {} }
  if (!g) { console.log('NO GUEST PAGE FOUND'); process.exit(1); }
  console.log('guest on :' + gp);
  console.log('guest baseline:', await g.evalJs(GUEST_SELF));
  console.log('host baseline :', await host.evalJs(HOST_REMOTE));

  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`);
  sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);
  const af = spawn('afplay', [CLIP]);
  const t0 = Date.now();
  const done = new Promise((res) => af.on('exit', res));
  while (Date.now() - t0 < 7000 && af.exitCode === null) {
    const gs = await g.evalJs(GUEST_SELF);
    const hs = await host.evalJs(HOST_REMOTE);
    console.log(`t=${((Date.now()-t0)/1000).toFixed(1)} guest=${gs}`);
    console.log(`      host =${hs}`);
    await sleep(700);
  }
  await done; restore();
  console.log('after :', await g.evalJs(GUEST_SELF));
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); try { sh('SwitchAudioSource -t output -s "MacBook Pro Speakers"'); sh('SwitchAudioSource -t input -s "MacBook Pro Microphone"'); } catch (x) {} process.exit(1); });
