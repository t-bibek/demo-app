'use strict';
// Observer instance: join a Meet, inject the real DOM detector, and log a
// who-is-speaking timeline (caption-free) by polling window.__meetDetect() against
// the live DOM. Writes JSONL you can diff against your known speaking schedule.
//
//   node observe-and-score.js <meetingUrl> <durationSec> [port] [outFile]
//
// This is the live analogue of run-browser-qa.js — same detector, real Meet DOM.
const fs = require('fs'); const path = require('path');
const { launchChrome, attachToPage, sleep } = require('./cdp-lib');

const URL = process.argv[2];
const DUR = parseInt(process.argv[3] || '60', 10);
const PORT = parseInt(process.argv[4] || '9300', 10);
const OUT = process.argv[5] || path.join(__dirname, 'observe-timeline.jsonl');
const DETECTOR = fs.readFileSync(path.join(__dirname, '..', 'browser-qa', 'dom-detector.js'), 'utf8');
if (!URL) { console.error('usage: node observe-and-score.js <meetingUrl> <durationSec> [port] [outFile]'); process.exit(2); }

const CLICK_FN = `function(sels){for(const s of sels){let el=null;try{el=document.querySelector(s);}catch(e){}if(!el){const rx=new RegExp(s,'i');el=[...document.querySelectorAll('button,[role=button],span')].find(n=>rx.test((n.getAttribute('aria-label')||'')+' '+(n.textContent||'')));}if(el){el.click();return s;}}return null;}`;

async function main() {
  const chrome = launchChrome({ port: PORT, headful: true, fakeAudio: true, url: URL, profileTag: 'meet-obs' });
  const out = fs.createWriteStream(OUT, { flags: 'w' });
  try {
    const { evalJs } = await attachToPage(PORT, /meet\.google\.com/);
    await sleep(4000);
    await evalJs(`(function(){var i=document.querySelector('input[jsname][type="text"], input[type="text"][aria-label]');if(i){i.value='QA Observer';i.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    await evalJs(`(${CLICK_FN})(['button[aria-label*="Turn off camera" i]','Turn off camera'])`);
    await evalJs(`(${CLICK_FN})(['button[aria-label*="Turn off microphone" i]','Turn off microphone'])`);
    await sleep(400);
    await evalJs(`(${CLICK_FN})(['Join now','Ask to join','button[jsname="Qx7uuf"]'])`);
    console.log('[observe] join clicked; waiting to be admitted…');
    // Wait until we're in the call (call controls / tiles present), then inject.
    for (let i = 0; i < 60; i++) { if (await evalJs(`!!document.querySelector('[data-participant-id],[jsname="QgSmzd"],.IisKdb')`)) break; await sleep(1000); }
    await evalJs(DETECTOR);
    await evalJs(`window.__ctx={vad:true}`);

    const start = Date.now(); let n = 0;
    while ((Date.now() - start) / 1000 < DUR) {
      const r = await evalJs(`JSON.stringify(window.__meetDetect())`);
      let d = {}; try { d = JSON.parse(r); } catch (e) {}
      // someoneFloor with a hardcoded vad=true just means "no attributable speaker" -> treat as silence for the log
      const names = d.via === 'someoneFloor' ? [] : (d.names || []);
      const rec = { t: +((Date.now() - start) / 1000).toFixed(2), names, via: d.via };
      out.write(JSON.stringify(rec) + '\n'); n++;
      await sleep(500);
    }
    out.end();
    console.log(JSON.stringify({ samples: n, out: OUT, durationSec: DUR }, null, 2));
    console.log('[observe] Compare observe-timeline.jsonl against your known who-spoke-when schedule.');
    chrome.kill(); process.exit(0);
  } catch (e) { console.error('ERROR', e.stack || e); try { out.end(); } catch (x) {} chrome.kill(); process.exit(1); }
}
main();
