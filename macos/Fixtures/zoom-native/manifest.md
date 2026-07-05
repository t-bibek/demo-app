# Native-Zoom AX fixture corpus

Raw `swift run AXSnapshot zoom` dumps (committed as-is; the
`AXSnapshotFixture` decoder maps them to the platform-free node the pure
extractors consume). Replayed per cell in `SpeakerCoreSelfTest`. Provenance:
`us.zoom.xos` **Zoom 7.0.5 (81138)**.

| Fixture | Source | Cell | What it proves |
|---|---|---|---|
| `native-grid-3p-panelopen-talk.json` | ax-dump 20260625-200432 (3-party) | gallery, 3p, docked panel | phantom-`AXImage` guard, split-row P2 join, `(Host, me)` self, `", active speaker"` tolerated-not-depended-on, 2-unmuted-remote honest `Someone` |
| `native-grid-2p-panelopen-talk.json` | LIVE 2026-07-04, guest UNMUTED | gallery, 2p, panel open | host self via `(Host, me)`, single unmuted remote → NAMED |
| `native-grid-2p-panelopen-silent.json` | LIVE 2026-07-04, guest MUTED | gallery, 2p, panel open | talk↔silent pair: parsed output byte-identical except Guest Alpha's mute clause (no AX speaking signal) |
| `native-grid-2p-panelclosed-silent.json` | LIVE 2026-07-04, panel closed, guest muted | gallery, 2p, panel closed | tile overlays still expose name+mute; `(me)` gone → meeting window alone can't ID self |
| `native-grid-2p-panelclosed-talk.json` | LIVE 2026-07-04, panel closed, guest unmuted | gallery, 2p, panel closed | fused with the home window → self resolved, single remote NAMED (the panel-closed fix) |
| `native-home-inmeeting.json` | LIVE 2026-07-04, home window mid-call | home shell (self source) | profile button `"Zoom, David Thapa, In a Zoom Meeting, Basic account"` → the app-wide self name that survives a closed panel |
| `native-pip-2p.json` | LIVE 2026-07-04, minimal view | PIP | `AXSystemDialog` + `AXRoleDescription "Video render"` → `isPip`; keeps call alive |
| `native-home-negative.json` | LIVE 2026-07-04, post-call | home shell (negative) | not a meeting, empty roster (toolbar chrome ≠ participants) |

Re-capture when Zoom's version differs from 7.0.5 or a live run FAILs on
roster-text drift (e.g. a reworded `"computer audio"` clause — that is a
`zoom-rules.json` config drop). Capture: join a call, set the layout, then
`cd macos && swift run AXSnapshot zoom --depth 100 --max-nodes 40000`, and copy
the meeting-window `zoom-native-win<N>.json` here with the canonical label.
