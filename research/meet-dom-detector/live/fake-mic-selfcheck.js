'use strict';
// Self-check the WAV-backed getUserMedia override in isolation (no Meet):
// install override -> mic-check page -> confirm RMS>0 while speaking, RMS~0 when gated.
//   node fake-mic-selfcheck.js [host|guest] [headful]
const path = require('path'); const fs = require('fs'); const os = require('os');
const { CHROME, sleep, httpJson, WS } = require('./cdp-lib.js');
const { buildOverride } = require('./fake-mic-override.js');
const { spawn, execSync } = require('child_process');

const WHICH = process.argv[2] === 'guest' ? 'guest' : 'host';
const HEADFUL = process.argv[3] === 'headful';
const WAV = path.join(__dirname, 'fake-audio', WHICH + '.wav');
const PORT = 9233;
const PAGE = 'file://' + path.join(__dirname, 'mic-check.html');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-selfcheck-'));

async function main() {
  const chrome = spawn(CHROME, [
    ...(HEADFUL ? [] : ['--headless=new']),
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { const l = await httpJson(PORT, '/json'); if (Array.isArray(l)) target = l.find((t) => t.type === 'page'); } catch (e) {} }
    if (!target) throw new Error('page never appeared');
    const ws = new WS(target.webSocketDebuggerUrl); await ws.connect();
    let id = 0; const w = new Map(); ws.onmessage = (m) => { let o; try { o = JSON.parse(m); } catch (e) { return; } if (o.id && w.has(o.id)) { w.get(o.id)(o); w.delete(o.id); } };
    const cmd = (method, params) => new Promise((r) => { const mid = ++id; w.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
    const ev = async (e) => { const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result && r.result.result.value; };
    await cmd('Runtime.enable'); await cmd('Page.enable');
    await cmd('Page.addScriptToEvaluateOnNewDocument', { source: buildOverride(WAV, WHICH) });
    await cmd('Page.navigate', { url: PAGE });
    await sleep(4500);
    const ready = await ev('window.__fakeMicReady'); const ferr = await ev('window.__fakeMicErr||null');
    // reset the analyser's running max so the SPEAK/GATE phases are measured fresh
    const rmsSpeak = await ev('(function(){window.__micRMS=0;return 0;})()') , _ = rmsSpeak;
    await sleep(1500); const speak = await ev('window.__micRMS');
    await ev('window.__fakeMicSpeak(false)'); await ev('window.__micRMS=0');
    await sleep(1500); const gated = await ev('window.__micRMS');
    await ev('window.__fakeMicSpeak(true)'); await ev('window.__micRMS=0');
    await sleep(1500); const speak2 = await ev('window.__micRMS');
    const pass = speak > 0.01 && gated < 0.005 && speak2 > 0.01;
    console.log(JSON.stringify({ which: WHICH, headful: HEADFUL, decodeReady: ready, decodeErr: ferr, rms_speak: speak, rms_gated: gated, rms_speak_again: speak2, PASS: pass }));
    ws.close();
    process.exitCode = pass ? 0 : 1;
  } finally { try { chrome.kill('SIGKILL'); } catch (e) {} try { execSync(`rm -rf ${PROFILE}`); } catch (e) {} }
}
main().catch((e) => { console.error('ERROR:', e.stack || e); process.exit(1); });
