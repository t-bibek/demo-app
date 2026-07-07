#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CONSUMER /v2/ in-call tree measurement DRIVER (demo-app sandbox).
//
// Drives the MEASURED Teams-web guest tab in the PERSISTENT signed-in rig Chrome
// profile, joined anonymously as a web guest to a teams.live.com/meet/<id>
// meeting hosted by the NATIVE Teams app. Purpose: capture DEEP plain-`chrome`
// AXSnapshot dumps of the guest tab across the C1..C5 cells for the
// consumer-detection-extension gate (landmark predicate, identity hunt, tiles,
// URL shapes). Ports the proven join flow from tabaway-sweep-driver.mjs and adds
// the cells this gate needs:
//   boot            launch measured chrome (persistent profile, real mic)
//   join-greenroom  navigate + continue-on-web + type name + STOP at green room
//                   (Join button present, Leave absent) — the C3 negative control
//   join-now        click Join now (green room -> in-call) — reach C1
//   panel-open      open the People/participants panel (roster + share source)
//   share-open      open the Share-invite tray inside the People panel (id hunt)
//   panel-close     close the People panel
//   leave           click Leave (post-leave landing, C4)
//   label           report document.title + location.href
//   dom-id-hunt     evalJs grep of the LIVE DOM for the meeting <id> + meet/ frags
//   quit            clean-quit (Browser.close -> SIGTERM); NEVER SIGKILL the profile
// Every command prints one JSON line. Command-file polling model (TW_CMD_FILE),
// identical to tabaway-sweep-driver so a separate Bash caller can drive cells.
// ---------------------------------------------------------------------------
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync as _exists, writeFileSync as _write } from 'node:fs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LIVE = join(REPO, 'research', 'meet-dom-detector', 'live');
const { attachToPage, httpJson, sleep, WS } = require(join(LIVE, 'cdp-lib.js'));

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HOST_PROFILE = join(LIVE, '.rig-profiles', 'host');
const MEASURED_PORT = 9351;

const URL = process.env.TEAMS_MEETING_URL;
if (!URL) { console.error(JSON.stringify({ ok: false, fatal: 'no TEAMS_MEETING_URL' })); process.exit(2); }
const GUEST_NAME = process.env.TEAMS_GUEST_NAME || 'QA Web Guest';

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function launchMeasured() {
  const args = [
    `--remote-debugging-port=${MEASURED_PORT}`, `--user-data-dir=${HOST_PROFILE}`,
    '--profile-directory=Default',
    '--no-first-run', '--no-default-browser-check', '--restore-last-session=false',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: 'ignore', detached: true });
  proc.unref();
  return proc;
}

let measured = null;

// Attach preferring the IN-CALL meeting tab (title contains "Meeting with"), else
// any teams.live.com tab, else the last blank tab. Both the meeting AND the chat
// tab are teams.live.com/v2/, so a url-only match is ambiguous — select by title.
async function attachMeasured() {
  const require2 = createRequire(import.meta.url);
  const { WS: _WS } = require2(join(LIVE, 'cdp-lib.js'));
  const http = require2('node:http');
  const list = () => new Promise((res) => {
    http.get({ host: '127.0.0.1', port: MEASURED_PORT, path: '/json' }, (r) => {
      let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { res(JSON.parse(b)); } catch { res([]); } });
    }).on('error', () => res([]));
  });
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    const l = (await list()).filter((t) => t.type === 'page');
    target = l.find((t) => /meeting with/i.test(t.title || ''))
      || l.find((t) => /teams\.(live|microsoft)\.com/.test(t.url || '') && !/chat \|/i.test(t.title || ''))
      || l.find((t) => /teams\./.test(t.url || ''));
    if (!target) await sleep(400);
  }
  if (!target) throw new Error('no meeting tab found on ' + MEASURED_PORT);
  // Attach directly to THIS target's webSocketDebuggerUrl (unambiguous — the meeting
  // and chat tabs share the /v2/ URL, so a url regex can't distinguish them).
  const ws = new _WS(target.webSocketDebuggerUrl); await ws.connect();
  let id = 0; const waiters = new Map();
  ws.onmessage = (m) => { let o; try { o = JSON.parse(m); } catch { return; } if (o.id && waiters.has(o.id)) { const w = waiters.get(o.id); waiters.delete(o.id); clearTimeout(w.timer); w.resolve(o); } };
  const cmd = (method, params, timeoutMs) => new Promise((resolve, reject) => {
    const mid = ++id; const ms = timeoutMs == null ? 15000 : timeoutMs;
    const timer = ms > 0 ? setTimeout(() => { if (waiters.has(mid)) { waiters.delete(mid); reject(new Error(`CDP ${method} timeout`)); } }, ms) : null;
    waiters.set(mid, { resolve, timer });
    try { ws.send(JSON.stringify({ id: mid, method, params: params || {} })); } catch (e) { if (waiters.has(mid)) { waiters.delete(mid); clearTimeout(timer); reject(e); } }
  });
  const evalJs = async (expr, timeoutMs) => { const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs); return r.result && r.result.result && r.result.result.value; };
  await cmd('Runtime.enable'); await cmd('Page.enable');
  measured = { page: { ws, cmd, evalJs }, targetTitle: target.title, targetUrl: target.url };
  return measured.page;
}

