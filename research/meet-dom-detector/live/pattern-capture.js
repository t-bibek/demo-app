'use strict';
// Capture the PARTICIPANT-TILE ROWS across many layout STATES, each to its own
// file, so a human can diff them for an active-speaker / promotion pattern.
// Drives the live host via CDP (no audio → no echo): baseline, pin each
// participant (pin == the same promotion the auto-layout applies to a speaker),
// and each built-in layout (Auto/Tiled/Spotlight/Sidebar) if reachable.
// Writes: pattern-dumps/<ts>/<state>.json  (full rows)
//         pattern-dumps/<ts>/ALL.txt       (stacked readable tables)
//   node pattern-capture.js
const fs = require('fs'); const path = require('path');
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222;

const SNAP = `(function(){
  function rect(el){var r=el.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];}
  var tiles=[].slice.call(document.querySelectorAll('[data-participant-id]')).filter(function(t){
    return !t.closest('[role=list],[role=listitem],[role=dialog],[role=complementary],aside');});
  var live=[].slice.call(document.querySelectorAll('[aria-live]')).map(function(l){
    return {pol:l.getAttribute('aria-live'), txt:(l.textContent||'').trim().slice(0,80)};}).filter(function(x){return x.txt;});
  var presenting=!!document.querySelector('[data-is-presentation],[data-presentation-source]')
    || /presenting|stop presenting/i.test(document.body.textContent||'');
  var rows=tiles.map(function(t,i){
    var r=rect(t);
    var name=((t.querySelector('span.notranslate,.zWGUib,.XWGOtd')||{}).textContent||'').trim();
    // SPEAKING ground-truth (DOM-only; pruned from AX): any equalizer BAR whose
    // computed animation is running. MUTED heuristic: the tile has bar widgets but
    // they are all display:none / 0-bar (Meet hides the meter for a muted remote).
    var eqs=[].slice.call(t.querySelectorAll('[jsname=QgSmzd]')).map(function(w){
      var bars=[].slice.call(w.children).filter(function(c){return c.tagName==='DIV';});
      var animating=bars.some(function(b){var a=getComputedStyle(b).animationName;return a&&a!=='none';});
      return {wh:rect(w).slice(2), display:getComputedStyle(w).display, nBars:bars.length, animating:animating};});
    var barWidgets=eqs.filter(function(e){return e.nBars>=3;});
    var speaking=barWidgets.some(function(e){return e.animating;});
    var anyVisibleMeter=barWidgets.some(function(e){return e.display!=='none';});
    var v=t.querySelector('video');
    var self=v?/matrix\\(-1[,\\s]/.test(getComputedStyle(v).transform):false;
    // muted: has a bar meter in the DOM but none visible (self is mic-driven, skip)
    var muted=(!self && barWidgets.length>0 && !anyVisibleMeter);
    return {domIdx:i, name:name, pid:(t.getAttribute('data-participant-id')||''),
      pidShort:(t.getAttribute('data-participant-id')||'').slice(-8),
      rect:r, area:r[2]*r[3],
      speaking:speaking, muted:muted, state:(speaking?'SPEAKING':(muted?'muted':'silent')),
      inPromotedKssMZb:!!t.closest('.kssMZb'),
      hasKssMZbInside:!!t.querySelector('.kssMZb'),
      selfMirroredVideo:self,
      ariaLabel:t.getAttribute('aria-label'), tabindex:t.getAttribute('tabindex'),
      classesHead:(t.className||'').split(' ').slice(0,4).join(' '),
      equalizers:eqs};});
  var byArea=rows.slice().sort(function(a,b){return b.area-a.area;});
  return JSON.stringify({when:Date.now(), presenting:presenting,
    largest:byArea[0]&&byArea[0].name, top2ratio:byArea.length>=2&&byArea[1].area>0?+(byArea[0].area/byArea[1].area).toFixed(2):null,
    speakingNow:rows.filter(function(r){return r.speaking;}).map(function(r){return r.name;}),
    mutedNow:rows.filter(function(r){return r.muted;}).map(function(r){return r.name;}),
    kssMZbTiles:rows.filter(function(r){return r.inPromotedKssMZb;}).map(function(r){return r.name;}),
    ariaLive:live, rows:rows});
})()`;

const PIN = `(function(name){var b=[].slice.call(document.querySelectorAll('button,[role=button]')).find(function(x){
  return new RegExp('^Pin '+name.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&')).test(x.getAttribute('aria-label')||'')&&x.offsetParent;});
  if(b){b.click();return 'pinned';}return 'no-pin-btn';})`;
const PIN_MENU = `(async function(name){var m=[].slice.call(document.querySelectorAll('button,[role=button]')).find(function(x){
  return new RegExp('More options for '+name).test(x.getAttribute('aria-label')||'')&&x.offsetParent;});
  if(!m)return 'no-more'; m.click(); await new Promise(function(r){setTimeout(r,700);});
  var it=[].slice.call(document.querySelectorAll('[role=menuitem],[role=menuitemcheckbox],li,button,span')).find(function(z){
    return /^pin\\b|pin to/i.test((z.textContent||'').trim())&&z.offsetParent;});
  if(it){it.click();return 'pinned-menu';} document.body.click(); return 'no-pin-item';})`;
