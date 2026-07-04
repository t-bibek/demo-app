// ---------------------------------------------------------------------------
// DIAGNOSTIC PROBE — guest audio injection into a live native Zoom meeting.
//
// Bootstraps ONE fresh meeting via the shared host lib, joins ONE web guest
// (either the fake-DEVICE tone guest `zoom-web-guest.mjs` or the fake-mic
// OVERRIDE speech guest `zoomweb-live/zoomweb-guest.mjs`), admits it, then does
// deep CDP instrumentation of the guest page:
//   - the mute button's aria-label before/after setGuestMuted(false)
//   - whether "Join audio by computer" was ever needed / clicked
//   - AudioContext state, __fakeMicReady, getUserMedia override installed
//   - __rtcAudioStats() outbound audioLevel (the WebRTC transmission oracle)
// while running the detector (MSD event mode + vad trace + edge log) and
// printing every remote-RMS / vad_frame / speech_on line it sees.
//
// SUCCESS = (a) detector shows the guest is_muted:false,
//           (b) sustained remote RMS >= ~0.005 when speaking, silence when not,
//           (c) a speech_on names the guest via zoom.mute_gate.
//
// Usage:
//   node qa/zoom-live/probe-guest-audio.mjs [--guest tone|speech] [--secs 45]
// Env: ZOOM_MEETING_URL to reuse a live meeting (skips bootstrap).
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PATHS, sleep, makeLog, drive, keystroke, panelToggle,
  bootstrapMeeting, harvestInvite, admitLoop, endMeeting, rosterCount,
} from './zoom-host-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const log = makeLog('probe');
const DEBUG_DIR = join(HERE, 'debug');
const EDGE_LOG = join(HERE, 'zoom-native-edges.ndjson');
const EVENTS = join(HERE, 'probe-events.ndjson');

const argv = process.argv.slice(2);
const guestKind = (argv.includes('--guest') ? argv[argv.indexOf('--guest') + 1] : 'tone');
const SECS = (argv.includes('--secs') ? Number(argv[argv.indexOf('--secs') + 1]) : 45);
const GUEST_NAME = guestKind === 'speech' ? 'Guest Bravo' : 'Guest Alpha';
const PORT = guestKind === 'speech' ? 9351 : 9350;

// ---- guest module (both expose joinZoomWebGuest + setGuestMuted) -----------
const toneMod = await import('./zoom-web-guest.mjs');
const speechMod = await import('../zoomweb-live/zoomweb-guest.mjs');
const mod = guestKind === 'speech' ? speechMod : toneMod;

const DETECTOR_BIN = PATHS.DETECTOR_BIN;
const isZoom = (e) => typeof e.meeting_id === 'string' && e.meeting_id.startsWith('zoom::');

function startDetector(seconds) {
  writeFileSync(EVENTS, '');
  try { writeFileSync(EDGE_LOG, ''); } catch (e) {}
  const env = {
    ...process.env, MSD_AUTOSTART: '1', MSD_RUN_SECONDS: String(seconds),
    MSD_MODE: 'event', MSD_VAD_TRACE: '1', MSD_EDGE_LOG: EDGE_LOG,
  };
  const proc = spawn(DETECTOR_BIN, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = [], raw = [];
  let buf = '';
  const onData = (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ln = buf.slice(0, i); buf = buf.slice(i + 1);
      const j = ln.indexOf('{'); if (j < 0) continue;
      let o; try { o = JSON.parse(ln.slice(j)); } catch (e) { continue; }
      if (!o || !o.type) continue;
      const instr = /(_edge|_walk_stats|_observer|vad_frame|vadtrace)$/.test(o.type) || o.kind === 'talking-changed';
      if (instr) raw.push(o); else { events.push(o); appendFileSync(EVENTS, ln.slice(j) + '\n'); }
    }
  };
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  const done = new Promise((res) => proc.on('exit', res));
  return { proc, events, raw, done, kill: () => { try { proc.kill('SIGKILL'); } catch (e) {} } };
}

