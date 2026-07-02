'use strict';
// ---------------------------------------------------------------------------
// Google Meet active-speaker detector — configurable, class-name-independent
// fallback chain. Companion to ~/.claude/google-meet-speaking-detection-analysis.md
// and docs/meet-active-speaker-no-hardcoded-css.md.
//
// This is the DOM-based path (content script / CDP / Electron webContents) — the
// only surface that can see Meet's stable `jsname`/`jscontroller` handles, which
// the accessibility tree (macOS AX / Windows UIA) strips. The native engines use
// the geometry+class subset of this same chain (see MeetActiveSpeaker.swift /
// window/engine/cs/meet.cs).
//
// Node model (normalized so the same chain documents DOM *and* AX/UIA):
//   { tag, role, classes:Set<string>, attrs:{jsname,jscontroller,...},
//     name, frame:{x,y,w,h}, isMe:bool,
//     bars:[{animating:bool}],          // equalizer bars, when readable
//     computed:{animating:bool, outlineWidth:number, boxShadow:string} }
// ---------------------------------------------------------------------------

// Default, fully-configurable strategy chain. Every token here is overridable at
// runtime (remote config) — the DESIGN is that a Google class rotation is a
// config edit, never a code change. Ordered most-durable → least-durable.
//
// NB (2026-07-02): CAPTIONS are deliberately NOT a strategy here — the product
// requires who-is-speaking to work WITHOUT captions enabled. Naming comes from
// the tile roster, never from the caption speaker-badge.
//
// Longitudinal note: between the 2026-06-25 capture and current open-source
// snapshots, the audio widget's `jscontroller` ROTATED (tae9tc → ES310d) and its
// bar child classes changed (UBNDXc/HPxjXe/DwvCqe → p21yBf/iitYmd), while
// `jsname="QgSmzd"`, the base class `IisKdb`, and the silence class `gjg47c` held
// constant. So we anchor on jsname/IisKdb (proven durable), NOT jscontroller.
//
// LIVE 2026-07-03 (real 2-person call, BlackHole speech): jscontroller rotated
// AGAIN (YQvg8b on the no-bars self-meter variant). The equalizer's STRUCTURE is
// the anchor that held: a visible small circle (28x28 in-tile / 24x24 roster row)
// with exactly 3 leaf bar divs (4x16), bars animating `stripeJiggleAnimation`
// while speaking; class swaps gjg47c -> HX2H7/wEsLMd/Oaajhc/OgVli by audio level.
// A MUTED participant's widget stays in the DOM as display:none/0x0 — so
// structural anchoring requires visibility (node.visible !== false here; rect +
// computed display in the browser detector). Structure is now the PRIMARY anchor
// (`structuralBars`); jsname remains a supplemental one.
const DEFAULT_CONFIG = {
  vadGate: true,               // audio VAD decides IF anyone speaks (durability backbone)
  someoneFloor: true,          // VAD speech but nobody attributable -> "Someone"
  strategies: [
    // 1) SEMANTIC audio level — the most rotation-proof DOM signal (Vexa's
    //    primary): a tile carrying `data-audio-level` with a non-zero value is
    //    actively producing audio. A data-* attribute with real semantics, not an
    //    obfuscated class, so it survives class churn best of all.
    {
      id: 'dataAudioLevel',
      anchor: { dataAttrAny: ['data-audio-level'] },
      speakingBy: { dataAudioLevel: true },
    },
    // 2) Audio-level indicator widget — the 3-bar equalizer. Anchor on the DURABLE
    //    handles (`jsname="QgSmzd"` + base class `IisKdb`), NOT the rotating
    //    jscontroller. Read the SPEAKING STATE most-robustly as the ABSENCE of the
    //    silence class `gjg47c` (triple-confirmed: `speaking = !hasClass(gjg47c)`),
    //    or structurally (bars animate); positive speaking-class tokens are a fast
    //    path but rotate.
    {
      id: 'audioIndicator',
      anchor: { structuralBars: 3, jsnameAny: ['QgSmzd'], classAny: ['IisKdb'], jscontrollerAny: ['YQvg8b', 'ES310d', 'tae9tc'] },
      speakingBy: {
        computedAnimation: true,                        // rotation-proof: bars actually animate
        barsAnimating: true,                            // rotation-proof: >=1 equalizer bar animating
        speakingIfNotIdle: true,                        // rotation-proof: widget present && NOT silent
        idleClassAny: ['gjg47c'],                       // the durable silence marker
        stateClassAny: ['HX2H7', 'Oaajhc', 'wEsLMd', 'OgVli'], // fast path (rotates)
      },
    },
    // 3) Tile active-speaker ring — anchor the tile by a stable container/data
    //    attribute, read the ring by its COMPUTED outline/box-shadow (rotation-proof)
    //    or the class token as a fast path.
    // (REMOVED) tileRing / cssClass `kssMZb` positives. LIVE-REFUTED 2026-07-03:
    // on a real 2-person call, `.kssMZb` is present on the SILENT, muted host tile
    // and ABSENT on the remote — it is a persistent structural class, not a per-tile
    // speaking signal, and using it false-named the muted participant. `gjg47c`
    // absence on the QgSmzd/IisKdb widget (audioIndicator, above) is the confirmed
    // signal. If Meet ever exposes a real per-tile ring token, add it here as a
    // remote-config'd, VAD-corroborated last resort — never a standalone positive.
    // 4) Geometry — the clearly promoted/spotlit tile (>= ratio x next). Class-free.
    { id: 'geometry', promotedRatio: 1.5, suppressWhenPresenting: true },
  ],
};

