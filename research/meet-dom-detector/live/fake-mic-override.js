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
    // Toggle handle: ramp to avoid clicks. true = speak, false = silent.
    window.__fakeMicSpeak = function(on){
      try { if (ctx.state === 'suspended') ctx.resume(); } catch(e){}
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(on ? 1.0 : 0.0, t + 0.05);
      window.__fakeMicOn = !!on;
      return !!on;
    };
    window.__fakeMicOn = true;
    ctx.decodeAudioData(b64ToBuf(B64)).then((audioBuf) => {
      let src;
      function start(){
        src = ctx.createBufferSource();
        src.buffer = audioBuf; src.loop = true;
        src.connect(gain); src.start();
      }
      start();
      window.__fakeMicReady = true;
      try { if (ctx.state === 'suspended') ctx.resume(); } catch(e){}
    }).catch((e) => { window.__fakeMicErr = String(e); });

    window.__fakeStream = dest.stream;
    const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = function(constraints){
      if (constraints && constraints.audio) {
        if (constraints.video) {
          // keep real (fake-device) video if requested, splice our audio track in
          return realGUM({ video: constraints.video }).then((v) => {
            dest.stream.getAudioTracks().forEach((t) => v.addTrack(t.clone ? t.clone() : t));
            return v;
          }).catch(() => dest.stream);
        }
        return Promise.resolve(dest.stream);
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