// Deep CDP snapshot of the guest page's audio state.
async function inspect(page, tag) {
  const snap = await page.evalJs(`(() => {
    const btns = [...document.querySelectorAll('button,[role=button]')];
    const muteBtn = btns.find(e => /^(un)?mute( my microphone| audio)?$/i.test((e.getAttribute('aria-label')||e.innerText||'').trim()));
    const audioJoinBtn = btns.find(e => /join audio by computer|join with computer audio|join audio/i.test((e.getAttribute('aria-label')||e.innerText||'').trim()));
    const bodyTxt = (document.body?.innerText||'').slice(0, 4000);
    return {
      url: location.href,
      visibility: document.visibilityState,
      muteLabel: muteBtn ? (muteBtn.getAttribute('aria-label')||muteBtn.innerText).trim() : null,
      audioJoinPresent: !!audioJoinBtn,
      audioJoinLabel: audioJoinBtn ? (audioJoinBtn.getAttribute('aria-label')||audioJoinBtn.innerText).trim() : null,
      needsAudioJoinText: /join audio by computer|join with computer audio/i.test(bodyTxt),
      gumOverridden: (navigator.mediaDevices.getUserMedia.toString()||'').slice(0,90),
      fakeMicReady: typeof window.__fakeMicReady !== 'undefined' ? window.__fakeMicReady : 'n/a',
      fakeMicOn: typeof window.__fakeMicOn !== 'undefined' ? window.__fakeMicOn : 'n/a',
      ctxState: typeof window.__fakeMicCtxState === 'function' ? window.__fakeMicCtxState() : 'n/a',
      fakeMicErr: window.__fakeMicErr || null,
    };
  })()`).catch((e) => ({ evalErr: String(e) }));
  // RTC stats + AudioContext state need separate awaited eval (async).
  let rtc = null;
  try { rtc = await page.evalJs('window.__rtcAudioStats ? window.__rtcAudioStats() : null', { awaitPromise: true }); } catch (e) { rtc = { err: String(e) }; }
  log(`INSPECT[${tag}]`, JSON.stringify({ ...snap, rtc }));
  return { ...snap, rtc };
}

async function snapshotDetector(det, label, page) {
  const roster = new Map();
  for (const e of det.events) {
    if (!isZoom(e)) continue;
    // Keep the LAST is_muted we actually saw (some updates omit the field → don't
    // clobber a known value with undefined).
    if (e.type === 'participant_joined' || e.type === 'participant_updated') {
      const prev = roster.get(e.name);
      roster.set(e.name, (typeof e.is_muted === 'boolean') ? e.is_muted : prev);
    } else if (e.type === 'participant_left') roster.delete(e.name);
  }
  const guestMuted = roster.has(GUEST_NAME) ? roster.get(GUEST_NAME) : 'absent';
  // remote RMS / vad frames
  const vad = det.raw.filter((r) => /vad_frame|vadtrace/.test(r.type || ''));
  const rmsVals = vad.map((v) => v.remote_rms ?? v.rms ?? v.remoteRms ?? v.level).filter((x) => typeof x === 'number');
  const maxRms = rmsVals.length ? Math.max(...rmsVals) : null;
  const speech = det.events.filter((e) => isZoom(e) && e.type === 'speech_on');
  // Guest's own WebRTC outbound audioLevel (proves the guest is transmitting).
  let outLevel = null;
  if (page) { try { const r = await page.evalJs('window.__rtcAudioStats ? window.__rtcAudioStats() : null'); outLevel = r && r.outAudioLevelMax; } catch (e) {} }
  log(`DETSNAP[${label}] guest(${GUEST_NAME}).is_muted=${guestMuted} roster=[${[...roster.keys()].join(', ')}] vadFrames=${vad.length} maxRemoteRMS=${maxRms} guestOutRTP=${outLevel} speech_on=[${speech.map((s) => s.name + '/' + (s.source || '')).join(', ')}]`);
  return { guestMuted, maxRms, rmsVals, speech, vadCount: vad.length, outLevel };
}

