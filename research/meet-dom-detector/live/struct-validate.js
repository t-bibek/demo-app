'use strict';
// FINAL page-wide uniqueness validation of the refined TOKEN-FREE equalizer
// predicate, silent vs speaking. The predicate must (a) find every QgSmzd
// equalizer that is visible, (b) find (almost) nothing else, (c) read speaking
// purely from computed animation. Prints per-phase match lists with tile owner.
//   node struct-validate.js
const path = require('path');
const { execSync, spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222, DEV = 'BlackHole 2ch';
const CLIP = path.join(__dirname, 'audio', 'Bob.wav');
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

const SCAN = `(function(){
  function isEq(d){
    if(d.tagName!=='DIV') return false;
    var r=d.getBoundingClientRect();
    if(!(r.width>0&&r.height>0&&r.width<=80&&r.height<=80)) return false;
    var cs=getComputedStyle(d);
    if(cs.display==='none'||cs.visibility==='hidden') return false;
    var kids=[].slice.call(d.children).filter(function(c){return c.tagName==='DIV'});
    if(kids.length<3) return false;
    if(!kids.every(function(k){return k.children.length===0})) return false;
    return kids.every(function(k){var kr=k.getBoundingClientRect();
      return kr.width>0&&kr.width<=12&&kr.height>=kr.width;});
  }
  var hits=[].slice.call(document.querySelectorAll('div')).filter(isEq);
  return JSON.stringify(hits.map(function(d){
    var tile=d.closest('[data-participant-id],[data-requested-participant-id]');
    var name=tile?((tile.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim():null;
    var bars=[].slice.call(d.children).filter(function(c){return c.tagName==='DIV'});
    var speaking=bars.some(function(b){var a=getComputedStyle(b).animationName;return a&&a!=='none'});
    var r=d.getBoundingClientRect();
    return {owner:name, jsname:d.getAttribute('jsname'), wh:[Math.round(r.width),Math.round(r.height)],
      nBars:bars.length, speaking:speaking, cls:(d.className||'').slice(0,45)};}));})()`;

async function scanTimes(host, label, secs, hz) {
  const t0 = Date.now(); const rows = [];
  while ((Date.now() - t0) / 1000 < secs) { rows.push(JSON.parse(await host.evalJs(SCAN))); await sleep(1000 / hz); }
  // summarize: distinct (owner,jsname,wh,speaking) with counts
  const agg = {};
  rows.forEach((r) => r.forEach((h) => { const k = JSON.stringify({ o: h.owner, j: h.jsname, wh: h.wh, sp: h.speaking, n: h.nBars }); agg[k] = (agg[k] || 0) + 1; }));
  console.log(`\n[${label}] ${rows.length} scans; per-scan hit count min/max = ${Math.min(...rows.map(r=>r.length))}/${Math.max(...rows.map(r=>r.length))}`);
  Object.entries(agg).sort((a,b)=>b[1]-a[1]).forEach(([k, c]) => console.log(`  ${c}x ${k}`));
  return rows;
}

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  const restore = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} };
  process.on('exit', restore);
  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);

  await scanTimes(host, 'SILENT', 4, 2);
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);
  const af = spawn('afplay', [CLIP]);
  const p = scanTimes(host, 'SPEAKING', 7, 4);
  await new Promise((res) => af.on('exit', res)); await p; restore();
  await scanTimes(host, 'SILENT-AFTER', 4, 2);
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); try { sh('SwitchAudioSource -t output -s "MacBook Pro Speakers"'); sh('SwitchAudioSource -t input -s "MacBook Pro Microphone"'); } catch (x) {} process.exit(1); });
