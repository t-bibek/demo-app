#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PHASE-2 host-side Teams-WEB rig DRIVER (sandbox demo-app).
//
// Opens a REAL teams.microsoft.com meeting in HOST Chrome (VISIBLE, not
// headless), joins as an anonymous/guest web participant, and injects SYNTHETIC
// guest speech on a scripted ON/OFF schedule — so a later capture sweep (run
// separately, NOT here) can correlate audible guest speech with the
// AXDOMClassList changes the product binary sees. This driver ONLY produces the
// "flip timeline": an NDJSON log of every speak-on / speak-off transition with
// wall-clock AND monotonic timestamps. It does NOT run the capture sweep.
//
// REUSE (host driver + device-free fake audio, identical to the Meet/Teams-native
// rigs):
//   research/meet-dom-detector/live/cdp-lib.js          launchChrome / attachToPage
//   research/meet-dom-detector/live/fake-mic-override.js buildOverride (WAV→mic)
//   qa/teams-live/run-teams-live-qa.mjs                  meeting provisioning +
//                                                        anonymous guest join flow
//   research/meet-dom-detector/live/gum-override-probe   the __fakeMicReady /
//                                                        __rtcAudioStats assertion
//
// The fake mic is the WAV-backed getUserMedia override (no real mic, no virtual
// audio device): a decoded voice buffer looped through gain→MediaStreamDestination,
// gated by window.__fakeMicSpeak(true|false). Because it is REAL decoded voice,
// Teams' VAD treats it as speech; because it is device-free, N guests each get an
// independent source in their own Chrome.
//
// USAGE
//   node qa/teams-web/run-teams-web-capture.mjs --smoke [--url <teamsUrl>]
//       Launch + join ONE guest + assert the fake-audio track is live, then exit.
//   node qa/teams-web/run-teams-web-capture.mjs \
//       --participants 2|3 --cam on|off --foreground|--background-tab \
//       --duration-s N [--url <teamsUrl>]
//       Full scripted-speech capture driver (the sweep correlates against the
//       flip-timeline NDJSON this prints the path of).
//
// FLAGS
//   --participants 2|3   web guests to spawn (2 => 1 guest; 3 => 2 guests). def 2
//   --cam on|off         guest camera on the pre-join screen. def off
//   --foreground         keep guest-1's tab/window foregrounded (Page.bringToFront)
//   --background-tab     background guest-1's window (Browser.setWindowBounds
//                        minimized) — exercises WebView2/tab-throttle conditions
//   --duration-s N       total scripted-speech window in seconds. def 60
//   --smoke              one-guest launch+join+track-live assertion, then exit
//   --url <teamsUrl>     explicit meeting URL (skips native harvest)
//   --keep-open          do not kill Chrome on exit (leave tabs for inspection)
//
// ENV (mirrors the native rig)
//   TEAMS_MEETING_URL    explicit meeting URL (same as --url; --url wins)
//   TEAMS_GUEST_NAME     base guest display name. def "QA Web Guest"
//   TEAMS_WEB_OUT_DIR    artifact dir for the flip-timeline NDJSON.
//                        def qa/teams-web/artifacts
//
// MEETING PROVISIONING (same approach as qa/teams-live/run-teams-live-qa.mjs):
//   1. --url / TEAMS_MEETING_URL if given.
//   2. otherwise open native Teams, join/start a call, and harvest the link via
//      People panel → "Share invite" → "Copy meeting link" (clipboard). This
//      needs a signed-in native Teams (com.microsoft.teams2) + AX trust. If it
//      cannot obtain a URL, the driver returns BLOCKED (it never fabricates one).
//
// BLOCKED contract: if the web-guest join hits an auth wall / licensing gate
// (anonymous join disabled for the tenant, sign-in forced, "waiting for host"
// with no admit), the driver captures a DOM snapshot (screenshot-equivalent) to
// the artifact dir and prints STATUS=BLOCKED with the exact stage — it does NOT
// pretend the guest joined.
// ---------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LIVE = join(REPO, 'research', 'meet-dom-detector', 'live');
const { launchChrome, attachToPage, sleep } = require(join(LIVE, 'cdp-lib.js'));
const { buildOverride } = require(join(LIVE, 'fake-mic-override.js'));