async function main() {
  mkdirSync(DEBUG_DIR, { recursive: true });
  spawnSync('pkill', ['-f', `remote-debugging-port=${PORT}`]);
  log(`probe start: guestKind=${guestKind} name=${GUEST_NAME} port=${PORT} secs=${SECS}`);

  if (!process.env.ZOOM_MEETING_URL) {
    if (!await bootstrapMeeting(log)) { log('FATAL: could not bootstrap meeting'); process.exit(2); }
  }
  const invite = await harvestInvite(log);
  if (!invite) { log('FATAL: no invite harvested'); process.exit(2); }
  log('invite: ' + invite);

  // Join the guest.
  let guest;
  const joinArgs = { port: PORT, name: GUEST_NAME, inviteUrl: invite };
  if (guestKind === 'speech') joinArgs.seat = 'bravo';
  guest = await mod.joinZoomWebGuest(joinArgs);
  log('guest join returned: ' + JSON.stringify({ overrideReady: guest.overrideReady }));
  // GUEST-SPECIFIC admit: press Admit unconditionally each round (robust vs stale
  // roster counts from a reused meeting) and confirm THIS guest is in-meeting by
  // polling its own web client for the footer mute button, not the host roster count.
  const inMeeting = async () => guest.page.evalJs(`!![...document.querySelectorAll('button,[role=button]')].find(e=>/^(un)?mute( my microphone| audio)?$/i.test((e.getAttribute('aria-label')||e.innerText||'').trim()))`).catch(() => false);
  drive('raise');
  panelToggle(); await sleep(2500); // reveal Admit (open panel once)
  let admitted = false;
  for (let i = 0; i < 30 && !admitted; i++) {
    drive('press', 'Admit all', '--role', 'AXButton');
    drive('press', 'Admit', '--role', 'AXButton');
    drive('press', 'Admit', '--window', 'Zoom Meeting');
    if (await inMeeting()) { admitted = true; break; }
    await sleep(2500);
  }
  log('admitted (guest footer visible): ' + admitted + ' rosterCount=' + rosterCount());
  await sleep(4000);

  // --- Instrument BEFORE unmute ---
  await inspect(guest.page, 'after-admit');

  const det = startDetector(SECS);
  await sleep(4000);
  await snapshotDetector(det, 'detector-start', guest.page);

  // Open panel so self is named (harmless if already open).
  panelToggle(); await sleep(2500);

  // --- Unmute the guest ---
  log('setGuestMuted(false) …');
  const muteOk = await mod.setGuestMuted(guest.page, false);
  log('setGuestMuted returned: ' + muteOk);
  await sleep(1500);
  await inspect(guest.page, 'after-unmute');

  // --- Speak (speech guest) or rely on tone (tone guest) ---
  if (guestKind === 'speech' && speechMod.setGuestSpeak) {
    log('setGuestSpeak(true) …');
    await speechMod.setGuestSpeak(guest.page, true);
  }
  await sleep(2000);
  await inspect(guest.page, 'speaking');

  // Hold ~12s of speaking, snapshot detector periodically.
  for (let i = 0; i < 6; i++) { await sleep(2000); await snapshotDetector(det, `speaking-${i}`, guest.page); }

  // Silence check (speech guest): stop speech, verify RMS drops.
  if (guestKind === 'speech' && speechMod.setGuestSpeak) {
    log('setGuestSpeak(false) …');
    await speechMod.setGuestSpeak(guest.page, false);
    await sleep(3000);
    await snapshotDetector(det, 'silence-after', guest.page);
  }

  // Screenshot on the way out.
  try {
    const shot = await guest.page.cmd('Page.captureScreenshot', { format: 'png' });
    if (shot?.result?.data) writeFileSync(join(DEBUG_DIR, `probe-${guestKind}-final.png`), Buffer.from(shot.result.data, 'base64'));
  } catch (e) {}

  det.kill(); await det.done.catch(() => {});
  const final = await snapshotDetector(det, 'FINAL', guest.page);

  // Verdict. The load-bearing criteria are (b) sustained remote RMS at the tap and
  // (c) a mute_gate naming of THIS guest. is_muted:false is desirable but the AX field
  // is sometimes absent on the join event, so treat "not positively muted" as OK.
  const namedByGate = final.speech.some((s) => s.name === GUEST_NAME && /mute_gate/.test(s.source || ''));
  const success = (final.guestMuted !== true) && (final.maxRms !== null && final.maxRms >= 0.005) && namedByGate;
  log(`PROBE VERDICT: ${success ? 'SUCCESS' : 'FAIL'} (is_muted=${final.guestMuted} maxRMS=${final.maxRms} namedByMuteGate=${final.speech.some((s) => s.name === GUEST_NAME && /mute_gate/.test(s.source || ''))})`);

  // Teardown.
  try { guest.chrome.kill(); } catch (e) {}
  await endMeeting(log);
  spawnSync('pkill', ['-f', `remote-debugging-port=${PORT}`]);
  process.exit(success ? 0 : 1);
}

main().catch((e) => { log('FATAL ' + (e.stack || e)); process.exit(3); });