const UNPIN = `(function(){var b=[].slice.call(document.querySelectorAll('button,[role=button]')).find(function(x){
  return /^Unpin\\b/.test(x.getAttribute('aria-label')||'')&&x.offsetParent;}); if(b){b.click();return 'unpinned';}return 'none';})`;
// Change built-in layout via call-controls "More options" -> "Change layout".
const LAYOUT = `(async function(which){
  var more=[].slice.call(document.querySelectorAll('button,[role=button]')).find(function(x){
    return (x.getAttribute('aria-label')||'')==='More options'&&x.offsetParent;});
  if(!more)return 'no-more-options'; more.click(); await new Promise(function(r){setTimeout(r,600);});
  var cl=[].slice.call(document.querySelectorAll('[role=menuitem],li,span,button')).find(function(z){
    return /change layout/i.test((z.textContent||''))&&z.offsetParent;});
  if(!cl){document.body.click();return 'no-change-layout';} cl.click(); await new Promise(function(r){setTimeout(r,700);});
  var opt=[].slice.call(document.querySelectorAll('[role=radio],label,span,button')).find(function(z){
    return new RegExp('^'+which+'$','i').test((z.textContent||'').trim())&&z.offsetParent;});
  if(!opt){document.body.click();return 'no-opt:'+which;} opt.click(); await new Promise(function(r){setTimeout(r,500);});
  document.body.click(); return 'set:'+which;})`;

function tableTxt(label, snap) {
  var L = [];
  L.push(`===== ${label} =====`);
  L.push(`presenting=${snap.presenting}  largest=${snap.largest}  top2ratio=${snap.top2ratio}`);
  L.push(`SPEAKING=${JSON.stringify(snap.speakingNow)}  muted=${JSON.stringify(snap.mutedNow)}  promoted(kssMZb)=${JSON.stringify(snap.kssMZbTiles)}  ariaLive=${JSON.stringify(snap.ariaLive)}`);
  L.push('dom  name          state     pid       x     y     w    h     area   promoted self  eq(bars/display)');
  snap.rows.forEach(function (r) {
    L.push((r.domIdx + '').padEnd(5) + (r.name || '?').padEnd(14) +
      (r.state || '?').padEnd(10) + r.pidShort.padEnd(10) +
      (r.rect[0] + '').padStart(5) + (r.rect[1] + '').padStart(6) + (r.rect[2] + '').padStart(6) + (r.rect[3] + '').padStart(5) +
      (r.area + '').padStart(9) + '  ' + (r.inPromotedKssMZb ? '★YES' : '-').padEnd(9) + (r.selfMirroredVideo ? 'SELF' : '-').padEnd(6) +
      JSON.stringify(r.equalizers.map(function (e) { return e.nBars + 'b/' + e.display + (e.animating ? '/ANIM' : ''); })));
  });
  return L.join('\n');
}

async function main() {
  const h = await attachToPage(HOST_PORT, /meet\.google\.com/);
  const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const dir = path.join(__dirname, 'pattern-dumps', ts);
  fs.mkdirSync(dir, { recursive: true });
  const all = [];
  async function capture(state) {
    const snap = JSON.parse(await h.evalJs(SNAP));
    fs.writeFileSync(path.join(dir, state + '.json'), JSON.stringify(snap, null, 2));
    const txt = tableTxt(state, snap);
    all.push(txt);
    console.log(txt);
    return snap;
  }

  const base = await capture('01-baseline');
  const names = base.rows.map(function (r) { return r.name; }).filter(Boolean);

  // pin each participant in turn (pin == manual promotion; auto-layout promotes the speaker the same way)
  let i = 2;
  for (const nm of names) {
    let res = await h.evalJs(`(${PIN})(${JSON.stringify(nm)})`);
    if (/no-pin-btn/.test(res)) res = await h.evalJs(`(${PIN_MENU})(${JSON.stringify(nm)})`);
    await sleep(2200);
    await capture((i < 10 ? '0' + i : '' + i) + '-pin-' + nm.replace(/\s+/g, ''));
    console.log(`  (pin "${nm}": ${res})`);
    await h.evalJs(`(${UNPIN})()`); await sleep(1200);
    i++;
  }

  // built-in layouts (best-effort; some may not be offered at this call size)
  for (const which of ['Spotlight', 'Sidebar', 'Tiled', 'Auto']) {
    const res = await h.evalJs(`(${LAYOUT})(${JSON.stringify(which)})`);
    await sleep(1800);
    if (!/^no-|^set:/.test(res) || /^set:/.test(res)) await capture((i < 10 ? '0' + i : '' + i) + '-layout-' + which);
    console.log(`  (layout ${which}: ${res})`);
    i++;
  }
  // restore Auto
  await h.evalJs(`(${LAYOUT})('Auto')`);

  fs.writeFileSync(path.join(dir, 'ALL.txt'), all.join('\n\n'));
  console.log(`\nWROTE ${all.length} state files + ALL.txt to: ${dir}`);
  process.exit(0);
}
main().catch(function (e) { console.error('ERROR', e.stack || e); process.exit(1); });
