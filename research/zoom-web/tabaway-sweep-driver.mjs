#!/usr/bin/env node
// ---------------------------------------------------------------------------
// G3a Zoom-WEB tab-away measurement sweep DRIVER (demo-app sandbox).
//
// Mirrors research/teams-web/tabaway-sweep-driver.mjs (the G2a precedent) but for
// the Zoom WEB client (app.zoom.us/wc/). Drives the MEASURED Zoom-web guest tab in
// the PERSISTENT signed-in rig Chrome profile
// (research/meet-dom-detector/live/.rig-profiles/host), joined as a web guest via the
// /wc/join/<id>?pwd=<pwd>&un=<name> link to a meeting HOSTED by the NATIVE Zoom app.
// REAL mic (--use-fake-ui-for-media-stream, NO fake DEVICE) so the OS mic-device
// signal genuinely flips (Z5 — the mic-termination decision point). Clean-quit only
// (Browser.close → SIGTERM); NEVER SIGKILL/rmSync the persistent profile.
//
// Also (optionally) launches ONE EXTRA fake-audio guest in an EPHEMERAL profile
// (SIGKILL+rm ok) that can speak a looping WAV on demand — used to make the MEASURED
// tab AUDIBLE (remote speech playing = Chrome throttle exemption) for the Z3 audible
// sub-cell. Quiet sub-cell = extra guest silent + native host muted.
//
// Long-lived stdin/command-file REPL so the sweep can drive cells one at a time from
// Bash (AXSnapshot dumps + mic logging are orchestrated externally for precise
// timing). Commands (one per line in TW_CMD_FILE as `<seq> <cmd>`):
//   boot                 launch measured guest chrome (persistent profile)
//   join                 navigate the /wc/ link, clear name+audio join, report stage
//   audible-guest        launch the extra fake-audio guest + join (audible sub-cell)
//   fg                   Page.bringToFront the measured tab
//   bg                   open+activate a blank 2nd tab so measured tab is backgrounded
//   secondtab <url>      open a 2nd NAMED tab (e.g. app.zoom.us home) + activate it (Z9)
//   min                  minimize the measured guest window (Browser.setWindowBounds)
//   unmin                un-minimize
//   speak-on / speak-off toggle the EXTRA guest's fake speech (audible sub-cell)
//   mute / unmute        toggle the MEASURED tab's in-call mic via the Zoom web UI
//   rename <topic>       rename the meeting topic from the web UI if drivable (Z2b)
//   leave                click Leave in the measured tab
//   label                report the measured tab's document.title + url + audible
//   audible?             report measured tab Page audible state (best-effort)
//   quit                 clean-quit all Chromes and exit
// Every command prints one JSON line: {"seq":N,"ok":true,"cmd":..,"result":..}.
// ---------------------------------------------------------------------------
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync as _exists, writeFileSync as _write, rmSync } from 'node:fs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LIVE = join(REPO, 'research', 'meet-dom-detector', 'live');
const { attachToPage, httpJson, sleep, WS } = require(join(LIVE, 'cdp-lib.js'));
const { buildOverride } = require(join(LIVE, 'fake-mic-override.js'));

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HOST_PROFILE = join(LIVE, '.rig-profiles', 'host');
const GUEST_WAV = join(LIVE, 'fake-audio', 'guest.wav');
const MEASURED_PORT = 9371; // measured guest (persistent profile, real mic)
const AUDIBLE_PORT = 9372;  // extra fake-audio guest (ephemeral profile)

const INVITE = process.env.ZOOM_MEETING_URL;
if (!INVITE) { console.error(JSON.stringify({ ok: false, fatal: 'no ZOOM_MEETING_URL' })); process.exit(2); }

