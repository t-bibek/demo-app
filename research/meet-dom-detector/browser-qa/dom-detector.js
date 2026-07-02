'use strict';
// Browser-side Meet active-speaker detector — the REAL DOM implementation of the
// fallback chain (querySelector / getComputedStyle / closest). Injected into a page
// (the Meet-DOM simulator, or a live Meet tab) and called as window.__meetDetect().
//
// Caption-free by design. Mirrors research/meet-dom-detector/detector.js but runs
// against a live DOM so getComputedStyle(animationName)/getBoundingClientRect are
// REAL, not simulated. Reads speaking-context from window.__ctx
// ({ vad, presentationActive, structOnly, holdMs }) so the harness can gate it; on
// a live page pass these from your VAD + presentation detector instead.
//   structOnly: true  -> ignore the jsname anchor entirely (token-free mode)
//   holdMs: N         -> bridge animation render gaps: a name stays "speaking" for
//                        N ms after its bars last animated (live speech shows
//                        ~80-95% raw per-poll detection with ~0.5s gaps; a 500ms
//                        hold closes them). Default 0 = off (keeps QA exact).
(function () {
  function nameOf(tile) {
    if (!tile) return null;
    var s = tile.querySelector('span.notranslate, .zWGUib, .XWGOtd, [data-self-name]');
    var t = s && (s.textContent || s.getAttribute('data-self-name'));
    return t ? t.trim() : null;
  }
  function tileOf(el) {
    return el.closest('[data-participant-id],[data-requested-participant-id],[data-ssrc],.oZRSLe');
  }
  function push(arr, n) { if (n && arr.indexOf(n) === -1) arr.push(n); }

  // DO NOT DEPEND ON THE PEOPLE PANEL. It is usually CLOSED, and its roster rows
  // ALSO carry `data-participant-id` and their OWN 24x24 equalizer — so scoping
  // to it would make detection require an optional overlay and double-count.
  // Everything keys on the VIDEO STAGE tiles only; the panel being open or closed
  // must not change the result. (The panel/dialog/complementary/aside containers
  // hold roster rows, side panels, and the participants list.)
  var PANEL_SEL = '[role=list],[role=listitem],[role=dialog],[role=complementary],aside,[data-panel-container]';
  function inPanel(el) { return !!(el && el.closest && el.closest(PANEL_SEL)); }
  var TILE_SEL = '[data-participant-id],[data-requested-participant-id],[data-ssrc],.oZRSLe';
  function stageTiles(root) {
    return [].slice.call(root.querySelectorAll(TILE_SEL)).filter(function (t) { return !inPanel(t); });
  }

  // Silence-class list is a LAST-RESORT (for the no-bars widget variant) only; the
  // computed-animation read is the primary, class-independent signal.
  var SILENCE_CLASSES = ['gjg47c'];

  // --- STRUCTURE-FIRST discovery (token-free), LIVE-VERIFIED 2026-07-03 on a real
  // multi-party call with real (BlackHole) speech. We key on the in-tile STAGE
  // equalizer (28x28) — NOT the People-panel row variant (24x24), which only
  // exists while that optional overlay is open. Both share the same structural
  // signature, so panel rows are simply excluded by scope (stageTiles), not by a
  // different shape test. The signature:
  //   a VISIBLE, roughly-square small div (0 < w,h <= 80, aspect 0.5..2) whose
  //   children are ALL divs, 3..8 of them, each a leaf "bar" that is TALLER than
  //   wide (live bars are 4x16; stripeJiggleAnimation animates only
  //   background-size/position, so bar boxes are stable while animating).
  // Non-div children disqualify (the live widget has exactly 3 div children);
  // square dots (loading/typing "..."), wide segmented strips, and icon fonts
  // all fail one of these checks. Visibility (display/visibility/opacity) is
  // load-bearing: a MUTED participant's widget stays in the DOM as
  // display:none/0x0 (bars 0x0), and a hidden 0x0 junk div with >=3 leaf children
  // exists on the live page — neither may count as an observable indicator.
  function isBarDiv(k) {
    if (k.children.length !== 0) return false;
    var r = k.getBoundingClientRect();
    return r.width > 0 && r.width <= 12 && r.height >= r.width;
  }
  function isEqualizerShape(d) {
    var r = d.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0 && r.width <= 80 && r.height <= 80)) return false;
    var ar = r.width / r.height;
    if (ar < 0.5 || ar > 2) return false;
    if (!isDisplayed(d)) return false;
    var kids = [].slice.call(d.children);
    if (kids.length < 3 || kids.length > 8) return false;
    if (kids.some(function (c) { return c.tagName !== 'DIV'; })) return false;
    return kids.every(isBarDiv);
  }
  function isDisplayed(el) {
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0;
  }
  // Find speaking-indicator widgets STRUCTURE-FIRST (no tokens; scanned INSIDE the
  // STAGE tiles only — never the People panel — the only place a named speaker can
  // come from, and much cheaper than a page-wide div scan), then union the stable
  // framework handle [jsname="QgSmzd"] as a supplement (also excluded from the
  // panel) — it captures the no-bars/collapsed variants (self meter `DYfzY`) that
  // structure alone can't see. Hidden jsname widgets are EXCLUDED from naming (a
  // widget hidden mid-speech can retain a stale speaking class/animation — computed
  // styles still resolve inside display:none subtrees) but still count as
  // "observable indicator machinery" for the geometry gate. structOnly skips the
  // jsname union entirely.
  function findIndicators(root, structOnly) {
    var tiles = stageTiles(root);
    var scope = tiles.length ? tiles : [root];
    var shaped = [];
    scope.forEach(function (t) {
      [].slice.call(t.querySelectorAll('div')).forEach(function (d) {
        if (shaped.indexOf(d) === -1 && isEqualizerShape(d)) shaped.push(d);
      });
    });
    var jsnameAll = structOnly ? []
      : [].slice.call(root.querySelectorAll('[jsname="QgSmzd"]')).filter(function (w) { return !inPanel(w); });
    var named = shaped.slice();
    jsnameAll.forEach(function (w) { if (named.indexOf(w) === -1 && isDisplayed(w)) named.push(w); });
    return { named: named, observable: shaped.length + jsnameAll.length };
  }
  // SPEAKING = a bar's computed animationName runs (live: stripeJiggleAnimation —
  // but the NAME is not matched; any running animation counts), OR the widget
  // itself animates, OR a Web-Animations-API animation runs anywhere in the
  // widget's subtree (element.animate() NEVER reflects into computed
  // animationName — proven in Chrome 149 — so a WAAPI migration would otherwise
  // be a silent total failure). When bars exist and none animate, the widget is
  // SILENT — the bars decide; the silence-class read is ONLY for the no-bars
  // variant (live: the DYfzY self meter swaps gjg47c -> HX2H7/wEsLMd/Oaajhc/OgVli
  // with audio level and never animates).
  function indicatorSpeaking(w) {
    var bars = [].slice.call(w.children).filter(function (c) { return c.tagName === 'DIV'; });
    if (bars.some(function (b) { var a = getComputedStyle(b).animationName; return !!a && a !== 'none'; })) return true;
    var wa = getComputedStyle(w).animationName;
    if (wa && wa !== 'none') return true;
    if (w.getAnimations) {
      try {
        if (w.getAnimations({ subtree: true }).some(function (a) {
          return a.playState === 'running' && !(a.constructor && a.constructor.name === 'CSSTransition');
        })) return true;
      } catch (e) {}
    }
    if (bars.length) return false;   // bars present, none animating => SILENT
    return !(w.getAttribute('class') || '').split(/\s+/).some(function (c) { return SILENCE_CLASSES.indexOf(c) >= 0; });
  }

  // --- SELF-TILE detection, live-verified 2026-07-03 on two independent guest
  // views (each sees a different tile as self). Discriminators, strongest first:
  //   1. the self <video> is MIRRORED (computed transform matrix(-1,...)) —
  //      token-free and locale-free; remotes are never mirrored;
  //   2. the self tile carries NO 3-bar equalizer widget AT ALL (not even a
  //      hidden one) — only the empty no-bars meter; every remote tile keeps a
  //      bar widget in the DOM (visible or display:none);
  //   3. semantic [data-self]/[data-self-name] when the build provides it.
  // (Self-only hover controls — "Reframe"/"Backgrounds and effects" — also
  // discriminate but are locale-bound; deliberately not used.)
  function isSelfTile(t) {
    if (t.hasAttribute('data-self') || t.querySelector('[data-self-name]')) return true;
    var v = t.querySelector('video');
    if (v && /matrix\(-1[,\s]/.test(getComputedStyle(v).transform)) return true;
    var widgets = [].slice.call(t.querySelectorAll('[jsname="QgSmzd"]'));
    if (widgets.length) {
      var hasBarWidget = widgets.some(function (w) {
        return [].slice.call(w.children).some(function (c) { return c.tagName === 'DIV'; });
      });
      if (!hasBarWidget) return true;
    }
    return false;
  }

  // Participant enumeration from the VIDEO STAGE only, keyed on the STABLE
  // per-device id (data-participant-id = "spaces/<space>/devices/<N>") — display
  // names can collide; pids don't. The People panel is deliberately NOT read: it
  // is usually closed, so depending on it would make the roster flicker with an
  // optional overlay. Everyone in the call has a stage tile (grid, or the
  // filmstrip in spotlight), so the stage is a complete-enough roster on its own.
  window.__meetParticipants = function () {
    var root = document.querySelector('#stage') || document.body;
    var seen = {};
    stageTiles(root).forEach(function (t) {
      var pid = t.getAttribute('data-participant-id')
        || t.getAttribute('data-requested-participant-id') || t.getAttribute('data-ssrc');
      if (!pid) return;
      var r = t.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;   // off-screen filmstrip overflow
      var cur = seen[pid] || (seen[pid] = { pid: pid, name: null, isSelf: false, rect: null });
      cur.name = cur.name || nameOf(t);
      cur.rect = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      cur.isSelf = cur.isSelf || isSelfTile(t);
    });
    return Object.keys(seen).map(function (k) { return seen[k]; });
  };

  window.__meetDetect = function () {
    var ctx = window.__ctx || {};
    var vad = ctx.vad !== false;                 // soft gate
    var presenting = !!ctx.presentationActive;
    var root = document.querySelector('#stage') || document.body;
    // STAGE tiles only — never the People panel (see stageTiles / inPanel).
    var tiles = stageTiles(root);

    if (!vad) return { names: [], via: 'none' };

    // 1) SEMANTIC data-audio-level (most durable — but ABSENT from the current
    //    live build, so in practice stage 2 is the workhorse).
    var names = [];
    tiles.forEach(function (t) {
      var v = t.getAttribute('data-audio-level');
      if (v !== null && v !== '0' && v !== '') push(names, nameOf(t));
    });
    if (names.length) return { names: names, via: 'dataAudioLevel' };

    // 2) Audio-level indicator — STRUCTURE-FIRST, class-independent. Live-verified
    //    2026-07-03 (real remote speech): the equalizer is found purely by shape
    //    (isEqualizerShape) with ZERO page-wide false positives, and SPEAKING is
    //    read from the bars' COMPUTED animation (WAAPI-unioned). jsname="QgSmzd"
    //    is only a supplemental anchor now (skipped under ctx.structOnly).
    //    Bar-carrying widgets are authoritative: the class-based no-bars read is
    //    evaluated ONLY when the page has no bar widgets at all (a bars-less
    //    build), so a silence-class rotation cannot false-name every silent tile.
    names = [];
    var inds = findIndicators(root, !!ctx.structOnly);
    var shaped = inds.named.filter(function (w) {
      return [].slice.call(w.children).some(function (c) { return c.tagName === 'DIV'; });
    });
    var evalSet = shaped.length ? shaped : inds.named;
    evalSet.forEach(function (w) {
      if (indicatorSpeaking(w)) push(names, nameOf(tileOf(w)));
    });

    //    Optional speech-hold: bridge the sub-second animation render gaps that
    //    cap raw per-poll detection at ~80-95% during continuous speech.
    var holdMs = +ctx.holdMs || 0;
    if (holdMs > 0) {
      var st = window.__meetHoldState || (window.__meetHoldState = {});
      var now = Date.now();
      names.forEach(function (n) { st[n] = now; });
      Object.keys(st).forEach(function (n) {
        if (now - st[n] > holdMs) delete st[n];
        else push(names, n);
      });
    } else if (window.__meetHoldState) {
      window.__meetHoldState = null;   // hold turned off: drop stale state
    }
    if (names.length) return { names: names, via: 'audioIndicator' };

    // 3) (REMOVED) Tile ring `.kssMZb`. LIVE-REFUTED 2026-07-03: on a real 2-person
    //    call, `.kssMZb` is present on the SILENT, muted host tile (and absent on the
    //    remote), so it is NOT a speaking signal — using it false-named the muted
    //    participant. It's a persistent structural class, not per-speech. Dropped as
    //    a positive signal; the `gjg47c`-toggling widget above is the confirmed one.
    //    (A generic computed outline/box-shadow ring read was ALSO rejected earlier —
    //    it matched every tile's default styling in a real browser.)

    // 4) Geometry: LAST-RESORT heuristic, and ONLY when no indicator machinery is
    //    observable at all (all pruned) — hidden/muted widgets still count as
    //    "machinery exists", so an all-muted call does NOT geometry-guess. If
    //    indicators ARE present but none active, nobody is speaking — don't guess
    //    via the biggest tile (that would false-fire on a pinned, silent main tile
    //    in sidebar/spotlight). Also skips self + the screen-share surface, and is
    //    suppressed entirely under a presentation.
    if (!presenting && inds.observable === 0) {
      var areas = tiles.map(function (t) {
        var r = t.getBoundingClientRect();
        return { n: nameOf(t), a: r.width * r.height,
                 self: t.hasAttribute('data-self'), share: t.hasAttribute('data-screenshare') };
      }).filter(function (x) { return x.n && x.a > 0 && !x.share; })
        .sort(function (a, b) { return b.a - a.a; });
      if (areas.length === 1 && !areas[0].self) return { names: [areas[0].n], via: 'geometry' };
      if (areas.length >= 2 && areas[1].a > 0 && areas[0].a >= areas[1].a * 1.5 && !areas[0].self)
        return { names: [areas[0].n], via: 'geometry' };
    }

    // 5) VAD floor.
    return { names: ['Someone'], via: 'someoneFloor' };
  };
})();
