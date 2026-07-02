'use strict';
// Launch Chrome with a fake-audio WAV as the mic and confirm a live non-zero mic
// RMS — proves the live multi-party rig's audio injection works before wiring Meet.
//   node mic-check.js [wavPath]
const http = require('http'); const net = require('net'); const crypto = require('crypto');
const path = require('path'); const os = require('os'); const fs = require('fs');
const { spawn, execSync } = require('child_process');
const { URL } = require('url');

const PORT = 9224;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BEEP_MODE = process.argv[2]==='beep'; const WAV = (!BEEP_MODE && process.argv[2]) || path.join(__dirname, 'audio', 'Alice.wav');
const PAGE = 'file://' + path.join(__dirname, 'mic-check.html');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'mic-chk-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res(d); } }); }).on('error', rej));

class WS { /* minimal CDP WS client */
  constructor(u){this.url=new URL(u);this.buf=Buffer.alloc(0);this.pending=Buffer.alloc(0);this.onmessage=null;}
  connect(){return new Promise((resolve,reject)=>{const key=crypto.randomBytes(16).toString('base64');this.sock=net.connect(this.url.port,this.url.hostname,()=>{this.sock.write(`GET ${this.url.pathname}${this.url.search} HTTP/1.1\r\nHost: ${this.url.hostname}:${this.url.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);});let done=false;this.sock.on('data',(chunk)=>{if(!done){this.pending=Buffer.concat([this.pending,chunk]);const idx=this.pending.indexOf('\r\n\r\n');if(idx===-1)return;if(!/101/.test(this.pending.slice(0,idx).toString()))return reject(new Error('handshake'));done=true;const rest=this.pending.slice(idx+4);this.pending=Buffer.alloc(0);if(rest.length)this._feed(rest);resolve();}else this._feed(chunk);});this.sock.on('error',reject);});}
  _feed(chunk){this.buf=Buffer.concat([this.buf,chunk]);while(this.buf.length>=2){const op=this.buf[0]&0x0f;let len=this.buf[1]&0x7f;let off=2;if(len===126){if(this.buf.length<4)return;len=this.buf.readUInt16BE(2);off=4;}else if(len===127){if(this.buf.length<10)return;len=Number(this.buf.readBigUInt64BE(2));off=10;}if(this.buf.length<off+len)return;const pl=this.buf.slice(off,off+len);this.buf=this.buf.slice(off+len);if(op===0x1&&this.onmessage)this.onmessage(pl.toString('utf8'));}}
  send(s){const p=Buffer.from(s,'utf8');const len=p.length;let h;if(len<126){h=Buffer.alloc(2);h[1]=0x80|len;}else if(len<65536){h=Buffer.alloc(4);h[1]=0x80|126;h.writeUInt16BE(len,2);}else{h=Buffer.alloc(10);h[1]=0x80|127;h.writeBigUInt64BE(BigInt(len),2);}h[0]=0x81;const m=crypto.randomBytes(4);const o=Buffer.alloc(len);for(let i=0;i<len;i++)o[i]=p[i]^m[i%4];this.sock.write(Buffer.concat([h,m,o]));}
  close(){try{this.sock.destroy();}catch(e){}}
}

async function main() {
  if (!fs.existsSync(WAV)) throw new Error('WAV not found: ' + WAV + ' (run make-test-audio first)');
  const chrome = spawn(CHROME, [
    ...(process.env.MIC_HEADFUL?[]:['--headless=new']), `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    ...(BEEP_MODE?[]:[`--use-file-for-fake-audio-capture=${WAV}`]), '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check', PAGE,
  ], { stdio: 'ignore' });
  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { const l = await httpJson('/json'); if (Array.isArray(l)) target = l.find((t) => /mic-check\.html/.test(t.url || '')); } catch (e) {} }
    if (!target) throw new Error('mic-check page never appeared');
    const ws = new WS(target.webSocketDebuggerUrl); await ws.connect();
    let id = 0; const w = new Map(); ws.onmessage = (m) => { let o; try { o = JSON.parse(m); } catch (e) { return; } if (o.id && w.has(o.id)) { w.get(o.id)(o); w.delete(o.id); } };
    const cmd = (method, params) => new Promise((r) => { const mid = ++id; w.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
    const ev = async (e) => { const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
    await cmd('Runtime.enable');
    await sleep(5000); // let the WAV play through the analyser
    const rms = await ev('window.__micRMS'); const err = await ev('window.__micErr'); const ready = await ev('window.__micReady'); const state = await ev('window.__ctxState');
    const ok = typeof rms === 'number' && rms > 0.001;
    console.log(JSON.stringify({ wav: path.basename(WAV), micReady: ready, ctxState: state, maxRMS: rms, error: err, PASS: ok }, null, 2));
    ws.close();
    process.exitCode = ok ? 0 : 1;
  } finally { try { chrome.kill('SIGKILL'); } catch (e) {} try { execSync(`rm -rf ${PROFILE}`); } catch (e) {} }
}
main().catch((e) => { console.error('ERROR:', e.stack || e); process.exit(1); });