const has = (set, arr) => !!set && Array.isArray(arr) && arr.some((t) => set.has(t));

function nodeAnchoredBy(node, anchor) {
  if (!anchor) return false;
  const a = node.attrs || {};
  // STRUCTURE-FIRST (live-verified 2026-07-03): a VISIBLE node carrying >= N
  // equalizer bars is an indicator regardless of any token. Hidden widgets
  // (muted participants render display:none/0x0) are NOT structurally anchored.
  if (anchor.structuralBars && Array.isArray(node.bars)
    && node.bars.length >= anchor.structuralBars && node.visible !== false) return true;
  if (anchor.jscontrollerAny && anchor.jscontrollerAny.includes(a.jscontroller)) return true;
  if (anchor.jsnameAny && anchor.jsnameAny.includes(a.jsname)) return true;
  if (anchor.dataAttrAny && anchor.dataAttrAny.some((k) => a[k] !== undefined)) return true;
  if (anchor.classAny && has(node.classes, anchor.classAny)) return true;
  if (anchor.tileClassAny && has(node.classes, anchor.tileClassAny)) return true;
  return false;
}

// Does this node's speaking-state say "talking"? Semantic/structural signals win;
// class tokens are the fast path. `speakingIfNotIdle` = the widget is present and
// does NOT carry the silence class (the most rotation-proof class-based read).
function nodeSpeaking(node, rule) {
  if (!rule) return false;
  const c = node.computed || {};
  const a = node.attrs || {};
  if (rule.dataAudioLevel) {
    const v = a['data-audio-level'];
    if (v !== undefined && v !== '0' && v !== '') return true;
  }
  if (rule.computedAnimation && c.animating === true) return true;
  if (rule.computedOutline && ((c.outlineWidth || 0) > 0 || (c.boxShadow && c.boxShadow !== 'none'))) return true;
  if (rule.barsAnimating && Array.isArray(node.bars) && node.bars.some((b) => b.animating)) return true;
  // BARS DECIDE. When equalizer bars exist and none animate, the widget is
  // SILENT — never fall through to the class reads. (Adversarial-review find,
  // 2026-07-03: a structurally-anchored SILENT widget whose tokens ALL rotated
  // away has no recognizable gjg47c, so speakingIfNotIdle would false-name it.)
  if (Array.isArray(node.bars) && node.bars.length) return false;
  if (rule.stateClassAny && has(node.classes, rule.stateClassAny)) return true;
  if (rule.classAny && has(node.classes, rule.classAny)) return true;
  // Rotation-proof last resort (no-bars widget variant only): an anchored audio
  // widget that is NOT marked silent.
  if (rule.speakingIfNotIdle && rule.idleClassAny && !has(node.classes, rule.idleClassAny)) return true;
  return false;
}

