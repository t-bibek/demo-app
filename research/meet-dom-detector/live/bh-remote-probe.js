'use strict';
// The guest's mic is now BlackHole (audio reaches Meet). Diff the HOST's view of the
// camera-off remote "BH Speaker" tile between SILENT and SPEAKING to discover how
// Meet marks a camera-off remote as talking (ring? outline? a different indicator?).
//   node bh-remote-probe.js
const path = require('path'); const { execSync, spawn } = require('child_process');
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222, DEV = 'BlackHole 2ch', GUEST = 'BH Speaker';
const CLIP = path.join(__dirname, 'audio', 'Alice.wav');
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

const DUMP = `(function(name){
  var t=[...document.querySelectorAll('[data-participant-id]')].find(function(x){return ((x.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]')||{}).textContent||'').trim().toLowerCase()===name.toLowerCase();});
  if(!t)return {found:false};
  var cs=getComputedStyle(t);
  return {found:true,
    tileClasses:t.className,
    kssMZb:!!t.querySelector('.kssMZb'),
    jsnames:[...new Set([...t.querySelectorAll('[jsname]')].map(function(e){return e.getAttribute('jsname')}))],
    jsctrls:[...new Set([...t.querySelectorAll('[jscontroller]')].map(function(e){return e.getAttribute('jscontroller')}))],
    outline:cs.outlineWidth+'/'+cs.outlineColor, boxShadow:(cs.boxShadow||'none').slice(0,40), borderW:cs.borderWidth,
    animEls:[...t.querySelectorAll('*')].filter(function(e){var a=getComputedStyle(e).animationName;return a&&a!=='none'}).map(function(e){return (e.getAttribute('jsname')||e.tagName)+':'+getComputedStyle(e).animationName}).slice(0,8),
    // classes that appear anywhere inside the tile (to spot a toggled speaking class)
    innerClassTokens:[...new Set([].concat.apply([],[...t.querySelectorAll('*')].map(function(e){return (e.className||'').toString().split(' ')})).filter(Boolean))].slice(0,60)
  };})`;

async function main() {
  const origIn = sh('SwitchAudioSource -c -t input'), origOut = sh('SwitchAudioSource -c -t output');
  const restore = () => { try { sh(`SwitchAudioSource -t input -s ${JSON.stringify(origIn)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(origOut)}`); } catch (e) {} };
  process.on('exit', restore);
  sh(`SwitchAudioSource -t input -s ${JSON.stringify(DEV)}`); sh(`SwitchAudioSource -t output -s ${JSON.stringify(DEV)}`);
  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);

  console.log('=== SILENT baseline (host view of ' + GUEST + ') ===');
  const silent = JSON.parse(await host.evalJs(`JSON.stringify((${DUMP})(${JSON.stringify(GUEST)}))`));
  console.log(JSON.stringify(silent, null, 2));

  console.log('\n=== SPEAKING (playing clip; sampling host view) ===');
  const af = spawn('afplay', [CLIP]);
  let speaking = null;
  for (let i = 0; i < 12; i++) { await sleep(600); const d = JSON.parse(await host.evalJs(`JSON.stringify((${DUMP})(${JSON.stringify(GUEST)}))`)); if (!speaking) speaking = d; if (d.animEls.length || d.kssMZb !== silent.kssMZb || d.boxShadow !== silent.boxShadow || d.outline !== silent.outline) { speaking = d; break; } }
  try { af.kill(); } catch (e) {}
  console.log(JSON.stringify(speaking, null, 2));

  console.log('\n=== DIFF (what changed silent -> speaking) ===');
  const diff = {};
  ['kssMZb', 'outline', 'boxShadow', 'borderW', 'tileClasses'].forEach((k) => { if (JSON.stringify(silent[k]) !== JSON.stringify(speaking[k])) diff[k] = { silent: silent[k], speaking: speaking[k] }; });
  diff.animEls_speaking = speaking.animEls;
  diff.jsnames_added = (speaking.jsnames || []).filter((x) => !(silent.jsnames || []).includes(x));
  diff.innerClass_added = (speaking.innerClassTokens || []).filter((x) => !(silent.innerClassTokens || []).includes(x));
  diff.innerClass_removed = (silent.innerClassTokens || []).filter((x) => !(speaking.innerClassTokens || []).includes(x));
  console.log(JSON.stringify(diff, null, 2));
  restore(); process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); try { sh('SwitchAudioSource -t output -s "MacBook Pro Speakers"'); sh('SwitchAudioSource -t input -s "MacBook Pro Microphone"'); } catch (x) {} process.exit(1); });
