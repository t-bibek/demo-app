'use strict';
// Create a Google Meet using a NON-DESTRUCTIVE copy of the user's signed-in Chrome
// auth (Local State + Default/Cookies + Preferences) in an isolated profile, so the
// user's running Chrome is untouched. Launches headful (Meet blocks headless), goes
// to /new, clicks "Join now", and reports the meeting URL + whether we're signed in.
// Leaves Chrome running on port 9222 for the observer/guest steps. Cleanup: the
// caller deletes the temp profile (it contains auth cookies) when done.
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');

const PORT = 9222;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SRC = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
const PROFILE = path.join(__dirname, '.live-profile');        // temp, deleted by caller
const URL_FILE = path.join(__dirname, '.meeting-url');

function cp(rel) {
  const s = path.join(SRC, rel), d = path.join(PROFILE, rel);
  try { if (!fs.existsSync(s)) return; fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); }
  catch (e) { console.error('copy failed', rel, e.message); }
}

async function main() {
  // Fresh isolated profile with just the auth surface.
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  cp('Local State');
  cp('Default/Cookies'); cp('Default/Cookies-wal'); cp('Default/Cookies-shm');
  cp('Default/Network/Cookies'); cp('Default/Network/Cookies-wal');
  cp('Default/Preferences');
  fs.writeFileSync(path.join(PROFILE, 'First Run'), '');

  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--profile-directory=Default',
    '--no-first-run', '--no-default-browser-check', '--restore-last-session=false',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    'https://meet.google.com/new',
  ], { stdio: 'ignore', detached: true });
  chrome.unref();

  const { evalJs } = await attachToPage(PORT, /google\.com/);
  // Give it time to auth-redirect and create the room.
  let url = '', title = '';
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    url = (await evalJs('location.href')) || '';
    title = (await evalJs('document.title')) || '';
    // Click "Join now" if we're at the green room.
    await evalJs(`(function(){var b=[...document.querySelectorAll('button,span')].find(function(n){return /^(Join now|Ask to join)$/i.test((n.textContent||'').trim());});if(b){b.click();return true}return false})()`);
    if (/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url)) break;
    if (/accounts\.google\.com/i.test(url)) break;
  }
  const signedIn = !/accounts\.google\.com/i.test(url);
  const inMeeting = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url);
  if (inMeeting) fs.writeFileSync(URL_FILE, url.split('?')[0]);
  console.log(JSON.stringify({ signedIn, inMeeting, url: url.split('?')[0], title, port: PORT, profile: PROFILE }, null, 2));
  process.exit(inMeeting ? 0 : 1);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(2); });
