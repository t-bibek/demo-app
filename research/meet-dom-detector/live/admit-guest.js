'use strict';
// Robust, reusable ADMIT flow for the live rig (runbook §2 step 4, gotchas #3/#6).
// Clicks with REAL CDP mouse events (el.click() no-ops on Meet controls) and
// verifies success on VIDEO TILES, not People-panel rows (rows also carry
// data-participant-id — a naive name check false-positives the moment the
// People panel opens).
//
// Steps, looped until admitted or timeout:
//   1. toast "Admit"/"Admit 1 guest"    -> CDP click
//   2. dialog/panel row  [jsname=OYykWd] (aria "Admit <name>") -> CDP click
//   3. success = guest page left the "asking to be let in" state AND the host
//      has a REAL video tile for the guest (in the main stage, not the panel).
//   node admit-guest.js [guestName]
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222, GUEST_PORTS = [9318, 9320, 9321];
const GUEST = process.argv[2] || 'BH Speaker';

async function cdpClick(page, x, y) {
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
}

// Real video tiles: data-participant-id elements OUTSIDE any list/dialog/aside
// container, big enough to be a stage tile (People rows are ~48px tall).
const HOST_TILES = `(function(){
  return JSON.stringify([...document.querySelectorAll('[data-participant-id]')].filter(function(t){
    if(t.closest('[role=list],[role=listitem],[role=dialog],[role=complementary],aside')) return false;
    var r=t.getBoundingClientRect(); return r.width>=150 && r.height>=84;
  }).map(function(t){
    return {name:((t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim(),
      w:Math.round(t.getBoundingClientRect().width), h:Math.round(t.getBoundingClientRect().height)};}));})()`;

const ADMIT_TARGET = `(function(){
  function ctr(e){var r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width};}
  // 1) People-panel / dialog row button first (the authoritative one)
  var oyy=[...document.querySelectorAll('[jsname=OYykWd]')].find(function(e){return e.offsetParent&&e.getBoundingClientRect().width>0;});
  if(oyy) return JSON.stringify(Object.assign({what:'row:'+(oyy.getAttribute('aria-label')||'')},ctr(oyy)));
  // 2) any visible clickable whose OWN text or aria says Admit (toast chip, dialog button)
  var els=[...document.querySelectorAll('button,[role=button],div,span')].filter(function(e){
    if(!e.offsetParent) return false;
    var own=[].filter.call(e.childNodes,function(n){return n.nodeType===3}).map(function(n){return n.textContent}).join('');
    return /\\badmit\\b/i.test((e.getAttribute('aria-label')||'')+' '+own);});
  if(els.length){var e=els[0];return JSON.stringify(Object.assign({what:e.tagName+':'+((e.getAttribute('aria-label')||e.textContent)||'').trim().slice(0,50)},ctr(e)));}
  return 'null';})()`;

const GUEST_STATE = `(function(){
  var waiting=/asking to be let in|asking to join/i.test(document.body.textContent||'');
  var inCall=!![...document.querySelectorAll('button')].find(function(b){return /leave call/i.test(b.getAttribute('aria-label')||'')});
  return JSON.stringify({waiting:waiting,inCall:inCall});})()`;

async function admit({ hostPort = HOST_PORT, guestPorts = GUEST_PORTS, guestName = GUEST, timeoutSec = 60, log = console.log } = {}) {
  const host = await attachToPage(hostPort, /meet\.google\.com/);
  let guest = null;
  for (const p of guestPorts) { try { guest = await attachToPage(p, /meet\.google\.com/); log(`[admit] guest page on :${p}`); break; } catch (e) {} }

  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    const tiles = JSON.parse(await host.evalJs(HOST_TILES));
    const gstate = guest ? JSON.parse(await guest.evalJs(GUEST_STATE)) : null;
    const admitted = tiles.some((t) => t.name === guestName) && (!gstate || !gstate.waiting);
    log(`[admit] tiles=${JSON.stringify(tiles.map((t) => t.name))} guest=${JSON.stringify(gstate)}`);
    if (admitted) { log(`[admit] ✅ "${guestName}" ADMITTED (video tile present, guest out of waiting state)`); return true; }
    const target = JSON.parse(await host.evalJs(ADMIT_TARGET));
    if (target) { log(`[admit] clicking ${target.what}`); await cdpClick(host, target.x, target.y); }
    await sleep(1500);
  }
  log(`[admit] ❌ timed out after ${timeoutSec}s`);
  return false;
}

if (require.main === module) {
  admit().then((ok) => process.exit(ok ? 0 : 1))
    .catch((e) => { console.error('ERROR', e.stack || e); process.exit(1); });
}
module.exports = { admit };
