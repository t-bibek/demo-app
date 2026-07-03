'use strict';
// ============================================================================
// 3-participant roster rig (host + 2 anonymous guests) for AX ROSTER capture.
//
// Reuses the committed rig building blocks (cdp-lib, fake-mic-override,
// admit-guest). Brings up a HOST (signed-in .rig-profiles/host) + Guest A + Guest
// B (two anonymous temp profiles, distinct typed names, distinct fake voices),
// joins/admits both, then LEAVES ALL WINDOWS OPEN so an external AXSnapshot pass
// can dump the host page (panel-closed then panel-open).
//
//   node roster-rig-3p.js new "Guest A" "Guest B"     # host creates a fresh room
//   node roster-rig-3p.js <url> "Guest A" "Guest B"   # join an existing room
//
// Ports: host 9224, guestA 9226, guestB 9227.
// Writes the resolved meeting URL + host port to ./.roster-rig-state.json.
// ============================================================================
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn, execSync } = require('child_process');
const { CHROME, sleep, httpJson, attachToPage } = require('./cdp-lib.js');
const { buildOverride } = require('./fake-mic-override.js');
const { admit } = require('./admit-guest.js');

const MEET_ARG = process.argv[2] || 'new';
const GUEST_A_NAME = process.argv[3] || 'Guest Alpha';
const GUEST_B_NAME = process.argv[4] || 'Guest Bravo';
const HOST = { port: 9224, wav: path.join(__dirname, 'fake-audio', 'host.wav'), profile: path.join(__dirname, '.rig-profiles', 'host') };
const GUEST_A = { port: 9226, wav: path.join(__dirname, 'fake-audio', 'guest.wav'), name: GUEST_A_NAME };
const GUEST_B = { port: 9227, wav: path.join(__dirname, 'fake-audio', 'guestb.wav'), name: GUEST_B_NAME };
const log = (...a) => console.log('[roster-rig]', ...a);

async function launch({ port, profile, wav, label }) {
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    'about:blank',
  ], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(300); try { const l = await httpJson(port, '/json'); if (Array.isArray(l)) target = l.find((t) => t.type === 'page'); } catch (e) {} }
  if (!target) throw new Error(`[${label}] no page target on :${port}`);
  const conn = await attachToPage(port, /about:blank|/);
  await conn.cmd('Page.addScriptToEvaluateOnNewDocument', { source: buildOverride(wav, label) });
  return { proc, port, conn, profile, kill() { try { proc.kill('SIGKILL'); } catch (e) {} } };
}

async function cdpClick(page, x, y) {
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y) });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
}
const CENTER = `function(rx){var re=new RegExp(rx,"i");var el=[...document.querySelectorAll("button,[role=button]")].find(function(n){return n.getBoundingClientRect().width>0&&re.test((n.getAttribute("aria-label")||"")+" "+(n.textContent||""));});if(!el)return "null";var r=el.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,label:(el.getAttribute("aria-label")||el.textContent||"").replace(/\\s+/g," ").trim().slice(0,30)});}`;
const CLICK = `function(rx){var re=new RegExp(rx,"i");var el=[...document.querySelectorAll("button,[role=button]")].find(function(n){return n.getBoundingClientRect().width>0&&re.test((n.getAttribute("aria-label")||"")+" "+(n.textContent||""));});if(!el)return "null";el.click();return (el.getAttribute("aria-label")||el.textContent||"").replace(/\\s+/g," ").trim().slice(0,30);}`;

async function waitPrejoin(conn) {
  for (let i = 0; i < 50; i++) {
    const ok = await conn.evalJs(`/meet\\.google\\.com/.test(location.href)&&!![...document.querySelectorAll("button,[role=button]")].find(function(b){return /join now|ask to join/i.test((b.getAttribute("aria-label")||b.textContent||""))})`);
    if (ok) return true; await sleep(500);
  }
  return false;
}
const inCall = (pg) => pg.evalJs(`!![...document.querySelectorAll("button")].find(function(b){return /leave call/i.test(b.getAttribute("aria-label")||"")})`);

async function hostJoin(host) {
  if (await inCall(host)) return true;
  await waitPrejoin(host); await sleep(2000);
  if (await inCall(host)) return true;
  let t = JSON.parse(await host.evalJs(`(${CENTER})("Turn off camera")`) || 'null'); if (t) { await cdpClick(host, t.x, t.y); await sleep(400); }
  t = JSON.parse(await host.evalJs(`(${CENTER})("^Join now$|Join now")`) || 'null');
  if (t) { await cdpClick(host, t.x, t.y); }
  else {
    await host.evalJs(`(${CLICK})("Not now")`); await sleep(300);
    await host.evalJs(`(${CLICK})("Other ways to join")`); await sleep(800);
    const c = await host.evalJs(`(${CLICK})("Join here too")`);
    if (c === 'null') throw new Error('host: neither "Join now" nor "Join here too" found');
  }
  for (let i = 0; i < 20; i++) { await sleep(1500); if (await inCall(host)) return true; }
  return false;
}

async function guestAsk(guest, name) {
  await waitPrejoin(guest); await sleep(2000);
  await guest.evalJs(`(function(){var i=document.querySelector("input[type=text][aria-label], input[jsname][type=text]");if(i){i.value=${JSON.stringify(name)};i.dispatchEvent(new Event("input",{bubbles:true}));i.dispatchEvent(new Event("change",{bubbles:true}));}})()`);
  await sleep(500);
  await guest.evalJs(`(${CLICK})("Got it")`); await sleep(300);
  await guest.evalJs(`(${CLICK})("Turn off camera")`); await sleep(300);
  const c = await guest.evalJs(`(${CLICK})("Ask to join|Join now")`);
  return c;
}

