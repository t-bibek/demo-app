# Chromium macOS AX notification behavior (source-verified 2026-07-03, chromium/chromium@main)

What NSAccessibility notifications Chrome actually posts — verified by reading
`ui/accessibility/platform/browser_accessibility_manager_mac.mm`, `ax_platform_node_cocoa.mm`,
`ax_platform_node_mac.mm`, Blink `ax_object_cache_impl.cc`, `ax_event_generator.cc`, `ax_object.cc`.
HIGH confidence throughout unless noted. Companion to `.claude/AX-OBSERVER-TARGETS.md`.

## The one-line upshot for Meet speaker detection

**Class-token changes (kssMZb ring, gjg47c equalizer flips) post NO notification of any kind.**
An AXObserver will never be told the ring moved. Observable signals are limited to:
node **removal** (`AXUIElementDestroyed`), `AXTitleChanged`, live-region events, value/selected-text/
row-count changes, menu open/close, and (window-focus-gated) `AXFocusedUIElementChanged`.
Everything else requires polling — and the AX tree itself only re-serializes in ~150 ms batches.

## Evidence

1. **Class attribute → silent.** Blink `HandleAttributeChanged` for `kClassAttr` → `MarkElementDirty` only
   ("Reserialize the class"), no event queued. `ax_event_generator.cc OnStringAttributeChanged`:
   `case kClassName: break;` — explicitly no generated event. The browser-side AXNode gets the new
   className (AXDOMClassList stays readable — `ax_platform_node_cocoa.mm:2124` splits kClassName on
   spaces) but nothing is posted.
2. **AXLayoutChanged: never posted.** Zero occurrences across all Chromium mac AX files; the old
   kLayoutComplete→AXLayoutComplete mapping is gone from main. Subscribing to it is useless.
3. **Node appearance: silent. Node removal: notifies.** CHILDREN_CHANGED / SUBTREE_CREATED /
   IGNORED_CHANGED are mac no-ops (internal cache invalidation only). But every web-node deletion
   posts `NSAccessibilityUIElementDestroyedNotification` on the dying element
   (`AXPlatformNodeMac::Destroy` → `detachAndNotifyDestroyed:YES`).
4. **Notifications that DO fire** (FireGeneratedEvent): CHECKED_STATE/RANGE_VALUE/SELECTED_VALUE/
   VALUE_IN_TEXT_FIELD → `AXValueChanged` (real value semantics only — not attributes);
   NAME_CHANGED → `AXTitleChanged`; LIVE_REGION_CHANGED → `AXLiveRegionChanged` (20 ms delayed);
   ALERT/LIVE_REGION_CREATED → `AXLiveRegionCreated`; SELECTED_CHILDREN/ROWS, ROW_COUNT, EXPANDED/
   COLLAPSED, DOCUMENT_SELECTION, MENU_*, BUSY, INVALID_STATUS. The explicit no-op list includes
   FOCUS_CHANGED (handled separately), IGNORED_CHANGED, LAYOUT_INVALIDATED, SUBTREE_CREATED,
   STATE_CHANGED, ROLE_CHANGED, PARENT_CHANGED, DESCRIPTION_CHANGED, etc.
5. **Focus events are window-focus-gated.** `FireFocusEventsIfNeeded` returns early when the view
   doesn't have focus; on window blur the last-focused node is cleared; on window focus the focus
   notification RE-FIRES. So `AXFocusedUIElementChanged` fires on window activation and in-page focus
   moves while focused — keyboard/window semantics, not speech (consistent with dump audit: tiles are
   never AXFocused).
6. **Serialization cadence.** Blink batches AX updates to ≥150 ms apart post-load (350 ms pre-load),
   riding the render lifecycle; immediate only for focus/checked/expanded/selection/action-sourced
   changes. Location-only updates: 500 ms (unfocused) / 75 ms (focused). Ceiling: even a perfect
   observer or a 100 Hz poll cannot see DOM churn faster than the ~150 ms serializer batches.

## Design consequences (Meet event-driven detector)

- **Primary edge source = fast bounded Meet-subtree reads** (~200–500 nodes, vs 6–7k full multi-window
  walk), diffed via `meetEdgesFromDiff`. Edges are already derived from snapshot diffs in the design,
  so this is a cadence/scope change, not an architecture change. 250–500 ms bounded reads +150 ms
  serializer batching keeps worst-case edge latency well under the 800 ms QA bar.
- **AXObserver role = opportunistic wake-ups + lifecycle**, not primary detection:
  `AXUIElementDestroyed` (tile/equalizer node churn → immediate re-read + re-subscribe),
  `AXTitleChanged` (names), `AXLiveRegionChanged/Created` (Meet announcements), `AXValueChanged`
  (genuine value semantics), `AXFocusedUIElementChanged` (window focus → re-fire re-read; also
  detects the user un/re-focusing Chrome). Any callback ⇒ trigger an immediate bounded re-read.
- **CPU win still lands**: `full_walks` (multi-window) drop to reconcile-only; frequent reads are
  bounded `subtree_reads`. cpu-compare thresholds (event ≤ 0.6× polling CPU, full-walks halved)
  remain achievable and unchanged.
- **Don't subscribe** expecting: AXLayoutChanged (never posted), AXValueChanged on class flips
  (silent), any notification for a node APPEARING (silent — only removal notifies).

## Enablement + visibility mechanics (peer-session research, source-verified)

- **AXManualAccessibility is Electron-only** — real Chrome ignores it entirely (zero hits in
  chrome_browser_application_mac.mm / browser_accessibility_state_impl.cc). The repo's
  `forceFullAXTree` setting it on Chrome is a harmless no-op; the effective part is
  `AXEnhancedUserInterface`.
- **AXEnhancedUserInterface** enables screen-reader-complete mode after a **2.0s debounce**
  (Sonoma spurious-toggle workaround); setting it to NO can disable again. Known side effect:
  breaks window managers / window positioning (why Electron invented AXManualAccessibility).
- Merely **reading `accessibilityRole` on the app AXUIElement** enables accessibility process-wide
  (kAXModeBasic normally; possibly only kNativeAPIs — no web content — under Sonoma "accessibility
  refinements"). Never reset for process lifetime.
- **Visibility semantics:** background TAB = `HIDDEN` → renderer lifecycle stops → AX tree stale,
  no notifications; under the ProgressiveAccessibility phase-2 Finch experiment AX can be fully
  DISABLED after ~5 min hidden. Minimized/fully-occluded WINDOW = `OCCLUDED` → mode not cleared but
  renderer stalls → stale tree anyway. Visible-but-not-frontmost = `VISIBLE` → serialization and
  notifications keep flowing, EXCEPT focus events + AXLoadComplete (focus-gated) and live-region
  notifications ("seems to require application be active" — source comment ~line 250). A tab doing
  capture/PiP is forced `kHiddenButPainting` (keeps rendering) — relevant since Meet captures.
- **Repo precedent:** `docs/research-ax.md:79` already recorded this exact lesson from live runs —
  "Chromium toggles AXDOMClassList with no AX notification, so the event observer was blind…
  needs a high-freq per-tile diff." The QA rigs must keep the Meet window unminimized and
  unoccluded during timed windows.
- **Live-verification gap:** AXUIElementDestroyed delivery on tile teardown is source-verified but
  never observed live in this repo; one 60s `swift run AXObserve chrome/meet` during a layout
  switch settles it.