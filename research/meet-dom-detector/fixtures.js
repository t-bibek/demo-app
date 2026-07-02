'use strict';
// Scenario fixtures for the Meet active-speaker detector.
//
// [REAL]      derived verbatim from a captured Meet DOM snippet
//             (ax-dumps/20260625-135929/meet-snippet.html) — ground truth (2026-06-25).
// [REAL-EXT]  verbatim from an external live-Meet DOM snapshot published in
//             open-source repos (CrankyHippo/meet-ui-tool) — the CURRENT widget,
//             whose jscontroller rotated tae9tc->ES310d while jsname="QgSmzd",
//             base class IisKdb, and silence class gjg47c held constant.
// [SYNTHETIC] built from the documented tile/indicator structure to exercise
//             layouts we have no captured speaking-state snapshot for.
//
// NOTE: no caption-based fixture exists by design — speaker detection must work
// without captions (product requirement 2026-07-02).
//
// Node model: see detector.js.

// --- REAL: the 2026-06-25 captured indicator, two states.
const REAL_SILENT_INDICATOR_HTML =
  '<div jscontroller="tae9tc" jsname="QgSmzd" jsaction="rcuQ6b:wfi2bd;sA65sc:wfi2bd;bbo0ld:wfi2bd" class="IisKdb GF8M7d  gjg47c YFyDbd iPFm3e VeFZv"><div class="UBNDXc"></div><div class="HPxjXe"></div><div class="DwvCqe"></div></div>';
const REAL_SPEAKING_INDICATOR_HTML =
  '<div jscontroller="tae9tc" jsname="QgSmzd" jsaction="rcuQ6b:wfi2bd;sA65sc:wfi2bd;bbo0ld:wfi2bd" class="IisKdb GF8M7d  HX2H7 YFyDbd iPFm3e VeFZv"><div class="UBNDXc"></div><div class="HPxjXe"></div><div class="DwvCqe"></div></div>';

// --- REAL-EXT: the CURRENT widget (jscontroller rotated to ES310d, new bar
// classes p21yBf/iitYmd) — silent carries gjg47c; speaking drops it.
const EXT_SILENT_INDICATOR_HTML =
  '<div jscontroller="ES310d" class="IisKdb gjg47c u5mc1b BbJhmb YE1TS MNVeFb kT2pkb" jsname="QgSmzd" jsaction="r31gIf:wfi2bd;x1hWwd:wfi2bd"><div class="p21yBf iitYmd"></div><div class="p21yBf iitYmd"></div><div class="p21yBf iitYmd"></div></div>';
const EXT_SPEAKING_INDICATOR_HTML =
  '<div jscontroller="ES310d" class="IisKdb u5mc1b BbJhmb YE1TS MNVeFb kT2pkb" jsname="QgSmzd" jsaction="r31gIf:wfi2bd;x1hWwd:wfi2bd"><div class="p21yBf iitYmd"></div><div class="p21yBf iitYmd"></div><div class="p21yBf iitYmd"></div></div>';

// Helpers to build normalized nodes.
// speaking widget: base class IisKdb, NO gjg47c (+ optional rotating state class).
// silent widget: IisKdb + gjg47c.
const indicator = (owner, { speaking, computedAnimating, bars, stateClass } = {}) => ({
  tag: 'div',
  attrs: { jscontroller: 'ES310d', jsname: 'QgSmzd' },
  classes: new Set(speaking
    ? ['IisKdb', stateClass || 'HX2H7']
    : ['IisKdb', 'gjg47c']),
  owner,
  computed: { animating: computedAnimating === true },
  bars: bars || [{ animating: !!speaking }, { animating: !!speaking }, { animating: !!speaking }],
});
const tile = (name, { w = 320, h = 180, isMe = false, ringClass = null, audioLevel = null } = {}) => {
  const attrs = { 'data-participant-id': name.replace(/\s+/g, '_') };
  if (audioLevel !== null) attrs['data-audio-level'] = String(audioLevel);
  return {
    tag: 'div', isTile: true, name, isMe, owner: name,
    frame: { x: 0, y: 0, w, h },
    classes: new Set(['oZRSLe', ...(ringClass ? [ringClass] : [])]),
    attrs,
    computed: { outlineWidth: ringClass === 'kssMZb' ? 2 : 0 },
  };
};

