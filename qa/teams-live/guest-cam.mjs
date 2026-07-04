#!/usr/bin/env node
// Toggle a web-Teams guest's camera on/off via CDP.
//   node qa/teams-live/guest-cam.mjs <port> on|off
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { attachToPage } = require(join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'research', 'meet-dom-detector', 'live', 'cdp-lib.js'));
const [port, want] = [+process.argv[2], process.argv[3]];
const page = await attachToPage(port, /teams\.(live|microsoft)\.com/);
const r = await page.evalJs(`(() => {
  const btn = [...document.querySelectorAll('button,[role="button"]')].find(b => {
    const l = ((b.getAttribute('aria-label')||b.getAttribute('title')||b.innerText||'')).toLowerCase();
    return /camera|video/.test(l) && /turn/.test(l);
  });
  if (!btn) return 'no-cam-button';
  const label = (btn.getAttribute('aria-label')||btn.getAttribute('title')||btn.innerText||'').toLowerCase();
  const isOff = /turn on/.test(label);   // "Turn on camera" => currently off
  const wantOn = ${JSON.stringify(want)} === 'on';
  if (wantOn === !isOff) return 'already-' + (wantOn?'on':'off');
  btn.click(); return 'toggled-to-' + (wantOn?'on':'off');
})()`);
console.log(`cam port=${port} -> ${r}`);
process.exit(0);
