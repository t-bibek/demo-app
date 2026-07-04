#!/usr/bin/env node
// One-off probe for the web-Teams anonymous guest join flow (de-risks
// teams-guest-live). Launches Chrome (fake mic tone), walks the join flow,
// reports each step, and leaves the tab open for the native-side check.
//   node qa/teams-live/guest-probe.mjs <meeting-url> [guest-name]
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const { launchChrome, attachToPage } = require(join(REPO, 'research', 'meet-dom-detector', 'live', 'cdp-lib.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const url = process.argv[2];
const name = process.argv[3] || 'QA Guest';
if (!url) { console.error('usage: guest-probe.mjs <url> [name]'); process.exit(2); }

const chrome = launchChrome({ port: 9331, headful: true, fakeAudio: true, url, profileTag: 'teams-guest-probe' });
console.log('chrome launched, attaching…');
const page = await attachToPage(9331, /teams\.(live|microsoft)\.com/);

const snapshot = () => page.evalJs(`(() => {
  const btns = [...document.querySelectorAll('button, a, [role="button"]')].map(e => (e.innerText || '').trim()).filter(Boolean);
  const inputs = [...document.querySelectorAll('input')].map(e => e.placeholder || e.type);
  return JSON.stringify({ url: location.href, title: document.title, btns: btns.slice(0, 25), inputs });
})()`);
const click = (needle) => page.evalJs(`(() => {
  const els = [...document.querySelectorAll('button, a, [role="button"]')];
  const el = els.find(e => (e.innerText || '').trim().toLowerCase().includes(${JSON.stringify(needle)}));
  if (el) { el.click(); return (el.innerText || '').trim(); } return null;
})()`);

for (let step = 0; step < 12; step++) {
  await sleep(4000);
  console.log(`--- t+${(step + 1) * 4}s:`, await snapshot());
  const cont = await click('continue on this browser') || await click('join on the web');
  if (cont) { console.log('clicked:', cont); continue; }
  const named = await page.evalJs(`(() => {
    const inp = document.querySelector('input[placeholder*="name" i], input[type="text"]');
    if (!inp || inp.value === ${JSON.stringify(name)}) return null;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, ${JSON.stringify(name)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  if (named) console.log('typed guest name');
  const joined = await click('join now');
  if (joined) { console.log('clicked:', joined); break; }
}
await sleep(8000);
console.log('final:', await snapshot());
console.log('PROBE DONE — leaving Chrome open (pid on port 9331)');
process.exit(0);
