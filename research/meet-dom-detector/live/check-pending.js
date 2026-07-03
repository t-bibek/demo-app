'use strict';
// Read-only lobby/roster probe across every live Chrome instance. For each CDP
// port: report the Meet URL, the REAL stage tiles (who's actually in the call),
// whether THIS page is itself stuck "asking to be let in", and whether — as a
// host — it currently sees a pending "Admit" request. Non-destructive: no clicks.
//   node check-pending.js
const { attachToPage } = require('./cdp-lib');
const PORTS = [9222, 9318, 9224, 9225, 9320, 9321];

const PROBE = `(function(){
  function txt(e){return ((e&&(e.textContent||''))||'').trim();}
  // real stage tiles (not People-panel rows): outside list/dialog/aside, >=150x84
  var tiles=[...document.querySelectorAll('[data-participant-id]')].filter(function(t){
    if(t.closest('[role=list],[role=listitem],[role=dialog],[role=complementary],aside'))return false;
    var r=t.getBoundingClientRect();return r.width>=150&&r.height>=84;
  }).map(function(t){return txt(t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]'))||'?';});
  var waiting=/asking to be let in|asking to join/i.test(document.body.textContent||'');
  var inCall=!![...document.querySelectorAll('button')].find(function(b){return /leave call/i.test(b.getAttribute('aria-label')||'');});
  // pending admission request seen by a HOST (toast or People-panel row)
  var oyy=[...document.querySelectorAll('[jsname=OYykWd]')].find(function(e){return e.offsetParent&&e.getBoundingClientRect().width>0;});
  var admitEls=[...document.querySelectorAll('button,[role=button],div,span')].filter(function(e){
    if(!e.offsetParent)return false;
    var own=[].filter.call(e.childNodes,function(n){return n.nodeType===3;}).map(function(n){return n.textContent;}).join('');
    return /\\badmit\\b/i.test((e.getAttribute('aria-label')||'')+' '+own);});
  var wantsJoin=(document.body.textContent||'').match(/(\\w[\\w .'-]*?)\\s+wants to join/i);
  return JSON.stringify({
    url:location.href, title:document.title,
    stageTiles:tiles, inCall:inCall, selfWaiting:waiting,
    pendingAdmit: !!oyy || admitEls.length>0,
    admitLabel: oyy?('row:'+(oyy.getAttribute('aria-label')||'')):(admitEls[0]?('el:'+((admitEls[0].getAttribute('aria-label')||admitEls[0].textContent)||'').trim().slice(0,60)):null),
    wantsJoinName: wantsJoin?wantsJoin[1]:null
  });
})()`;

(async () => {
  for (const p of PORTS) {
    let page;
    try { page = await attachToPage(p, /meet\.google\.com/); }
    catch (e) { console.log(`:${p}  — no Meet page (${e.message})`); continue; }
    try {
      const s = JSON.parse(await page.evalJs(PROBE));
      const code = (s.url.match(/[a-z]{3}-[a-z]{4}-[a-z]{3}/) || ['?'])[0];
      console.log(`:${p}  meet=${code}  inCall=${s.inCall}  selfWaiting=${s.selfWaiting}  pendingAdmit=${s.pendingAdmit}`);
      console.log(`      stageTiles(${s.stageTiles.length}): ${JSON.stringify(s.stageTiles)}`);
      if (s.pendingAdmit) console.log(`      ⚠️  PENDING ADMIT: ${s.admitLabel}  (wantsJoin=${s.wantsJoinName})`);
    } catch (e) { console.log(`:${p}  — probe error: ${e.message}`); }
  }
  process.exit(0);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
