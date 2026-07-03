'use strict';
// ============================================================================
// Device-free fake-audio Meet rig  (Agent B / "Blackbox" alternative)
//
// Injects DISTINCT synthetic HOST and GUEST speech into a live Google Meet with
// ZERO virtual audio devices and ZERO AEC plumbing. Does NOT use Chrome's
// --use-file-for-fake-audio-capture flag (validated BROKEN in Chrome 149: it
// yields silence in every format, headless and headful — see fake-file-probe.js).
//
// HOW: each Chrome gets an in-page getUserMedia override (fake-mic-override.js)
// that decodes a real speech WAV (fake-audio/host.wav | guest.wav) and serves it
// as the microphone via WebAudio BufferSource -> Gain -> MediaStreamDestination.
// It is installed with CDP Page.addScriptToEvaluateOnNewDocument so it runs
// BEFORE Meet reads the mic (survives navigations). Turns are gated two ways per
// seat:  window.__fakeMicSpeak(true|false)  (in-page speech gain)  AND  the Meet
// mic mute button. Real decoded voice content -> Meet's VAD treats it as speech.
//
// FLOW: launch host (signed-in) + guest (anonymous) -> host joins -> guest asks to
// join with a DISTINCT name -> host admits guest -> inject the DOM detector on
// BOTH pages -> drive HOST / GUEST / OVERLAP / SILENCE turns -> validate by
// CROSS-OBSERVATION (each side's detector names the OTHER participant's tile;
// Meet renders no strong equalizer on your OWN self-tile, so self-view is not a
// valid oracle).
//
//   node fake-audio-rig.js [meetingUrl] [guestName]
//     meetingUrl defaults to ./.meeting-url ; guestName defaults to "Fake Guest"
//
// Ports 9224 (host) / 9225 (guest) to avoid Agent A on 9222/9223.
// Host profile: .rig-profiles/host (a trimmed COPY of the signed-in .live-profile;
// run ./make-rig-profile.sh once to (re)create it). Guest: fresh anon temp profile.
// ============================================================================
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn, execSync } = require('child_process');
const { CHROME, sleep, httpJson, attachToPage } = require('./cdp-lib.js');
const { buildOverride } = require('./fake-mic-override.js');
const { admit } = require('./admit-guest.js');

const MEET_URL = process.argv[2] || fs.readFileSync(path.join(__dirname, '.meeting-url'), 'utf8').trim();
const GUEST_NAME = process.argv[3] || 'Fake Guest';
const HOST_NAME_HINT = 'Bibek Thapa'; // the signed-in account's display name (for validation labels)
const HOST = { port: 9224, wav: path.join(__dirname, 'fake-audio', 'host.wav'), profile: path.join(__dirname, '.rig-profiles', 'host') };
const GUEST = { port: 9225, wav: path.join(__dirname, 'fake-audio', 'guest.wav'), profile: fs.mkdtempSync(path.join(os.tmpdir(), 'rig-anon-')) };
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const log = (...a) => console.log(...a);

// --- Launch a Chrome on about:blank with the WAV-backed gUM override installed
// pre-navigation. Returns the persistent CDP connection to the about:blank target;
// the override (Page.addScriptToEvaluateOnNewDocument) re-runs on every subsequent
// navigation, so the fake mic survives the navigate-to-Meet below. ---
async function launch({ port, profile, wav, label }) {
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',      // auto-accept mic/cam permission
    '--use-fake-device-for-media-stream',  // fake CAMERA; audio is overridden below
    'about:blank',
  ], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(300); try { const l = await httpJson(port, '/json'); if (Array.isArray(l)) target = l.find((t) => t.type === 'page'); } catch (e) {} }
  if (!target) throw new Error(`[${label}] no page target on :${port}`);
  const conn = await attachToPage(port, /about:blank|/);
  await conn.cmd('Page.addScriptToEvaluateOnNewDocument', { source: buildOverride(wav, label) });
  return { proc, port, conn, kill() { try { proc.kill('SIGKILL'); } catch (e) {} } };
}

