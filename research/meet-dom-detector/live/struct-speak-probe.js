'use strict';
// THE structure-discovery run: with a BlackHole guest in the call, play speech
// clips and snapshot the GUEST tile's full indicator anatomy at ~4Hz — silent,
// then speaking, then silent — so the token-free structural signature can be
// derived from a real remote speaker (the case the product needs).
// Assumes: guest already joined (bh-full-test.js) and its Meet mic is BlackHole.
//   node struct-speak-probe.js [guestName]
const path = require('path');
const { execSync, spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222, DEV = 'BlackHole 2ch';
const GUEST = process.argv[2] || 'BH Speaker';
const CLIP = path.join(__dirname, 'audio', 'Alice.wav');
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

// Per snapshot: for EVERY tile, every QgSmzd widget AND every token-free
// structural candidate (visible small div with >=2 leaf-div kids), with computed
// animation state. Token-free candidacy is deliberately LOOSE here — this run is
// for learning what uniquely identifies the equalizer.
const SNAP = `(function(){
  function rect(el){var r=el.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];}
  function wsig(w){var cs=getComputedStyle(w);
    return {cls:w.className, jsname:w.getAttribute('jsname'), rect:rect(w), display:cs.display,
      pos:cs.position, br:cs.borderRadius, nKids:w.children.length,
      kids:[].slice.call(w.children).map(function(k){var kc=getComputedStyle(k);
        return {t:k.tagName.toLowerCase(), cls:k.className, rect:rect(k), anim:kc.animationName, dur:kc.animationDuration, play:kc.animationPlayState};}),
      anim:cs.animationName};}
  return [].slice.call(document.querySelectorAll('[data-participant-id]')).map(function(t){
    var name=((t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim();
    var qg=[].slice.call(t.querySelectorAll('[jsname="QgSmzd"]')).map(wsig);
    var structural=[].slice.call(t.querySelectorAll('div')).filter(function(d){
      var r=d.getBoundingClientRect(); if(r.width===0||r.height===0||r.width>80||r.height>80) return false;
      if(getComputedStyle(d).display==='none') return false;
      var kids=[].slice.call(d.children).filter(function(c){return c.tagName==='DIV'});
      return kids.length>=2 && kids.every(function(k){return k.children.length===0});})
      .map(wsig);
    return {name:name, tileRect:rect(t), qgsmzd:qg, structuralCandidates:structural};});})()`;

async function series(host, label, secs, hz) {
  const out = []; const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < secs) {
    out.push({ t: +((Date.now() - t0) / 1000).toFixed(1), snap: JSON.parse((await host.evalJs(`JSON.stringify(${SNAP})`)) || '[]') });
    await sleep(1000 / hz);
  }
  return { label, series: out };
}

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  const restore = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} };
  process.on('exit', restore); process.on('SIGINT', () => { restore(); process.exit(1); });

  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  const phases = [];
  phases.push(await series(host, 'SILENT-BEFORE', 4, 2));

  // route afplay -> BlackHole -> guest mic
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`);
  sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);
  const af = spawn('afplay', [CLIP]);
  const speak = series(host, 'SPEAKING', 7, 4);
  await new Promise((res) => af.on('exit', res));
  phases.push(await speak);
  restore();
  phases.push(await series(host, 'SILENT-AFTER', 4, 2));

  console.log(JSON.stringify(phases, null, 1));
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); try { sh('SwitchAudioSource -t output -s "MacBook Pro Speakers"'); sh('SwitchAudioSource -t input -s "MacBook Pro Microphone"'); } catch (x) {} process.exit(1); });