async function main() {
  const keepAlive = setInterval(() => {}, 1 << 30);
  const guestAProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-anonA-'));
  const guestBProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-anonB-'));

  log(`launching HOST :${HOST.port} + GUEST A :${GUEST_A.port} ("${GUEST_A.name}") + GUEST B :${GUEST_B.port} ("${GUEST_B.name}")`);
  const hostChrome = await launch({ port: HOST.port, profile: HOST.profile, wav: HOST.wav, label: 'HOST' });
  const guestAChrome = await launch({ port: GUEST_A.port, profile: guestAProfile, wav: GUEST_A.wav, label: 'GUEST_A' });
  const guestBChrome = await launch({ port: GUEST_B.port, profile: guestBProfile, wav: GUEST_B.wav, label: 'GUEST_B' });
  const cleanup = () => { clearInterval(keepAlive); hostChrome.kill(); guestAChrome.kill(); guestBChrome.kill();
    try { execSync(`rm -rf ${guestAProfile} ${guestBProfile}`); } catch (e) {} };
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  // Resolve meeting URL (host creates fresh room, or navigate to given URL).
  let meetingUrl = MEET_ARG;
  if (meetingUrl === 'new') {
    await hostChrome.conn.cmd('Page.navigate', { url: 'https://meet.google.com/new' });
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      meetingUrl = (await hostChrome.conn.evalJs('location.href')) || '';
      await hostChrome.conn.evalJs(`(function(){var b=[...document.querySelectorAll("button,span")].find(function(n){return /^(Join now|Ask to join)$/i.test((n.textContent||"").trim())});if(b)b.click();})()`);
      if (/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(meetingUrl)) break;
    }
    meetingUrl = meetingUrl.split('?')[0];
    log(`created meeting ${meetingUrl}`);
  } else {
    await hostChrome.conn.cmd('Page.navigate', { url: meetingUrl });
    await waitPrejoin(hostChrome.conn);
  }
  const code = (meetingUrl.match(/meet\.google\.com\/([a-z-]+)/i) || [])[1] || '';

  const host = hostChrome.conn, guestA = guestAChrome.conn, guestB = guestBChrome.conn;
  const hIn = await hostJoin(host);
  log(`host in call: ${hIn}`);
  if (!hIn) throw new Error('host failed to join');

  // Guest A joins + admit
  await guestA.cmd('Page.navigate', { url: meetingUrl });
  const gaAsk = await guestAsk(guestA, GUEST_A.name);
  log(`guest A asked to join: ${gaAsk}`);
  const aAdmit = await admit({ hostPort: HOST.port, guestPorts: [GUEST_A.port], guestName: GUEST_A.name, timeoutSec: 90, log });
  log(`guest A admitted: ${aAdmit}`);

  // Guest B joins + admit
  await guestB.cmd('Page.navigate', { url: meetingUrl });
  const gbAsk = await guestAsk(guestB, GUEST_B.name);
  log(`guest B asked to join: ${gbAsk}`);
  const bAdmit = await admit({ hostPort: HOST.port, guestPorts: [GUEST_B.port], guestName: GUEST_B.name, timeoutSec: 90, log });
  log(`guest B admitted: ${bAdmit}`);

  await sleep(3000);
  // Report the host's stage tiles as a sanity check.
  const tiles = await host.evalJs(`(function(){return JSON.stringify([...document.querySelectorAll('[data-participant-id]')].filter(function(t){if(t.closest('[role=list],[role=listitem],[role=dialog],[role=complementary],aside'))return false;var r=t.getBoundingClientRect();return r.width>=150&&r.height>=84;}).map(function(t){return ((t.querySelector('span.notranslate,[data-self-name]')||{}).textContent||'').trim();}));})()`);
  log(`host stage tiles: ${tiles}`);

  const hostPid = await (async () => {
    // Find the host Chrome PID by matching the rig-profiles/host user-data-dir.
    try {
      const out = execSync(`ps -Ao pid,command | grep -i 'Google Chrome' | grep 'rig-profiles/host' | grep -v grep | grep -v Helper | head -1`).toString().trim();
      return (out.match(/^(\d+)/) || [])[1] || '';
    } catch (e) { return ''; }
  })();

  const state = { meetingUrl, code, hostPort: HOST.port, hostPid, guestA: GUEST_A.name, guestB: GUEST_B.name,
    hostAdmittedA: aAdmit, hostAdmittedB: bAdmit, tiles: JSON.parse(tiles || '[]') };
  fs.writeFileSync(path.join(__dirname, '.roster-rig-state.json'), JSON.stringify(state, null, 2));
  log(`STATE: ${JSON.stringify(state)}`);
  log('READY. Windows left OPEN. Run AXSnapshot against the host, then Ctrl-C to tear down.');
  await new Promise(() => {});
}

process.on('unhandledRejection', (r) => { console.error('[roster-rig] UNHANDLED', (r && r.stack) || r); });
process.on('uncaughtException', (e) => { console.error('[roster-rig] UNCAUGHT', e.stack || e); });
main().catch((e) => { console.error('[roster-rig] ERROR', e.stack || e); process.exit(1); });
