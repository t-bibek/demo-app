'use strict';
// Host is already in the room (port 9222, muted). Bring a fake-tone GUEST in and
// observe a SPEAKING REMOTE tile on the live DOM: does its IisKdb widget drop
// gjg47c while the tone plays? does data-audio-level appear? Keeps guest alive.
//   node add-guest-observe.js [observeSeconds]
const fs = require('fs'); const path = require('path');
const { launchChrome, attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222, GUEST_PORT = 9314;
const OBSERVE = parseInt(process.argv[2] || '30', 10);
const URL = fs.readFileSync(path.join(__dirname, '.meeting-url'), 'utf8').trim();
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const OUT = path.join(__dirname, 'observe-timeline.jsonl');

const CLICK = `function(res){for(const s of res){var el=[...document.querySelectorAll('button,[role=button],span,div[role=button]')].find(function(n){var t=(n.getAttribute('aria-label')||'')+' '+(n.textContent||'');return new RegExp(s,'i').test(t);});if(el){el.click();return s;}}return null;}`;
// Per participant tile, deduped by pid: name, audio-level, and BOTH indicator widgets' gjg47c state.
const PROBE = `function(){var m={};[...document.querySelectorAll('[data-participant-id]')].forEach(function(t){
  var pid=t.getAttribute('data-participant-id')||''; var n=t.querySelector('span.notranslate,.zWGUib,.XWGOtd,[data-self-name]');
  var name=n?(n.textContent||'').trim():null;
  var ws=[...t.querySelectorAll('[jsname="QgSmzd"], .IisKdb, .DYfzY')];
  var anySpeak=ws.some(function(w){return !w.classList.contains('gjg47c');});
  var e=m[pid]||(m[pid]={pid:pid.slice(0,16),name:null,audioLevel:t.getAttribute('data-audio-level'),widgets:0,anyNotSilent:false,kssMZb:false});
  if(name&&!e.name)e.name=name; e.widgets+=ws.length; e.anyNotSilent=e.anyNotSilent||anySpeak;
  if(t.getAttribute('data-audio-level')!=null)e.audioLevel=t.getAttribute('data-audio-level');
  if(t.querySelector('.kssMZb'))e.kssMZb=true;});
  return Object.keys(m).map(function(k){return m[k];});}`;

async function main() {
  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  const guest = launchChrome({ port: GUEST_PORT, headful: true, fakeAudio: true, url: URL, profileTag: 'meet-guest' });
  const g = await attachToPage(GUEST_PORT, /meet\.google\.com/);

  let pids = 1;
  for (let i = 0; i < 45 && pids < 2; i++) {
    await sleep(2000);
    // keep nudging the guest through name -> ask to join
    await g.evalJs(`(function(){var i=document.querySelector('input[jsname][type="text"], input[type="text"][aria-label]');if(i&&!i.value){i.value='QA Bob tone';i.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    await g.evalJs(`(${CLICK})(['Turn off camera'])`);
    const gj = await g.evalJs(`(${CLICK})(['Ask to join','Join now'])`);
    // host: admit
    const ad = await host.evalJs(`(${CLICK})(['^Admit$','Admit','Allow to join'])`);
    const names = JSON.parse((await host.evalJs(`JSON.stringify((${PROBE})().map(function(x){return x.name}))`)) || '[]');
    pids = new Set(JSON.parse((await host.evalJs(`JSON.stringify((${PROBE})().map(function(x){return x.pid}))`)) || '[]')).size;
    if (i % 3 === 0) console.log(`  t${i*2}s guest@${((await g.evalJs('location.href'))||'').split('/')[2]} | host tiles=${pids} names=${JSON.stringify(names)}${ad?' [ADMIT]':''}${gj?' [guest '+gj+']':''}`);
  }

  if (pids < 2) {
    console.log('[!] guest never appeared as a 2nd participant. If you see an Admit prompt in the host window, click it, then re-run.');
    console.log('    (guest left running on port ' + GUEST_PORT + ')');
    process.exit(1);
  }

  console.log('[observe] 2 participants present; sampling ' + OBSERVE + 's (guest tone = speaking)…');
  await host.evalJs(DETECTOR); await host.evalJs('window.__ctx={vad:true}');
  const out = fs.createWriteStream(OUT, { flags: 'w' });
  const start = Date.now(); const samples = [];
  while ((Date.now() - start) / 1000 < OBSERVE) {
    const probe = JSON.parse((await host.evalJs(`JSON.stringify((${PROBE})())`)) || '[]');
    const det = JSON.parse((await host.evalJs(`JSON.stringify((window.__meetDetect&&window.__meetDetect())||{})`)) || '{}');
    out.write(JSON.stringify({ t: +((Date.now() - start) / 1000).toFixed(1), det, probe }) + '\n');
    samples.push({ probe, det });
    await sleep(1000);
  }
  out.end();

  // Summarize: for the REMOTE (name != host) tile, how often was it NOT silent (speaking)?
  const host0 = samples[0].probe.map(p => p.name).filter(Boolean)[0];
  const mid = samples[Math.floor(samples.length / 2)];
  console.log('\n===== mid-sample live probe =====\n' + JSON.stringify(mid.probe, null, 2));
  const remote = (p) => p.find(x => x.name && x.name !== host0);
  const remoteSpeakingFrac = samples.filter(s => { const r = remote(s.probe); return r && r.anyNotSilent; }).length / samples.length;
  const remoteAudioLevels = [...new Set(samples.map(s => { const r = remote(s.probe); return r ? r.audioLevel : null; }))];
  console.log('\n===== summary =====');
  console.log(JSON.stringify({
    hostName: host0,
    remoteSeen: !!remote(samples[Math.floor(samples.length/2)].probe),
    remoteName: (remote(mid.probe) || {}).name,
    remote_notSilent_fraction: +remoteSpeakingFrac.toFixed(2),
    remote_data_audio_level_values: remoteAudioLevels,
    remote_kssMZb_present: (remote(mid.probe) || {}).kssMZb,
    detector_via_mid: mid.det.via, detector_names_mid: mid.det.names,
  }, null, 2));
  console.log('\n[done] timeline -> ' + OUT + '  (guest still running; pkill -f meet-guest to remove)');
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(1); });
