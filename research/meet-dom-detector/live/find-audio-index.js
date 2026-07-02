'use strict';
// Find the ffmpeg audiotoolbox output index for a virtual loopback device by
// playing a short sine into each index and recording FROM the device by NAME
// (avfoundation) — pure CoreAudio oracle, no Meet dependency. Verifies the
// device's loopback actually works at the same time.
//   node find-audio-index.js ["Microsoft Teams Audio"]
const { execSync, spawnSync } = require('child_process');
const fs = require('fs'); const path = require('path');
const DEV = process.argv[2] || process.env.VIRT_MIC || 'BlackHole 2ch';
const TMP = process.env.TMPDIR || '/tmp';

function rmsOf(file) {
  const out = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' });
  const m = /max_volume:\s*(-?[\d.]+) dB/.exec(out.stderr || '');
  return m ? +m[1] : -91;
}

function probe(idx) {
  const cap = path.join(TMP, `aidx-${idx}.wav`);
  const rec = require('child_process').spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'avfoundation', '-i', ':' + DEV, '-t', '1.8', '-y', cap]);
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=880:duration=1.4', '-f', 'audiotoolbox', '-audio_device_index', String(idx), '-']);
  return new Promise((res) => rec.on('exit', () => res(rmsOf(cap))));
}

(async () => {
  for (let idx = 0; idx <= 9; idx++) {
    const db = await probe(idx);
    console.log(`idx=${idx} max=${db}dB`);
    if (db > -50) {
      fs.writeFileSync(path.join(__dirname, '.audio-device-index'),
        JSON.stringify({ device: DEV, index: idx }));
      console.log(`FOUND: "${DEV}" = audiotoolbox index ${idx} (cached in .audio-device-index)`);
      process.exit(0);
    }
  }
  console.error(`no index reached "${DEV}" — loopback broken or device missing`);
  process.exit(1);
})();
