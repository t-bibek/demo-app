'use strict';
// Copy the user's signed-in auth into an isolated profile and create a Meet. On
// macOS, Chrome decrypts the copied Cookies via the "Chrome Safe Storage" Keychain
// item — which may prompt; the user approves it. We then auto-pick a target account
// on the chooser and click through to a meeting. Real Chrome is untouched.
//   node copy-create.js <accountEmail> [waitSeconds]
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');

const PORT = 9222;
const ACCOUNT = process.argv[2] || 'bibekthapa922@gmail.com';
const WAIT = parseInt(process.argv[3] || '210', 10);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SRC = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
const PROFILE = path.join(__dirname, '.live-profile');
const URL_FILE = path.join(__dirname, '.meeting-url');

function cp(rel) {
  const s = path.join(SRC, rel), d = path.join(PROFILE, rel);
  try { if (!fs.existsSync(s)) return; fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); } catch (e) {}
}

async function main() {
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  ['Local State', 'Default/Cookies', 'Default/Cookies-wal', 'Default/Cookies-shm',
   'Default/Network/Cookies', 'Default/Network/Cookies-wal', 'Default/Preferences'].forEach(cp);
  fs.writeFileSync(path.join(PROFILE, 'First Run'), '');

  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--profile-directory=Default',
    '--no-first-run', '--no-default-browser-check',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    'https://meet.google.com/new',
  ], { stdio: 'ignore', detached: true });
  chrome.unref();

  const { evalJs } = await attachToPage(PORT, /google\.com/);
  console.log(`[copy-create] window open on ${PORT}. APPROVE the Keychain prompt if it appears; I'll auto-pick ${ACCOUNT}. Waiting up to ${WAIT}s…`);
  // Click the target account tile on the chooser, or Join now on the green room.
  const clickThrough = `(function(email){
    var acct=[...document.querySelectorAll('[data-identifier],[data-email],div[role="link"],li,a')].find(function(n){
      return ((n.getAttribute&&(n.getAttribute('data-identifier')||n.getAttribute('data-email')))===email)
          || (n.textContent||'').indexOf(email)>=0; });
    if(acct){(acct.closest('[role=link],li,a,div[jsname]')||acct).click(); return 'acct';}
    var b=[...document.querySelectorAll('button,span')].find(function(n){return /^(Join now|Ask to join)$/i.test((n.textContent||'').trim());});
    if(b){b.click(); return 'join';}
    return null;})(${JSON.stringify(ACCOUNT)})`;

  const start = Date.now(); let url = '', last = '';
  while ((Date.now() - start) / 1000 < WAIT) {
    await sleep(2500);
    url = (await evalJs('location.href')) || '';
    const host = url.split('/')[2] || '';
    if (host !== last) { console.log(`  … at ${host}`); last = host; }
    const did = await evalJs(clickThrough);
    if (did) console.log(`    clicked: ${did}`);
    if (/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url)) {
      await sleep(2500);
      url = (await evalJs('location.href')) || url;
      fs.writeFileSync(URL_FILE, url.split('?')[0]);
      console.log(JSON.stringify({ ok: true, inMeeting: true, account: ACCOUNT, url: url.split('?')[0], port: PORT }, null, 2));
      process.exit(0);
    }
  }
  console.log(JSON.stringify({ ok: false, inMeeting: false, url: url.split('?')[0], port: PORT,
    note: 'not in a meeting yet; Chrome left open — re-run to keep polling, or finish sign-in manually in the window' }, null, 2));
  process.exit(1);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(2); });
