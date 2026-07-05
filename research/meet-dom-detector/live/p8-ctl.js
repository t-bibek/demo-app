'use strict';
// p8-ctl.js — Phase 2.7 (P8) spot-check controller for the live Meet rig.
// Small imperative commands so the experiment can be driven stepwise from bash:
//   node p8-ctl.js probe                 # host-DOM ground truth: per-tile meter classes + ring
//   node p8-ctl.js speak <seat> <on|off> # seat = host|alpha|bravo; fake-mic speech + mic button
//   node p8-ctl.js silence-all           # all three seats: speech off + mic muted
//   node p8-ctl.js leave <seat>          # click "Leave call" on that seat (bravo -> 2-person call)
//   node p8-ctl.js rtc                   # host inbound RTC audio level (ground truth receiving)
const { attachToPage, sleep } = require('./cdp-lib');

const PORTS = { host: 9224, alpha: 9226, bravo: 9227 };

// Ground-truth DOM probe on the HOST page: every stage tile, its name, the FULL
// className of each meter widget (jsname=QgSmzd), whether the silent token gjg47c
// is present, and whether the tile shows the speaking ring (kssMZb) anywhere.
const PROBE = `(function(){
  return JSON.stringify([].slice.call(document.querySelectorAll('[data-participant-id]'))
    .filter(function(t){return !t.closest('[role=list],[role=listitem],[role=dialog],[role=complementary],aside');})
    .map(function(t){
      var name=((t.querySelector('span.notranslate,[data-self-name]')||{}).textContent||'').trim();
      var meters=[].slice.call(t.querySelectorAll('[jsname=QgSmzd]')).map(function(w){
        return {cls:(w.className||''), silent:/(^| )gjg47c( |$)/.test(w.className||'')};
      });
      var ring=!!t.querySelector('.kssMZb');
      var lvl=(t.querySelector('[data-audio-level]')||{}).getAttribute
        ? (t.querySelector('[data-audio-level]')).getAttribute('data-audio-level') : null;
      return {name:name, meters:meters, ringKssMZb:ring, dataAudioLevel:lvl};
    }));})()`;

const MIC = `(function(act){var b=[...document.querySelectorAll("button,[role=button]")].find(function(n){if(!n.offsetParent||n.disabled)return false;return /^Turn (on|off) microphone/.test(n.getAttribute("aria-label")||"")&&n.getAttribute("data-is-muted")!==null;});if(!b)return "null";if(act==="click")b.click();return JSON.stringify({muted:b.getAttribute("data-is-muted")==="true"});})`;

async function setMic(pg, on) {
  for (let a = 0; a < 4; a++) {
    const st = JSON.parse((await pg.evalJs(`(${MIC})("read")`)) || 'null');
    if (!st) { await sleep(600); continue; }
    if (st.muted === !on) return true;
    await pg.evalJs(`(${MIC})("click")`);
    for (let w = 0; w < 10; w++) { await sleep(300); const n = JSON.parse((await pg.evalJs(`(${MIC})("read")`)) || 'null'); if (n && n.muted === !on) return true; }
  }
  return false;
}

async function seatPage(seat) {
  if (!PORTS[seat]) throw new Error('unknown seat ' + seat);
  return attachToPage(PORTS[seat], /meet\.google\.com/);
}

(async () => {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (cmd === 'probe') {
    const host = await seatPage('host');
    console.log(await host.evalJs(PROBE));
  } else if (cmd === 'speak') {
    const pg = await seatPage(a1);
    const on = a2 === 'on';
    await pg.evalJs(`window.__fakeMicSpeak&&window.__fakeMicSpeak(${on})`);
    const ok = await setMic(pg, on);
    console.log(JSON.stringify({ seat: a1, speak: on, micSet: ok }));
  } else if (cmd === 'silence-all') {
    for (const seat of ['host', 'alpha', 'bravo']) {
      try {
        const pg = await seatPage(seat);
        await pg.evalJs('window.__fakeMicSpeak&&window.__fakeMicSpeak(false)');
        const ok = await setMic(pg, false);
        console.log(JSON.stringify({ seat, silenced: ok }));
      } catch (e) { console.log(JSON.stringify({ seat, error: e.message })); }
    }
  } else if (cmd === 'leave') {
    const pg = await seatPage(a1);
    const r = await pg.evalJs(`(function(){var b=[...document.querySelectorAll("button,[role=button],[aria-label]")].find(function(n){return /leave call/i.test(n.getAttribute("aria-label")||"")});if(!b)return "no-button";b.click();return "clicked";})()`);
    console.log(JSON.stringify({ seat: a1, leave: r }));
  } else if (cmd === 'rtc') {
    const host = await seatPage('host');
    const r = await host.evalJs('window.__rtcAudioStats?JSON.stringify(window.__rtcAudioStats()):"n/a"').catch(() => 'err');
    console.log(r);
  } else {
    console.error('usage: probe | speak <seat> <on|off> | silence-all | leave <seat> | rtc');
    process.exit(2);
  }
  process.exit(0);
})().catch((e) => { console.error('P8_CTL_ERROR', e.stack || e.message); process.exit(1); });
