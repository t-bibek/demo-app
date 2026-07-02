'use strict';
// DEEP anatomy of every speaking-indicator candidate on the live Meet page —
// built to derive a TOKEN-FREE structural signature. Dumps, page-wide:
//   1. every [jsname="QgSmzd"] node: rect, computed styles, children, ancestor
//      chain up to the participant tile (tags/rects only, no class reliance);
//   2. every @keyframes rule whose name smells like an audio meter;
//   3. every div matching the CURRENT structural predicate (>=3 tiny leaf divs)
//      so false positives are visible;
//   4. sibling/parent context of each indicator (what structurally surrounds it).
//   node struct-anatomy.js
const { attachToPage } = require('./cdp-lib');
const HOST_PORT = 9222;

const PROBE = `(function(){
  function rect(el){var r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};}
  function brief(el){ if(!el||!el.tagName) return null; return {tag:el.tagName.toLowerCase(), jsname:el.getAttribute('jsname'),
      cls:(el.className&&el.className.baseVal!==undefined?el.className.baseVal:el.className)||'', rect:rect(el), nKids:el.children.length}; }
  function deep(el, depth){ if(!el) return null; var cs=getComputedStyle(el);
    var o={tag:el.tagName.toLowerCase(), jsname:el.getAttribute('jsname'), jscontroller:el.getAttribute('jscontroller'),
      role:el.getAttribute('role'), aria:el.getAttribute('aria-label'), cls:el.className||'',
      rect:rect(el), display:cs.display, position:cs.position, borderRadius:cs.borderRadius,
      background:cs.backgroundColor, animationName:cs.animationName, animationDuration:cs.animationDuration,
      transform:cs.transform, overflow:cs.overflow, clipPath:cs.clipPath==='none'?undefined:cs.clipPath};
    if(depth>0) o.children=[].slice.call(el.children).map(function(c){return deep(c,depth-1);});
    else o.nKids=el.children.length;
    return o; }
  function chainToTile(el){ var out=[],cur=el.parentElement,hop=0;
    while(cur&&hop<12){ out.push(brief(cur));
      if(cur.hasAttribute('data-participant-id')||cur.hasAttribute('data-requested-participant-id')) break;
      cur=cur.parentElement;hop++; }
    return out; }

  // 1) all QgSmzd, everywhere
  var q=[].slice.call(document.querySelectorAll('[jsname="QgSmzd"]')).map(function(el){
    return {node:deep(el,2), chainToTile:chainToTile(el),
      siblings:[].slice.call(el.parentElement?el.parentElement.children:[]).map(brief)};});

  // 2) audio-meter-ish keyframes available in CSS
  var kf=[];
  try{ [].slice.call(document.styleSheets).forEach(function(ss){ var rules; try{rules=ss.cssRules;}catch(e){return;}
    [].slice.call(rules||[]).forEach(function(r){ if(r.type===7) kf.push(r.name); }); }); }catch(e){}
  var meterish=kf.filter(function(n){return /jiggle|stripe|bar|audio|sound|meter|pulse|halo|wave/i.test(n);});

  // 3) current structural predicate, page-wide (false-positive scan)
  var structHits=[].slice.call(document.querySelectorAll('div')).filter(function(d){
    var kids=[].slice.call(d.children).filter(function(c){return c.tagName==='DIV';});
    if(kids.length<3) return false;
    return kids.every(function(k){return k.children.length===0 && k.getBoundingClientRect().width<12;});
  }).map(function(d){return {node:brief(d), inTile:!!(d.closest&&d.closest('[data-participant-id]')), jsname:d.getAttribute('jsname')};});

  // 4) tiles overview
  var tiles=[].slice.call(document.querySelectorAll('[data-participant-id]')).map(function(t){
    return {rect:rect(t), pid:(t.getAttribute('data-participant-id')||'').slice(0,20),
      nQgSmzd:t.querySelectorAll('[jsname=\\'QgSmzd\\']').length,
      name:((t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim()};});

  return {url:location.href, nTiles:tiles.length, tiles:tiles,
    qgsmzd_count:q.length, qgsmzd:q,
    keyframes_total:kf.length, keyframes_meterish:meterish,
    struct_predicate_hits:structHits.length, struct_hits:structHits};
})()`;

async function main() {
  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  const out = JSON.parse((await host.evalJs(`JSON.stringify(${PROBE})`)) || 'null');
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(1); });
