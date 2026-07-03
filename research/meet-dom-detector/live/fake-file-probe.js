'use strict';
// Probe whether Chrome's --use-file-for-fake-audio-capture actually drives the mic
// with a given WAV, across formats. Prints max RMS. Reuses cdp-lib.
//   node fake-file-probe.js <wavPath> [headful] [loopmode]
// loopmode: "" (default, loop) | "noloop"
const path = require('path'); const fs = require('fs');
const { CHROME, sleep, httpJson, WS } = require('./cdp-lib.js');
const { spawn, execSync } = require('child_process');
const os = require('os');

const WAV = process.argv[2] || path.join(__dirname, 'fake-audio', 'host_48k_mono.wav');
const HEADFUL = process.argv[3] === 'headful';
const LOOP = process.argv[4] === 'noloop' ? '%noloop' : '';
const PORT = 9231;
const PAGE = 'file://' + path.join(__dirname, 'mic-check.html');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'file-probe-'));

async function main() {
  if (!fs.existsSync(WAV)) throw new Error('WAV not found: ' + WAV);
  const args = [
    ...(HEADFUL ? [] : ['--headless=new']),
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}${LOOP}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check', PAGE,
  ];
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { const l = await httpJson(PORT, '/json'); if (Array.isArray(l)) target = l.find((t) => /mic-check\.html/.test(t.url || '')); } catch (e) {} }
    if (!target) throw new Error('mic-check page never appeared');
    const ws = new WS(target.webSocketDebuggerUrl); await ws.connect();
    let id = 0; const w = new Map(); ws.onmessage = (m) => { let o; try { o = JSON.parse(m); } catch (e) { return; } if (o.id && w.has(o.id)) { w.get(o.id)(o); w.delete(o.id); } };
    const cmd = (method, params) => new Promise((r) => { const mid = ++id; w.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
    const ev = async (e) => { const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
    await cmd('Runtime.enable');
    await sleep(4000);
    const rms = await ev('window.__micRMS'); const err = await ev('window.__micErr'); const ready = await ev('window.__micReady'); const state = await ev('window.__ctxState');
    const ok = typeof rms === 'number' && rms > 0.001;
    console.log(JSON.stringify({ wav: path.basename(WAV), loop: LOOP || 'loop', headful: HEADFUL, micReady: ready, ctxState: state, maxRMS: rms, error: err, PASS: ok }));
    ws.close();
    process.exitCode = ok ? 0 : 1;
  } finally { try { chrome.kill('SIGKILL'); } catch (e) {} try { execSync(`rm -rf ${PROFILE}`); } catch (e) {} }
}
main().catch((e) => { console.error('ERROR:', e.stack || e); process.exit(1); });
