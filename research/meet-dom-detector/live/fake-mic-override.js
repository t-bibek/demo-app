'use strict';
// Builds the in-page getUserMedia-override script that turns a real speech WAV into
// the browser's microphone WITHOUT any virtual audio device. Installed via CDP
// Page.addScriptToEvaluateOnNewDocument so it runs BEFORE Meet grabs the mic.
//
// The WAV bytes are base64-embedded into the script (the page can't read local
// files), decoded with decodeAudioData into an AudioBuffer, and looped through a
// BufferSource -> GainNode -> MediaStreamDestination. getUserMedia({audio}) then
// returns that synthetic stream. A window-level gain handle gates turns:
//   window.__fakeMicSpeak(true|false)   // 1 = emit speech, 0 = silence
// This is REAL decoded voice content (not a pure tone), so Meet's VAD treats it as
// speech. Verified in Chrome 149 where --use-file-for-fake-audio-capture is broken.
const fs = require('fs');

// label is only for debug logging inside the page.
function buildOverride(wavPath, label) {
  const b64 = fs.readFileSync(wavPath).toString('base64');
  return `(() => {
    const LABEL = ${JSON.stringify(label || 'fake-mic')};
    const B64 = ${JSON.stringify(b64)};
    function b64ToBuf(b64){ const bin = atob(b64); const len = bin.length; const u8 = new Uint8Array(len); for (let i=0;i<len;i++) u8[i]=bin.charCodeAt(i); return u8.buffer; }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain(); gain.gain.value = 1.0;   // start SPEAKING; gate via __fakeMicSpeak
    gain.connect(dest);
    window.__fakeMicReady = false;
    window.__fakeMicLabel = LABEL;

    // CRITICAL: this AudioContext is created at page-load in a PRE-NAV injected script —
    // no user gesture, and the tab is frequently BACKGROUNDED (the rig launches many
    // guests; only one is foreground). A backgrounded/gesture-less context starts (or
    // silently reverts to) 'suspended', which FREEZES the whole graph: gain→dest emits
    // ZERO samples, so getUserMedia's track carries silence and Zoom transmits nothing
    // (outbound RTP audioLevel = 0) even though the buffer source is "playing". Live
    // evidence 2026-07-04: intermittently outAudioLevel=0 with fakeMicReady:true. FIX:
    // resume unconditionally, keep resuming on a timer, and re-resume whenever the tab
    // is hidden or the context state changes. Chrome's --autoplay-policy=
    // no-user-gesture-required (which the rig always passes) makes the resume() take.
    function keepRunning(){ try { if (ctx.state !== 'running') ctx.resume(); } catch(e){} }
    keepRunning();
    try { ctx.onstatechange = keepRunning; } catch(e){}
    try { document.addEventListener('visibilitychange', keepRunning); } catch(e){}
    // A silent DC keep-alive node also discourages Chrome from idling the context.
    setInterval(keepRunning, 1000);
    window.__fakeMicResume = function(){ keepRunning(); return ctx.state; };
    window.__fakeMicCtxState = function(){ return ctx.state; };

    // Toggle handle: ramp to avoid clicks. true = speak, false = silent.
    window.__fakeMicSpeak = function(on){
      keepRunning();
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(on ? 1.0 : 0.0, t + 0.05);
      window.__fakeMicOn = !!on;
      return !!on;
    };
    window.__fakeMicOn = true;
    // Independent PURE-TONE path (Teams ring probe only; the Meet rig never calls this).
    // A tone carries audio ENERGY but no speech CONTENT, so it distinguishes a
    // ring/VAD that keys on transmitted energy from one that keys on voice. Lazily
    // created so no oscillator exists unless the probe asks for it. Gated by its OWN
    // gain node, fully independent of __fakeMicSpeak's speech gain.
    const toneGain = ctx.createGain(); toneGain.gain.value = 0.0; toneGain.connect(dest);
    let osc = null;
    window.__fakeMicTone = function(on, hz){
      keepRunning();
      if (on && !osc) { osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = hz || 440; osc.connect(toneGain); osc.start(); }
      const t = ctx.currentTime;
      toneGain.gain.cancelScheduledValues(t);
      toneGain.gain.setValueAtTime(toneGain.gain.value, t);
      toneGain.gain.linearRampToValueAtTime(on ? 0.6 : 0.0, t + 0.05);
      window.__fakeMicToneOn = !!on;
      return !!on;
    };
    window.__fakeMicToneOn = false;
    // SAMPLE-ACCURATE short-transient tone burst train (VAD-quality probe). Schedules
    // the whole train on the AudioContext clock so timing does NOT depend on CDP
    // round-trips — each burst is a brief ding-like transient (pulseMs, default 40ms)
    // that a debounced VAD (enterFrames >= 2 over 50ms frames) must reject, repeated
    // count times with gapMs silence between. Returns the scheduled train total
    // duration in ms so the caller can await it. Fully independent of speech gain.
    window.__fakeMicTonePulse = function(count, pulseMs, gapMs, hz){
      keepRunning();
      count = count || 12; pulseMs = pulseMs || 40; gapMs = gapMs || 300; hz = hz || 440;
      if (!osc) { osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = hz; osc.connect(toneGain); osc.start(); }
      else { osc.frequency.setValueAtTime(hz, ctx.currentTime); }
      const p = pulseMs / 1000, g = gapMs / 1000;
      let t = ctx.currentTime + 0.02;
      toneGain.gain.cancelScheduledValues(ctx.currentTime);
      toneGain.gain.setValueAtTime(0.0, ctx.currentTime);
      for (let i = 0; i < count; i++) {
        // Fast attack/decay so each burst is a genuine transient shorter than two
        // 50ms VAD frames (rise ~5ms, hold pulseMs, fall ~5ms).
        toneGain.gain.setValueAtTime(0.0, t);
        toneGain.gain.linearRampToValueAtTime(0.6, t + 0.005);
        toneGain.gain.setValueAtTime(0.6, t + 0.005 + p);
        toneGain.gain.linearRampToValueAtTime(0.0, t + 0.005 + p + 0.005);
        t += 0.005 + p + 0.005 + g;
      }
      window.__fakeMicToneOn = false;
      return Math.round((t - ctx.currentTime) * 1000);
    };
    ctx.decodeAudioData(b64ToBuf(B64)).then((audioBuf) => {
      let src;
      function start(){
        src = ctx.createBufferSource();
        src.buffer = audioBuf; src.loop = true;
        src.connect(gain); src.start();
      }
      start();
      window.__fakeMicReady = true;
      keepRunning();
    }).catch((e) => { window.__fakeMicErr = String(e); });

    window.__fakeStream = dest.stream;
    // CRITICAL: hand each getUserMedia call a FRESH CLONE of the source track in a NEW
    // MediaStream — never the shared dest.stream/track directly. Zoom (and Meet/Teams)
    // call getUserMedia multiple times during setup/renegotiation and STOP the streams
    // they no longer need; if we return the ONE shared MediaStreamAudioDestinationNode
    // track, that track.stop() ENDS it permanently (readyState:'ended') for everyone →
    // the outbound RTP goes silent forever (outAudioLevel=0). Root cause of the
    // intermittent "guest audio never flows" bug (diagnosed live 2026-07-04:
    // track.readyState was 'ended'). A clone is an independent track fed by the SAME
    // node graph, so stopping a clone leaves the source (and other clones) alive.
    function freshAudioStream(){
      const src = dest.stream.getAudioTracks()[0];
      const track = (src && src.clone) ? src.clone() : src;
      return new MediaStream(track ? [track] : []);
    }
    const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = function(constraints){
      if (constraints && constraints.audio) {
        if (constraints.video) {
          // keep real (fake-device) video if requested, splice a fresh audio clone in
          return realGUM({ video: constraints.video }).then((v) => {
            freshAudioStream().getAudioTracks().forEach((t) => v.addTrack(t));
            return v;
          }).catch(() => freshAudioStream());
        }
        return Promise.resolve(freshAudioStream());
      }
      return realGUM(constraints);
    };
    // Also patch legacy navigator.getUserMedia just in case.
    try {
      navigator.getUserMedia = function(c, ok, err){ navigator.mediaDevices.getUserMedia(c).then(ok, err); };
    } catch(e){}

    // Capture every RTCPeerConnection Meet creates (this override runs before Meet's
    // JS, so we see them all) — lets the harness read REAL WebRTC audio stats as the
    // ground-truth transmission oracle: window.__rtcAudioStats() ->
    //   { outMax, inMax } peak audioLevel across outbound/inbound audio RTP.
    try {
      var OrigPC = window.RTCPeerConnection;
      if (OrigPC && !window.__pcHooked) {
        window.__pcHooked = true; window.__pcs = [];
        var Wrapped = function(){ var pc = new OrigPC(...arguments); try { window.__pcs.push(pc); } catch(e){} return pc; };
        Wrapped.prototype = OrigPC.prototype;
        window.RTCPeerConnection = Wrapped;
        window.webkitRTCPeerConnection = Wrapped;
        window.__rtcAudioStats = async function(){
          var outMax = 0, inMax = 0, out = 0, inn = 0;
          for (var k = 0; k < window.__pcs.length; k++) {
            try {
              var report = await window.__pcs[k].getStats();
              report.forEach(function(s){
                if (s.type === 'outbound-rtp' && s.kind === 'audio') { out++; }
                if (s.type === 'media-source' && s.kind === 'audio' && typeof s.audioLevel === 'number') { if (s.audioLevel > outMax) outMax = s.audioLevel; }
                if (s.type === 'inbound-rtp' && s.kind === 'audio') { inn++; if (typeof s.audioLevel === 'number' && s.audioLevel > inMax) inMax = s.audioLevel; }
              });
            } catch(e){}
          }
          return { pcs: window.__pcs.length, outboundAudioRtp: out, inboundAudioRtp: inn, outAudioLevelMax: outMax, inAudioLevelMax: inMax };
        };
      }
    } catch(e){}
  })();`;
}

module.exports = { buildOverride };
