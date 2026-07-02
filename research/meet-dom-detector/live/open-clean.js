'use strict';
// Open ONE fresh, empty-profile Chrome window on the debug port for manual sign-in.
// No cookie copy (so no re-auth loop, no Keychain), no auto-clicking. Exits
// immediately, leaving Chrome running. Then use watch-meeting.js to detect the room.
const fs = require('fs'); const path = require('path');
const { spawn, execSync } = require('child_process');
const PORT = 9222;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = path.join(__dirname, '.live-profile');

try { execSync(`pkill -f "\\.live-profile"`); } catch (e) {}
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(path.join(__dirname, '.meeting-url'), { force: true }); } catch (e) {}
fs.mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  'https://meet.google.com/new',
], { stdio: 'ignore', detached: true });
chrome.unref();
console.log(`[open-clean] fresh empty Chrome open on port ${PORT} -> meet.google.com/new.`);
console.log('Sign in normally in that window and create/land in the meeting. I will only WATCH.');
setTimeout(() => process.exit(0), 1500);