// Climb (or map) an indicator node to the participant tile that owns it. In this
// normalized model each node carries `owner` (the tile name) if it's an indicator;
// tiles carry their own `name`. Real DOM: closest [data-participant-id]; AX/UIA:
// geometry containment (already done in the native engines).
function ownerName(node) {
  return node.owner || node.name || null;
}

function promotedTileName(tiles, ratio) {
  const withArea = tiles
    .map((t) => ({ name: t.name, area: (t.frame ? t.frame.w * t.frame.h : 0), isMe: t.isMe }))
    .filter((t) => t.name && t.area > 0)
    .sort((a, b) => b.area - a.area);
  if (withArea.length === 0) return null;
  if (withArea.length === 1) return withArea[0].isMe ? null : withArea[0].name;
  if (withArea[1].area > 0 && withArea[0].area >= withArea[1].area * ratio) {
    return withArea[0].isMe ? null : withArea[0].name;
  }
  return null;
}

/**
 * Resolve active speaker(s) from a normalized node list.
 * @param {Array} nodes
 * @param {{vadSpeechActive?:boolean, presentationActive?:boolean, tiles?:Array}} ctx
 * @param {object} config
 * @returns {{names:string[], via:string}}
 */
function detectActiveSpeaker(nodes, ctx = {}, config = DEFAULT_CONFIG) {
  const vad = ctx.vadSpeechActive !== false; // default true if unknown (soft gate)
  if (config.vadGate && ctx.vadSpeechActive === false) return { names: [], via: 'none' };

  const tiles = ctx.tiles || nodes.filter((n) => n.isTile);

  for (const strat of config.strategies) {
    if (strat.id === 'geometry') {
      if (strat.suppressWhenPresenting && ctx.presentationActive) continue;
      const name = promotedTileName(tiles, strat.promotedRatio || 1.5);
      if (name) return { names: [name], via: 'geometry' };
      continue;
    }
    // Indicator / ring / class strategies: scan nodes.
    const names = [];
    for (const n of nodes) {
      const anchored = strat.anchor ? nodeAnchoredBy(n, strat.anchor) : true;
      if (!anchored) continue;
      const rule = strat.speakingBy || { classAny: strat.classAny };
      if (!nodeSpeaking(n, rule)) continue;
      const who = ownerName(n);
      if (who && !who.startsWith('(you)') && !names.includes(who)) names.push(who);
    }
    if (names.length) return { names, via: strat.id };
  }

  if (config.someoneFloor && vad) return { names: ['Someone'], via: 'someoneFloor' };
  return { names: [], via: 'none' };
}

// --- Minimal, dependency-free HTML → nodes extractor for the captured snippets.
// Handles the flat, well-formed snippet fixtures (not a general HTML parser).
function parseSnippet(html) {
  const nodes = [];
  const tagRe = /<(\w[\w-]*)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1];
    const attrsRaw = m[2];
    const attrs = {};
    const aRe = /([\w:-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = aRe.exec(attrsRaw)) !== null) {
      if (a[1] === '/') continue;
      attrs[a[1]] = a[2] === undefined ? '' : a[2];
    }
    const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    nodes.push({ tag, attrs, classes, name: attrs['aria-label'] || null });
  }
  return nodes;
}

module.exports = {
  DEFAULT_CONFIG,
  detectActiveSpeaker,
  parseSnippet,
  promotedTileName,
  nodeSpeaking,
  nodeAnchoredBy,
};
