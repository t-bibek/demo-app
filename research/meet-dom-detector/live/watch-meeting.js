'use strict';
// Passively WATCH the existing debug-port Chrome (opened by open-clean.js) for the
// user to finish sign-in and land in a meeting. Does NOT relaunch Chrome and does
// NOT click the account chooser — the only click is "Join now" at the green room
// (safe, expected). Writes .meeting-url when a room is detected. Re-runnable.
//   node watch-meeting.js [waitSeconds]
const fs = require('fs'); const path = require('path');
const { attachToPage, sleep } = require('./cdp-lib');
const PORT = 9222;
const WAIT = parseInt(process.argv[2] || '110', 10);
const URL_FILE = path.join(__dirname, '.meeting-url');

async function main() {
  const { evalJs } = await attachToPage(PORT, /google\.com/);
  const start = Date.now(); let url = '', last = '';
  while ((Date.now() - start) / 1000 < WAIT) {
    url = (await evalJs('location.href')) || '';
    const host = url.split('/')[2] || '';
    if (host !== last) { console.log(`  … at ${host}`); last = host; }
    // Only click Join now / Ask to join (green room) — never the account chooser.
    await evalJs(`(function(){var b=[...document.querySelectorAll('button,span')].find(function(n){return /^(Join now|Ask to join)$/i.test((n.textContent||'').trim());});if(b){b.click();return true}return false})()`);
    if (/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url)) {
      await sleep(2500);
      url = (await evalJs('location.href')) || url;
      fs.writeFileSync(URL_FILE, url.split('?')[0]);
      console.log(JSON.stringify({ ok: true, inMeeting: true, url: url.split('?')[0], port: PORT }, null, 2));
      process.exit(0);
    }
    await sleep(3000);
  }
  console.log(JSON.stringify({ ok: false, inMeeting: false, url: url.split('?')[0], port: PORT, note: 're-run to keep watching' }, null, 2));
  process.exit(1);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(2); });