// Navigate a launched connection to a Meet URL and wait for the pre-join screen.
async function gotoMeet(conn, url) {
  await conn.cmd('Page.navigate', { url });
  await waitPrejoin(conn);
}

// Real CDP mouse click (needed for HOST window controls; el.click() no-ops there).
async function cdpClick(page, x, y) {
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y) });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
}
const CENTER = `function(rx){var re=new RegExp(rx,"i");var el=[...document.querySelectorAll("button,[role=button]")].find(function(n){return n.getBoundingClientRect().width>0&&re.test((n.getAttribute("aria-label")||"")+" "+(n.textContent||""));});if(!el)return "null";var r=el.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,label:(el.getAttribute("aria-label")||el.textContent||"").replace(/\\s+/g," ").trim().slice(0,30)});}`;
// el.click() by accessible-name regex — the method that WORKS on guest windows
// (coordinate CDP clicks do NOT land on them; verified live 2026-07-03).
const CLICK = `function(rx){var re=new RegExp(rx,"i");var el=[...document.querySelectorAll("button,[role=button]")].find(function(n){return n.getBoundingClientRect().width>0&&re.test((n.getAttribute("aria-label")||"")+" "+(n.textContent||""));});if(!el)return "null";el.click();return (el.getAttribute("aria-label")||el.textContent||"").replace(/\\s+/g," ").trim().slice(0,30);}`;

async function waitPrejoin(conn) {
  for (let i = 0; i < 50; i++) {
    const ok = await conn.evalJs(`/meet\\.google\\.com/.test(location.href)&&!![...document.querySelectorAll("button,[role=button]")].find(function(b){return /join now|ask to join/i.test((b.getAttribute("aria-label")||b.textContent||""))})`);
    if (ok) return true; await sleep(500);
  }
  return false;
}

const inCall = (pg) => pg.evalJs(`!![...document.querySelectorAll("button")].find(function(b){return /leave call/i.test(b.getAttribute("aria-label")||"")})`);

// HOST joins. Normally clicks "Join now" (real CDP mouse click). If a STALE seat of
// the same account is still in the call, Meet shows "Join here too" instead — fall
// back to that (via el.click, expanding "Other ways to join" first if needed).
async function hostJoin(host) {
  if (await inCall(host)) return true;   // "new"-mode create already joined the host
  await waitPrejoin(host); await sleep(2000);
  if (await inCall(host)) return true;
  let t = JSON.parse(await host.evalJs(`(${CENTER})("Turn off camera")`) || 'null'); if (t) { await cdpClick(host, t.x, t.y); await sleep(400); }
  t = JSON.parse(await host.evalJs(`(${CENTER})("^Join now$|Join now")`) || 'null');
  if (t) {
    await cdpClick(host, t.x, t.y);
  } else {
    log('[rig] host: no "Join now" (stale seat?) — trying "Join here too"');
    await host.evalJs(`(${CLICK})("Not now")`); await sleep(300);
    await host.evalJs(`(${CLICK})("Other ways to join")`); await sleep(800);
    const c = await host.evalJs(`(${CLICK})("Join here too")`);
    if (c === 'null') throw new Error('host: neither "Join now" nor "Join here too" found (clear stale seats: pkill -f rig-profiles, wait ~60s)');
  }
  for (let i = 0; i < 20; i++) { await sleep(1500); if (await host.evalJs(`!![...document.querySelectorAll("button")].find(function(b){return /leave call/i.test(b.getAttribute("aria-label")||"")})`)) return true; }
  return false;
}

// GUEST (anonymous) sets a distinct name and asks to join, via el.click().
async function guestAsk(guest, name) {
  await waitPrejoin(guest); await sleep(2000);
  await guest.evalJs(`(function(){var i=document.querySelector("input[type=text][aria-label], input[jsname][type=text]");if(i){i.value=${JSON.stringify(name)};i.dispatchEvent(new Event("input",{bubbles:true}));i.dispatchEvent(new Event("change",{bubbles:true}));}})()`);
  await sleep(500);
  await guest.evalJs(`(${CLICK})("Got it")`); await sleep(300);
  await guest.evalJs(`(${CLICK})("Turn off camera")`); await sleep(300);
  const c = await guest.evalJs(`(${CLICK})("Ask to join|Join now")`);
  return c;
}

