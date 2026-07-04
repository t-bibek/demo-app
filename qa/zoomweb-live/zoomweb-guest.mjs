// ---------------------------------------------------------------------------
// Zoom WEB-client guest with SPEECH-GAIN GATING for the web live-QA rig.
//
// This is the discriminating primitive the whole web rig hangs on: unlike
// qa/zoom-live/zoom-web-guest.mjs (which relies on Chrome's fake-DEVICE tone and
// drives the Zoom Mute button), this guest installs the getUserMedia override
// from research/meet-dom-detector/live/fake-mic-override.js BEFORE the page
// navigates (Page.addScriptToEvaluateOnNewDocument), so real decoded speech
// becomes the mic AND `window.__fakeMicSpeak(true|false)` gates the speech gain
// INDEPENDENTLY of the mute button. That independence is the point:
//   • speech OFF + unmuted  → the falsification state (silence-live must be ZERO)
//   • speech ON  + unmuted  → a real speaker onset the detector must catch
//   • mute state is a SEPARATE control (setGuestMuted) — never toggled to fake speech.
// NEVER tone+mute-toggle (that conflates "is muted" with "is speaking").
//
// Chrome 149's --use-file-for-fake-audio-capture is broken, so we still launch
// with --use-fake-device-for-media-stream (the override REPLACES that device's
// track via getUserMedia; the fake device just satisfies the permission grant).
// ---------------------------------------------------------------------------
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LIVE = join(REPO, 'research', 'meet-dom-detector', 'live');
const { CHROME, sleep, httpJson, attachToPage } = require(join(LIVE, 'cdp-lib.js'));
const { buildOverride } = require(join(LIVE, 'fake-mic-override.js'));

const DEBUG_DIR = join(HERE, 'debug');
const FAKE_AUDIO = join(LIVE, 'fake-audio');

// Ensure the distinct speech WAVs exist (make-fake-speech.sh generates them; they
// are gitignored). Returns a resolved path for a seat, falling back to whatever WAV
// is present so a checkout without the exact file still gets SOME speech content.
export function ensureFakeAudio() {
  const need = ['host.wav', 'guest.wav', 'guest2.wav'].map((f) => join(FAKE_AUDIO, f));
  if (!need.every(existsSync)) {
    // Best-effort generation; the rig degrades to REVIEW if speech never materializes.
    spawnSync('bash', [join(LIVE, 'make-fake-speech.sh')], { encoding: 'utf8', timeout: 120_000 });
  }
}
export function wavFor(seat) {
  const map = { observer: 'host.wav', alpha: 'guest.wav', bravo: 'guest2.wav' };
  const p = join(FAKE_AUDIO, map[seat] || 'guest.wav');
  if (existsSync(p)) return p;
  for (const f of ['guest.wav', 'host.wav', 'guest2.wav', 'guestb.wav']) {
    const alt = join(FAKE_AUDIO, f); if (existsSync(alt)) return alt;
  }
  return p; // may not exist — buildOverride will surface __fakeMicErr, rig records it
}

// Invite URL (…zoom.us/j/<id>?pwd=<pwd>) → the web-client join URL. `un` seeds the
// display name; the join screen also lets us set it explicitly.
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
    if (shot?.result?.data) writeFileSync(join(DEBUG_DIR, `${tag}.png`), Buffer.from(shot.result.data, 'base64'));
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

