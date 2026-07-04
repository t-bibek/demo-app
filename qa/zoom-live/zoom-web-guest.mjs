// Resilient Zoom WEB-client guest for the live native-Zoom QA rig. Joins the
// meeting in a headful Chrome (via cdp-lib.js) with a fake-device audio tone and
// a distinct name, driving the join flow by TEXT/aria discovery (no brittle CSS
// selectors), then exposes setGuestMuted() so the rig can drive the mute-gate
// matrix from the remote side. On any failure it writes an HTML + screenshot
// debug dump and rejects — the runner turns that into an honest verdict, never a
// hang. Native Zoom's waiting room (if on) is cleared host-side by admitLoop().
import { createRequire } from 'module';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const { launchChrome, attachToPage, sleep } =
  require(join(REPO, 'research', 'meet-dom-detector', 'live', 'cdp-lib.js'));

const DEBUG_DIR = join(HERE, 'debug');

/// Invite URL (…zoom.us/j/<id>?pwd=<pwd>) → the web-client join URL. `un` seeds
/// the display name; the join screen also lets us set it explicitly.
export function guestUrl(inviteUrl, name) {
  const m = inviteUrl.match(/zoom\.us\/j\/(\d+)\?pwd=([\w.-]+)/);
  if (!m) throw new Error(`unparseable invite URL: ${inviteUrl}`);
  return `https://app.zoom.us/wc/join/${m[1]}?pwd=${m[2]}&un=${encodeURIComponent(name)}`;
}

async function debugDump(page, tag) {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    const html = await page.evalJs('document.documentElement.outerHTML');
    if (html) writeFileSync(join(DEBUG_DIR, `${tag}.html`), html);
    const shot = await page.cmd('Page.captureScreenshot', { format: 'png' });
    if (shot?.result?.data) {
      writeFileSync(join(DEBUG_DIR, `${tag}.png`), Buffer.from(shot.result.data, 'base64'));
    }
  } catch (_) { /* best effort */ }
}

function clickByText(page, reSrc) {
  return page.evalJs(`(() => {
    const re = ${reSrc};
    const els = [...document.querySelectorAll('button,[role=button],a')];
    const b = els.find(e => re.test((e.innerText || e.getAttribute('aria-label') || '').trim()));
    if (b) { b.click(); return true; } return false;
  })()`);
}

function setNameInput(page, name) {
  return page.evalJs(`(() => {
    const i = document.querySelector('#input-for-name, input[type=text], input[placeholder*="name" i]');
    if (!i) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, ${JSON.stringify(name)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

function readState(page) {
  return page.evalJs(`(() => ({
    hasNameInput: !!document.querySelector('#input-for-name'),
    inFooter: !!document.querySelector('[aria-label*="mute" i], [class*="footer-button"]'),
    needsAudioJoin: /join audio by computer|join with computer audio/i.test(document.body?.innerText || ''),
    needsSignIn: /sign in to join|please sign in/i.test(document.body?.innerText || ''),
  }))()`);
}

/// Launch a guest and drive it to the in-meeting footer (or the host waiting
/// room, which admitLoop clears). Returns { chrome, page, name }. The guest may
/// be sitting in the waiting room on return — the caller polls the native roster.
export async function joinZoomWebGuest({ port, name, inviteUrl, joinTimeoutMs = 90_000 }) {
  const url = guestUrl(inviteUrl, name);
  const chrome = launchChrome({ port, headful: true, fakeAudio: true, url, profileTag: `zoom-${name.replace(/\s+/g, '')}` });
  let page;
  try {
    page = await attachToPage(port, /zoom\.us/);
    const t0 = Date.now();
    let clickedJoin = false;
    while (Date.now() - t0 < joinTimeoutMs) {
      const st = await readState(page);
      if (st.needsSignIn) { await debugDump(page, `${name}-signin-required`); throw new Error(`${name}: meeting requires sign-in (guests disabled?)`); }
      if (st.hasNameInput) {
        await setNameInput(page, name);
        await sleep(400);
        await clickByText(page, '/^join$/i');
        clickedJoin = true;
      }
      if (st.needsAudioJoin) await clickByText(page, '/join audio by computer|join with computer audio|join audio/i');
      // In the footer (or waiting room past the Join click) → done driving here.
      if (clickedJoin && !st.hasNameInput) return { chrome, page, name };
      await sleep(2000);
    }
    await debugDump(page, `${name}-join-timeout`);
    throw new Error(`${name}: never cleared the join screen within ${joinTimeoutMs}ms`);
  } catch (e) {
    if (page) await debugDump(page, `${name}-join-error`);
    chrome.kill();
    throw e;
  }
}

/// Drive the guest's mic to a desired state (the mute-gate matrix). Discovers the
/// current state from the toggle's label ("Unmute" shown ⇒ currently muted).
export async function setGuestMuted(page, wantMuted) {
  for (let i = 0; i < 3; i++) {
    const label = await page.evalJs(`(() => {
      const b = [...document.querySelectorAll('button,[role=button]')]
        .find(e => /^(un)?mute( my microphone| audio)?$/i.test((e.getAttribute('aria-label') || e.innerText || '').trim()));
      return b ? (b.getAttribute('aria-label') || b.innerText).trim() : null;
    })()`);
    if (!label) { await sleep(1200); continue; }
    const isMuted = /^unmute/i.test(label);
    if (isMuted === wantMuted) return true;
    await clickByText(page, '/^(un)?mute/i');
    await sleep(1200);
  }
  await debugDump(page, 'mute-toggle-fail');
  return false;
}

export { debugDump };
