'use strict';
// Real-browser QA: launch isolated headless Chrome, load the Meet-DOM simulator,
// inject the real DOM detector, step through every scenario, score vs the oracle.
// This exercises the ACTUAL browser DOM APIs (getComputedStyle animationName,
// getBoundingClientRect, closest, querySelector) — not a Node simulation.
//
//   node research/meet-dom-detector/browser-qa/run-browser-qa.js
//
// Zero external deps (Node built-ins + a minimal CDP WebSocket client).
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { URL } = require('url');

const PORT = 9223;
// Resolve a Chrome/Chromium binary — portable across macOS dev and Linux CI.
// Override with CHROME_PATH; otherwise try common locations, then fall back to a
// PATH-resolved name (spawn finds it on $PATH in CI).
function resolveChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cands = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser', '/usr/bin/chromium',
    '/opt/google/chrome/chrome',
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return process.env.CHROME_PATH || 'google-chrome-stable';
}
const CHROME = resolveChrome();
// GitHub-hosted runners require --no-sandbox; shared-memory is small in containers.
const CI_FLAGS = process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
const SIM = 'file://' + path.join(__dirname, 'meet-sim.html');
const DETECTOR = fs.readFileSync(path.join(__dirname, 'dom-detector.js'), 'utf8');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-qa-'));

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class WS {
  constructor(u) { this.url = new URL(u); this.buf = Buffer.alloc(0); this.pending = Buffer.alloc(0); this.onmessage = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock = net.connect(this.url.port, this.url.hostname, () => {
        this.sock.write(`GET ${this.url.pathname}${this.url.search} HTTP/1.1\r\nHost: ${this.url.hostname}:${this.url.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let done = false;
      this.sock.on('data', (chunk) => {
        if (!done) {
          this.pending = Buffer.concat([this.pending, chunk]);
          const idx = this.pending.indexOf('\r\n\r\n'); if (idx === -1) return;
          if (!/101/.test(this.pending.slice(0, idx).toString())) return reject(new Error('WS handshake failed'));
          done = true; const rest = this.pending.slice(idx + 4); this.pending = Buffer.alloc(0);
          if (rest.length) this._feed(rest); resolve();
        } else this._feed(chunk);
      });
      this.sock.on('error', reject);
    });
  }
  _feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const op = this.buf[0] & 0x0f; let len = this.buf[1] & 0x7f; let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len); this.buf = this.buf.slice(off + len);
      if (op === 0x1 && this.onmessage) this.onmessage(payload.toString('utf8'));
    }
  }
  send(s) {
    const p = Buffer.from(s, 'utf8'); const len = p.length; let h;
    if (len < 126) { h = Buffer.alloc(2); h[1] = 0x80 | len; }
    else if (len < 65536) { h = Buffer.alloc(4); h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); }
    h[0] = 0x81; const m = crypto.randomBytes(4); const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = p[i] ^ m[i % 4];
    this.sock.write(Buffer.concat([h, m, out]));
  }
  close() { try { this.sock.destroy(); } catch (e) {} }
}

const sortedEq = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', ...CI_FLAGS, SIM,
  ], { stdio: 'ignore', detached: false });

  try {
    // Wait for the DevTools endpoint + the sim page target.
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(250);
      try {
        const list = await httpJson('/json');
        if (Array.isArray(list)) target = list.find((t) => t.type === 'page' && /meet-sim\.html/.test(t.url || ''));
      } catch (e) { /* not up yet */ }
    }
    if (!target) throw new Error('sim page target never appeared');

    const ws = new WS(target.webSocketDebuggerUrl); await ws.connect();
    let id = 0; const waiters = new Map();
    ws.onmessage = (m) => { let o; try { o = JSON.parse(m); } catch (e) { return; } if (o.id && waiters.has(o.id)) { waiters.get(o.id)(o); waiters.delete(o.id); } };
    const cmd = (method, params) => new Promise((res) => { const mid = ++id; waiters.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
    const evalJs = async (expr) => {
      const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.result && r.result.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.result.exceptionDetails));
      return r.result && r.result.result && r.result.result.value;
    };

    await cmd('Runtime.enable');
    // Wait for the sim's globals to be ready.
    for (let i = 0; i < 40; i++) { if (await evalJs('typeof window.__setScenario === "function"')) break; await sleep(150); }
    await evalJs(DETECTOR);   // inject the real DOM detector

    const ids = await evalJs('window.__scenarios');
    const rows = []; let pass = 0, fail = 0;
    for (let i = 0; i < ids.length; i++) {
      const out = JSON.parse(await evalJs(
        `(function(){window.__setScenario(${i}); return JSON.stringify({oracle:window.__oracle, got:window.__meetDetect()});})()`));
      const exp = out.oracle.expect, got = out.got;
      const okVia = !exp.via || got.via === exp.via;
      const okNames = exp.namesSet ? sortedEq(got.names, exp.namesSet)
        : JSON.stringify(got.names) === JSON.stringify(exp.names);
      const ok = okVia && okNames; ok ? pass++ : fail++;
      rows.push({ id: out.oracle.id, ok,
        got: `${JSON.stringify(got.names)} via ${got.via}`,
        want: `${JSON.stringify(exp.namesSet || exp.names)} via ${exp.via || '*'}` });
    }

    const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
    console.log('\nGoogle Meet detector — SIMULATOR QA in a real browser (meet-sim.html; NOT a live Meet call)\n' +
      'Tests the detector\'s DOM-reading logic (real getComputedStyle/getBoundingClientRect) — no participants join.\n' + '='.repeat(96));
    console.log(pad('RESULT', 8) + pad('SCENARIO', 26) + 'GOT  |  WANT');
    console.log('-'.repeat(96));
    rows.forEach((r) => console.log(pad(r.ok ? 'PASS' : 'FAIL', 8) + pad(r.id, 26) + `${r.got}   |   ${r.want}`));
    console.log('-'.repeat(96));
    console.log(`\n${pass}/${pass + fail} scenarios passed in a real browser\n`);
    ws.close();
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    try { chrome.kill('SIGKILL'); } catch (e) {}
    try { execSync(`rm -rf ${PROFILE}`); } catch (e) {}
  }
}
main().catch((e) => { console.error('ERROR:', e.stack || e); process.exit(1); });