// Launch Chrome, attach to about:blank FIRST so we can install the getUserMedia
// override BEFORE the Zoom SPA loads, THEN navigate to the join URL. Mirrors
// roster-rig-3p.js's pre-nav injection. Returns { chrome, page, name, seat }.
export async function joinZoomWebGuest({ port, name, seat, inviteUrl, joinTimeoutMs = 120_000 }) {
  ensureFakeAudio();
  const wav = wavFor(seat || 'alpha');
  const profile = mkdtempSync(join(tmpdir(), `zoomweb-${(name || seat).replace(/\s+/g, '')}-`));
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    // Keep occluded/background renderers live so a backgrounded guest's audio
    // pipeline (and the observer's tile animations) don't get compositor-throttled.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    'about:blank',
  ];
  const { spawn, execSync } = await import('node:child_process');
  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  const chrome = { proc, profile, port, kill() { try { proc.kill('SIGKILL'); } catch (e) {} try { execSync(`rm -rf ${profile}`); } catch (e) {} } };

  let page;
  try {
    // Attach to the blank tab first.
    page = await attachToPage(port, /about:blank|/);
    // Install the speech-gain override so it runs on the NEXT document (the Zoom SPA).
    await page.cmd('Page.addScriptToEvaluateOnNewDocument', { source: buildOverride(wav, `zoomweb-${seat || name}`) });
    // Now navigate to the join URL.
    const url = guestUrl(inviteUrl, name);
    await page.cmd('Page.navigate', { url });

    const t0 = Date.now();
    let clickedJoin = false;
    while (Date.now() - t0 < joinTimeoutMs) {
      let st;
      try { st = await readState(page); } catch (e) { await sleep(1500); continue; }
      if (st.needsSignIn) { await debugDump(page, `${name}-signin-required`); throw new Error(`${name}: meeting requires sign-in (guests disabled?)`); }
      if (st.hasNameInput) {
        await setNameInput(page, name);
        await sleep(400);
        await clickByText(page, '/^join$/i');
        clickedJoin = true;
      }
      if (st.needsAudioJoin) await clickByText(page, '/join audio by computer|join with computer audio|join audio/i');
      if (clickedJoin && !st.hasNameInput) {
        // Confirm the speech override actually installed on this document.
        let ready = false;
        try { ready = await page.evalJs('!!window.__fakeMicSpeak'); } catch (e) {}
        return { chrome, page, name, seat, overrideReady: !!ready };
      }
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

// Gate a guest's SPEECH GAIN — independent of mute. true = emit real decoded
// speech; false = silence (unmuted-but-silent = the falsification state).
export async function setGuestSpeak(page, on) {
  try {
    await page.evalJs(`window.__fakeMicSpeak && window.__fakeMicSpeak(${on ? 'true' : 'false'})`);
    return true;
  } catch (e) { return false; }
}

// Gate a guest's PURE TONE (energy, no speech content) — the VAD-quality probe:
// energy without voice must NOT name the guest. Independent of __fakeMicSpeak.
export async function setGuestTone(page, on, hz = 440) {
  try {
    await page.evalJs(`window.__fakeMicTone && window.__fakeMicTone(${on ? 'true' : 'false'}, ${hz})`);
    return true;
  } catch (e) { return false; }
}

// Fire a repeated SHORT TRANSIENT tone burst (a ding / click / chime — the exact
// class of non-voice energy the SchmittVad's enterFrames>=2 debounce rejects). Each
// pulse is well under two 50ms VAD frames, so it never opens a speech segment, yet
// the audio path genuinely carries energy (so this is a real falsification, not a
// no-op). A SUSTAINED tone is deliberately NOT used: a level-only VAD cannot and does
// not claim to reject sustained tone energy — only transients — so the probe must
// test transients to be an honest test of the shipped VAD (plan B4).
export async function pulseGuestTone(page, { pulseMs = 40, gapMs = 300, count = 12, hz = 440 } = {}) {
  // Schedule the whole burst train on the browser's AudioContext clock (timing must
  // not depend on CDP round-trips — a jittery gap could accidentally sustain a
  // transient across two VAD frames and open a segment). Returns the train duration.
  let durMs = 0;
  try {
    durMs = await page.evalJs(`window.__fakeMicTonePulse ? window.__fakeMicTonePulse(${count}, ${pulseMs}, ${gapMs}, ${hz}) : 0`);
  } catch (e) { durMs = 0; }
  const ms = Number(durMs) || (count * (pulseMs + gapMs) + 500);
  await sleep(ms + 300);   // wait out the scheduled train
  return ms > 0;
}

// Drive the guest's Zoom MUTE button to a desired state (a SEPARATE axis from
// speech gain). Discovers current state from the toggle label ("Unmute" ⇒ muted).
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

// Switch the OBSERVED web client's own View (client-local; controls what the
// detector reads). Discovers the top-right "View" control, opens it, picks the
// wanted mode by text. Returns the mode string on success or null.
export async function setObserverView(page, mode /* 'speaker' | 'gallery' */) {
  const want = mode === 'gallery' ? /gallery/i : /speaker/i;
  for (let i = 0; i < 3; i++) {
    // Open the View menu (top-right). Zoom labels it "View" / "Change view".
    const opened = await clickByText(page, '/^view$|change view/i');
    if (opened) await sleep(900);
    // Pick the wanted item.
    const picked = await page.evalJs(`(() => {
      const re = ${want.toString()};
      const els = [...document.querySelectorAll('button,[role=menuitem],[role=button],a,li')];
      const b = els.find(e => re.test((e.innerText || e.getAttribute('aria-label') || '').trim()));
      if (b) { b.click(); return true; } return false;
    })()`);
    if (picked) { await sleep(1500); return mode; }
    await sleep(800);
  }
  return null;
}

// Start a screen share from a guest (the observed client's filmstrip block). Zoom
// web share needs the browser picker; Chrome auto-selects a source when launched
// with --auto-select-desktop-capture-source, which the rig can't retro-fit, so
// this is BEST-EFFORT: it clicks Share and auto-confirms any picker it can reach.
// Returns true only if a share visibly started (a Stop Share control appears).
export async function startGuestShare(page) {
  await clickByText(page, '/^share screen$|share$/i');
  await sleep(1500);
  // Some Zoom-web builds render an in-page source picker; pick the first tab/window.
  await page.evalJs(`(() => {
    const b = [...document.querySelectorAll('button,[role=button]')]
      .find(e => /^share$|^screen$/i.test((e.innerText || e.getAttribute('aria-label') || '').trim()));
    if (b) b.click(); return !!b;
  })()`);
  await sleep(2000);
  const sharing = await page.evalJs(`!![...document.querySelectorAll('button,[role=button]')]
    .find(e => /stop share|stop sharing/i.test((e.getAttribute('aria-label') || e.innerText || '').trim()))`);
  return !!sharing;
}

export { debugDump };
