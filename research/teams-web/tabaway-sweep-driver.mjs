#!/usr/bin/env node
// ---------------------------------------------------------------------------
// G2a Teams-WEB tab-away measurement sweep DRIVER (demo-app sandbox).
//
// Drives the MEASURED Teams-web guest tab in the PERSISTENT signed-in rig
// Chrome profile (research/meet-dom-detector/live/.rig-profiles/host), joined
// anonymously as a web guest to a teams.live.com meeting hosted by the NATIVE
// Teams app. REAL mic (--use-fake-ui-for-media-stream, NO fake DEVICE) so the
// OS mic-device signal genuinely flips (T5). Clean-quit only (Browser.close →
// SIGTERM); NEVER SIGKILL/rmSync the persistent profile.
//
// Also (optionally) launches ONE EXTRA fake-audio guest in an EPHEMERAL profile
// (SIGKILL+rm ok) that can speak a looping WAV on demand — used to make the
// MEASURED tab AUDIBLE (remote speech playing = Chrome throttle exemption) for
// the T3 audible sub-cell. Quiet sub-cell = extra guest silent + native host
// muted.
//
// This is a long-lived stdin REPL so the sweep can drive cells one at a time
// from Bash (AXSnapshot dumps + mic logging are orchestrated externally for
// precise timing). Commands (one JSON or bare word per line on stdin):
//   join                 launch measured guest, join meeting, report stage
//   audible-guest        launch the extra fake-audio guest + join (for audible sub-cell)
//   fg                   Page.bringToFront the measured tab
//   bg                   open+activate a blank 2nd tab so measured tab is backgrounded
//   min                  minimize the measured guest window (Browser.setWindowBounds)
//   unmin                un-minimize
//   speak-on / speak-off toggle the EXTRA guest's fake speech (audible sub-cell)
//   mute / unmute        toggle the MEASURED tab's in-call mic via the Teams web UI
//   leave                click Leave in the measured tab
//   label                report the measured tab's current document.title + url + audible
//   audible?             report measured tab Page audible state (best-effort)
//   quit                 clean-quit all Chromes and exit
// Every command prints one JSON line: {"ok":true,"cmd":..,"result":..}.
// ---------------------------------------------------------------------------
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LIVE = join(REPO, 'research', 'meet-dom-detector', 'live');
const { attachToPage, httpJson, sleep, WS } = require(join(LIVE, 'cdp-lib.js'));
const { buildOverride } = require(join(LIVE, 'fake-mic-override.js'));

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HOST_PROFILE = join(LIVE, '.rig-profiles', 'host');
const GUEST2_WAV = join(LIVE, 'fake-audio', 'guest.wav');
const MEASURED_PORT = 9351; // measured guest (persistent profile, real mic)
const AUDIBLE_PORT = 9352;  // extra fake-audio guest (ephemeral profile)

const URL = process.env.TEAMS_MEETING_URL;
if (!URL) { console.error(JSON.stringify({ ok: false, fatal: 'no TEAMS_MEETING_URL' })); process.exit(2); }

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// ---- launch the MEASURED guest: persistent profile, REAL mic, clean-quit -----
function launchMeasured() {
  const args = [
    `--remote-debugging-port=${MEASURED_PORT}`, `--user-data-dir=${HOST_PROFILE}`,
    '--profile-directory=Default',
    '--no-first-run', '--no-default-browser-check', '--restore-last-session=false',
    '--use-fake-ui-for-media-stream',           // auto-grant gUM, REAL default mic (no fake device)
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: 'ignore', detached: true });
  proc.unref();
  return proc;
}

