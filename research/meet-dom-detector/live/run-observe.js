'use strict';
// Full live validation: host (signed-in, on port 9222, already in the room) mutes,
// a fake-tone GUEST joins, host admits it, then we inject the real detector and
// probe the LIVE Meet DOM — confirming data-audio-level / the QgSmzd(IisKdb) widget
// / gjg47c against the report's claims, and that the detector names the speaker.
//   node run-observe.js [observeSeconds]
const fs = require('fs'); const path = require('path');
const { launchChrome, attachToPage, sleep } = require('./cdp-lib');

const HOST_PORT = 9222, GUEST_PORT = 9313;
const OBSERVE = parseInt(process.argv[2] || '40', 10);
const URL = fs.readFileSync(path.join(__dirname, '.meeting-url'), 'utf8').trim();
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const OUT = path.join(__dirname, 'observe-timeline.jsonl');

const CLICK = `function(res){for(const s of res){var el=[...document.querySelectorAll('button,[role=button],span,div[role=button]')].find(function(n){var t=(n.getAttribute('aria-label')||'')+' '+(n.textContent||'');return new RegExp(s,'i').test(t);});if(el){el.click();return s;}}return null;}`;

const RAW_PROBE = `function(){return [...document.querySelectorAll('[data-participant-id]')].map(function(t){
  var n=t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]');
  var w=t.querySelector('[jsname="QgSmzd"], .IisKdb');
  return {name:n?(n.textContent||'').trim():null, pid:(t.getAttribute('data-participant-id')||'').slice(0,18),
    audioLevel:t.getAttribute('data-audio-level'), hasWidget:!!w,
    jsctrl:w?w.getAttribute('jscontroller'):null, wclass:w?w.className:null,
    gjg47c:w?w.classList.contains('gjg47c'):null, kssMZb:!!t.querySelector('.kssMZb')};});}`;

async function main() {
  const out = fs.createWriteStream(OUT, { flags: 'w' });
  // 1) Host: make sure we're IN the call (click Join now if still at the green
  //    room), then mute mic + camera off so the GUEST is the only audio source.
  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  await host.evalJs(`(${CLICK})(['Join now'])`);
  await sleep(3000);
  await host.evalJs(`(${CLICK})(['Turn off microphone','Turn off mic'])`);
  await host.evalJs(`(${CLICK})(['Turn off camera'])`);
  console.log('[host] in call; muted mic + camera off');

  // 2) Guest speaker joins (isolated, fake tone).
  const guest = launchChrome({ port: GUEST_PORT, headful: true, fakeAudio: true, url: URL, profileTag: 'meet-guest' });
  const g = await attachToPage(GUEST_PORT, /meet\.google\.com/);
  for (let i = 0; i < 4; i++) {
    await sleep(3000);
    await g.evalJs(`(function(){var i=document.querySelector('input[jsname][type="text"], input[type="text"][aria-label]');if(i){i.value='QA Bob tone';i.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    await g.evalJs(`(${CLICK})(['Turn off camera'])`);
    const did = await g.evalJs(`(${CLICK})(['Ask to join','Join now'])`);
    if (did) { console.log('[guest] clicked ' + did); break; }
  }

  // 3) Host admits the guest (poll for the Admit control).
  let admitted = false;
  for (let i = 0; i < 40 && !admitted; i++) {
    await sleep(1500);
    const did = await host.evalJs(`(${CLICK})(['^Admit$','Admit'])`);
    if (did) { admitted = true; console.log('[host] clicked Admit'); }
  }
  if (!admitted) console.log('[host] no Admit button seen (guest may have entered directly, or quick-access on)');

  // 4) Wait for 2 participant tiles, then inject + observe.
  await host.evalJs(DETECTOR);
  await host.evalJs('window.__ctx={vad:true}');
  for (let i = 0; i < 20; i++) { const n = await host.evalJs(`document.querySelectorAll('[data-participant-id]').length`); if (n >= 2) break; await sleep(1000); }

  console.log(`[observe] sampling ${OBSERVE}s…`);
  const start = Date.now(); let firstRaw = null, detHits = {};
  while ((Date.now() - start) / 1000 < OBSERVE) {
    const det = JSON.parse((await host.evalJs(`JSON.stringify((window.__meetDetect&&window.__meetDetect())||{})`)) || '{}');
    const raw = JSON.parse((await host.evalJs(`JSON.stringify((${RAW_PROBE})())`)) || '[]');
    if (!firstRaw && raw.length) firstRaw = raw;
    const via = det.via || 'none';
    detHits[via] = (detHits[via] || 0) + 1;
    out.write(JSON.stringify({ t: +((Date.now() - start) / 1000).toFixed(1), det, raw }) + '\n');
    await sleep(1000);
  }
  out.end();

  console.log('\n===== LIVE DOM PROBE (first sample with 2 tiles) =====');
  console.log(JSON.stringify(firstRaw, null, 2));
  console.log('\n===== detector via-signal tally over ' + OBSERVE + 's =====');
  console.log(JSON.stringify(detHits, null, 2));
  console.log('\n[done] timeline -> ' + OUT + '  (guest left running; kill with pkill -f meet-guest)');
  guest.kill();
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(1); });
