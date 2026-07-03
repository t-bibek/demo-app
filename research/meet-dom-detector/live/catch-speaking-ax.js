'use strict';
// Watch ALL host tiles for a speaking signal for up to 90s; the instant any tile's
// equalizer goes non-silent, record which tile + widget variant + focus state, then
// fire an AX dump at that exact moment. Answers: does the speaker className appear
// in AX when a tile is actively speaking (foreground)?
const { attachToPage, sleep } = require('./cdp-lib');
const { execSync } = require('child_process');

const PROBE = `(function(){
  return JSON.stringify([].slice.call(document.querySelectorAll('[data-participant-id]'))
    .filter(function(t){return !t.closest('[role=list]');})
    .map(function(t){
      var name=((t.querySelector('span.notranslate')||{}).textContent||'').trim();
      var remote=/can.t unmute someone else/i.test(t.textContent||'');
      var ws=[].slice.call(t.querySelectorAll('[jsname=QgSmzd]'));
      var active=ws.filter(function(w){return !/(^| )gjg47c( |$)/.test(w.className||'');})
        .map(function(w){var bars=[].slice.call(w.children).filter(function(c){return c.tagName==='DIV'}).length;
          return {variant:(w.className.match(/DYfzY|IisKdb/)||['?'])[0], bars:bars, cls:w.className};});
      return {name:name, remote:remote, active:active};
    }).filter(function(t){return t.active.length>0;}));})()`;
const FOCUS = `JSON.stringify({hasFocus:document.hasFocus(),vis:document.visibilityState})`;

(async () => {
  const h = await attachToPage(9222, /meet\.google\.com/);
  await h.cmd('Page.bringToFront', {});
  try { execSync(`osascript -e 'tell application "System Events" to repeat with p in (every process whose name is "Google Chrome")
    repeat with w in (every window of p)
      if title of w contains "Meet - yzs-mvzw-rkv" then
        set frontmost of p to true
        perform action "AXRaise" of w
      end if
    end repeat
  end repeat'`, { timeout: 10000 }); } catch (e) {}
  console.log('watching all tiles for 90s — speak now (unmute first!)...\n');
  let hit = null;
  for (let i = 0; i < 180 && !hit; i++) {
    const spk = JSON.parse(await h.evalJs(PROBE));
    if (spk.length) {
      const foc = JSON.parse(await h.evalJs(FOCUS));
      console.log(`\n>>> ACTIVE SIGNAL at t=${(i * 0.5).toFixed(1)}s  focus=${JSON.stringify(foc)}`);
      console.log('    tiles speaking:', JSON.stringify(spk));
      const isRemoteBar = spk.some(t => t.remote && t.active.some(a => a.variant === 'IisKdb' && a.bars >= 3));
      console.log('    remote bar-equalizer active? ' + (isRemoteBar ? 'YES (the real case!)' : 'no (self-meter/DYfzY only)'));
      console.log('    firing AX dump NOW — keep talking...');
      try { execSync('cd /Users/bibekthapa/projects/work/demo-app/macos && swift run AXSnapshot chrome --url yzs-mvzw-rkv >/tmp/catchax.log 2>&1', { timeout: 60000 }); } catch (e) {}
      hit = { spk, foc, isRemoteBar };
    }
    if (i % 20 === 0 && !hit) console.log(`  t=${(i * 0.5).toFixed(0)}s ... (still silent)`);
    await sleep(500);
  }
  if (!hit) { console.log('\nno active signal in 90s'); process.exit(1); }
  console.log('\nCAPTURED. isRemoteBar=' + hit.isRemoteBar);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
