'use strict';
// Prove a VIRTUAL LOOPBACK device carries recognized speech INTO a real browser
// getUserMedia stream (what Meet needs) — no fake-device flags, no BlackHole/sudo.
//   node virtmic-browser-proof.js ["Microsoft Teams Audio"] [audiotoolboxIndex]
// Sets the device as the system default INPUT, launches Chrome that grabs the REAL
// default mic, plays a speech WAV into the device via ffmpeg audiotoolbox, and
// reads the live in-page mic RMS. PASS => the browser actually hears the speech.
const path = require('path'); const fs = require('fs');
const { execSync, spawn } = require('child_process');
const { launchChrome, attachToPage, sleep } = require('./cdp-lib');

const DEV = process.argv[2] || 'Microsoft Teams Audio';
const IDX = process.argv[3] != null ? +process.argv[3] : null;
const WAV = path.join(__dirname, 'audio', 'Alice.wav');
const PORT = 9330;
const PAGE = 'file://' + path.join(__dirname, 'mic-check.html');
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

function resolveIdx() {
  if (IDX != null) return IDX;
  const cache = path.join(__dirname, '.audio-device-index');
  if (fs.existsSync(cache)) { const c = JSON.parse(fs.readFileSync(cache, 'utf8')); if (c.device === DEV) return c.index; }
  const out = sh(`ffmpeg -hide_banner -f lavfi -i "sine=frequency=440:duration=0.05" -f audiotoolbox -list_devices true - 2>&1 | grep ${JSON.stringify(DEV)} | grep -oE '\\[[0-9]+\\]' | tr -d '[]' | head -1`);
  return +out;
}

async function main() {
  const idx = resolveIdx();
  if (!Number.isInteger(idx)) throw new Error('could not resolve audiotoolbox index for ' + DEV);
  const origIn = sh('SwitchAudioSource -c -t input');
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`);
  const restore = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); } catch (e) {} };
  process.on('exit', restore);
  console.log(`[proof] input->"${DEV}" (audiotoolbox idx ${idx}); browser grabs real mic; playing ${path.basename(WAV)}`);

  const chrome = launchChrome({ port: PORT, headful: false, realMicGrant: true, url: PAGE, profileTag: 'virtmic-proof' });
  try {
    const page = await attachToPage(PORT, /mic-check\.html/);
    await sleep(1500);
    // play the speech clip into the device 3x while we sample the in-page RMS
    let maxRMS = 0; const samples = [];
    for (let rep = 0; rep < 3; rep++) {
      const af = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-i', WAV,
        '-f', 'audiotoolbox', '-audio_device_index', String(idx), '-']);
      const t0 = Date.now();
      while (af.exitCode === null && Date.now() - t0 < 6000) {
        const rms = await page.evalJs('window.__micRMS || 0');
        if (typeof rms === 'number') { samples.push(rms); if (rms > maxRMS) maxRMS = rms; }
        await sleep(300);
      }
      await new Promise((r) => af.on('exit', r));
      await sleep(400);
    }
    const err = await page.evalJs('window.__micErr'); const ready = await page.evalJs('window.__micReady');
    const ok = maxRMS > 0.005;
    console.log(JSON.stringify({ device: DEV, audiotoolboxIndex: idx, micReady: ready, error: err,
      maxRMS: +maxRMS.toFixed(4), nonzeroSamples: samples.filter((s) => s > 0.005).length + '/' + samples.length,
      PASS: ok, conclusion: ok
        ? `"${DEV}" delivers recognized speech into a real browser mic stream — usable as the Meet guest mic without BlackHole or sudo.`
        : `no signal reached the browser mic via "${DEV}" — check the audiotoolbox index and that the device is a working loopback.` }, null, 2));
    process.exitCode = ok ? 0 : 1;
  } finally { chrome.kill(); restore(); }
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(1); });
