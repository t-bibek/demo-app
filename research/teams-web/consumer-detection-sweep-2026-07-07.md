# Consumer Teams (`teams.live.com/v2/`) in-call AX tree measurement — detection-extension gate

**Date:** 2026-07-07 · **Repo:** demo-app @ `c920437`
**Environment:** screen UNLOCKED (`IOConsoleLocked=No`), `caffeinate` running, AX TRUSTED.
**Gate question:** does the consumer `teams.live.com/v2/` in-call web-area tree satisfy the shipping
detector's expectations (`isTeamsMeetingURL`, `teamsWebCallActive`, `findTeamsWebAreas`,
`findTeamsCallLandmarks`, `teamsExtractWindow` P1-WEB), so consumer detection can be a bounded
EXTENSION of `bubbles-meet-detector` rather than a rewrite? **Verdict: GO with two required
adapter changes (URL scope is already fine; the CALL GATE fires via the Shared-content landmark;
the TILE/roster extraction needs the consumer-specific AX shapes wired in).**

## Rig & method

- **Host** = native Teams (`com.microsoft.teams2`, "Bibek Thapa") hosting an instant consumer meeting,
  bootstrapped + invite-harvested + lobby-admitted operator-free via `qa/teams-live/teams-host-lib.mjs`.
  Harvested link shape: `https://teams.live.com/meet/<REDACTED-MEETING-ID>?p=<REDACTED-PASSCODE>`.
- **Measured guest** = the PERSISTENT signed-in rig Chrome profile
  (`research/meet-dom-detector/live/.rig-profiles/host`, CDP 9351, real mic), joined anonymously via
  "Continue on this browser". Driven by `research/teams-web/consumer-sweep-driver.mjs`. Clean-quit only.
- **Captures**: DEEP plain-`chrome` `AXSnapshot` dumps (`--max-nodes 200000 --depth 200`, full a11y force)
  of the guest tab, curated to `research/teams-web/consumer-captures-2026-07-07/` (personal-Chrome web
  areas REDACTED/removed; meeting id + passcode REDACTED from all committed dumps).
- **Note on the compact wedge**: the consumer guest lands in a fixed **"Meeting compact view"** window
  whose calling controls hide `#roster-button`. Clicking the in-window **"Maximize meeting window"**
  affordance drops the "compact view" and exposes the full calling-controls toolbar + roster — every
  in-call measurement below is the MAXIMIZED layout.

### Cell matrix (all five cells)

| Cell | Capture | Nodes | AXWebArea AXURL | AXWebArea title | In-call landmarks |
|------|---------|-------|-----------------|-----------------|-------------------|
| **C1** in-call foreground | `C1-incall-fg-webarea.*` | 155 | `teams.live.com/v2/` | `Meeting with Bibek Thapa \| Microsoft Teams` | **ALL present** (hangup/roster/mic/cam/share + Shared-content landmark) |
| **C2** in-call, roster panel open | `C2-incall-roster-open-webarea.*` | 193 | `teams.live.com/v2/` | `People \| Meeting with Bibek Thapa \| Microsoft Teams` | + `AXOutline "Attendees"` + structured roster rows |
| **C2′** in-call, Share-invite tray open | `C2-incall-roster-shareinvite-webarea.*` | 12 (modal-scoped) | `teams.live.com/v2/` | (modal) | `AXHeading "Invite people to join you"` + `AXButton "Copy meeting link"` |
| **C3** green room (pre-join) | `C3-greenroom-webarea.*` | 127 | `teams.live.com/v2/` | `Meeting join \| Microsoft Teams meeting \| Microsoft Teams` | `AXButton #prejoin-join-button "Join now"`; **NO hangup/roster/landmark** |
| **C4** post-leave landing | `C4-postleave-webarea.*` | 104 | `teams.live.com/v2/` | `People \| Meeting with Bibek Thapa \| Microsoft Teams` | **NONE** — "Stay connected after your meeting" |
| **C5** chat tab | `C5-chat-webarea.*` | 279 | `teams.live.com/v2/` | `Chat \| Test \| Microsoft Teams` | **NONE** |