// navigate + continue-on-web + type name; STOP before Join now.
async function joinGreenroom(page, name) {
  const click = (needle) => page.evalJs(`(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"]')];
    const el = els.find(e => (e.innerText || '').trim().toLowerCase().includes(${JSON.stringify(needle)}));
    if (el) { el.click(); return (el.innerText || '').trim(); } return null;
  })()`, 10_000);
  await page.cmd('Page.navigate', { url: URL });
  let continued = false;
  for (let i = 0; i < 24 && !continued; i++) {
    if (await click('continue on this browser') || await click('join on the web')) { continued = true; break; }
    await sleep(1500);
  }
  await sleep(6000);
  await page.evalJs(`(() => {
    const inp = document.querySelector('input[placeholder*="name" i], input[type="text"]');
    if (!inp) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, ${JSON.stringify(name)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`, 8_000);
  await sleep(1500);
  // Report whether a Join affordance is now present (green room) without clicking it.
  const gr = await page.evalJs(`(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"]')];
    const join = els.some(e => /join now|join meeting|^join$/i.test((e.innerText||'').trim()));
    const leave = els.some(e => /^leave$|leave meeting|hang up/i.test((e.innerText||'').trim()));
    return JSON.stringify({ url: location.href, title: document.title, joinPresent: join, leavePresent: leave });
  })()`, 8_000);
  return { continued, greenroom: gr };
}

async function clickJoinNow(page) {
  const click = (needle) => page.evalJs(`(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"]')];
    const el = els.find(e => (e.innerText || '').trim().toLowerCase().includes(${JSON.stringify(needle)}));
    if (el) { el.click(); return (el.innerText || '').trim(); } return null;
  })()`, 10_000);
  let joined = false;
  for (let i = 0; i < 16 && !joined; i++) {
    if (await click('join now') || await click('join meeting')) { joined = true; break; }
    await sleep(1500);
  }
  return joined;
}

async function pressLabel(page, rx) {
  return page.evalJs(`(() => {
    const els = [...document.querySelectorAll('button,[role="button"],[data-tid],a')];
    const el = els.find(e => (${rx}).test(((e.getAttribute('aria-label')||'') + ' ' + (e.getAttribute('title')||'') + ' ' + (e.innerText||'')).trim()));
    if (!el) return 'not-found';
    el.click();
    return (el.getAttribute('aria-label')||el.getAttribute('title')||el.innerText||'').trim().slice(0,60);
  })()`, 8_000);
}