// invite (…zoom.us/j/<id>?pwd=<pwd>) → web-client join URL (same parse as
// qa/zoomweb-live/zoomweb-guest.mjs guestUrl()).
function guestUrl(inviteUrl, name) {
  const m = inviteUrl.match(/zoom\.us\/j\/(\d+)\?pwd=([\w.-]+)/);
  if (!m) throw new Error(`unparseable invite URL: ${inviteUrl}`);
  return `https://app.zoom.us/wc/join/${m[1]}?pwd=${m[2]}&un=${encodeURIComponent(name)}`;
}

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
  const profile = join('/tmp', `zoom-web-audible-${Date.now()}`);
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

// ---- Zoom-web guest join (name input -> Join -> join-audio-by-computer) -------
// Mirrors qa/zoomweb-live/zoomweb-guest.mjs join loop but standalone here.
function setNameInput(page, name) {
  return page.evalJs(`(() => {
    const i = document.querySelector('#input-for-name, input[type=text], input[placeholder*="name" i]');
    if (!i) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, ${JSON.stringify(name)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, 8_000);
}
function clickByText(page, reSrc) {
  return page.evalJs(`(() => {
    const re = ${reSrc};
    const els = [...document.querySelectorAll('button,[role=button],a')];
    const b = els.find(e => re.test((e.innerText || e.getAttribute('aria-label') || '').trim()));
    if (b) { b.click(); return true; } return false;
  })()`, 8_000);
}
function readState(page) {
  return page.evalJs(`(() => ({
    hasNameInput: !!document.querySelector('#input-for-name'),
    inFooter: !!document.querySelector('[aria-label*="mute" i], [class*="footer-button"]'),
    needsAudioJoin: /join audio by computer|join with computer audio/i.test(document.body?.innerText || ''),
    needsSignIn: /sign in to join|please sign in/i.test(document.body?.innerText || ''),
    url: location.href, title: document.title,
  }))()`, 8_000);
}

async function joinGuest(page, name, joinTimeoutMs = 120_000) {
  const url = guestUrl(INVITE, name);
  await page.cmd('Page.navigate', { url });
  const t0 = Date.now();
  let clickedJoin = false, lastState = {};
  while (Date.now() - t0 < joinTimeoutMs) {
    let st;
    try { st = await readState(page); } catch (e) { await sleep(1500); continue; }
    lastState = st;
    if (st.needsSignIn) return { stage: 'auth-wall', ...st };
    if (st.hasNameInput) {
      await setNameInput(page, name);
      await sleep(400);
      await clickByText(page, '/^join$/i');
      clickedJoin = true;
    }
    if (st.needsAudioJoin) await clickByText(page, '/join audio by computer|join with computer audio|join audio/i');
    if (clickedJoin && !st.hasNameInput && st.inFooter) {
      return { stage: 'in-call', ...st };
    }
    await sleep(2000);
  }
  return { stage: 'timeout', ...lastState };
}

// ---- window helpers over CDP ------------------------------------------------
async function measuredWindowId(page) {
  const t = await page.cmd('Target.getTargets', {});
  const list = (t.result && t.result.targetInfos) || [];
  const tgt = list.find((x) => x.type === 'page' && /app\.zoom\.us\/wc/.test(x.url || ''))
    || list.find((x) => x.type === 'page' && /zoom\.us/.test(x.url || ''))
    || list.find((x) => x.type === 'page');
  if (!tgt) return null;
  const w = await page.cmd('Browser.getWindowForTarget', { targetId: tgt.targetId });
  return (w.result && w.result.windowId) ?? null;
}

let measured = null;   // { page }
let audible = null;    // { proc, profile, page }

async function attachMeasured() {
  const page = await attachToPage(MEASURED_PORT, /about:blank|^$|zoom\./);
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
  const [word, ...rest] = cmd.split(/\s+/);
  const arg = rest.join(' ');
  try {
    if (word === 'boot') {
      launchMeasured();
      await sleep(3500);
      await attachMeasured();
      return emit({ ok: true, cmd: word, result: 'measured chrome up' });
    }
    if (word === 'join') {
      const r = await joinGuest(measured.page, process.env.ZOOM_GUEST_NAME || 'QA Web Guest');
      await sleep(4000);
      return emit({ ok: true, cmd: word, result: { stage: r.stage, url: r.url, title: r.title } });
    }
    if (word === 'audible-guest') {
      const g = launchAudibleGuest();
      await sleep(3500);
      const page = await attachToPage(AUDIBLE_PORT, /about:blank|^$/);
      await page.cmd('Page.addScriptToEvaluateOnNewDocument', { source: buildOverride(GUEST_WAV, 'AUDIBLE-GUEST') });
      audible = { ...g, page };
      const r = await joinGuest(page, 'QA Audible Guest');
      await sleep(6000);
      let ready = false;
      for (let i = 0; i < 20 && !ready; i++) { try { ready = await page.evalJs('!!window.__fakeMicSpeak'); } catch {} if (!ready) await sleep(500); }
      return emit({ ok: true, cmd: word, result: { stage: r.stage, fakeMicReady: ready } });
    }
    if (word === 'speak-on' || word === 'speak-off') {
      if (!audible) return emit({ ok: false, cmd: word, error: 'no audible guest' });
      const on = word === 'speak-on';
      await audible.page.evalJs(`(() => { if (${on} && window.__fakeMicResume) window.__fakeMicResume(); return window.__fakeMicSpeak && window.__fakeMicSpeak(${on}); })()`, 6_000);
      return emit({ ok: true, cmd: word, result: on ? 'speaking' : 'silent' });
    }
    if (word === 'fg') {
      await measured.page.cmd('Page.bringToFront');
      return emit({ ok: true, cmd: word, result: 'foreground' });
    }
    if (word === 'bg') {
      const nt = await measured.page.cmd('Target.createTarget', { url: 'about:blank' });
      const newId = nt.result && nt.result.targetId;
      if (newId) await measured.page.cmd('Target.activateTarget', { targetId: newId });
      return emit({ ok: true, cmd: word, result: 'backgrounded (blank tab activated)' });
    }
    if (word === 'secondtab') {
      const u = arg || 'https://app.zoom.us/';
      const nt = await measured.page.cmd('Target.createTarget', { url: u });
      const newId = nt.result && nt.result.targetId;
      if (newId) await measured.page.cmd('Target.activateTarget', { targetId: newId });
      return emit({ ok: true, cmd: word, result: `second tab opened+activated: ${u}` });
    }
    if (word === 'min') {
      const wid = await measuredWindowId(measured.page);
      if (wid == null) return emit({ ok: false, cmd: word, error: 'no windowId' });
      await measured.page.cmd('Browser.setWindowBounds', { windowId: wid, bounds: { windowState: 'minimized' } });
      return emit({ ok: true, cmd: word, result: 'minimized' });
    }
    if (word === 'unmin') {
      const wid = await measuredWindowId(measured.page);
      if (wid == null) return emit({ ok: false, cmd: word, error: 'no windowId' });
      await measured.page.cmd('Browser.setWindowBounds', { windowId: wid, bounds: { windowState: 'normal' } });
      return emit({ ok: true, cmd: word, result: 'normal' });
    }
    if (word === 'mute' || word === 'unmute') {
      await measured.page.cmd('Page.bringToFront');
      const want = word === 'mute'; // true = want muted
      const r = await measured.page.evalJs(`(() => {
        const els = [...document.querySelectorAll('button,[role=button]')];
        const findLbl = () => els.find(e => /^(un)?mute( my microphone| audio)?$/i.test((e.getAttribute('aria-label') || e.innerText || '').trim()));
        const b = findLbl();
        if (!b) return 'no-toggle';
        const label = (b.getAttribute('aria-label') || b.innerText).trim();
        const isMuted = /^unmute/i.test(label);   // "Unmute" shown ⇒ currently muted
        if (isMuted === ${want}) return 'already:' + label;
        b.click();
        return 'clicked:' + label;
      })()`, 8_000);
      return emit({ ok: true, cmd: word, result: r });
    }
    if (word === 'rename') {
      // Zoom web: Meeting Information / topic rename is host-only and lives behind the
      // "Meeting Information" (i) affordance; best-effort click-through. Reports what it found.
      await measured.page.cmd('Page.bringToFront');
      const r = await measured.page.evalJs(`(() => {
        const topic = ${JSON.stringify(arg)};
        // Try to open Meeting Information first.
        const info = [...document.querySelectorAll('button,[role=button],[aria-label]')]
          .find(e => /meeting information|meeting info/i.test((e.getAttribute('aria-label')||e.innerText||'')));
        if (info) info.click();
        // Look for an editable topic field.
        const inp = document.querySelector('input[aria-label*="topic" i], input[placeholder*="topic" i]');
        if (inp) {
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          set.call(inp, topic); inp.dispatchEvent(new Event('input', {bubbles:true}));
          return 'topic-field-found+set';
        }
        return info ? 'info-opened-no-topic-field' : 'no-info-affordance';
      })()`, 8_000);
      return emit({ ok: true, cmd: word, result: r });
    }
    if (word === 'leave') {
      await measured.page.cmd('Page.bringToFront');
      const r = await measured.page.evalJs(`(() => {
        const els = [...document.querySelectorAll('button,[role=button]')];
        // Zoom web: "Leave" opens a confirm popover with "Leave Meeting".
        let el = els.find(e => /^leave$/i.test((e.getAttribute('aria-label')||e.innerText||'').trim()));
        if (el) { el.click(); }
        // confirm
        setTimeout(() => {
          const c = [...document.querySelectorAll('button,[role=button]')]
            .find(e => /leave meeting|leave now/i.test((e.getAttribute('aria-label')||e.innerText||'').trim()));
          if (c) c.click();
        }, 600);
        return el ? 'clicked-leave' : 'no-leave';
      })()`, 8_000);
      // give the confirm click + navigation time to land
      await sleep(1500);
      return emit({ ok: true, cmd: word, result: r });
    }
    if (word === 'label') {
      const r = await measured.page.evalJs(`JSON.stringify({ title: document.title, url: location.href })`, 8_000);
      return emit({ ok: true, cmd: word, result: r });
    }
    if (word === 'audible?') {
      const r = await measured.page.evalJs(`(() => {
        const m = [...document.querySelectorAll('audio,video')];
        const playing = m.some(e => !e.paused && !e.muted && e.readyState > 2 && (e.currentTime>0));
        return JSON.stringify({ mediaEls: m.length, anyPlaying: playing });
      })()`, 6_000);
      return emit({ ok: true, cmd: word, result: r });
    }
    if (word === 'quit') {
      await cleanQuit(MEASURED_PORT);
      if (audible) { try { audible.proc.kill('SIGKILL'); } catch {} try { rmSync(audible.profile, { recursive: true, force: true }); } catch {} }
      emit({ ok: true, cmd: word, result: 'quit' });
      process.exit(0);
    }
    return emit({ ok: false, cmd: word, error: 'unknown command' });
  } catch (e) {
    return emit({ ok: false, cmd: word, error: (e && (e.message || String(e))) });
  }
}

// COMMAND-FILE POLLING model (robust across separate Bash invocations). Each command
// line is `<seq> <cmd>`; results carry the seq so the caller can await a specific reply.
const CMD_FILE = process.env.TW_CMD_FILE || join(HERE, 'tabaway-captures-2026-07-07', 'zw-cmd');
if (!_exists(CMD_FILE)) _write(CMD_FILE, '');
let lastSeq = 0;
emit({ ok: true, cmd: 'ready', invite: INVITE, hostProfile: HOST_PROFILE, cmdFile: CMD_FILE });

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
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s) => { try { const o = JSON.parse(String(s)); origWrite(JSON.stringify({ seq, ...o }) + '\n'); } catch { origWrite(s); } return true; };
      try { await handle(m[2]); } finally { process.stdout.write = origWrite; }
    }
    await sleep(400);
  }
}
pollLoop();
