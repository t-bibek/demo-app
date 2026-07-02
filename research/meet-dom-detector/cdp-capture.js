// Minimal CDP driver using Node built-ins (http + net + crypto). No external deps.
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const { URL } = require('url');

const TARGET_URL = process.argv[2];
const OUT_FILE = process.argv[3];
const WAIT_MS = parseInt(process.argv[4] || '6000', 10);

function httpGetJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve(d); }
      });
    }).on('error', reject);
  });
}

function httpPut(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 9222, path, method: 'PUT' }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// Minimal WS client for CDP (server won't fragment/mask; we handle text frames).
class WS {
  constructor(wsUrl) {
    this.url = new URL(wsUrl);
    this.buf = Buffer.alloc(0);
    this.onmessage = null;
    this.pending = Buffer.alloc(0);
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock = net.connect(this.url.port, this.url.hostname, () => {
        const req =
          `GET ${this.url.pathname}${this.url.search} HTTP/1.1\r\n` +
          `Host: ${this.url.hostname}:${this.url.port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`;
        this.sock.write(req);
      });
      let handshakeDone = false;
      this.sock.on('data', (chunk) => {
        if (!handshakeDone) {
          this.pending = Buffer.concat([this.pending, chunk]);
          const idx = this.pending.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const header = this.pending.slice(0, idx).toString();
          if (!/101/.test(header)) { reject(new Error('WS handshake failed: ' + header)); return; }
          handshakeDone = true;
          const rest = this.pending.slice(idx + 4);
          this.pending = Buffer.alloc(0);
          if (rest.length) this._feed(rest);
          resolve();
        } else {
          this._feed(chunk);
        }
      });
      this.sock.on('error', reject);
    });
  }
  _feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buf.length < offset + len) return;
      const payload = this.buf.slice(offset, offset + len);
      this.buf = this.buf.slice(offset + len);
      if (opcode === 0x1 && this.onmessage) this.onmessage(payload.toString('utf8'));
    }
  }
  send(str) {
    const payload = Buffer.from(str, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len; // masked
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x81; // FIN + text
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  close() { try { this.sock.destroy(); } catch (e) {} }
}

async function main() {
  // Create a fresh page target.
  const created = await httpPut('/json/new?' + encodeURIComponent(TARGET_URL));
  const wsUrl = created.webSocketDebuggerUrl;
  const ws = new WS(wsUrl);
  await ws.connect();

  let id = 0;
  const waiters = new Map();
  ws.onmessage = (msg) => {
    let obj;
    try { obj = JSON.parse(msg); } catch (e) { return; }
    if (obj.id && waiters.has(obj.id)) {
      const w = waiters.get(obj.id);
      waiters.delete(obj.id);
      w(obj);
    }
  };
  function cmd(method, params) {
    return new Promise((resolve) => {
      const mid = ++id;
      waiters.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  }

  await cmd('Page.enable');
  await cmd('Runtime.enable');
  // Navigate (page was created at TARGET_URL, but navigate again to be safe & capture redirects)
  await cmd('Page.navigate', { url: TARGET_URL });

  // Wait for content to settle.
  await new Promise((r) => setTimeout(r, WAIT_MS));

  const evalRes = await cmd('Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML',
    returnByValue: true,
  });
  const finalUrl = await cmd('Runtime.evaluate', {
    expression: 'location.href',
    returnByValue: true,
  });
  const title = await cmd('Runtime.evaluate', {
    expression: 'document.title',
    returnByValue: true,
  });

  const html = (evalRes.result && evalRes.result.result && evalRes.result.result.value) || '';
  fs.writeFileSync(OUT_FILE, html, 'utf8');

  console.log(JSON.stringify({
    requestedUrl: TARGET_URL,
    finalUrl: finalUrl.result && finalUrl.result.result && finalUrl.result.result.value,
    title: title.result && title.result.result && title.result.result.value,
    bytes: Buffer.byteLength(html, 'utf8'),
    outFile: OUT_FILE,
  }, null, 2));

  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error('ERROR:', e.stack || e); process.exit(1); });
