'use strict';
// Shared, dependency-free CDP helpers for the live Meet rig: launch Chrome, find a
// page target, drive it over a minimal WebSocket. Node built-ins only.
const http = require('http'); const net = require('net'); const crypto = require('crypto');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { spawn, execSync } = require('child_process');
const { URL } = require('url');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(port, p) {
  return new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res(d); } });
  }).on('error', rej));
}

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
      const pl = this.buf.slice(off, off + len); this.buf = this.buf.slice(off + len);
      if (op === 0x1 && this.onmessage) this.onmessage(pl.toString('utf8'));
    }
  }
  send(s) {
    const p = Buffer.from(s, 'utf8'); const len = p.length; let h;
    if (len < 126) { h = Buffer.alloc(2); h[1] = 0x80 | len; }
    else if (len < 65536) { h = Buffer.alloc(4); h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); }
    h[0] = 0x81; const m = crypto.randomBytes(4); const o = Buffer.alloc(len);
    for (let i = 0; i < len; i++) o[i] = p[i] ^ m[i % 4];
    this.sock.write(Buffer.concat([h, m, o]));
  }
  close() { try { this.sock.destroy(); } catch (e) {} }
}

// Launch a Chrome instance. opts: { port, headful, fakeAudio (tone), wav, url, profileTag }
function launchChrome(opts) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), (opts.profileTag || 'meet-rig') + '-'));
  const args = [
    `--remote-debugging-port=${opts.port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  ];
  if (!opts.headful) args.push('--headless=new');
  if (opts.fakeAudio) { args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'); }
  // Auto-grant the mic permission but use the REAL default input device (e.g. a
  // BlackHole virtual mic carrying recognized speech) — NOT the fake tone device.
  else if (opts.realMicGrant) { args.push('--use-fake-ui-for-media-stream'); }
  // NOTE: --use-file-for-fake-audio-capture is BROKEN in Chrome 149 (validated:
  // tone works, file yields silence). The fake DEVICE tone above is the working
  // audio source. If a future Chrome fixes the file flag, add it here with opts.wav.
  if (opts.wav) args.push(`--use-file-for-fake-audio-capture=${opts.wav}`);
  if (opts.url) args.push(opts.url);
  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  return { proc, profile, kill() { try { proc.kill('SIGKILL'); } catch (e) {} try { execSync(`rm -rf ${profile}`); } catch (e) {} } };
}

async function attachToPage(port, urlMatch) {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try { const l = await httpJson(port, '/json'); if (Array.isArray(l)) target = l.find((t) => t.type === 'page' && (!urlMatch || (urlMatch.test(t.url || '')))); } catch (e) {}
  }
  if (!target) throw new Error('page target not found for ' + (urlMatch || 'any'));
  const ws = new WS(target.webSocketDebuggerUrl); await ws.connect();
  let id = 0; const waiters = new Map();
  ws.onmessage = (m) => { let o; try { o = JSON.parse(m); } catch (e) { return; } if (o.id && waiters.has(o.id)) { waiters.get(o.id)(o); waiters.delete(o.id); } };
  const cmd = (method, params) => new Promise((r) => { const mid = ++id; waiters.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
  const evalJs = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result && r.result.result && r.result.result.value; };
  await cmd('Runtime.enable'); await cmd('Page.enable');
  return { ws, cmd, evalJs };
}

module.exports = { CHROME, sleep, httpJson, WS, launchChrome, attachToPage };