// --- Turn gating: in-page speech gain + Meet mic mute button ---
const MIC = `(function(act){var b=[...document.querySelectorAll("button,[role=button]")].find(function(n){if(!n.offsetParent||n.disabled)return false;return /^Turn (on|off) microphone/.test(n.getAttribute("aria-label")||"")&&n.getAttribute("data-is-muted")!==null;});if(!b)return "null";if(act==="click")b.click();return JSON.stringify({muted:b.getAttribute("data-is-muted")==="true"});})`;
async function setMic(pg, on) {
  for (let a = 0; a < 4; a++) {
    const st = JSON.parse(await pg.evalJs(`(${MIC})("read")`) || 'null');
    if (!st) { await sleep(600); continue; }
    if (st.muted === !on) return true;
    await pg.evalJs(`(${MIC})("click")`);
    for (let w = 0; w < 10; w++) { await sleep(300); const n = JSON.parse(await pg.evalJs(`(${MIC})("read")`) || 'null'); if (n && n.muted === !on) return true; }
  }
  return false;
}
async function setSpeak(pg, on) { await pg.evalJs(`window.__fakeMicSpeak&&window.__fakeMicSpeak(${on ? 'true' : 'false'})`); await setMic(pg, on); }

const frac = (p, f) => +(p.length ? p.filter(f).length / p.length : 0).toFixed(2);
const has = (d, n) => (d.names || []).includes(n);

