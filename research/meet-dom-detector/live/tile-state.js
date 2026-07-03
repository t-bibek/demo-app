'use strict';
// Per-tile state on the host view: mute, self/remote, and which widget variant
// (DYfzY self-meter vs IisKdb/QgSmzd bar-equalizer) + its speaking class.
const { attachToPage } = require('./cdp-lib');
const PROBE = `(function(){
  return JSON.stringify([].slice.call(document.querySelectorAll('[data-participant-id]'))
    .filter(function(t){return !t.closest('[role=list]');})
    .map(function(t){
      var name=((t.querySelector('span.notranslate')||{}).textContent||'').trim();
      var micOff=/mic_off/.test(t.textContent||'');
      var remote=/can.t unmute someone else/i.test(t.textContent||'');
      var widgets=[].slice.call(t.querySelectorAll('[jsname=QgSmzd]')).map(function(w){
        var bars=[].slice.call(w.children).filter(function(c){return c.tagName==='DIV';}).length;
        var variant=(w.className.match(/DYfzY|IisKdb/)||['?'])[0];
        var state=(w.className.match(/gjg47c|Oaajhc|HX2H7|wEsLMd|OgVli/)||['-'])[0];
        return variant+':'+bars+'bars:'+state;
      });
      return {name:name, micOff:micOff, isRemote:remote, widgets:widgets};
    }));})()`;
(async () => {
  const h = await attachToPage(9222, /meet\.google\.com/);
  console.log(await h.evalJs(PROBE));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
