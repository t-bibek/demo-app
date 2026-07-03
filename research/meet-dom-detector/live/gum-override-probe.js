'use strict';
// Probe the getUserMedia-override approach: inject a synthetic MediaStream (WebAudio
// oscillator -> MediaStreamDestination) and monkeypatch navigator.mediaDevices.getUserMedia
// BEFORE the page reads the mic, then measure RMS via the SAME page's analyser.
// This is the device-free per-instance audio source for Meet.
//   node gum-override-probe.js [freq] [headful]
const path = require('path'); const fs = require('fs'); const os = require('os');
const { CHROME, sleep, httpJson, WS } = require('./cdp-lib.js');
const { spawn, execSync } = require('child_process');

const FREQ = Number(process.argv[2] || 440);
const HEADFUL = process.argv[3] === 'headful';
const PORT = 9232;
const PAGE = 'file://' + path.join(__dirname, 'mic-check.html');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'gum-probe-'));

// The override script. Installed via Page.addScriptToEvaluateOnNewDocument so it runs
// before ANY page JS (before Meet grabs the mic). Uses a modulated oscillator so the
// signal resembles speech bursts (Meet's VAD ignores steady pure tones).
function overrideScript(freq) {
  return `(() => {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = ${freq};
    // Amplitude-modulate to mimic speech syllables (~4Hz) so VAD treats it as voice.
    const gain = ctx.createGain(); gain.gain.value = 0.25;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 4;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.25;
    lfo.connect(lfoGain); lfoGain.connect(gain.gain);
    osc.connect(gain); gain.connect(dest);
    osc.start(); lfo.start();
    if (ctx.state === 'suspended') ctx.resume();
    window.__fakeStream = dest.stream;
    window.__fakeGain = gain;         // toggle handle: gain.gain.value = 0 to "mute"
    window.__fakeCtx = ctx;
    const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = function (constraints) {
      if (constraints && constraints.audio) {
        // Clone so each getUserMedia call gets a live track from our synthetic source.
        const s = dest.stream;
        if (constraints.video) {
          return realGUM({ video: constraints.video }).then((v) => {
            s.getAudioTracks().forEach((t) => v.addTrack(t)); return v;
          }).catch(() => s);
        }
        return Promise.resolve(s);
      }
      return realGUM(constraints);
    };
  })();`;
}

async function main() {
  const args = [
    ...(HEADFUL ? [] : ['--headless=new']),
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ];
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { const l = await httpJson(PORT, '/json'); if (Array.isArray(l)) target = l.find((t) => t.type === 'page'); } catch (e) {} }
    if (!target) throw new Error('page never appeared');
    const ws = new WS(target.webSocketDebuggerUrl); await ws.connect();
    let id = 0; const w = new Map(); ws.onmessage = (m) => { let o; try { o = JSON.parse(m); } catch (e) { return; } if (o.id && w.has(o.id)) { w.get(o.id)(o); w.delete(o.id); } };
    const cmd = (method, params) => new Promise((r) => { const mid = ++id; w.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
    const ev = async (e) => { const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result && r.result.result.value; };
    await cmd('Runtime.enable'); await cmd('Page.enable');
    // Install override to run on the next document, then navigate to the mic-check page.
    await cmd('Page.addScriptToEvaluateOnNewDocument', { source: overrideScript(FREQ) });
    await cmd('Page.navigate', { url: PAGE });
    await sleep(4000);
    const rms = await ev('window.__micRMS'); const err = await ev('window.__micErr'); const state = await ev('window.__ctxState');
    const hasFake = await ev('!!window.__fakeStream');
    const ok = typeof rms === 'number' && rms > 0.001;
    console.log(JSON.stringify({ freq: FREQ, headful: HEADFUL, overrideInstalled: hasFake, ctxState: state, maxRMS: rms, error: err, PASS: ok }));
    ws.close();
    process.exitCode = ok ? 0 : 1;
  } finally { try { chrome.kill('SIGKILL'); } catch (e) {} try { execSync(`rm -rf ${PROFILE}`); } catch (e) {} }
}
main().catch((e) => { console.error('ERROR:', e.stack || e); process.exit(1); });