// Per-guest WAV so overlapping speech is distinguishable in the mix.
const GUEST_WAVS = [
  join(LIVE, 'fake-audio', 'guest.wav'),
  join(LIVE, 'fake-audio', 'guest2.wav'),
];
// Distinct CDP ports per guest so multiple visible Chromes coexist. (The native
// rig uses 9331 for its single guest; keep clear of it.)
const GUEST_PORTS = [9341, 9342];

const log = (...a) => console.log('[teams-web]', ...a);

// ---- CLI ------------------------------------------------------------------
function parseArgs(argv) {
  const a = {
    participants: 2, cam: 'off', tab: 'foreground', durationS: 60,
    smoke: false, url: null, keepOpen: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--participants') a.participants = Number(argv[++i]);
    else if (t === '--cam') a.cam = String(argv[++i]);
    else if (t === '--foreground') a.tab = 'foreground';
    else if (t === '--background-tab') a.tab = 'background';
    else if (t === '--duration-s') a.durationS = Number(argv[++i]);
    else if (t === '--smoke') a.smoke = true;
    else if (t === '--url') a.url = String(argv[++i]);
    else if (t === '--keep-open') a.keepOpen = true;
    else if (t === '--help' || t === '-h') { printUsage(); process.exit(0); }
    else log(`WARN: ignoring unknown arg "${t}"`);
  }
  if (![2, 3].includes(a.participants)) { console.error('--participants must be 2 or 3'); process.exit(2); }
  if (!['on', 'off'].includes(a.cam)) { console.error('--cam must be on or off'); process.exit(2); }
  if (!(a.durationS > 0)) { console.error('--duration-s must be > 0'); process.exit(2); }
  return a;
}
function printUsage() {
  console.log('usage: run-teams-web-capture.mjs [--smoke] [--participants 2|3] [--cam on|off]');
  console.log('       [--foreground|--background-tab] [--duration-s N] [--url <teamsUrl>] [--keep-open]');
}

const GUEST_NAME_BASE = process.env.TEAMS_GUEST_NAME || 'QA Web Guest';
const guestName = (i) => (i === 0 ? GUEST_NAME_BASE : `${GUEST_NAME_BASE} ${i + 1}`);
const OUT_DIR = process.env.TEAMS_WEB_OUT_DIR || join(HERE, 'artifacts');

// ---- clocks ---------------------------------------------------------------
// wall = Date.now() (ms since epoch, correlatable with the detector's [event]
// wall timestamps). mono = process.hrtime.bigint() → ms, a monotonic clock
// immune to wall-clock jumps (NTP/suspend) so intra-run flip durations stay
// accurate even if wall time steps. The sweep aligns on wall; mono cross-checks.
const MONO0 = process.hrtime.bigint();
const monoMs = () => Number(process.hrtime.bigint() - MONO0) / 1e6;
const stamp = () => ({ wall: Date.now(), mono: Math.round(monoMs() * 1e3) / 1e3 });

// ---- meeting provisioning (same approach as the native rig) ---------------
// Precedence: --url > TEAMS_MEETING_URL > native-Teams harvest.
function drive(bin, ...args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 120_000 });
  return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}
