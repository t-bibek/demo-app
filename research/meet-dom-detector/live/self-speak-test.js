'use strict';
// Self-contained live signal test (no 2nd participant needed): toggle the host's
// fake-tone mic and watch whether its OWN IisKdb/QgSmzd widget flips gjg47c
// (silent) off while audio plays. Confirms the core "speaking = NOT gjg47c" signal
// against live Meet, and re-checks that kssMZb is present regardless of speech.
//   node self-speak-test.js
const { attachToPage, sleep } = require('./cdp-lib');
const HOST_PORT = 9222;

const CLICK = `function(res){for(const s of res){var el=[...document.querySelectorAll('button,[role=button],span,div[role=button]')].find(function(n){var t=(n.getAttribute('aria-label')||'')+' '+(n.textContent||'');return new RegExp(s,'i').test(t);});if(el){el.click();return s;}}return null;}`;
// gjg47c state of the mic-level widget(s), plus kssMZb presence, for the self tile.
const PROBE = `function(){var ws=[...document.querySelectorAll('[jsname="QgSmzd"], .IisKdb, .DYfzY')];
  var notSilent=ws.filter(function(w){return !w.classList.contains('gjg47c');}).length;
  return {widgets:ws.length, notSilent:notSilent, anySpeaking:notSilent>0,
    kssMZb:!!document.querySelector('.kssMZb'),
    micLabel:(function(){var b=[...document.querySelectorAll('button,[role=button]')].find(function(n){return /microphone/i.test(n.getAttribute('aria-label')||'')});return b?b.getAttribute('aria-label'):null;})()};}`;

async function phase(host, label, secs) {
  const rows = []; const start = Date.now();
  while ((Date.now() - start) / 1000 < secs) {
    rows.push(JSON.parse((await host.evalJs(`JSON.stringify((${PROBE})())`)) || '{}'));
    await sleep(1000);
  }
  const speakingFrac = rows.filter(r => r.anySpeaking).length / rows.length;
  console.log(`  [${label}] anySpeaking ${(speakingFrac*100).toFixed(0)}% of ${rows.length}s · kssMZb=${rows[0].kssMZb} · mic="${rows[0].micLabel}"`);
  return speakingFrac;
}

async function main() {
  const host = await attachToPage(HOST_PORT, /meet\.google\.com/);
  console.log('[self-speak-test] toggling the host fake-tone mic and watching gjg47c\n');

  await host.evalJs(`(${CLICK})(['Turn off microphone'])`); await sleep(1500);
  const muted1 = await phase(host, 'MUTED   ', 6);

  const on = await host.evalJs(`(${CLICK})(['Turn on microphone'])`); await sleep(1500);
  console.log(`  (clicked: ${on})`);
  const speaking = await phase(host, 'UNMUTED ', 12);

  await host.evalJs(`(${CLICK})(['Turn off microphone'])`); await sleep(1500);
  const muted2 = await phase(host, 'MUTED   ', 6);

  console.log('\n===== verdict =====');
  const works = speaking > 0.5 && muted1 < 0.2 && muted2 < 0.2;
  console.log(JSON.stringify({
    gjg47c_toggles_with_speech: works,
    muted_speakingFrac: [+muted1.toFixed(2), +muted2.toFixed(2)],
    unmuted_speakingFrac: +speaking.toFixed(2),
    note: works ? 'CONFIRMED live: widget drops gjg47c while audio plays; kssMZb is present regardless (not a speech signal)'
                : 'inconclusive — fake tone may not drive Meet self-meter; try a real 2nd speaker',
  }, null, 2));
  // leave host muted
  process.exit(0);
}
main().catch((e) => { console.error('ERROR', e.stack || e); process.exit(1); });
