'use strict';
// Clean interactive path: launch a FRESH isolated headful Chrome (empty profile —
// no cookie copy, real Chrome untouched) on a debug port, open meet.google.com/new,
// and WAIT for the user to sign in manually in that window. Once signed in, Google
// lands us in a real meeting; we click "Join now", record the URL, and leave Chrome
// running for the observer/guest steps.
//   node signin-create.js [waitSeconds]
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');

const PORT = 9222;
const WAIT = parseInt(process.argv[2] || '170', 10);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = path.join(__dirname, '.live-profile');
const URL_FILE = path.join(__dirname, '.meeting-url');

async function main() {
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    'https://meet.google.com/new',
  ], { stdio: 'ignore', detached: true });
  chrome.unref();

  const { evalJs } = await attachToPage(PORT, /google\.com/);
  console.log(`[signin] window open on port ${PORT} — SIGN IN in that Chrome window now. Waiting up to ${WAIT}s…`);
  const start = Date.now(); let url = '', last = '';
  while ((Date.now() - start) / 1000 < WAIT) {
    await sleep(2500);
    url = (await evalJs('location.href')) || '';
    const host = url.split('/')[2] || '';
    if (host !== last) { console.log(`  … at ${host}`); last = host; }
    // Click Join now / Ask to join when we reach the green room.
    await evalJs(`(function(){var b=[...document.querySelectorAll('button,span')].find(function(n){return /^(Join now|Ask to join)$/i.test((n.textContent||'').trim());});if(b){b.click();return true}return false})()`);
    if (/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url)) {
      // give the join click a moment, re-read
      await sleep(2500);
      url = (await evalJs('location.href')) || url;
      fs.writeFileSync(URL_FILE, url.split('?')[0]);
      console.log(JSON.stringify({ ok: true, inMeeting: true, url: url.split('?')[0], port: PORT }, null, 2));
      process.exit(0);
    }
  }
  console.log(JSON.stringify({ ok: false, inMeeting: false, url: url.split('?')[0], port: PORT, note: 'timed out waiting for sign-in; re-run to keep waiting (Chrome left open)' }, null, 2));
  process.exit(1);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(2); });
