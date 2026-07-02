'use strict';
// Validate the CLASS-INDEPENDENT structural speaking signal and re-check kssMZb.
// Toggles the host mic (fake tone) and, per tile, records whether the QgSmzd
// equalizer BARS animate (getComputedStyle animationName != none) and whether
// kssMZb PERSISTS after speech stops (the "last-active-speaker sticks" hypothesis).
//   node struct-toggle-test.js
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222;

const MIC_LABEL = `(function(){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){return /microphone/i.test(n.getAttribute('aria-label')||'')});return b?b.getAttribute('aria-label'):null;})()`;
const CLICK_MIC = `(function(want){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){return new RegExp(want,'i').test(n.getAttribute('aria-label')||'')});if(b){b.click();return true}return false})`;
// Per participant: does any QgSmzd bar animate? widget class? kssMZb present?
const PROBE = `(function(){return [...document.querySelectorAll('[data-participant-id]')].map(function(t){
  var name=((t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim();
  var ind=t.querySelector('[jsname="QgSmzd"]');
  var bars=ind?[...ind.children].filter(function(c){return c.tagName==='DIV'}):[];
  var animating=bars.some(function(b){var a=getComputedStyle(b);return a.animationName!=='none'&&a.animationPlayState!=='paused'});
  // also: does the widget itself (no bars variant) animate / lack a silence class?
  var indCS=ind?getComputedStyle(ind):null;
  return {name:name, roleTile:t.getAttribute('role'),
    barsAnimating:animating, nBars:bars.length,
    widgetClass:ind?ind.className:null,
    widgetAnim:indCS?indCS.animationName:null,
    kssMZb:!!t.querySelector('.kssMZb')};});})()`;

async function phase(host, label, secs) {
  const rows = [];
  for (let i = 0; i < secs; i++) { rows.push(JSON.parse((await host.evalJs(`JSON.stringify(${PROBE})`)) || '[]')); await sleep(1000); }
  // collapse per name
  const byName = {};
  rows.forEach(snap => snap.forEach(p => { const a = byName[p.name] || (byName[p.name] = { animatingHits: 0, kssHits: 0, n: 0, classes: new Set() }); a.n++; if (p.barsAnimating) a.animatingHits++; if (p.kssMZb) a.kssHits++; a.classes.add(p.widgetClass); }));
  console.log(`  [${label}]`);
  Object.keys(byName).forEach(nm => { const a = byName[nm]; console.log(`     ${nm}: barsAnimating ${a.animatingHits}/${a.n} · kssMZb ${a.kssHits}/${a.n} · widgetClasses ${JSON.stringify([...a.classes])}`); });
  return byName;
}

async function main() {
  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  console.log('mic label:', await host.evalJs(MIC_LABEL), '\n');

  // ensure MUTED
  await host.evalJs(`(${CLICK_MIC})('Turn off microphone')`); await sleep(1500);
  console.log('after mute-attempt, mic label:', await host.evalJs(MIC_LABEL));
  const muted1 = await phase(host, 'MUTED (baseline)', 6);

  // UNMUTE -> fake tone
  await host.evalJs(`(${CLICK_MIC})('Turn on microphone')`); await sleep(1500);
  console.log('after unmute, mic label:', await host.evalJs(MIC_LABEL));
  const speaking = await phase(host, 'UNMUTED (tone)', 8);

  // MUTE again -> does kssMZb persist? does animation stop?
  await host.evalJs(`(${CLICK_MIC})('Turn off microphone')`); await sleep(1500);
  console.log('after re-mute, mic label:', await host.evalJs(MIC_LABEL));
  const muted2 = await phase(host, 'MUTED (after speaking)', 6);

  console.log('\n===== interpretation =====');
  console.log('- Structural speaking signal works if barsAnimating is HIGH only in UNMUTED.');
  console.log('- kssMZb is "sticky last-speaker" if kssMZb stays present in MUTED-after-speaking (does not clear).');
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(1); });
