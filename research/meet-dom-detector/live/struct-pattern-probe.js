'use strict';
// Structural active-speaker PATTERN probe (no audio needed — uses PIN to force a
// promotion, which is the same layout mechanism auto-layout uses for the speaker).
// Tests the investigative hypotheses against the live host DOM:
//   H1 containment  — does the promoted `.kssMZb` wrapper's tile change?
//   H3 geometry     — does the promoted tile become the largest (>=1.5x)?
//   H4 child-order  — does the `[data-participant-id]` DOM order reshuffle?
//   H2/H5 attrs     — aria-activedescendant / focus, per-tile description/aria,
//                     aria-live region text.
//   node struct-pattern-probe.js
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222;

const SNAP = `(function(){
  function rect(el){var r=el.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];}
  var tiles=[].slice.call(document.querySelectorAll('[data-participant-id]')).filter(function(t){
    return !t.closest('[role=list],[role=listitem],[role=dialog],[role=complementary],aside');});
  var ad=document.activeElement;
  var activeDesc=(document.querySelector('[aria-activedescendant]')||{}).getAttribute
    ? document.querySelector('[aria-activedescendant]').getAttribute('aria-activedescendant') : null;
  var live=[].slice.call(document.querySelectorAll('[aria-live]')).map(function(l){
    return {pol:l.getAttribute('aria-live'), txt:(l.textContent||'').trim().slice(0,60)};}).filter(function(x){return x.txt;});
  var rows=tiles.map(function(t,i){
    var r=rect(t);
    var name=((t.querySelector('span.notranslate,.zWGUib,.XWGOtd')||{}).textContent||'').trim();
    var promotedWrap=t.closest('.kssMZb');
    var eq=[].slice.call(t.querySelectorAll('[jsname=QgSmzd]')).map(function(w){
      var b=[].slice.call(w.children).filter(function(c){return c.tagName==='DIV';});
      return b.length+'bar/'+getComputedStyle(w).display;});
    return {domIdx:i, name:name, pid:(t.getAttribute('data-participant-id')||'').slice(-8),
      rect:r, area:r[2]*r[3], inPromotedKssMZb:!!promotedWrap,
      ariaLabel:t.getAttribute('aria-label'), tabindex:t.getAttribute('tabindex'),
      isActiveEl:t===ad||t.contains(ad), eq:eq};});
  // rank by area
  var byArea=rows.slice().sort(function(a,b){return b.area-a.area;});
  var ratio=byArea.length>=2&&byArea[1].area>0?+(byArea[0].area/byArea[1].area).toFixed(2):null;
  return JSON.stringify({rows:rows, largest:byArea[0]&&byArea[0].name, ratioTop2:ratio,
    activeDescendant:activeDesc, ariaLive:live});
})()`;

// Find + click a tile's pin control (aria-label "Pin <name> to your main screen").
const PIN = `(function(name){
  var btn=[].slice.call(document.querySelectorAll('button,[role=button]')).find(function(b){
    var a=b.getAttribute('aria-label')||''; return new RegExp('^Pin '+name.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&')).test(a)&&b.offsetParent;});
  if(btn){btn.click();return 'pinned:'+name;} return 'no-pin-btn (hover the tile? menu?)';})`;
const UNPIN = `(function(){
  var btn=[].slice.call(document.querySelectorAll('button,[role=button]')).find(function(b){
    return /^Unpin\\b/.test(b.getAttribute('aria-label')||'')&&b.offsetParent;});
  if(btn){btn.click();return 'unpinned';} return 'no-unpin';})`;
// Some builds surface pin via the tile's "More options" menu.
const PIN_VIA_MENU = `(async function(name){
  var more=[].slice.call(document.querySelectorAll('button,[role=button]')).find(function(b){
    return new RegExp('More options for '+name).test(b.getAttribute('aria-label')||'')&&b.offsetParent;});
  if(!more)return 'no-more-btn';
  more.click(); await new Promise(function(r){setTimeout(r,600);});
  var item=[].slice.call(document.querySelectorAll('[role=menuitem],[role=menuitemcheckbox],li,button')).find(function(m){
    return /pin/i.test((m.textContent||''))&&m.offsetParent;});
  if(item){item.click();return 'pinned-via-menu';}
  document.body.click(); return 'no-pin-menuitem';})`;

