#!/usr/bin/env node
// Set a web-Teams guest's mic to on/off via CDP (toggles the in-call mic button).
//   node qa/teams-live/guest-mic.mjs <port> on|off
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { attachToPage } = require(join(resolve(HERE, '..', '..'), 'research', 'meet-dom-detector', 'live', 'cdp-lib.js'));

const [port, want] = [+process.argv[2], process.argv[3]];
if (!port || !['on', 'off'].includes(want)) { console.error('usage: guest-mic.mjs <port> on|off'); process.exit(2); }
const page = await attachToPage(port, /teams\.(live|microsoft)\.com/);
// The mic button carries aria-label "Mute" (currently unmuted) or "Unmute" (currently muted).
const r = await page.evalJs(`(() => {
  const btn = [...document.querySelectorAll('button, [role="button"]')].find(b => {
    const l = ((b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || '')).toLowerCase();
    return /^\\s*(mute|unmute)\\b/.test(l) && /mic|microphone|mute/.test(l);
  });
  if (!btn) return 'no-mic-button';
  const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.innerText || '').toLowerCase();
  const isMuted = /unmute/.test(label);          // says "Unmute" => currently muted
  const wantOn = ${JSON.stringify(want)} === 'on';
  if (wantOn === !isMuted) return 'already-' + (wantOn ? 'on' : 'off');
  btn.click();
  return 'toggled-to-' + (wantOn ? 'on' : 'off') + ' (was ' + label + ')';
})()`);
console.log(`mic port=${port} -> ${r}`);
process.exit(0);
