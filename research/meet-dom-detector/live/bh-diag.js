'use strict';
// Diagnose the BlackHole audio path WITHOUT Meet: route audio to BlackHole, launch a
// Chrome using the real default mic (BlackHole), afplay a clip, and read the mic RMS.
// RMS>0 => the loopback + Chrome-mic works (so any failure is Meet-side).
const path = require('path'); const { execSync, spawn } = require('child_process');
const { launchChrome, attachToPage, sleep } = require('./cdp-lib');
const PORT = 9317, DEV = 'BlackHole 2ch';
const PAGE = 'file://' + path.join(__dirname, 'mic-check.html');
const CLIP = path.join(__dirname, 'audio', 'Alice.wav');
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  const restore = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} };
  process.on('exit', restore);
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`);
  sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);
  console.log(`[diag] input+output -> ${DEV}; default in now: ${sh('SwitchAudioSource -c -t input')}, out: ${sh('SwitchAudioSource -c -t output')}`);

  // Chrome uses the real default mic (BlackHole), permission auto-granted.
  const chrome = launchChrome({ port: PORT, headful: false, realMicGrant: true, url: PAGE, profileTag: 'bh-diag' });
  const { evalJs } = await attachToPage(PORT, /mic-check/);
  await sleep(1500);
  // list the mic devices Chrome sees (needs the page; enumerateDevices after getUserMedia)
  const devs = await evalJs(`navigator.mediaDevices.enumerateDevices().then(function(ds){return JSON.stringify(ds.filter(function(d){return d.kind==='audioinput'}).map(function(d){return d.label}))})`);
  console.log('[diag] Chrome audioinput devices:', devs);

  // play the clip several times to overlap the measurement window
  for (let i = 0; i < 3; i++) spawn('afplay', [CLIP]);
  await sleep(6000);
  const rms = await evalJs('window.__micRMS'); const err = await evalJs('window.__micErr'); const st = await evalJs('window.__ctxState');
  console.log(JSON.stringify({ maxRMS: rms, ctxState: st, micErr: err, PASS: typeof rms === 'number' && rms > 0.001 }, null, 2));
  restore(); chrome.kill(); process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); try { require('child_process').execSync('SwitchAudioSource -t output -s "MacBook Pro Speakers"'); } catch (x) {} process.exit(1); });