function table(label, snap) {
  console.log(`\n===== ${label} =====`);
  console.log(`largest=${snap.largest}  top2ratio=${snap.ratioTop2}  activeDescendant=${snap.activeDescendant}  ariaLive=${JSON.stringify(snap.ariaLive)}`);
  console.log('dom  name          pid       x    y     w    h    area    inKssMZb activeEl  eq');
  snap.rows.forEach(function (r) {
    console.log(
      (r.domIdx + '').padEnd(5) + (r.name || '?').padEnd(14) + r.pid.padEnd(10) +
      (r.rect[0] + '').padStart(5) + (r.rect[1] + '').padStart(6) + (r.rect[2] + '').padStart(6) + (r.rect[3] + '').padStart(5) +
      (r.area + '').padStart(8) + '   ' + (r.inPromotedKssMZb ? 'YES' : '-  ').padEnd(7) + (r.isActiveEl ? 'ACTIVE' : '-   ').padEnd(8) + ' ' + JSON.stringify(r.eq));
  });
}

async function main() {
  const h = await attachToPage(HOST_PORT, /meet\.google\.com/);
  const base = JSON.parse(await h.evalJs(SNAP));
  table('BASELINE (gallery, no pin)', base);

  // pick a NON-self remote to pin (self won't demonstrate the remote-promotion case)
  const target = base.rows.find(function (r) { return r.eq.some(function (e) { return e.indexOf('3bar') === 0; }); }) || base.rows[0];
  const nm = target.name;
  console.log(`\n[pin] promoting "${nm}" …`);
  let res = await h.evalJs(`(${PIN})(${JSON.stringify(nm)})`);
  if (/no-pin-btn/.test(res)) res = await h.evalJs(`(${PIN_VIA_MENU})(${JSON.stringify(nm)})`);
  console.log('[pin] ' + res);
  await sleep(2500);
  const pinned = JSON.parse(await h.evalJs(SNAP));
  table(`AFTER PIN "${nm}"`, pinned);

  console.log('\n[unpin] restoring gallery …', await h.evalJs(`(${UNPIN})()`));
  await sleep(1500);

  // ---- verdicts ----
  const movedContainment = base.rows.filter(function (r) { return r.inPromotedKssMZb; }).map(function (r) { return r.name; }).join(',')
    !== pinned.rows.filter(function (r) { return r.inPromotedKssMZb; }).map(function (r) { return r.name; }).join(',');
  const geomPromoted = pinned.largest === nm && pinned.ratioTop2 && pinned.ratioTop2 >= 1.5;
  const orderChanged = base.rows.map(function (r) { return r.pid; }).join(',') !== pinned.rows.map(function (r) { return r.pid; }).join(',');
  console.log('\n===== HYPOTHESIS VERDICTS (pin as a promotion proxy) =====');
  console.log(JSON.stringify({
    H1_kssMZb_containment_moves_to_promoted: movedContainment,
    H3_geometry_promoted_tile_is_largest_1p5x: !!geomPromoted,
    H4_dom_participant_order_reshuffles: orderChanged,
    pinned_target: nm,
    pinned_largest: pinned.largest, pinned_ratio: pinned.ratioTop2,
    kssMZb_before: base.rows.filter(function (r) { return r.inPromotedKssMZb; }).map(function (r) { return r.name; }),
    kssMZb_after: pinned.rows.filter(function (r) { return r.inPromotedKssMZb; }).map(function (r) { return r.name; }),
  }, null, 2));
  process.exit(0);
}
main().catch(function (e) { console.error('ERROR', e.stack || e); process.exit(1); });