async function main() {
  // Keep-alive: prevents Node from exiting 0 during the brief window when a CDP socket
  // closes (a target destroyed by Page.navigate) before the next attach — without it
  // the event loop can drain and the process exits silently mid-join.
  const keepAlive = setInterval(() => {}, 1 << 30);

  log(`[rig] launching HOST :${HOST.port} (signed-in) + GUEST :${GUEST.port} (anon "${GUEST_NAME}")`);
  const hostChrome = await launch({ port: HOST.port, profile: HOST.profile, wav: HOST.wav, label: 'HOST' });
  const guestChrome = await launch({ port: GUEST.port, profile: GUEST.profile, wav: GUEST.wav, label: 'GUEST' });
  const cleanup = () => { clearInterval(keepAlive); hostChrome.kill(); guestChrome.kill(); try { execSync(`rm -rf ${GUEST.profile}`); } catch (e) {} };
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  // MEETING_URL="new" -> create a FRESH room on the host (avoids contention with other
  // seats of the same account); otherwise navigate the host straight to the given URL.
  let meetingUrl = MEET_URL;
  if (meetingUrl === 'new') {
    await hostChrome.conn.cmd('Page.navigate', { url: 'https://meet.google.com/new' });
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      meetingUrl = (await hostChrome.conn.evalJs('location.href')) || '';
      await hostChrome.conn.evalJs(`(function(){var b=[...document.querySelectorAll("button,span")].find(function(n){return /^(Join now|Ask to join)$/i.test((n.textContent||"").trim())});if(b)b.click();})()`);
      if (/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(meetingUrl)) break;
    }
    meetingUrl = meetingUrl.split('?')[0];
    log(`[rig] created meeting ${meetingUrl}`);
  } else {
    await gotoMeet(hostChrome.conn, meetingUrl);
  }
  await gotoMeet(guestChrome.conn, meetingUrl);

  // Reuse the SAME persistent connections (the page target survives navigation, so the
  // WS stays valid). Re-attaching opens a fresh WS that can race Meet's several targets.
  const host = hostChrome.conn;
  const guest = guestChrome.conn;
  log('[rig] both Meet pages ready');

  const hIn = await hostJoin(host);
  log(`[rig] host in call: ${hIn}`);
  if (!hIn) throw new Error('host failed to join');
  const gAsk = await guestAsk(guest, GUEST_NAME);
  log(`[rig] guest asked to join: ${gAsk}`);

  log('[rig] admitting guest...');
  const admitted = await admit({ hostPort: HOST.port, guestPorts: [GUEST.port], guestName: GUEST_NAME, timeoutSec: 90, log });
  if (!admitted) log('[rig] WARN: admit not confirmed — measuring anyway');

  await sleep(4000);
  for (const pg of [host, guest]) { await pg.evalJs(DETECTOR); await pg.evalJs(`window.__ctx={vad:true,structOnly:false,holdMs:400};window.__meetHoldState={};`); }
  log(`[rig] fake-mic decoded: host=${await host.evalJs('window.__fakeMicReady')} guest=${await guest.evalJs('window.__fakeMicReady')}`);

  const detH = async () => JSON.parse(await host.evalJs(`JSON.stringify((window.__meetDetect&&window.__meetDetect())||{})`) || '{}');
  const detG = async () => JSON.parse(await guest.evalJs(`JSON.stringify((window.__meetDetect&&window.__meetDetect())||{})`) || '{}');
  async function turn(label, ms) {
    const ph = [], pg = []; const t0 = Date.now();
    while (Date.now() - t0 < ms) { ph.push(await detH()); pg.push(await detG()); await sleep(300); }
    // cross-observation: host names the GUEST tile; guest names the HOST tile
    const row = {
      turn: label,
      hostView_guestSpeaking: frac(ph, (d) => has(d, GUEST_NAME)),
      guestView_hostSpeaking: frac(pg, (d) => has(d, HOST_NAME_HINT)),
    };
    log('  ' + JSON.stringify(row));
    return row;
  }

  log('\n[rig] TURN SEQUENCE (cross-observed)');
  const rows = [];
  await setSpeak(host, false); await setSpeak(guest, false); await sleep(4000);
  rows.push(await turn('SILENCE', 3000));
  await setSpeak(guest, false); await setSpeak(host, true); await sleep(3000);
  rows.push(await turn('HOST speaks', 8000));
  await setSpeak(host, false); await setSpeak(guest, true); await sleep(3000);
  rows.push(await turn('GUEST speaks', 8000));
  await setSpeak(host, true); await setSpeak(guest, true); await sleep(3000);
  rows.push(await turn('OVERLAP', 8000));
  await setSpeak(host, false); await setSpeak(guest, false); await sleep(4000);
  rows.push(await turn('SILENCE', 3000));

  const [S0, H, G, O, S1] = rows;
  const pass =
    H.guestView_hostSpeaking >= 0.6 && H.hostView_guestSpeaking <= 0.3 &&   // host turn: guest sees host
    G.hostView_guestSpeaking >= 0.6 && G.guestView_hostSpeaking <= 0.5 &&   // guest turn: host sees guest
    O.hostView_guestSpeaking >= 0.5 && O.guestView_hostSpeaking >= 0.5 &&   // overlap: both sides see the other
    S1.hostView_guestSpeaking <= 0.3 && S1.guestView_hostSpeaking <= 0.3;   // silence: both quiet
  log('\n===== VERDICT =====');
  log(JSON.stringify({
    result: pass ? 'PASS' : 'REVIEW',
    note: 'hostView_guestSpeaking = fraction of polls the HOST detector named the guest tile; guestView_hostSpeaking = fraction the GUEST detector named the host tile. Self-view is ~0 by design (Meet renders no equalizer on your own tile).',
    rows,
  }, null, 2));
  fs.writeFileSync(path.join(__dirname, 'fake-audio-rig-results.json'), JSON.stringify(rows, null, 2));
  log('\n[rig] windows left OPEN for inspection. Ctrl-C to tear down.');
  await new Promise(() => {});
}

process.on('unhandledRejection', (r) => { console.error('[rig] UNHANDLED REJECTION', (r && r.stack) || r); process.exit(3); });
process.on('uncaughtException', (e) => { console.error('[rig] UNCAUGHT', e.stack || e); process.exit(4); });
main().catch((e) => { console.error('[rig] ERROR', e.stack || e); process.exit(1); });
