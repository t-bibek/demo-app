# Teams speaking-signal hooks — external evidence base (researched 2026-07-04)

Verified against actual source of production meeting bots (raw files fetched + grepped).
Companion to `docs/teams-active-speaker-detection.md` §8 and `.claude/CHROMIUM-AX-NOTIFICATIONS.md`.

> **Product decision (2026-07-04): speaker detection must NOT depend on captions** — same
> caption-free principle as the Meet detector. The caption section below is retained as
> evidence/context only, not a direction.

## The ring: `vdi-frame-occlusion` — STRONG (5 independent codebases)

New Teams (teams.microsoft.com v2 = the DOM inside the desktop client's WebView2): every
participant tile contains `div[data-tid="voice-level-stream-outline"]` (the blue speaking-ring
element). Speaking ⇒ class `vdi-frame-occlusion` is ADDED to it (or an ancestor); stop ⇒ removed.
Independently used as THE speaking signal by:
- **Vexa** `msteams/recording.ts` — "voice-level-stream-outline + vdi-frame-occlusion (NO FALLBACKS)";
  MutationObserver `attributeFilter: ['style','class','aria-hidden']`, 300ms debounce.
- **joinly** `teams.py` — compound selector `div[data-tid="voice-level-stream-outline"].vdi-frame-occlusion`
  inside `div[data-tid="stage-layout"] div[role="menuitem"]` (class sits ON the same div).
- **AWS LMA** ×2 — browser ext `teams.js`: class ADDED = active speaker, name from parent
  `aria-label.split(',')[0]`, excluded if label ends `" Muted"`; virtual participant `teams.ts`
  observes `[data-tid="modern-stage-wrapper"]`.
- **Meeting-BaaS** `speakersObserver.ts` — class OR blueish `::before` border at opacity 1;
  mute checked separately.
(elizaOS is a verbatim Vexa port — derived, not independent.)

Mute is always checked SEPARATELY from the ring ⇒ semantics = speaking, not unmuted.
**Caution (Vexa issue #191):** the DOM signal can drop out; Vexa proposes VAD + DOM-timeline
correlation — independent validation of our fusion design (ring = who, audio = when).
**Name origin (WEAK inference, no MS doc):** VDI overlay-occlusion bookkeeping (video composited
locally; UI tracks elements occluding the frame — the ring occludes only while visible). Empirical
anchor only; semantics could shift with a VDI-pipeline rework.

**Open first-hand gaps nobody has measured (repo or external):** unmuted-but-silent behavior
(the repo co-variance used tone + mute toggles, which cannot discriminate speaking from
unmuted-audio-flowing) and ring LINGER after speech stops (turn-boundary attribution error;
the TransitionConfidence problem Meet already solved). A ~30 min falsification probe with
speech-gain gating (`fake-mic-override.js` pattern) closes both.

## Consumer variant: teams.live.com uses a DIFFERENT hook

`div[data-tid="participant-speaker-ring"]` with Fluent-v9 hashed class flip
(`___s78zj80` inactive → `___19upu4n` active) or opacity 1 (LMA `teams-live.js`, BaaS).
Hashes rotate. Our detector has no teams.live.com coverage today (known gap; low priority).
`data-tid` never bridges to macOS AX — only classes do.

## Captions — evidence only; NOT a direction (see product decision above)

Selector consensus (Recall's OSS bot uses captions as its ONLY Teams attribution; Vexa; Zerg00s;
amurex; CueMeet): container `[data-tid="closed-caption-renderer-wrapper"]`, rows
`.fui-ChatMessageCompact`, speaker `span[data-tid="author"]`, text
`span[data-tid="closed-caption-text"]`. Host-vs-guest DOM variance (Vexa, 2026-03). AX caveat:
the author anchor is a `data-tid` (does not bridge to AX); only the row class bridges. Recall's
own blog calls the caption DOM "brittle by design". All consistent with the decision not to
depend on it: user-visible setting required, brittle, and view-dependent.

## Media-layer alternative (context, NOT portable to external AX)

**Attendee** hooks in-page `RTCPeerConnection.getContributingSources()` (CSRC → participant via
`window.callManager.activeCall.participants[].hasAudioSource()`), parses the WebRTC main data
channel — `{"type":"dsh","history":[...]}` = dominant-speaker events — and caption payloads with
`userId`. Requires running JS inside the call (bot); an external AX observer cannot use it.
Relevant only for future embedded/bot contexts.

## Null results + token fragility

- No "is speaking" ARIA label exists anywhere (no bot, doc, or forum reference) — matches our
  live negative.
- `aria_calling_roster_muted` has ZERO public hits — it matches the shape of a Teams
  **localization string ID leaking into the a11y tree when lookup fails**. Implication: the
  ID-form token may vanish on builds/locales where lookup succeeds; always ALSO match the
  localized suffix form (`", muted"` / label ends-with `" Muted"` — our rules already carry both),
  and expect locale tables for non-English tenants.
- Tile `data-tid` = participant display name in DOM (BaaS, LMA) — invisible to AX; AX name comes
  from the tile AXMenuItem description (our current anchor is correct).