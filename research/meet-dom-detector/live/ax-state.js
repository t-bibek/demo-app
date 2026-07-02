'use strict';
// Change the meeting Chrome's window/tab state so we can measure AX-tree
// availability in each. Commands: front | newtab | closetabs | minimize | restore
const http = require('http');
const { attachToPage, httpJson, sleep } = require('./cdp-lib');
const PORT = 9222;
const put = (path) => new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port: PORT, path, method: 'PUT' }, x => { let d = ''; x.on('data', c => d += c); x.on('end', () => res(d)); }); r.on('error', rej); r.end(); });

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'newtab') { await put('/json/new?about:blank'); console.log('opened+activated about:blank (meeting tab backgrounded)'); }
  else if (cmd === 'front') { const p = await attachToPage(PORT, /meet\.google\.com/); await p.cmd('Page.bringToFront'); console.log('meeting tab -> front'); }
  else if (cmd === 'closetabs') { const l = await httpJson(PORT, '/json'); for (const t of l.filter(t => t.type === 'page' && /about:blank|chrome:\/\/new/.test(t.url || ''))) await put('/json/close/' + t.id); console.log('closed blank tabs'); }
  else if (cmd === 'minimize' || cmd === 'restore') {
    const l = await httpJson(PORT, '/json'); const m = l.find(t => /meet\.google\.com/.test(t.url || ''));
    const p = await attachToPage(PORT, /meet\.google\.com/);
    const w = await p.cmd('Browser.getWindowForTarget', { targetId: m.id });
    const windowId = w.result && w.result.windowId;
    if (cmd === 'restore') { await p.cmd('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); await p.cmd('Page.bringToFront'); console.log('window restored'); }
    else { await p.cmd('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }); console.log('window minimized'); }
  }
  await sleep(300); process.exit(0);
})().catch(e => { console.log('err', e.message); process.exit(0); });