// ---- launch the EXTRA fake-audio guest: ephemeral profile, SIGKILL ok --------
function launchAudibleGuest() {
  const profile = join('/tmp', `teams-web-audible-${Date.now()}`);
  const args = [
    `--remote-debugging-port=${AUDIBLE_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: 'ignore', detached: true });
  proc.unref();
  return { proc, profile };
}

// ---- Teams-web anonymous guest join (continue-on-web -> name -> mic -> join) --
async function joinGuest(page, name, opts = {}) {
  const click = (needle) => page.evalJs(`(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"]')];
    const el = els.find(e => (e.innerText || '').trim().toLowerCase().includes(${JSON.stringify(needle)}));
    if (el) { el.click(); return (el.innerText || '').trim(); } return null;
  })()`, 10_000);

  await page.cmd('Page.navigate', { url: URL });
  // 1) Continue on this browser / Join on the web.
  let continued = false;
  for (let i = 0; i < 24 && !continued; i++) {
    if (await click('continue on this browser') || await click('join on the web')) { continued = true; break; }
    await sleep(1500);
  }
  await sleep(6000);
  // 2) Type the guest display name.
  await page.evalJs(`(() => {
    const inp = document.querySelector('input[placeholder*="name" i], input[type="text"]');
    if (!inp) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, ${JSON.stringify(name)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`, 8_000);
  await sleep(1200);
  // 3) Mic ON (real mic guest wants to be unmuted so T5 device-hold is testable).
  //    Best-effort: if the pre-join toggle reads muted, click it.
  const micState = await page.evalJs(`(() => {
    const t = document.querySelector('[data-tid*="toggle-mute"], [aria-label*="microphone" i][role="switch"], [title*="Unmute" i], [aria-label*="Unmute" i]');
    if (t && (t.getAttribute('aria-checked') === 'false' || /unmute/i.test((t.getAttribute('title')||t.getAttribute('aria-label')||'')))) { t.click(); return 'clicked-unmute'; }
    return t ? 'already-on-or-unknown' : 'no-toggle';
  })()`, 8_000);
  // 4) Join now.
  let joined = false;
  for (let i = 0; i < 16 && !joined; i++) {
    if (await click('join now') || await click('join meeting')) { joined = true; break; }
    await sleep(1500);
  }
  return { continued, micState, joined };
}

async function classify(page) {
  const snap = await page.evalJs(`(() => {
    const btns = [...document.querySelectorAll('button, a, [role="button"]')].map(e => (e.innerText||'').trim()).filter(Boolean).slice(0,40);
    const body = (document.body ? document.body.innerText : '').slice(0,3000);
    return JSON.stringify({ url: location.href, title: document.title, btns, body });
  })()`, 10_000);
  let s = {}; try { s = JSON.parse(snap); } catch { s = {}; }
  const hay = ((s.body||'') + ' ' + (s.btns||[]).join(' ') + ' ' + (s.title||'')).toLowerCase();
  const inCall = /\bleave\b|hang up|call controls|meeting controls|raise( your)? hand|\bpeople\b|more actions/.test(hay)
    && !/waiting for|someone will let you in|let you in/.test(hay);
  const lobby = /waiting for|someone will let you in|let you in|when the meeting starts/.test(hay);
  const authWall = /sign in|sign-in|log in|work or school account|not allowed to join|can'?t join|isn'?t allowed|blocked by your organization/.test(hay) && !inCall;
  const stage = inCall ? 'in-call' : lobby ? 'lobby' : authWall ? 'auth-wall' : 'unknown';
  return { stage, snap: s };
}

// ---- window helpers over CDP ------------------------------------------------
async function measuredWindowId(page) {
  const t = await page.cmd('Target.getTargets', {});
  const list = (t.result && t.result.targetInfos) || [];
  const tgt = list.find((x) => x.type === 'page' && /teams\.(live|microsoft)\.com/.test(x.url||''))
    || list.find((x) => x.type === 'page');
  if (!tgt) return null;
  const w = await page.cmd('Browser.getWindowForTarget', { targetId: tgt.targetId });
  return (w.result && w.result.windowId) ?? null;
}

let measured = null;   // { proc, page }
let audible = null;    // { proc, profile, page }

async function attachMeasured() {
  const page = await attachToPage(MEASURED_PORT, /about:blank|^$|teams\./);
  measured = { page };
  return page;
}

async function cleanQuit(port) {
  try {
    const v = await httpJson(port, '/json/version');
    const wsUrl = v && v.webSocketDebuggerUrl;
    if (wsUrl) { const ws = new WS(wsUrl); await ws.connect(); ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); await sleep(1500); ws.close(); }
  } catch {}
}

// ---- command dispatch -------------------------------------------------------
async function handle(line) {
  const cmd = line.trim();
  if (!cmd) return;
  try {
    if (cmd === 'boot') {
      launchMeasured();
      await sleep(3500);
      await attachMeasured();
      return emit({ ok: true, cmd, result: 'measured chrome up' });
    }
    if (cmd === 'join') {
      const r = await joinGuest(measured.page, process.env.TEAMS_GUEST_NAME || 'QA Web Guest');
      await sleep(9000);
      const c = await classify(measured.page);
      return emit({ ok: true, cmd, result: { join: r, stage: c.stage, url: c.snap.url, title: c.snap.title } });
    }
    if (cmd === 'audible-guest') {
      const g = launchAudibleGuest();
      await sleep(3500);
      const page = await attachToPage(AUDIBLE_PORT, /about:blank|^$/);
      await page.cmd('Page.addScriptToEvaluateOnNewDocument', { source: buildOverride(GUEST2_WAV, 'AUDIBLE-GUEST') });
      audible = { ...g, page };
      const r = await joinGuest(page, 'QA Audible Guest');
      await sleep(8000);
      const c = await classify(page);
      // assert fake mic live
      let ready = false;
      for (let i = 0; i < 20 && !ready; i++) { ready = await page.evalJs('!!window.__fakeMicReady'); if (!ready) await sleep(500); }
      return emit({ ok: true, cmd, result: { join: r, stage: c.stage, fakeMicReady: ready } });
    }
    if (cmd === 'speak-on' || cmd === 'speak-off') {
      if (!audible) return emit({ ok: false, cmd, error: 'no audible guest' });
      const on = cmd === 'speak-on';
      await audible.page.evalJs(`window.__fakeMicSpeak && window.__fakeMicSpeak(${on})`, 6_000);
      return emit({ ok: true, cmd, result: on ? 'speaking' : 'silent' });
    }
    if (cmd === 'fg') {
      await measured.page.cmd('Page.bringToFront');
      return emit({ ok: true, cmd, result: 'foreground' });
    }
    if (cmd === 'bg') {
      // Open + activate a fresh blank tab in the SAME window so the Teams tab is
      // backgrounded (matches the Meet sweep's tabAway).
      const nt = await measured.page.cmd('Target.createTarget', { url: 'about:blank' });
      const newId = nt.result && nt.result.targetId;
      if (newId) await measured.page.cmd('Target.activateTarget', { targetId: newId });
      return emit({ ok: true, cmd, result: 'backgrounded (blank tab activated)' });
    }
    if (cmd === 'min') {
      const wid = await measuredWindowId(measured.page);
      if (wid == null) return emit({ ok: false, cmd, error: 'no windowId' });
      await measured.page.cmd('Browser.setWindowBounds', { windowId: wid, bounds: { windowState: 'minimized' } });
      return emit({ ok: true, cmd, result: 'minimized' });
    }
    if (cmd === 'unmin') {
      const wid = await measuredWindowId(measured.page);
      if (wid == null) return emit({ ok: false, cmd, error: 'no windowId' });
      await measured.page.cmd('Browser.setWindowBounds', { windowId: wid, bounds: { windowState: 'normal' } });
      return emit({ ok: true, cmd, result: 'normal' });
    }
    if (cmd === 'mute' || cmd === 'unmute') {
      // Toggle the measured tab's in-call mic via the Teams web UI. Must be
      // foreground for the click to register reliably.
      await measured.page.cmd('Page.bringToFront');
      const want = cmd; // 'mute' or 'unmute'
      const r = await measured.page.evalJs(`(() => {
        const els = [...document.querySelectorAll('button,[role="button"],[role="menuitemcheckbox"],[data-tid]')];
        const findByLabel = (rx) => els.find(e => rx.test(((e.getAttribute('aria-label')||'') + ' ' + (e.getAttribute('title')||'') + ' ' + (e.innerText||'')).trim()));
        const el = ${want === 'mute'}
          ? findByLabel(/\\bmute\\b/i) && !findByLabel(/unmute/i) ? findByLabel(/\\bmute\\b/i) : findByLabel(/^mute|mute mic|mute microphone/i)
          : findByLabel(/unmute/i);
        if (!el) return 'no-toggle';
        el.click();
        return (el.getAttribute('aria-label')||el.getAttribute('title')||el.innerText||'').trim().slice(0,40);
      })()`, 8_000);
      return emit({ ok: true, cmd, result: r });
    }
    if (cmd === 'leave') {
      await measured.page.cmd('Page.bringToFront');
      const r = await measured.page.evalJs(`(() => {
        const els = [...document.querySelectorAll('button,[role="button"],[data-tid]')];
        const el = els.find(e => /^leave$|leave meeting|hang up/i.test(((e.getAttribute('aria-label')||'') + ' ' + (e.innerText||'')).trim()));
        if (!el) return 'no-leave';
        el.click();
        return (el.getAttribute('aria-label')||el.innerText||'').trim().slice(0,40);
      })()`, 8_000);
      return emit({ ok: true, cmd, result: r });
    }
    if (cmd === 'label') {
      const r = await measured.page.evalJs('JSON.stringify({ title: document.title, url: location.href })', 8_000);
      return emit({ ok: true, cmd, result: r });
    }
    if (cmd === 'audible?') {
      // Best-effort: report whether any <audio>/<video> element is currently playing.
      const r = await measured.page.evalJs(`(() => {
        const m = [...document.querySelectorAll('audio,video')];
        const playing = m.some(e => !e.paused && !e.muted && e.readyState > 2 && (e.currentTime>0));
        return JSON.stringify({ mediaEls: m.length, anyPlaying: playing });
      })()`, 6_000);
      return emit({ ok: true, cmd, result: r });
    }
    if (cmd === 'quit') {
      await cleanQuit(MEASURED_PORT);
      if (audible) { try { audible.proc.kill('SIGKILL'); } catch {} try { require('node:fs').rmSync(audible.profile, { recursive: true, force: true }); } catch {} }
      emit({ ok: true, cmd, result: 'quit' });
      process.exit(0);
    }
    return emit({ ok: false, cmd, error: 'unknown command' });
  } catch (e) {
    return emit({ ok: false, cmd, error: (e && (e.message || String(e))) });
  }
}

// COMMAND-FILE POLLING model (robust across separate Bash invocations that can't
// keep a FIFO write-fd open): the driver tails a command file, executing each new
// line exactly once. Each command line is `<seq> <cmd>`; results carry the seq so
// the caller can await a specific reply. Set TW_CMD_FILE.
const CMD_FILE = process.env.TW_CMD_FILE || join(HERE, 'tabaway-captures-2026-07-07', 'tw-cmd');
import { readFileSync, existsSync as _exists, writeFileSync as _write } from 'node:fs';
if (!_exists(CMD_FILE)) _write(CMD_FILE, '');
let lastSeq = 0;
emit({ ok: true, cmd: 'ready', url: URL, hostProfile: HOST_PROFILE, cmdFile: CMD_FILE });

async function pollLoop() {
  for (;;) {
    let lines = [];
    try { lines = readFileSync(CMD_FILE, 'utf8').split('\n').filter(Boolean); } catch {}
    for (const raw of lines) {
      const m = raw.match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const seq = Number(m[1]);
      if (seq <= lastSeq) continue;
      lastSeq = seq;
      const before = (o) => emit({ seq, ...o });
      // Wrap handle() so the emitted line carries the seq.
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s) => { try { const o = JSON.parse(String(s)); origWrite(JSON.stringify({ seq, ...o }) + '\n'); } catch { origWrite(s); } return true; };
      try { await handle(m[2]); } finally { process.stdout.write = origWrite; }
    }
    await sleep(400);
  }
}
pollLoop();