async function harvestFromNativeTeams() {
  const TEAMSDRIVE = join(REPO, 'macos', '.build', 'debug', 'TeamsDrive');
  if (!existsSync(TEAMSDRIVE)) {
    log(`native harvest unavailable: TeamsDrive not built at ${TEAMSDRIVE} (run \`swift build --package-path macos\`)`);
    return null;
  }
  const press = async (labels, settleMs = 1500) => {
    for (const c of Array.isArray(labels) ? labels : [labels]) {
      if (drive(TEAMSDRIVE, 'press', c).ok) { log(`native pressed "${c}"`); await sleep(settleMs); return c; }
    }
    return null;
  };
  const win = drive(TEAMSDRIVE, 'windows');
  if (win.out.includes('NOT_TRUSTED')) { log('native harvest blocked: AX NOT_TRUSTED (grant Accessibility to the runner)'); return null; }
  spawnSync('open', ['-b', 'com.microsoft.teams2'], { encoding: 'utf8' });
  await sleep(12_000);
  drive(TEAMSDRIVE, 'raise');
  await sleep(2_000);
  // Join an existing call card, else start an instant "Meet now".
  if (!drive(TEAMSDRIVE, 'find', 'Leave').ok) {
    await press(['Meet']);
    if (!await press(['Join'])) {
      if (!await press(['Meet now', 'Meet Now', 'Start meeting'], 3_000)) { log('native harvest: no Join card and no "Meet now"'); return null; }
    }
    await sleep(6_000);
    await press(['Join now', 'Join'], 2_000);
    let inCall = false;
    for (let i = 0; i < 20 && !inCall; i++) { inCall = drive(TEAMSDRIVE, 'find', 'Leave').ok; if (!inCall) await sleep(3_000); }
    if (!inCall) { log('native harvest: never reached in-call (no Leave button)'); return null; }
  }
  if (!drive(TEAMSDRIVE, 'find', 'Attendees').ok) await press(['People'], 3_000);
  if (!await press(['Share invite'], 2_500)) { log('native harvest: no "Share invite"'); return null; }
  if (!await press(['Copy meeting link', 'Copy link'], 1_500)) { log('native harvest: no "Copy meeting link"'); return null; }
  const clip = spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout.trim();
  spawnSync('osascript', ['-e', 'tell application "System Events" to key code 53']); // Escape the share menu
  await sleep(800);
  return /^https:\/\/teams\./.test(clip) ? clip : null;
}
async function resolveMeetingUrl(args) {
  const explicit = args.url || process.env.TEAMS_MEETING_URL;
  if (explicit) {
    if (!/^https:\/\/teams\.(microsoft|live)\.com\//.test(explicit)) {
      log(`WARN: provided URL does not look like a teams.microsoft.com link: ${explicit}`);
    }
    return explicit;
  }
  log('no --url / TEAMS_MEETING_URL — attempting native-Teams harvest…');
  return harvestFromNativeTeams();
}

