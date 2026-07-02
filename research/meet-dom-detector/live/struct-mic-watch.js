'use strict';
// Watch the IN-TILE QgSmzd widget (DYfzY variant) materialize as the mic toggles:
// snapshots its childCount/rect/classes/animation every 500ms through a
// muted -> unmuted -> muted cycle. Token-free goal: learn WHAT structure appears.
//   node struct-mic-watch.js
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222;

const CLICK_MIC = `(function(want){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){return new RegExp(want,'i').test(n.getAttribute('aria-label')||'')});if(b){b.click();return b.getAttribute('aria-label')}return null})`;
const SNAP = `(function(){
  function rect(el){var r=el.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];}
  return [].slice.call(document.querySelectorAll('[data-participant-id]')).map(function(t){
    var ws=[].slice.call(t.querySelectorAll('[jsname="QgSmzd"]'));
    return {tileWidgets:ws.map(function(w){var cs=getComputedStyle(w);
      return {cls:w.className, rect:rect(w), display:cs.display, nKids:w.children.length,
        kids:[].slice.call(w.children).map(function(k){var kc=getComputedStyle(k);
          return {tag:k.tagName.toLowerCase(), cls:k.className, rect:rect(k), anim:kc.animationName, dur:kc.animationDuration};}),
        anim:cs.animationName};}),
      // ALSO: any div in the tile that is small & has >=2 leaf-div kids (loose net)
      loose:[].slice.call(t.querySelectorAll('div')).filter(function(d){
        var r=d.getBoundingClientRect(); if(r.width===0||r.width>60||r.height===0||r.height>60) return false;
        var kids=[].slice.call(d.children).filter(function(c){return c.tagName==='DIV'});
        return kids.length>=2 && kids.every(function(k){return k.children.length===0});})
        .map(function(d){var cs=getComputedStyle(d);return {cls:d.className, jsname:d.getAttribute('jsname'), rect:rect(d),
          nKids:d.children.length, kidAnims:[].slice.call(d.children).map(function(k){return getComputedStyle(k).animationName;})};})
    };});})()`;

async function snapLine(host, t) {
  const s = JSON.parse((await host.evalJs(`JSON.stringify(${SNAP})`)) || '[]');
  console.log(`t=${t}s ` + JSON.stringify(s));
}
async function main() {
  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  console.log('== baseline (muted?) ==');
  console.log('mic:', await host.evalJs(`(${CLICK_MIC})('ZZZ_no_match')`)); // just read
  await snapLine(host, 0);
  console.log('== UNMUTE ==');
  console.log('clicked:', await host.evalJs(`(${CLICK_MIC})('Turn on microphone')`));
  for (let i = 1; i <= 8; i++) { await sleep(700); await snapLine(host, i); }
  console.log('== MUTE again ==');
  console.log('clicked:', await host.evalJs(`(${CLICK_MIC})('Turn off microphone')`));
  for (let i = 9; i <= 12; i++) { await sleep(700); await snapLine(host, i); }
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(1); });
