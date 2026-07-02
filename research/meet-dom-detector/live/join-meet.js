'use strict';
// Join a Google Meet as a "speaker" participant and stay in the call, emitting the
// fake-device audio tone (the working audio source in Chrome 149) so this
// participant registers as speaking. Headful (Meet blocks headless joins).
//
//   node join-meet.js <meetingUrl> <displayName> [port]
//
// Requires: the meeting to admit the participant. For a personal meeting, the
// host must click "Admit" (or set the link to open access). Anonymous join uses a
// typed display name; no Google sign-in needed for the guest instances.
const { launchChrome, attachToPage, sleep } = require('./cdp-lib');

const URL = process.argv[2];
const NAME = process.argv[3] || 'QA Speaker';
const PORT = parseInt(process.argv[4] || '9310', 10);
if (!URL) { console.error('usage: node join-meet.js <meetingUrl> <name> [port]'); process.exit(2); }

// Click the first element matching any of a list of selectors / accessible names.
const CLICK_FN = `function(sels){
  for (const s of sels){
    let el = null;
    try { el = document.querySelector(s); } catch(e){}
    if (!el){ // treat as accessible-name match on buttons/spans
      const rx = new RegExp(s, 'i');
      el = [...document.querySelectorAll('button,[role=button],span')].find(n => rx.test((n.getAttribute('aria-label')||'')+' '+(n.textContent||'')));
    }
    if (el){ el.click(); return s; }
  }
  return null;
}`;

async function main() {
  const chrome = launchChrome({ port: PORT, headful: true, fakeAudio: true, url: URL, profileTag: 'meet-spk' });
  try {
    const { evalJs } = await attachToPage(PORT, /meet\.google\.com/);
    await sleep(4000);
    // Fill the guest name if the pre-join asks for it.
    await evalJs(`(function(){var i=document.querySelector('input[jsname][type="text"], input[type="text"][aria-label]');if(i){i.value=${JSON.stringify(NAME)};i.dispatchEvent(new Event('input',{bubbles:true}));return true;}return false;})()`);
    // Turn the camera OFF (no fake video needed); keep mic ON (fake tone = speaking).
    await evalJs(`(${CLICK_FN})(['button[aria-label*="Turn off camera" i]','Turn off camera'])`);
    await sleep(500);
    // Join / ask to join (locale-agnostic fallbacks).
    const joined = await evalJs(`(${CLICK_FN})(['Join now','Ask to join','button[jsname="Qx7uuf"]','button[jsname]:not([aria-label])'])`);
    console.log(JSON.stringify({ name: NAME, port: PORT, joinClicked: joined }, null, 2));
    console.log('[join-meet] staying in call — Ctrl-C to leave. (Host may need to Admit.)');
    // Stay resident so the participant remains in the meeting.
    await new Promise(() => {});
  } catch (e) { console.error('ERROR', e.stack || e); chrome.kill(); process.exit(1); }
}
main();