// ---- guest join (anonymous web guest, VISIBLE Chrome, fake-audio override) --
// Mirrors qa/teams-live/run-teams-live-qa.mjs joinGuest(override:true): launch
// about:blank, install the getUserMedia override as a PRE-NAV script so it runs
// before Teams grabs the mic, then navigate to the meeting. Completes the
// pre-join screen (continue-on-browser → name → mic ON → cam per flag → Join now).
async function launchGuest(url, idx, camOn) {
  const port = GUEST_PORTS[idx];
  const wav = GUEST_WAVS[idx % GUEST_WAVS.length];
  const name = guestName(idx);
  const chrome = launchChrome({
    port, headful: true, fakeAudio: true, url: 'about:blank',
    profileTag: `teams-web-guest-${idx}`,
  });
  const page = await attachToPage(port, /about:blank|^$/);
  await page.cmd('Page.addScriptToEvaluateOnNewDocument', { source: buildOverride(wav, `WEB-GUEST-${idx}`) });
  await page.cmd('Page.navigate', { url });

  const guest = { chrome, page, idx, name, port, url };
  const click = (needle) => page.evalJs(`(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"]')];
    const el = els.find(e => (e.innerText || '').trim().toLowerCase().includes(${JSON.stringify(needle)}));
    if (el) { el.click(); return (el.innerText || '').trim(); } return null;
  })()`);
  guest.click = click;

  // 1) "Continue on this browser" / "Join on the web" (anonymous path).
  let continued = false;
  for (let i = 0; i < 20 && !continued; i++) {
    if (await click('continue on this browser') || await click('join on the web')) { continued = true; break; }
    await sleep(1_500);
  }
  await sleep(6_000);

  // 2) Type the guest display name.
  await page.evalJs(`(() => {
    const inp = document.querySelector('input[placeholder*="name" i], input[type="text"]');
    if (!inp) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, ${JSON.stringify(name)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(1_000);

  // 3) Mic ON (pre-join). Best-effort: if the toggle reads muted, click it.
  const micState = await page.evalJs(`(() => {
    const t = document.querySelector('[data-tid*="toggle-mute"], [aria-label*="microphone" i][role="switch"], [title*="Unmute" i]');
    if (t && (t.getAttribute('aria-checked') === 'false' || /unmute/i.test(t.getAttribute('title') || ''))) { t.click(); return 'unmuted'; }
    return t ? 'already-on-or-unknown' : 'no-toggle';
  })()`);

  // 4) Camera per flag. Default off; if --cam on, click the camera toggle when it reads off.
  let camState = 'left-default';
  if (camOn) {
    camState = await page.evalJs(`(() => {
      const t = document.querySelector('[data-tid*="toggle-video"], [aria-label*="camera" i][role="switch"], [title*="Turn camera on" i], [aria-label*="Turn camera on" i]');
      if (!t) return 'no-toggle';
      const lbl = ((t.getAttribute('title') || '') + ' ' + (t.getAttribute('aria-label') || '')).toLowerCase();
      const off = /turn camera on/.test(lbl) || t.getAttribute('aria-checked') === 'false';
      if (off) { t.click(); return 'turned-on'; }
      return 'already-on-or-unknown';
    })()`);
  }

  // 5) Join now.
  let joinClicked = false;
  for (let i = 0; i < 12 && !joinClicked; i++) {
    if (await click('join now') || await click('join meeting')) { joinClicked = true; break; }
    await sleep(1_500);
  }
  guest.prejoin = { continued, micState, camState, joinClicked };
  return guest;
}

// Snapshot the guest DOM for BLOCKED evidence (screenshot-equivalent).
async function domSnapshot(page) {
  return page.evalJs(`(() => {
    const btns = [...document.querySelectorAll('button, a, [role="button"]')].map(e => (e.innerText || '').trim()).filter(Boolean).slice(0, 40);
    const inputs = [...document.querySelectorAll('input')].map(e => e.placeholder || e.type).slice(0, 15);
    const bodyText = (document.body ? document.body.innerText : '').slice(0, 4000);
    return JSON.stringify({ url: location.href, title: document.title, btns, inputs, bodyText });
  })()`);
}

// Classify whether a guest reached in-call, is waiting in a lobby, or is blocked
// by an auth/licensing wall. Returns { stage, detail }.
async function classifyJoinStage(page) {
  const snapRaw = await domSnapshot(page);
  let snap = {};
  try { snap = JSON.parse(snapRaw); } catch (e) { snap = { url: '', title: '', btns: [], inputs: [], bodyText: '' }; }
  const hay = ((snap.bodyText || '') + ' ' + (snap.btns || []).join(' ') + ' ' + (snap.title || '')).toLowerCase();
  // In-call markers: Leave/Hang up control present, or the call stage rendered.
  const inCall = /\bleave\b|hang up|call controls|meeting controls|\bmute\b|raise( your)? hand/.test(hay)
    && !/waiting for|someone will let you in|admit you/.test(hay);
  const lobby = /waiting for|someone will let you in|admit you|when the meeting starts|let you in soon/.test(hay);
  const authWall = /sign in|sign-in|log in|work or school account|not able to join|can'?t join|isn'?t allowed|not allowed to join|blocked by your organization|meeting has been locked|guest access/.test(hay)
    && !inCall;
  const stage = inCall ? 'in-call' : lobby ? 'lobby' : authWall ? 'auth-wall' : 'unknown';
  return { stage, snap };
}

// ---- fake-audio live assertion (reuse the override probe's oracles) --------
// Two distinct oracles, distinguished because the smoke can join but cannot force
// its own ADMISSION out of the meeting lobby:
//   trackLive  — the synthetic mic is genuinely alive CLIENT-side: __fakeMicReady
//                (decoded voice buffer looping through the graph), AudioContext
//                'running', and the dest track readyState === 'live'. This is the
//                smoke's actual target ("verify the fake-audio track is live").
//   transmit   — REAL WebRTC ground truth (__rtcAudioStats): an outbound audio RTP
//                exists AND media-source audioLevel > 0 while speaking. This proves
//                the mic is TRANSMITTING, but Teams only negotiates outbound media
//                (nonzero audioLevel) once the guest is ADMITTED — in the lobby it
//                reads 0 even with a perfectly live track. So `pass` keys on
//                trackLive; `transmitting` is reported separately (admission-gated).
async function assertFakeAudioLive(page) {
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) { ready = await page.evalJs('!!window.__fakeMicReady'); if (!ready) await sleep(500); }
  await page.evalJs('window.__fakeMicSpeak && window.__fakeMicSpeak(true)');
  const ctxState = await page.evalJs('window.__fakeMicCtxState ? window.__fakeMicCtxState() : "n/a"');
  // Give the graph a moment to emit and WebRTC a moment to encode.
  await sleep(4_000);
  let stats = null;
  for (let i = 0; i < 10; i++) {
    stats = await page.evalJs('window.__rtcAudioStats ? window.__rtcAudioStats() : null');
    if (stats && stats.outboundAudioRtp > 0 && stats.outAudioLevelMax > 0) break;
    await sleep(1_000);
  }
  const trackLive = await page.evalJs(`(() => {
    try { const t = window.__fakeStream && window.__fakeStream.getAudioTracks()[0]; return !!t && t.readyState === 'live'; } catch (e) { return false; }
  })()`);
  await page.evalJs('window.__fakeMicSpeak && window.__fakeMicSpeak(false)');
  // Track-liveness is the pass criterion (achievable pre-admission); transmission
  // is the stronger, admission-gated oracle reported alongside.
  const pass = !!ready && ctxState === 'running' && trackLive;
  const transmitting = !!stats && stats.outboundAudioRtp > 0 && stats.outAudioLevelMax > 0;
  return { pass, transmitting, fakeMicReady: ready, ctxState, trackLive, rtcStats: stats };
}

// ---- foreground / background the guest-1 window ----------------------------
async function setTabState(page, mode) {
  if (mode === 'foreground') { await page.cmd('Page.bringToFront'); return 'foreground'; }
  // background: minimize the browser window (WebView2/tab-throttle condition).
  try {
    const targets = await page.cmd('Target.getTargets', {});
    const list = (targets.result && targets.result.targetInfos) || [];
    const tgt = list.find((t) => t.type === 'page' && /teams\.(microsoft|live)\.com/.test(t.url || '')) || list.find((t) => t.type === 'page');
    if (!tgt) return 'no-target';
    const w = await page.cmd('Browser.getWindowForTarget', { targetId: tgt.targetId });
    const windowId = w.result && w.result.windowId;
    if (windowId == null) return 'no-window';
    await page.cmd('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    return 'background-minimized';
  } catch (e) { return 'error:' + (e && e.message); }
}

// ---- flip-timeline NDJSON --------------------------------------------------
function ensureOutDir() { if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true }); }
function newFlipLog(tag) {
  ensureOutDir();
  const p = join(OUT_DIR, `flip-timeline-${tag}.ndjson`);
  writeFileSync(p, '');
  return p;
}
function flip(path, record) { appendFileSync(path, JSON.stringify(record) + '\n'); }

// Toggle a single guest's speech gate WITHOUT letting a hung CDP eval stall the
// whole scripted timeline. cdp-lib's evalJs now rejects on timeout (a backgrounded
// guest can freeze Runtime.evaluate); we catch that, log it, and still emit the
// flip so the timeline stays aligned — the sweep reads `evalOk:false` as "this
// edge may not have taken client-side". Short 5s bound: the gate JS is trivial.
async function safeSpeak(g, on) {
  try { await g.page.evalJs(`window.__fakeMicSpeak && window.__fakeMicSpeak(${on ? 'true' : 'false'})`, 5_000); return true; }
  catch (e) { log(`WARN: guest ${g.idx} speak(${on}) eval failed: ${e && e.message}`); return false; }
}

// Set every guest's speech gate and record ONE flip event per guest with wall+mono.
async function setSpeakAll(guests, on, flipPath, extra = {}) {
  for (const g of guests) {
    const evalOk = await safeSpeak(g, on);
    const s = stamp();
    flip(flipPath, { event: on ? 'speak_on' : 'speak_off', guest: g.name, guestIdx: g.idx, wall: s.wall, mono: s.mono, evalOk, ...extra });
  }
}

// ---- smoke: launch + join ONE guest + assert fake-audio track live ---------
async function runSmoke(url) {
  log('SMOKE: launch + join one guest + assert fake-audio track live');
  let guest = null;
  try {
    guest = await launchGuest(url, 0, /* camOn */ false);
    log(`guest launched (port ${guest.port}); pre-join: ${JSON.stringify(guest.prejoin)}`);
    // Let the join settle, then classify where we landed.
    await sleep(8_000);
    const { stage, snap } = await classifyJoinStage(guest.page);
    log(`join stage: ${stage} (${snap.url})`);
    if (stage === 'auth-wall') {
      const snapPath = join(OUT_DIR, 'smoke-BLOCKED-dom.json');
      ensureOutDir();
      writeFileSync(snapPath, JSON.stringify(snap, null, 2));
      log(`BLOCKED at auth/licensing wall — DOM snapshot: ${snapPath}`);
      return { status: 'BLOCKED', stage, snapPath };
    }
    // Even if lobby/unknown, the fake-mic track can still be asserted live (the
    // synthetic source exists client-side regardless of admission).
    const audio = await assertFakeAudioLive(guest.page);
    log(`fake-audio assertion: ${JSON.stringify(audio)}`);
    if (!audio.pass) {
      // Track-not-live in a non-auth state is a REVIEW (rig defect), not a clean PASS.
      const snapPath = join(OUT_DIR, 'smoke-REVIEW-dom.json');
      ensureOutDir();
      writeFileSync(snapPath, JSON.stringify(snap, null, 2));
      return { status: 'REVIEW', stage, audio, snapPath };
    }
    return { status: 'PASS', stage, audio };
  } finally {
    if (guest && guest.chrome) { try { guest.chrome.kill(); } catch (e) {} }
  }
}

// ---- full scripted-speech capture driver -----------------------------------
async function runCapture(url, args) {
  const nGuests = args.participants - 1; // participants includes the native host
  const tag = `p${args.participants}-cam${args.cam}-${args.tab}-${Date.now()}`;
  const flipPath = newFlipLog(tag);
  log(`capture: ${nGuests} web guest(s), cam=${args.cam}, tab=${args.tab}, duration=${args.durationS}s`);
  log(`flip-timeline NDJSON: ${flipPath}`);

  const guests = [];
  let status = 'PASS';
  const blockedGuests = [];
  try {
    for (let i = 0; i < nGuests; i++) {
      const g = await launchGuest(url, i, args.cam === 'on');
      guests.push(g);
      log(`guest ${i} (${g.name}) launched on port ${g.port}; pre-join: ${JSON.stringify(g.prejoin)}`);
      await sleep(6_000);
      const { stage, snap } = await classifyJoinStage(g.page);
      log(`guest ${i} join stage: ${stage}`);
      flip(flipPath, { event: 'guest_join', guest: g.name, guestIdx: i, stage, ...stamp() });
      if (stage === 'auth-wall') {
        const snapPath = join(OUT_DIR, `BLOCKED-guest${i}-dom.json`);
        writeFileSync(snapPath, JSON.stringify(snap, null, 2));
        log(`guest ${i} BLOCKED at auth/licensing wall — DOM snapshot: ${snapPath}`);
        blockedGuests.push({ idx: i, snapPath });
      }
    }
    if (blockedGuests.length === guests.length && guests.length > 0) {
      // Every guest hit the wall — the whole run is BLOCKED.
      status = 'BLOCKED';
      flip(flipPath, { event: 'run_blocked', reason: 'all guests hit auth/licensing wall', ...stamp() });
      return { status, flipPath, blockedGuests };
    }

    // Assert each (non-blocked) guest's fake-audio track is live before scripting.
    for (const g of guests) {
      if (blockedGuests.some((b) => b.idx === g.idx)) continue;
      const audio = await assertFakeAudioLive(g.page);
      flip(flipPath, { event: 'audio_live', guest: g.name, guestIdx: g.idx, pass: audio.pass, rtc: audio.rtcStats, ...stamp() });
      if (!audio.pass) log(`WARN: guest ${g.idx} fake-audio not proven live: ${JSON.stringify(audio)}`);
    }

    // Foreground / background guest-1 per flag (the tab-throttle condition applies
    // to the FIRST guest's window; others are left as launched).
    if (guests[0]) {
      const tabState = await setTabState(guests[0].page, args.tab);
      flip(flipPath, { event: 'tab_state', guest: guests[0].name, mode: args.tab, applied: tabState, ...stamp() });
      log(`guest 0 tab state → ${tabState}`);
    }

    // Scripted speak ON/OFF cycles across the duration. Symmetric 4s-on / 4s-off
    // square wave; each edge is one NDJSON flip per guest with wall+mono. When
    // there are 2 guests they ALTERNATE (guest0 speaks while guest1 is silent and
    // vice-versa) so the sweep sees single-speaker transitions, not overlap.
    const activeGuests = guests.filter((g) => !blockedGuests.some((b) => b.idx === g.idx));
    const ON_MS = 4_000, OFF_MS = 4_000;
    const endAt = Date.now() + args.durationS * 1_000;
    // Start all silent.
    await setSpeakAll(activeGuests, false, flipPath, { phase: 'init_silence' });
    let cycle = 0;
    flip(flipPath, { event: 'script_start', durationS: args.durationS, guests: activeGuests.map((g) => g.name), ...stamp() });
    while (Date.now() < endAt) {
      if (activeGuests.length <= 1) {
        // Single guest: simple on/off square wave.
        await setSpeakAll(activeGuests, true, flipPath, { cycle });
        await sleep(Math.min(ON_MS, Math.max(0, endAt - Date.now())));
        await setSpeakAll(activeGuests, false, flipPath, { cycle });
        await sleep(Math.min(OFF_MS, Math.max(0, endAt - Date.now())));
      } else {
        // Multi guest: round-robin — exactly one speaker per slot.
        const speaker = activeGuests[cycle % activeGuests.length];
        for (const g of activeGuests) {
          const on = g === speaker;
          const evalOk = await safeSpeak(g, on);
          const s = stamp();
          flip(flipPath, { event: on ? 'speak_on' : 'speak_off', guest: g.name, guestIdx: g.idx, wall: s.wall, mono: s.mono, cycle, evalOk });
        }
        await sleep(Math.min(ON_MS, Math.max(0, endAt - Date.now())));
      }
      cycle++;
    }
    // End all silent.
    await setSpeakAll(activeGuests, false, flipPath, { phase: 'final_silence' });
    flip(flipPath, { event: 'script_end', cycles: cycle, ...stamp() });
    log(`scripted ${cycle} cycle(s) over ${args.durationS}s`);
    if (blockedGuests.length) status = 'PARTIAL-BLOCKED';
    return { status, flipPath, blockedGuests, cycles: cycle };
  } finally {
    if (!args.keepOpen) {
      for (const g of guests) { if (g.chrome) { try { g.chrome.kill(); } catch (e) {} } }
    } else {
      log('--keep-open: leaving Chrome guest(s) running');
    }
  }
}

// ---- main -----------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureOutDir();
  const url = await resolveMeetingUrl(args);
  if (!url) {
    log('STATUS=BLOCKED: could not obtain a Teams meeting URL (pass --url / TEAMS_MEETING_URL, or ensure native Teams is signed in + AX-trusted for harvest).');
    console.log(JSON.stringify({ status: 'BLOCKED', reason: 'no-meeting-url' }));
    process.exit(3);
  }
  log(`meeting URL: ${url}`);

  const result = args.smoke ? await runSmoke(url) : await runCapture(url, args);
  log(`STATUS=${result.status}`);
  if (result.flipPath) log(`flip-timeline NDJSON => ${result.flipPath}`);
  console.log(JSON.stringify({ ...result, url }));
  // Exit code: PASS=0, BLOCKED=3, anything else=1.
  process.exit(result.status === 'PASS' ? 0 : result.status === 'BLOCKED' ? 3 : 1);
}

main().catch((e) => { console.error('[teams-web] ERROR:', e && (e.stack || e.message || e)); process.exit(1); });
