'use strict';
// Does the DYfzY self-meter flip to a SPEAKING level class in the AX tree when the
// SELF tile actually speaks? Unmute host, user speaks, capture AX at the instant
// the host self-meter shows a non-gjg47c class in the DOM, then read the DYfzY
// node's class in AX.
const { attachToPage, sleep } = require('./cdp-lib');
const { execSync } = require('child_process');
const CODE = 'yzs-mvzw-rkv';

const MIC = `(function(on){var b=[].slice.call(document.querySelectorAll('button,[role=button]')).find(function(n){if(!n.offsetParent||n.disabled)return false;return /^Turn (on|off) microphone/.test(n.getAttribute('aria-label')||'')&&n.getAttribute('data-is-muted')!==null;});if(!b)return 'no';var m=b.getAttribute('data-is-muted')==='true';if(on&&m){b.click();return 'unmuted';}if(!on&&!m){b.click();return 'muted';}return m?'muted':'live';})`;
// self tile = the Bibek tile that is NOT a remote ("can't unmute" absent)
const SELFMETER = `(function(){var self=[].slice.call(document.querySelectorAll('[data-participant-id]')).find(function(t){return !t.closest('[role=list]')&&!/can.t unmute/i.test(t.textContent||'')&&/Bibek/.test(t.textContent||'');});if(!self)return '[]';return JSON.stringify([].slice.call(self.querySelectorAll('[jsname=QgSmzd]')).map(function(w){return w.className;}));})()`;

function foregroundAndDump() {
  execSync(`osascript -e 'tell application "System Events" to repeat with p in (every process whose name is "Google Chrome")\nrepeat with w in (every window of p)\nif title of w contains "Meet - ${CODE}" then\nset frontmost of p to true\nperform action "AXRaise" of w\nend if\nend repeat\nend repeat'`, { timeout: 8000 });
  execSync(`cd /Users/bibekthapa/projects/work/demo-app/macos && swift run AXSnapshot chrome --url ${CODE} >/tmp/self.log 2>&1`, { timeout: 60000 });
}

(async () => {
  const h = await attachToPage(9222, /meet\.google\.com/);
  console.log('unmute HOST:', await h.evalJs(`(${MIC})(true)`));
  console.log('SPEAK NOW — watching host self-meter for a speaking class...\n');
  let captured = false;
  for (let i = 0; i < 60 && !captured; i++) {
    const m = JSON.parse(await h.evalJs(SELFMETER));
    const speaking = m.some((c) => /DYfzY/.test(c) && !/gjg47c/.test(c));
    if (speaking) {
      console.log(`t=${(i * 0.5).toFixed(1)}s host self-meter DOM: ${JSON.stringify(m.filter((c) => /DYfzY/.test(c)))}  <- SPEAKING`);
      console.log('foreground + AX dump...');
      try { foregroundAndDump(); } catch (e) { console.log('dump err', e.message); }
      captured = true;
    }
    await sleep(500);
  }
  console.log('re-mute host:', await h.evalJs(`(${MIC})(false)`));
  console.log(captured ? 'CAPTURED during self-speech' : 'no self-speech detected');
  process.exit(captured ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
