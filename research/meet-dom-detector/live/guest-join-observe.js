'use strict';
// Robust guest join + observe. Launches a fake-tone guest, fills the name and clicks
// the actual (enabled) join BUTTON, prints the guest's green-room buttons so we can
// see what's there, admits from the host, then probes the live 2-person DOM.
// If auto-join misses, the guest window is visible — click "Ask to join" manually.
//   node guest-join-observe.js [observeSeconds]
const fs = require('fs'); const path = require('path');
const { launchChrome, attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222, GUEST_PORT = 9315;
const OBSERVE = parseInt(process.argv[2] || '25', 10);
const URL = fs.readFileSync(path.join(__dirname, '.meeting-url'), 'utf8').trim();
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const OUT = path.join(__dirname, 'observe-timeline.jsonl');

const GUEST_JOIN = `(function(){
  // fill any name field
  [...document.querySelectorAll('input')].forEach(function(i){ if((i.type==='text'||!i.type) && !i.value){ i.focus(); i.value='QA Bob tone'; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); }});
  // click the real, enabled join button
  var b=[...document.querySelectorAll('button')].find(function(x){var t=(x.getAttribute('aria-label')||'')+' '+(x.textContent||'');return /ask to join|join now/i.test(t) && !x.disabled;});
  if(b){ b.click(); return 'clicked'; }
  return 'no-enabled-join-btn';
})()`;
const GUEST_BTNS = `JSON.stringify([...document.querySelectorAll('button')].map(function(b){return {t:(b.textContent||'').trim().slice(0,16), al:(b.getAttribute('aria-label')||'').slice(0,22), dis:b.disabled};}).filter(function(x){return x.t||x.al;}).slice(0,8))`;
const ADMIT = `(function(){var b=[...document.querySelectorAll('button,[role=button],span')].find(function(n){var t=(n.getAttribute('aria-label')||'')+' '+(n.textContent||'');return /^\\s*Admit\\s*$/i.test((n.textContent||'').trim())||/admit/i.test(n.getAttribute('aria-label')||'');});if(b){b.click();return true}return false})()`;
const PROBE = `(function(){var m={};[...document.querySelectorAll('[data-participant-id]')].forEach(function(t){
  var pid=t.getAttribute('data-participant-id')||''; var n=t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]');
  var ws=[...t.querySelectorAll('[jsname="QgSmzd"], .IisKdb, .DYfzY')];
  var e=m[pid]||(m[pid]={pid:pid.slice(0,14),name:null,audioLevel:t.getAttribute('data-audio-level'),widgets:0,notSilent:0,kssMZb:false});
  if(n&&!e.name)e.name=(n.textContent||'').trim(); e.widgets+=ws.length;
  e.notSilent+=ws.filter(function(w){return !w.classList.contains('gjg47c');}).length;
  if(t.getAttribute('data-audio-level')!=null)e.audioLevel=t.getAttribute('data-audio-level');
  if(t.querySelector('.kssMZb'))e.kssMZb=true;});
  return Object.keys(m).map(function(k){return m[k];});})()`;

async function main() {
  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  const guest = launchChrome({ port: GUEST_PORT, headful: true, fakeAudio: true, url: URL, profileTag: 'meet-guest' });
  const g = await attachToPage(GUEST_PORT, /meet\.google\.com/);
  console.log('[guest-join] guest window open — I will click join; if it stays on the green room, CLICK "Ask to join" in the guest window.');

  let pids = 1;
  for (let i = 0; i < 50 && pids < 2; i++) {
    await sleep(2000);
    const j = await g.evalJs(GUEST_JOIN);
    await host.evalJs(ADMIT);
    const probe = JSON.parse((await host.evalJs(`JSON.stringify(${PROBE})`)) || '[]');
    pids = probe.length;
    if (i % 3 === 0) {
      const btns = JSON.parse((await g.evalJs(GUEST_BTNS)) || '[]');
      console.log(`  t${i*2}s join=${j} | hostTiles=${pids} names=${JSON.stringify(probe.map(p=>p.name))}`);
      console.log(`         guestBtns=${JSON.stringify(btns)}`);
    }
  }
  if (pids < 2) { console.log('[!] still 1 participant — guest never entered. Guest left open on 9315 for you to click join; then: node guest-join-observe.js'); process.exit(1); }

  console.log('\n[observe] 2 participants! sampling ' + OBSERVE + 's (guest = fake tone)…');
  await host.evalJs(DETECTOR); await host.evalJs('window.__ctx={vad:true}');
  const out = fs.createWriteStream(OUT, { flags: 'w' }); const samples = [];
  const start = Date.now();
  while ((Date.now() - start) / 1000 < OBSERVE) {
    const probe = JSON.parse((await host.evalJs(`JSON.stringify(${PROBE})`)) || '[]');
    const det = JSON.parse((await host.evalJs(`JSON.stringify((window.__meetDetect&&window.__meetDetect())||{})`)) || '{}');
    out.write(JSON.stringify({ t: +((Date.now()-start)/1000).toFixed(1), det, probe }) + '\n'); samples.push({ probe, det });
    await sleep(1000);
  }
  out.end();
  const mid = samples[Math.floor(samples.length/2)];
  const hostName = mid.probe.map(p=>p.name).filter(Boolean)[0];
  const remote = (arr)=>arr.find(x=>x.name && x.name!==hostName) || arr.find(x=>x.name!==hostName);
  const rSpeakFrac = samples.filter(s=>{const r=remote(s.probe);return r && r.notSilent>0;}).length/samples.length;
  console.log('\n===== mid live 2-person probe =====\n'+JSON.stringify(mid.probe,null,2));
  console.log('\n===== summary =====\n'+JSON.stringify({
    participants: mid.probe.length, hostName,
    remoteName:(remote(mid.probe)||{}).name,
    remote_notSilent_fraction:+rSpeakFrac.toFixed(2),
    remote_data_audio_level: [...new Set(samples.map(s=>{const r=remote(s.probe);return r?r.audioLevel:null;}))],
    remote_kssMZb:(remote(mid.probe)||{}).kssMZb,
    detector_via_mid: mid.det.via, detector_names_mid: mid.det.names,
  },null,2));
  console.log('\n[done] timeline -> '+OUT+'  (guest still running; pkill -f meet-guest to remove)');
  process.exit(0);
}
main().catch((e)=>{console.error('ERROR',e.stack||e);process.exit(1);});