---

## Q1 — IN-CALL LANDMARKS · verdict: **the shipping gate FIRES as-is (via the Shared-content landmark)**

The consumer in-call tree (C1) carries a rich, stable call-control landmark set. Verbatim from
`C1-incall-fg-webarea.txt` (Fluent CSS classes elided; **`#id` and `description` are stable AX identity**):

```
AXWebArea title="Meeting with Bibek Thapa | Microsoft Teams"   # AXURL = https://teams.live.com/v2/
  AXToolbar #horizontalMiddleEnd description="Meeting controls"
    AXButton #chat-button        description="Chat"
    AXButton #roster-button      description="People"
    AXButton #video-button       description="Turn camera on"
    AXButton #microphone-button  description="Mute mic"
    AXButton #share-button       description="Share content"
  AXGroup [AXApplicationGroup] #horizontalEnd description="Calling controls"
    AXButton #hangup-button      description="Leave"
  AXGroup [AXLandmarkMain] description="Shared content view"     # the canonical meeting-view landmark
```

Other in-call-only landmarks: `AXToolbar #indicators description="Calling indicators"` (call
timer/record chip lives here), and — **when the roster panel is open** (C2) —
`AXGroup [AXLandmarkComplementary] description="Participants"` + `AXOutline description="Attendees"`.

**Hang-up identity:** the Leave control is `AXButton #hangup-button` with a **stable DOM id
(`#hangup-button`)** and **`AXDescription="Leave"`**. CRITICAL: the name is in **AXDescription, NOT
AXTitle** (the node carries no `AXTitle`).

**Would the shipping `teamsWebCallActive` / `findTeamsCallLandmarks` fire on THIS tree as-is?**
`teamsWebCallActive` (TeamsExtractor.swift:156) is three OR-ed signals:
1. `AXGroup` subrole `AXLandmarkMain`, desc contains `"shared content"` → **the tree has
   `AXGroup [AXLandmarkMain] description="Shared content view"` → ✅ FIRES, and it is present in the
   DEFAULT in-call state (C1), no panel needed.**
2. `AXButton` whose **AXTitle** lowercased == `"leave"` → **✗ does NOT fire**: the consumer hang-up
   carries `AXDescription="Leave"` and **no AXTitle**, so the title-only check misses it.
3. `AXOutline` desc contains `"attendees"` → the tree has `AXOutline description="Attendees"`, but
   **only when the roster panel is open** (C2) → ✅ fires conditionally.
`findTeamsCallLandmarks` returns every `AXGroup [AXLandmarkMain]` → **returns the Shared-content-view
node → ✅ non-empty**.

