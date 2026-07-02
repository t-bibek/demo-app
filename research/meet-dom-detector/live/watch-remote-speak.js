'use strict';
// Watch every tile for a REAL speaking transition. Run while a human speaks in the
// call. Reports, per non-host participant, whether an indicator widget appears and
// its gjg47c drops (speaking) — the last unproven live claim.
//   node watch-remote-speak.js [seconds]
const fs = require('fs'); const path = require('path');
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222;
const SECS = parseInt(process.argv[2] || '60', 10);
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
const OUT = path.join(__dirname, 'observe-timeline.jsonl');

const ADMIT = `(function(){var b=[...document.querySelectorAll('button,[role=button],span')].find(function(n){return /^\\s*Admit\\s*$/i.test((n.textContent||'').trim())||/admit/i.test(n.getAttribute('aria-label')||'');});if(b){b.click();return true}return false})()`;
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
  await host.evalJs(DETECTOR); await host.evalJs('window.__ctx={vad:true}');
  console.log(`[watch] probing ${SECS}s — SPEAK now. (auto-admitting any joiner)`);
  const out = fs.createWriteStream(OUT, { flags: 'w' });
  const agg = {}; let hostName = null; const start = Date.now(); let sawSpeaking = null;
  while ((Date.now() - start) / 1000 < SECS) {
    await host.evalJs(ADMIT);
    const probe = JSON.parse((await host.evalJs(`JSON.stringify(${PROBE})`)) || '[]');
    const det = JSON.parse((await host.evalJs(`JSON.stringify((window.__meetDetect&&window.__meetDetect())||{})`)) || '{}');
    if (!hostName) hostName = probe.map(p => p.name).filter(Boolean)[0];
    probe.forEach(p => { const k = p.name || p.pid; const a = agg[k] || (agg[k] = { name: p.name, maxWidgets: 0, maxNotSilent: 0, kssMZb: false, audioLevels: new Set() }); a.maxWidgets = Math.max(a.maxWidgets, p.widgets); a.maxNotSilent = Math.max(a.maxNotSilent, p.notSilent); a.kssMZb = a.kssMZb || p.kssMZb; a.audioLevels.add(p.audioLevel); });
    const speakingRemote = probe.find(p => p.name && p.name !== hostName && p.notSilent > 0);
    if (speakingRemote && !sawSpeaking) { sawSpeaking = speakingRemote.name; console.log(`  ✓ SPEAKING widget on remote "${speakingRemote.name}" (gjg47c dropped) at ${((Date.now()-start)/1000).toFixed(0)}s`); }
    out.write(JSON.stringify({ t: +((Date.now()-start)/1000).toFixed(1), det, probe }) + '\n');
    await sleep(800);
  }
  out.end();
  console.log('\n===== per-participant summary =====');
  Object.values(agg).forEach(a => console.log(`  ${JSON.stringify({ name: a.name, maxWidgets: a.maxWidgets, maxNotSilent_speakingObserved: a.maxNotSilent, kssMZb: a.kssMZb, audioLevels: [...a.audioLevels] })}`));
  console.log('\n===== verdict =====');
  console.log(JSON.stringify({
    real_speaker_widget_dropped_gjg47c: !!sawSpeaking,
    speaker: sawSpeaking,
    conclusion: sawSpeaking ? 'CONFIRMED live: a real speaker\'s tile renders the IisKdb widget and drops gjg47c while talking'
                            : 'no speaking widget observed — speak louder/longer, or the widget renders only on the main-stage tile',
  }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(1); });
