#!/usr/bin/env node
// Launch ONE web-Teams anonymous guest (fake-mic tone), walk the join flow, and
// leave it in the lobby/call. Keeps Chrome alive (detached) so the co-variance
// hunt can toggle its mic. Prints the CDP port so the driver can re-attach.
//   node qa/teams-live/guest-join.mjs <url> <name> <port>
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const { launchChrome, attachToPage } = require(join(REPO, 'research', 'meet-dom-detector', 'live', 'cdp-lib.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [url, name, port] = [process.argv[2], process.argv[3] || 'QA Guest', +(process.argv[4] || 9331)];
if (!url) { console.error('usage: guest-join.mjs <url> <name> <port>'); process.exit(2); }

launchChrome({ port, headful: true, fakeAudio: true, url, profileTag: `tg-${port}` });
const page = await attachToPage(port, /teams\.(live|microsoft)\.com/);
const click = (needle) => page.evalJs(`(() => {
  const els = [...document.querySelectorAll('button, a, [role="button"]')];
  const el = els.find(e => (e.innerText || '').trim().toLowerCase().includes(${JSON.stringify(needle)}));
  if (el) { el.click(); return (el.innerText || '').trim(); } return null;
})()`);

for (let i = 0; i < 20; i++) { if (await click('continue on this browser')) break; await sleep(1500); }
await sleep(6000);
await page.evalJs(`(() => {
  const inp = document.querySelector('input[placeholder*="name" i], input[type="text"]');
  if (!inp) return false;
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(inp, ${JSON.stringify(name)});
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(1000);
for (let i = 0; i < 12; i++) { if (await click('join now')) break; await sleep(1500); }
console.log(`GUEST_JOINED name=${JSON.stringify(name)} port=${port}`);
process.exit(0);
