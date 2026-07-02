'use strict';
// Deep, CLASS-INDEPENDENT structural probe of the live Meet DOM. For each
// participant tile, dumps the structural anatomy of the speaking indicator —
// tag/role/aria/jsname/jscontroller, child-bar count, and the COMPUTED
// animationName / background of the bars (the rotation-proof speaking signal) —
// so we can anchor on STRUCTURE instead of obfuscated class names.
//   node struct-probe.js
const { attachToPage } = require('./cdp-lib');
const HOST_PORT = 9222;

const PROBE = `(function(){
  function sig(el){ if(!el) return null; var cs=getComputedStyle(el);
    return {tag:el.tagName.toLowerCase(), jsname:el.getAttribute('jsname'),
      jscontroller:el.getAttribute('jscontroller'), role:el.getAttribute('role'),
      aria:el.getAttribute('aria-label'), dataAttrs:[].slice.call(el.attributes).map(function(a){return a.name}).filter(function(n){return n.indexOf('data-')===0}),
      nChildDiv:[].slice.call(el.children).filter(function(c){return c.tagName==='DIV'}).length,
      animationName:cs.animationName, animationPlay:cs.animationPlayState,
      bgPos:cs.backgroundPositionX, classes:el.className}; }
  return [].slice.call(document.querySelectorAll('[data-participant-id]')).map(function(t){
    var name=(t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent;
    // candidate indicator: jsname=QgSmzd, else any descendant div that has >=3 tiny div children (equalizer)
    var byName=t.querySelector('[jsname="QgSmzd"]');
    var byStruct=[].slice.call(t.querySelectorAll('div')).find(function(d){
      var kids=[].slice.call(d.children).filter(function(c){return c.tagName==='DIV'});
      return kids.length>=3 && kids.every(function(k){return k.getBoundingClientRect().width<12 && k.children.length===0});});
    var ind=byName||byStruct;
    var bars=ind?[].slice.call(ind.children).filter(function(c){return c.tagName==='DIV'}):[];
    return {
      name:(name||'').trim(),
      tile:{tag:t.tagName.toLowerCase(), role:t.getAttribute('role'), aria:t.getAttribute('aria-label')},
      indicator_found_via: ind? (byName?'jsname=QgSmzd':'structure(>=3 tiny bar divs)') : 'NOT FOUND',
      indicator: sig(ind),
      bars_animationName: bars.map(function(b){return getComputedStyle(b).animationName}),
      bars_anyAnimating: bars.some(function(b){var a=getComputedStyle(b);return a.animationName!=='none'&&a.animationPlayState!=='paused'}),
      hasKssMZb: !!t.querySelector('.kssMZb')
    };});})()`;

async function main() {
  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  const n = await host.evalJs(`document.querySelectorAll('[data-participant-id]').length`);
  console.log(`participants (data-participant-id tiles): ${n}\n`);
  const probe = JSON.parse((await host.evalJs(`JSON.stringify(${PROBE})`)) || '[]');
  console.log(JSON.stringify(probe, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(1); });
