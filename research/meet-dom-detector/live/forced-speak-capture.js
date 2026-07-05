'use strict';
// forced-speak-capture.js — CLOSE THE GAP: prove that forcing the full AX tree
// (AXManualAccessibility + AXEnhancedUserInterface, the exact product flags) surfaces
// the Meet speaking-indicator token swap (gjg47c <-> rotating Oaajhc/OgVli/HX2H7/wEsLMd)
// in a LIVE MULTI-PARTY call, captured through the shipped AXSnapshot path.
//
// Preconditions: roster-rig-3p.js has a live 3-party call up (host on :9224, guests
// speaking via __fakeMicSpeak). This driver attaches to the HOST page, drives a
// remote guest (Alpha) to SPEAK, verifies on the host DOM that Alpha's REMOTE tile
// meter went active (gjg47c dropped), then fires the FORCED AXSnapshot (which sets
// the product force-flags on Chrome) targeting the meeting by code. It also captures
// a SILENT baseline. Diffing the meter node's AXDOMClassList across the two forced
// dumps is the evidence that forcing exposes the speaking swap in AX.
const { attachToPage, sleep } = require('./cdp-lib');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOST_PORT = 9224;
const GUEST_A_PORT = 9226;
const CODE = process.argv[2]; // meeting code, e.g. dfq-kudc-adj
if (!CODE) { console.error('usage: node forced-speak-capture.js <meeting-code>'); process.exit(2); }

const MACOS = '/Users/bibekthapa/projects/work/demo-app/macos';

// DOM probe on an observer page: for every stage tile (not roster list), report the
// tile name, whether it is a REMOTE participant, and the ACTIVE meter widgets — a
// meter is ACTIVE when its className has DROPPED the silent token gjg47c. This mirrors
// catch-speaking-ax.js exactly (jsname=QgSmzd meter, gjg47c = silent).
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

// Turn a seat's mic mute button on/off by accessible name (from roster-rig-turns.js).
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
async function setSpeak(pg, on) {
  await pg.evalJs(`window.__fakeMicSpeak&&window.__fakeMicSpeak(${on ? 'true' : 'false'})`);
  await setMic(pg, on);
}

function forcedSnapshot(tag) {
  // The shipped forced path: AXSnapshot sets AXManualAccessibility + AXEnhancedUserInterface
  // on Chrome, waits for the tree to build, then dumps the meeting web area by --url.
  const out = execSync(
    `cd ${MACOS} && swift run AXSnapshot chrome --url ${CODE}`,
    { timeout: 90000 }
  ).toString();
  return out;
}

function latestDumpDir() {
  const base = path.join(MACOS, 'ax-dumps');
  const dirs = fs.readdirSync(base).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort();
  return path.join(base, dirs[dirs.length - 1]);
}

(async () => {
  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  const guestA = await attachToPage(GUEST_A_PORT, /meet\.google\.com/);
  // Bring the HOST window frontmost — Chrome only publishes the live equalizer class
  // rotation on the frontmost window (AXKit note). AXSnapshot itself does not activate.
  await host.cmd('Page.bringToFront', {});
  try {
    execSync(`osascript -e 'tell application "System Events" to repeat with p in (every process whose name is "Google Chrome")
      repeat with w in (every window of p)
        if title of w contains "${CODE}" then
          set frontmost of p to true
          perform action "AXRaise" of w
        end if
      end repeat
    end repeat'`, { timeout: 10000 });
  } catch (e) {}
  await sleep(1500);

  // ---- SILENT baseline: everyone muted/silent ----
  await setSpeak(guestA, false);
  await sleep(2500);
  const silentDom = JSON.parse(await host.evalJs(PROBE));
  console.log('SILENT host-DOM active tiles (expect none/self-only): ' + JSON.stringify(silentDom));
  forcedSnapshot('silent');
  const silentDir = latestDumpDir();
  console.log('SILENT forced dump dir: ' + silentDir);

  // ---- SPEAKING: Alpha (a REMOTE participant on the host) speaks ----
  await setSpeak(guestA, true);
  // Wait until the host DOM confirms a REMOTE tile's meter went active (gjg47c dropped).
  let spk = [];
  let confirmedRemote = false;
  for (let i = 0; i < 40; i++) {
    spk = JSON.parse(await host.evalJs(PROBE));
    confirmedRemote = spk.some((t) => t.remote && t.active.length > 0);
    if (confirmedRemote) break;
    await sleep(500);
  }
  console.log('SPEAKING host-DOM active tiles: ' + JSON.stringify(spk));
  console.log('remote tile meter active on host? ' + (confirmedRemote ? 'YES' : 'no'));
  // Fire the forced snapshot WHILE Alpha is still speaking (keep it on).
  forcedSnapshot('speaking');
  const speakingDir = latestDumpDir();
  console.log('SPEAKING forced dump dir: ' + speakingDir);

  // Also grab RTC ground-truth: host should be RECEIVING Alpha's audio.
  const rtc = await host.evalJs('window.__rtcAudioStats?JSON.stringify(await window.__rtcAudioStats()):"n/a"').catch(() => 'n/a');
  console.log('host RTC stats (inAudioLevelMax>0 = really receiving speech): ' + rtc);

  // Stop speaking so we leave the call quiet.
  await setSpeak(guestA, false);

  console.log('\nRESULT_JSON ' + JSON.stringify({
    code: CODE,
    silentDir, speakingDir,
    silentDomActive: silentDom,
    speakingDomActive: spk,
    confirmedRemoteSpeakingOnHost: confirmedRemote,
  }));
  process.exit(0);
})().catch((e) => { console.error('DRIVER_ERROR', e.stack || e.message); process.exit(1); });
