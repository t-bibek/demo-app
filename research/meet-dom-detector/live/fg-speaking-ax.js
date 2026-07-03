'use strict';
// Definitive test: with the host tab FOREGROUND (hasFocus:true) AND an active
// speaking state (host fake-device bump drives the self-meter), capture the AX
// tree at the exact speaking instant and check whether the speaker-level
// className (DYfzY/Oaajhc/gjg47c/IisKdb) is present in AX.
const { attachToPage, sleep } = require('./cdp-lib');
const { execSync } = require('child_process');

const MIC = `(function(on){var b=[].slice.call(document.querySelectorAll('button,[role=button]')).find(function(n){if(!n.offsetParent||n.disabled)return false;return /^Turn (on|off) microphone/.test(n.getAttribute('aria-label')||'')&&n.getAttribute('data-is-muted')!==null;});if(!b)return 'no';var m=b.getAttribute('data-is-muted')==='true';if(on&&m){b.click();return 'unmuted';}if(!on&&!m){b.click();return 'muted';}return m?'muted':'live';})`;
// self-meter (DYfzY) or any QgSmzd widget showing a NON-silent level class
const SPEAKING = `(function(){var ws=[].slice.call(document.querySelectorAll('[jsname=QgSmzd]'));var spk=ws.filter(function(w){return !/(^| )gjg47c( |$)/.test(w.className||'');});return JSON.stringify({speaking:spk.length>0,classes:spk.map(function(w){return w.className}).slice(0,3)});})()`;
const FOCUS = `JSON.stringify({hasFocus:document.hasFocus(),vis:document.visibilityState})`;

(async () => {
  const h = await attachToPage(9222, /meet\.google\.com/);
  await h.cmd('Page.bringToFront', {});
  // OS-foreground the host meeting window
  try {
    execSync(`osascript -e 'tell application "System Events" to repeat with p in (every process whose name is "Google Chrome")
      repeat with w in (every window of p)
        if title of w contains "Meet - cyv-efne-fgr" then
          set frontmost of p to true
          perform action "AXRaise" of w
        end if
      end repeat
    end repeat'`, { timeout: 10000 });
  } catch (e) {}
  await sleep(2000);
  console.log('focus before:', await h.evalJs(FOCUS));
  console.log('unmute host (bump):', await h.evalJs(`(${MIC})(true)`));

  let captured = false;
  for (let i = 0; i < 40 && !captured; i++) {
    const s = JSON.parse(await h.evalJs(SPEAKING));
    if (s.speaking) {
      const foc = JSON.parse(await h.evalJs(FOCUS));
      console.log(`\n>>> SPEAKING (DOM) at t=${(i * 0.5).toFixed(1)}s, focus=${JSON.stringify(foc)} classes=${JSON.stringify(s.classes)}`);
      console.log('>>> capturing AX NOW...');
      try { execSync('cd /Users/bibekthapa/projects/work/demo-app/macos && swift run AXSnapshot chrome --url cyv-efne-fgr >/tmp/fgax.log 2>&1', { timeout: 60000 }); } catch (e) {}
      captured = true;
    }
    await sleep(500);
  }
  console.log('re-mute host:', await h.evalJs(`(${MIC})(false)`));
  console.log(captured ? 'CAPTURED during foreground speech' : 'no speaking detected');
  process.exit(captured ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