const SCENARIOS = [
  // ---- REAL, captured ground truth (2026-06-25) --------------------------
  {
    id: 'real-single-speaking', kind: 'REAL',
    desc: 'Captured Meet DOM: indicator in the SPEAKING (HX2H7) state',
    build: (D) => {
      const nodes = D.parseSnippet(REAL_SPEAKING_INDICATOR_HTML);
      nodes[0].owner = 'Bibek Thapa'; nodes[0].computed = { animating: true };
      nodes[0].bars = [{ animating: true }, { animating: true }, { animating: true }];
      return { nodes, ctx: { vadSpeechActive: true, tiles: [tile('Bibek Thapa')] } };
    },
    expect: { names: ['Bibek Thapa'], via: 'audioIndicator' },
  },
  {
    id: 'real-single-silent', kind: 'REAL',
    desc: 'Captured Meet DOM: indicator SILENT (gjg47c), VAD idle',
    build: (D) => {
      const nodes = D.parseSnippet(REAL_SILENT_INDICATOR_HTML);
      nodes[0].owner = 'Bibek Thapa'; nodes[0].computed = { animating: false };
      return { nodes, ctx: { vadSpeechActive: false, tiles: [tile('Bibek Thapa')] } };
    },
    expect: { names: [], via: 'none' },
  },
  {
    id: 'real-state-class-rotation', kind: 'REAL',
    desc: 'Captured DOM but speaking class HX2H7 RENAMED by Google; absence-of-gjg47c '
      + 'and bar animation must still detect speaking',
    build: (D) => {
      const nodes = D.parseSnippet(REAL_SPEAKING_INDICATOR_HTML.replace('HX2H7', 'ZZnewZZ'));
      nodes[0].owner = 'Bibek Thapa'; nodes[0].computed = { animating: true };
      return { nodes, ctx: { vadSpeechActive: true, tiles: [tile('Bibek Thapa')] } };
    },
    expect: { names: ['Bibek Thapa'], via: 'audioIndicator' },
  },

  // ---- REAL-EXT: the CURRENT widget with a rotated jscontroller -----------
  {
    id: 'ext-current-speaking', kind: 'REAL-EXT',
    desc: 'Current live widget (jscontroller ROTATED tae9tc->ES310d); anchored by '
      + 'jsname=QgSmzd/IisKdb, speaking = absence of gjg47c',
    build: (D) => {
      const nodes = D.parseSnippet(EXT_SPEAKING_INDICATOR_HTML);
      nodes[0].owner = 'Carol'; nodes[0].computed = {}; // no computed hint; rely on !gjg47c
      return { nodes, ctx: { vadSpeechActive: true, tiles: [tile('Carol')] } };
    },
    expect: { names: ['Carol'], via: 'audioIndicator' },
  },
  {
    id: 'ext-current-silent', kind: 'REAL-EXT',
    desc: 'Current live widget SILENT (gjg47c present), VAD idle -> no speaker',
    build: (D) => {
      const nodes = D.parseSnippet(EXT_SILENT_INDICATOR_HTML);
      nodes[0].owner = 'Carol'; nodes[0].computed = {};
      return { nodes, ctx: { vadSpeechActive: false, tiles: [tile('Carol')] } };
    },
    expect: { names: [], via: 'none' },
  },

  // ---- SEMANTIC data-audio-level (Vexa's rotation-proof primary) ----------
  {
    id: 'data-audio-level-speaking', kind: 'SYNTHETIC',
    desc: 'Tile carries data-audio-level="3" -> speaking via the semantic attribute',
    build: () => {
      const tiles = [tile('Alice', { audioLevel: 3 }), tile('Bob', { audioLevel: 0 })];
      return { nodes: [...tiles], ctx: { vadSpeechActive: true, tiles } };
    },
    expect: { names: ['Alice'], via: 'dataAudioLevel' },
  },

  // ---- SYNTHETIC layout coverage -----------------------------------------
  {
    id: 'grid-one-speaking', kind: 'SYNTHETIC',
    desc: 'Grid view, 4 equal tiles, one speaking',
    build: () => {
      const tiles = [tile('Alice'), tile('Bob'), tile('Carol'), tile('You', { isMe: true })];
      const nodes = [...tiles, indicator('Alice', { speaking: false }),
        indicator('Bob', { speaking: true }), indicator('Carol', { speaking: false })];
      return { nodes, ctx: { vadSpeechActive: true, tiles } };
    },
    expect: { names: ['Bob'], via: 'audioIndicator' },
  },
  {
    id: 'grid-sequence', kind: 'SYNTHETIC',
    desc: 'Grid view, speaker changes Alice -> Carol across two ticks',
    build: () => {
      const tiles = [tile('Alice'), tile('Bob'), tile('Carol')];
      return { ticks: [
        { nodes: [...tiles, indicator('Alice', { speaking: true }), indicator('Carol', { speaking: false })],
          ctx: { vadSpeechActive: true, tiles }, expect: { names: ['Alice'], via: 'audioIndicator' } },
        { nodes: [...tiles, indicator('Alice', { speaking: false }), indicator('Carol', { speaking: true })],
          ctx: { vadSpeechActive: true, tiles }, expect: { names: ['Carol'], via: 'audioIndicator' } },
      ] };
    },
  },
  {
    id: 'grid-multiple-speaking', kind: 'SYNTHETIC',
    desc: 'Grid view, two speaking at once',
    build: () => {
      const tiles = [tile('Alice'), tile('Bob'), tile('Carol')];
      const nodes = [...tiles, indicator('Alice', { speaking: true }),
        indicator('Bob', { speaking: false }), indicator('Carol', { speaking: true })];
      return { nodes, ctx: { vadSpeechActive: true, tiles } };
    },
    expect: { namesSet: ['Alice', 'Carol'], via: 'audioIndicator' },
  },
  {
    id: 'spotlight-indicator-present', kind: 'SYNTHETIC',
    desc: 'Spotlight: small tile speaks while a big tile is pinned; indicator beats geometry',
    build: () => {
      const tiles = [tile('Alice', { w: 900, h: 500 }), tile('Bob', { w: 200, h: 120 })];
      const nodes = [...tiles, indicator('Bob', { speaking: true }), indicator('Alice', { speaking: false })];
      return { nodes, ctx: { vadSpeechActive: true, tiles } };
    },
    expect: { names: ['Bob'], via: 'audioIndicator' },
  },
  {
    id: 'spotlight-no-indicator-geometry', kind: 'SYNTHETIC',
    desc: 'Spotlight, indicator absent/pruned -> geometry picks promoted tile',
    build: () => {
      const tiles = [tile('Alice', { w: 900, h: 500 }), tile('Bob', { w: 200, h: 120 })];
      return { nodes: [...tiles], ctx: { vadSpeechActive: true, tiles } };
    },
    expect: { names: ['Alice'], via: 'geometry' },
  },
  {
    id: 'pip-mode', kind: 'SYNTHETIC',
    desc: 'PiP: only the active-speaker tile + indicator remain',
    build: () => {
      const tiles = [tile('Alice', { w: 320, h: 180 })];
      const nodes = [...tiles, indicator('Alice', { speaking: true })];
      return { nodes, ctx: { vadSpeechActive: true, tiles } };
    },
    expect: { names: ['Alice'], via: 'audioIndicator' },
  },
  {
    id: 'muted-participant-no-fp', kind: 'SYNTHETIC',
    desc: 'Muted participant, VAD idle -> NO speaker (no false positive)',
    build: () => {
      const tiles = [tile('Alice'), tile('Bob')];
      const nodes = [...tiles, indicator('Alice', { speaking: false }), indicator('Bob', { speaking: false })];
      return { nodes, ctx: { vadSpeechActive: false, tiles } };
    },
    expect: { names: [], via: 'none' },
  },
  {
    id: 'nobody-speaking-vad-open', kind: 'SYNTHETIC',
    desc: 'VAD speech but nobody attributable -> Someone floor',
    build: () => {
      const tiles = [tile('Alice'), tile('Bob')];
      const nodes = [...tiles, indicator('Alice', { speaking: false }), indicator('Bob', { speaking: false })];
      return { nodes, ctx: { vadSpeechActive: true, tiles } };
    },
    expect: { names: ['Someone'], via: 'someoneFloor' },
  },
  {
    id: 'screenshare-suppress-geometry', kind: 'SYNTHETIC',
    desc: 'Screen share fills stage; no indicator -> geometry SUPPRESSED (no FP)',
    build: () => {
      const tiles = [tile('SharedScreen', { w: 1000, h: 560 }), tile('Alice', { w: 200, h: 120 })];
      return { nodes: [...tiles], ctx: { vadSpeechActive: true, presentationActive: true, tiles } };
    },
    expect: { names: ['Someone'], via: 'someoneFloor' },
  },
  {
    id: 'screenshare-with-indicator', kind: 'SYNTHETIC',
    desc: 'Screen share active but a participant indicator speaks -> named correctly',
    build: () => {
      const tiles = [tile('SharedScreen', { w: 1000, h: 560 }), tile('Alice', { w: 200, h: 120 })];
      const nodes = [...tiles, indicator('Alice', { speaking: true })];
      return { nodes, ctx: { vadSpeechActive: true, presentationActive: true, tiles } };
    },
    expect: { names: ['Alice'], via: 'audioIndicator' },
  },
  {
    id: 'join-leave-stable', kind: 'SYNTHETIC',
    desc: 'Participant joins then leaves; detector keys on live nodes only',
    build: () => {
      const t3 = [tile('Alice'), tile('Bob'), tile('Dan')];
      const t2 = [tile('Alice'), tile('Bob')];
      return { ticks: [
        { nodes: [...t3, indicator('Dan', { speaking: true })], ctx: { vadSpeechActive: true, tiles: t3 },
          expect: { names: ['Dan'], via: 'audioIndicator' } },
        { nodes: [...t2, indicator('Alice', { speaking: true })], ctx: { vadSpeechActive: true, tiles: t2 },
          expect: { names: ['Alice'], via: 'audioIndicator' } },
      ] };
    },
  },
  {
    id: 'kssmzb-not-a-signal', kind: 'SYNTHETIC',
    desc: 'LIVE-REFUTED (2026-07-03): kssMZb present on a SILENT tile is NOT speaking; '
      + 'must NOT be named — falls through to the Someone floor',
    build: () => {
      const tiles = [tile('Alice', { ringClass: 'kssMZb' }), tile('Bob')];
      const ring = { tag: 'div', classes: new Set(['kssMZb']), owner: 'Alice', computed: {}, attrs: {} };
      return { nodes: [...tiles, ring], ctx: { vadSpeechActive: true, tiles } };
    },
    expect: { names: ['Someone'], via: 'someoneFloor' },
  },

  // ---- STRUCTURE-FIRST anchoring (live-verified 2026-07-03) ----------------
  {
    id: 'structural-anchor-no-tokens', kind: 'REAL',
    desc: 'LIVE 2026-07-03: every Google token rotated away (no jsname/jscontroller/'
      + 'IisKdb) — a visible node with 3 animating equalizer bars is STILL anchored '
      + 'purely by structure and named',
    build: () => {
      const tiles = [tile('Alice'), tile('Bob')];
      const bare = { tag: 'div', attrs: {}, classes: new Set(['ZZrotatedAwayZZ']), owner: 'Alice',
        computed: {}, bars: [{ animating: true }, { animating: true }, { animating: true }] };
      return { nodes: [...tiles, bare], ctx: { vadSpeechActive: true, tiles } };
    },
    expect: { names: ['Alice'], via: 'audioIndicator' },
  },
  {
    id: 'structural-anchor-no-tokens-silent', kind: 'REAL',
    desc: 'Adversarial-review find (2026-07-03): a SILENT token-free widget (bars '
      + 'present, none animating, and no recognizable silence class) must NOT be '
      + 'named — the bars decide; no fall-through to speakingIfNotIdle',
    build: () => {
      const tiles = [tile('Alice'), tile('Bob')];
      const bare = { tag: 'div', attrs: {}, classes: new Set(['ZZrotatedAwayZZ']), owner: 'Alice',
        computed: {}, bars: [{ animating: false }, { animating: false }, { animating: false }] };
      return { nodes: [...tiles, bare], ctx: { vadSpeechActive: true, tiles } };
    },
    expect: { names: ['Someone'], via: 'someoneFloor' },
  },
  {
    id: 'structural-hidden-not-anchored', kind: 'REAL',
    desc: 'LIVE 2026-07-03: a MUTED participant\'s widget stays in the DOM as '
      + 'display:none/0x0 — bars present but NOT visible must NOT anchor (no name)',
    build: () => {
      const tiles = [tile('Alice'), tile('Bob')];
      const hidden = { tag: 'div', attrs: {}, classes: new Set(['ZZrotatedAwayZZ']), owner: 'Alice',
        visible: false,
        computed: {}, bars: [{ animating: true }, { animating: true }, { animating: true }] };
      return { nodes: [...tiles, hidden], ctx: { vadSpeechActive: true, tiles } };
    },
    expect: { names: ['Someone'], via: 'someoneFloor' },
  },
];

module.exports = { SCENARIOS, REAL_SILENT_INDICATOR_HTML, REAL_SPEAKING_INDICATOR_HTML,
  EXT_SILENT_INDICATOR_HTML, EXT_SPEAKING_INDICATOR_HTML };