**Predicate that fires vs the tree's reality:** the **Shared-content-view landmark (#1)** is the load-
bearing one — present in every in-call state, absent in green room (C3), post-leave (C4) and chat (C5).
The Leave-button check (#2) is DEAD on consumer (desc-not-title) and should be widened to read
AXDescription too; the Attendees check (#3) is panel-gated. **Recommendation: keep signal #1 as the
primary gate; fix #2 to also match `AXDescription == "leave"` OR `#hangup-button` (id-anchored) so the
gate survives a future layout that drops the Shared-content landmark.**

---

## Q2 — IDENTITY HUNT · verdict: **per-meeting id is NOT in the URL and NOT in the default tree; it is recoverable ONLY behind the explicit "Share invite → Copy meeting link" tray (the /v2/ collapse is real)**

Grepped the LIVE DOM (`document.documentElement.outerHTML`, body text, all inputs) and every AX dump
for the harvested id `<REDACTED-MEETING-ID>`, the passcode, and `meet/` / `19:meeting_` fragments:

| State | id in AXURL | id in DOM `outerHTML` | `meet/` links | `19:meeting_` |
|-------|-------------|-----------------------|---------------|---------------|
| in-call default (C1) | **0** (URL = `/v2/`) | **0** | none | none |
| roster panel open (C2) | 0 | **0** | none | none |
| **Share-invite tray OPEN (C2′)** | 0 | **1** | **`teams.live.com/meet/<id>?p=<passcode>`** | none |

- The AXWebArea **`AXURL` is bare `https://teams.live.com/v2/`** the instant "Continue on this browser"
  runs — the `/meet/<id>` path collapses to `/v2/` and never reappears in the URL, in ANY subnode
  `AXURL` (every subnode `AXURL` is empty), or in any `AXDOMIdentifier`.
- The meeting id appears in the DOM **exactly once and ONLY** after the user opens **Share invite**:
  the tray renders `AXHeading "Invite people to join you"`, `AXButton title="Copy meeting link"`, and
  the full `teams.live.com/meet/<id>?p=<passcode>` link (behind the Copy button; body text:
  `"Invite people to join you / Copy meeting link / Share via default email"`). This is a modal that
  becomes the ROOT AXWebArea (only 12 nodes reachable — the meeting tree sits behind it).
- **Per-PARTICIPANT ids DO exist** in the roster (C2) as stable DOM ids:
  `#calling-roster-item-8:live:bibekthapa933` (self) and
  `#calling-roster-item-8:live:.cid.8a5fc5ad54228011` (host). The self-tile base class in C1 decodes
  from `bkg_NTQyMjgwMTE4...` (base64) → `542280118livecid` — a per-participant "live consumer id",
  NOT the meeting id.

**Decision (per-meeting identity vs the /v2/ collapse):** consumer Teams **collapses all meetings to
one `/v2/` URL** — there is NO passive per-meeting identity in the URL or the default AX/DOM tree.
A per-meeting key is obtainable only by driving the Share-invite tray (a user action, not a passive
read), so the detector CANNOT distinguish meeting A from meeting B by URL or by a passive tree read.
Identity, if needed, must come from the **`Meeting with <organizer>` window/tab title** (subject-based,
as the G2a tab-away sweep already relies on) or the **participant roster ids**, not a meeting id.

---

## Q3 — TILES / ROSTER · verdict: **structured tiles AND roster rows exist, but in consumer-specific AX shapes that the shipping web extractor partially misses**

**Stage tiles (C1)** — the participant tile is a NATIVE-style `AXMenuItem` whose name + affordance ride
the **AXDescription** (there is NO AXTitle on the tile):
```
AXMenuItem  description="Bibek Thapa, Context menu is available"      # remote/host tile
AXImage     description="Myself video, bibek thapa, Unmuted, Has context menu"   # self tile (P2)
```
This matches the shipping **P1 NATIVE branch** (`n.role=="AXMenuItem"` && `desc.contains("context
menu")`), NOT the P1-WEB branch (which expects an EMPTY desc with the name in AXTitle). So:
- `teamsExtractWindow(source: .web)` runs BOTH P1 and P1-WEB → **the P1 branch catches this tile** ✅
  (name from desc, `cleanCandidateDetectingSelf` strips "Context menu is available"), and the self
  image is caught by the P2 `Myself video` token ✅.
- BUT the live web scraper `extractTeamsBrowserParticipants` (TeamsExtractor.swift:212) reads
  **`AXTitle` on AXMenuItem ONLY** → **it MISSES the consumer tile** (name is in AXDescription).
  This is the load-bearing extraction gap.

**Roster rows (C2, roster panel open)** — a structured `AXOutline "Attendees"` with per-participant
`AXOutlineRow`s carrying name + role + mute state in the row **AXTitle**, and stable per-row ids:
```
AXGroup [AXLandmarkComplementary] description="Participants"
  AXOutline description="Attendees"
    AXRow [AXOutlineRow]                                    title="In this meeting, 2 total Mute all"
    AXRow [AXOutlineRow] #menur7i title="bibek thapa, Unmuted"                 # self  (id ...bibekthapa933)
      AXStaticText value="bibek thapa"
      AXImage #roster-mic-button-... description="Unmuted"
    AXRow [AXOutlineRow] #menur7f title="Bibek Thapa, Organizer, Unmuted"      # host  (id ....cid.8a5fc5ad54228011)
      AXStaticText value="Bibek Thapa"
      AXStaticText value="Organizer"
```
The shipping `parseTeamsRosterRow` grammar (name, role, mute) is scoped inside the
`AXOutline "Attendees"` container by `teamsExtractWindow` P3 → **the consumer `AXOutlineRow` titles
(`"Bibek Thapa, Organizer, Unmuted"`) are exactly that grammar → P3 extraction WORKS as-is** ✅ (the
row name is in AXTitle, which the roster path reads).

**Own name vs host name in structured nodes:** YES — both are in structured nodes. The guest's own
name and the host's name appear as `AXStaticText value=...` inside their `AXOutlineRow`, and the
self/host distinction is carried by role (`Organizer`) + the `Myself video` self-tile in C1. (Cosmetic
caveat from the G2a sweep persists: the anonymous consumer guest's display name falls back to the
signed-in profile name `bibek thapa` rather than the typed "QA Web Guest" — does not affect structure.)

---

## Q4 — URL SHAPES · verdict: **every state is `teams.live.com/v2/`; negatives differ ONLY by landmarks (and title), NEVER by URL**

Exact AXWebArea `AXURL` per cell (all identical):

| State | AXURL | Distinguisher |
|-------|-------|---------------|
| in-call (C1/C2) | `https://teams.live.com/v2/` | Shared-content landmark + call controls |
| green room (C3) | `https://teams.live.com/v2/` | `#prejoin-join-button "Join now"`, no landmark |
| post-leave (C4) | `https://teams.live.com/v2/` | no landmarks, "Stay connected after your meeting" |
| chat (C5) | `https://teams.live.com/v2/` | no landmarks, `Chat \| …` title |

**What the widened URL scope must accept:** the shipping `isTeamsMeetingURL` already returns true for
`teams.live.com/v2/`? — **NO, it does not.** `isTeamsMeetingURL` requires the host to be a Teams host
AND the URL to contain one of `meetup-join`, `/meet/`, `/light-meetings/`, `meetingjoin=`,
`meetingid=`, `meeting_`, `/calling/`. The consumer in-call URL is **bare `teams.live.com/v2/` with
NONE of those markers**, so **`isTeamsMeetingURL("https://teams.live.com/v2/")` returns FALSE** →
`findTeamsWebAreas` would NOT collect the consumer in-call web area at all. **This is the single
biggest required change: the URL predicate must accept the bare `teams.live.com/v2/` host+path.**
Because `/v2/` also covers chat/home/post-leave, the URL alone is necessarily over-broad — it can only
say "this is a Teams-web tab", and the **landmark gate (`teamsWebCallActive`) is what promotes it to
in-call**. The negatives (green room, post-leave, chat) share the URL and are rejected purely by the
landmark absence, exactly as the gate is designed to.

---

## Q5 — NODE / DEPTH BUDGETS · verdict: **the ~150-node figure is REAL, not a bounding artifact**

Captured with generous bounds (`--max-nodes 200000 --depth 200`); the trees are genuinely small:
in-call default **155 nodes** (the earlier G2a "151" figure reproduced — real), roster-open **193**,
green room **127**, post-leave **104**, chat **279**. The consumer meeting stage is a compact tree
(compact-view layout + a 2-person call); even the roster-open state is under 200 nodes. The shipping
walkers' `maxNodes` (5000–8000) are comfortably above the real tree size — **no budget change needed**;
the tree is fully reachable well within the existing bounds.

---

## PROPOSED DETECTION DESIGN (consumer extension of bubbles-meet-detector)

Each item grounded in a quoted node above. Three changes; all ADDITIVE and web-scoped.

**1. URL-scope widening (REQUIRED — `isTeamsMeetingURL`).**
Add a consumer branch: for host `teams.live.com` (or `*.teams.live.com`), ALSO accept the bare
`/v2/` path (and `/v2` / `/`), not just the `/meet/` etc. markers — because the in-call URL collapses
to `teams.live.com/v2/` (Q4, every cell). Keep this consumer-broad match GATED so it only widens
`teams.live.com`, never `teams.microsoft.com` (work URLs keep their marker discipline). The broad
match is safe because detection is landmark-gated (item 2), not URL-gated.
> Grounded in: `AXWebArea … AXURL = https://teams.live.com/v2/` (C1..C5, all identical).

**2. Landmark predicate (the in-call gate — mostly already fires; one hardening).**
Primary signal: `AXGroup [AXLandmarkMain] description="Shared content view"` — present in every
in-call state, absent in all three negatives → this is the gate. `teamsWebCallActive` signal #1
ALREADY matches it, so the gate FIRES as-is. HARDEN signal #2: change the Leave-button check from
AXTitle-only to `(AXTitle||AXDescription) == "leave"` **or** id `#hangup-button`, because the consumer
hang-up carries `description="Leave"` with no AXTitle (so the current title-only check is dead on
consumer). Optionally also accept `AXOutline description="Attendees"` (already signal #3) for the
panel-open path.
> Grounded in: `AXGroup [AXLandmarkMain] description="Shared content view"` (C1:202);
> `AXButton #hangup-button description="Leave"` (C1:182); `AXOutline description="Attendees"` (C2:284).

**3. Participant/identity source (tiles + roster — wire the consumer AX shapes).**
- Prefer the pure `teamsExtractWindow(source: .web)` over the live `extractTeamsBrowserParticipants`:
  the pure extractor's P1 branch already handles the consumer tile
  (`AXMenuItem description="…, Context menu is available"`, name-in-desc) and its P3 branch already
  handles the consumer roster (`AXOutline "Attendees"` → `AXOutlineRow title="Name, Role, Unmuted"`).
  If the live scraper is kept, its `AXMenuItem` read MUST switch from AXTitle to AXDescription (with
  the `"Context menu is available"` anchor + `cleanCandidateDetectingSelf`) to catch consumer tiles.
- **Meeting identity**: there is NO passive per-meeting id (Q2). Use the **window/tab title
  `Meeting with <organizer> | Microsoft Teams`** as the meeting key (subject-based, matches the G2a
  tab-away design), NOT a meeting id. If a stable per-meeting id is ever required, it is reachable
  only by driving Share-invite → Copy meeting link (a user action) — do not depend on it.
> Grounded in: `AXMenuItem description="Bibek Thapa, Context menu is available"` (C1:218);
> `AXImage description="Myself video, bibek thapa, Unmuted, …"` (C1:210);
> `AXRow [AXOutlineRow] title="Bibek Thapa, Organizer, Unmuted"` (C2:314);
> share-tray link `teams.live.com/meet/<id>?p=<passcode>` (C2′, Share-invite only).

### GO / NO-GO — **GO** (bounded extension, not a rewrite)

| Criterion | Result | Evidence |
|-----------|--------|----------|
| In-call gate fires on consumer tree | ✅ via Shared-content landmark (default state, no panel) | C1:202 |
| Landmarks stable & id-anchored | ✅ `#hangup-button`/`#roster-button`/`#microphone-button`/`#share-button` + landmark | C1:150–202 |
| Tiles/roster structured & extractable | ✅ P1 (tile, name-in-desc) + P3 (`AXOutline "Attendees"` rows) via pure extractor | C1:218, C2:284–334 |
| URL predicate needs widening | ⚠️ REQUIRED — bare `/v2/` is rejected by `isTeamsMeetingURL` today | Q4 table |
| Negatives cleanly rejected by landmarks | ✅ green room / post-leave / chat share the `/v2/` URL, all landmark-negative | C3/C4/C5 |
| Per-meeting identity | ⚠️ none passive — use `Meeting with <organizer>` title; id only via Share-invite | Q2 table |

Two small required adapter changes (URL widening + Leave-desc hardening) and one extraction-path
choice (use the pure `.web` extractor / switch the tile read to AXDescription). All web-scoped and
additive; native fixtures stay byte-stable.

## Teardown

Host meeting ended via `teams-host-lib.endMeeting` (`reallyInMeeting=false`); rig Chrome clean-quit
(`Browser.close` → SIGTERM, 9351 free, persistent profile intact, never SIGKILLed); driver stopped.