async function handle(line) {
  const cmd = line.trim();
  if (!cmd) return;
  try {
    if (cmd === 'boot') {
      launchMeasured(); await sleep(3500); await attachMeasured();
      return emit({ ok: true, cmd, result: { attached: measured.targetTitle, url: measured.targetUrl } });
    }
    if (cmd === 'reattach') {
      await attachMeasured();
      return emit({ ok: true, cmd, result: { attached: measured.targetTitle, url: measured.targetUrl } });
    }
    if (cmd === 'join-greenroom') {
      const r = await joinGreenroom(measured.page, GUEST_NAME);
      return emit({ ok: true, cmd, result: r });
    }
    if (cmd === 'join-now') {
      const joined = await clickJoinNow(measured.page);
      await sleep(9000);
      const r = await measured.page.evalJs('JSON.stringify({ title: document.title, url: location.href })', 8_000);
      return emit({ ok: true, cmd, result: { joined, label: r } });
    }
    if (cmd === 'panel-open') {
      await measured.page.cmd('Page.bringToFront');
      const r = await pressLabel(measured.page, '/^people$|participants|show participants|roster/i');
      await sleep(3000);
      return emit({ ok: true, cmd, result: r });
    }
    if (cmd === 'roster-incall') {
      // Press the IN-CALL roster toggle precisely by its DOM id (#roster-button in
      // the calling controls), NOT the app-bar People contacts button.
      await measured.page.cmd('Page.bringToFront');
      const r = await measured.page.evalJs(`(() => {
        const el = document.querySelector('#roster-button, [id="roster-button"], button[aria-label*="participant" i], button[title*="participant" i]');
        if (!el) return 'not-found';
        el.click();
        return (el.getAttribute('aria-label')||el.getAttribute('title')||el.id||'').slice(0,60);
      })()`, 8_000);
      await sleep(3000);
      return emit({ ok: true, cmd, result: r });
    }
    if (cmd === 'share-incall') {
      // In-call share flow: press the roster's "Share invite"/"Add people"/"Copy join info"
      // by DOM/aria. Reports what it clicked.
      const r = await measured.page.evalJs(`(() => {
        const q = [...document.querySelectorAll('button,[role="button"],a,[data-tid]')];
        const el = q.find(e => /share invite|copy meeting link|copy join info|add people|invite someone|copy link|share meeting/i.test(((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')+' '+(e.innerText||'')).trim()));
        if (!el) return 'not-found';
        el.click();
        return (el.getAttribute('aria-label')||el.getAttribute('title')||el.innerText||'').trim().slice(0,60);
      })()`, 8_000);
      await sleep(2500);
      return emit({ ok: true, cmd, result: r });
    }
    if (cmd === 'panel-close') {
      const r = await pressLabel(measured.page, '/^people$|close (people|roster|participants)/i');
      await sleep(1500);
      return emit({ ok: true, cmd, result: r });
    }
    if (cmd === 'share-open') {
      // Inside the People panel: the share-invite affordance.
      const r = await pressLabel(measured.page, '/share invite|copy join info|invite someone|share meeting|add people|copy meeting link|share link/i');
      await sleep(2500);
      return emit({ ok: true, cmd, result: r });
    }
    if (cmd === 'leave') {
      await measured.page.cmd('Page.bringToFront');
      const r = await pressLabel(measured.page, '/^leave$|leave meeting|hang up/i');
      await sleep(6000);
      const lab = await measured.page.evalJs('JSON.stringify({ title: document.title, url: location.href })', 8_000);
      return emit({ ok: true, cmd, result: { clicked: r, label: lab } });
    }
    if (cmd === 'label') {
      const r = await measured.page.evalJs('JSON.stringify({ title: document.title, url: location.href })', 8_000);
      return emit({ ok: true, cmd, result: r });
    }
    if (cmd === 'dom-id-hunt') {
      // Grep the LIVE DOM (outerHTML + all attributes) for the meeting <id> and meet/ frags.
      const idFromUrl = (URL.match(/meet\/([^/?#]+)/) || [])[1] || '';
      const r = await measured.page.evalJs(`(() => {
        const id = ${JSON.stringify(idFromUrl)};
        const html = document.documentElement.outerHTML;
        const idHits = id ? (html.split(id).length - 1) : 0;
        const meetFrag = (html.match(/meet\\/[A-Za-z0-9_%-]+/g) || []).slice(0,8);
        const threadFrag = (html.match(/19:meeting_[A-Za-z0-9_%.-]+/g) || []).slice(0,4);
        const hrefMeet = [...document.querySelectorAll('[href]')].map(e=>e.getAttribute('href')).filter(h=>/meet\\/|meetup-join|meeting/i.test(h||'')).slice(0,8);
        return JSON.stringify({ id, idHitsInDom: idHits, meetFrag, threadFrag, hrefMeet });
      })()`, 10_000);
      return emit({ ok: true, cmd, result: r });
    }
    if (cmd === 'quit') {
      try {
        const v = await httpJson(MEASURED_PORT, '/json/version');
        const wsUrl = v && v.webSocketDebuggerUrl;
        if (wsUrl) { const ws = new WS(wsUrl); await ws.connect(); ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); await sleep(1500); ws.close(); }
      } catch {}
      emit({ ok: true, cmd, result: 'quit' });
      process.exit(0);
    }
    return emit({ ok: false, cmd, error: 'unknown command' });
  } catch (e) {
    return emit({ ok: false, cmd, error: (e && (e.message || String(e))) });
  }
}

const CMD_FILE = process.env.TW_CMD_FILE || join(HERE, 'consumer-captures-2026-07-07', 'cw-cmd');
if (!_exists(CMD_FILE)) _write(CMD_FILE, '');
let lastSeq = 0;
emit({ ok: true, cmd: 'ready', url: URL, cmdFile: CMD_FILE });

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
