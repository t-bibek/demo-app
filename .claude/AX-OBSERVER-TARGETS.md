# AXObserver subscription-target cheat sheet (mined from real dumps, 2026-07-03)

Derived by auditing `macos/ax-dumps/` + `ax-pattern-diff/` (read-only). Companion to
`.claude/MEET-AX-STRUCTURE-HANDOFF.md` — all three of its load-bearing claims were verified
against raw capture JSON (see §5). Ready for AXObserverAddNotification targeting.

## 1. Subscription targets

| Target | Anchor | Evidence |
|---|---|---|
| **Tile ancestor (ring)** | `AXGroup`, `AXDOMClassList` contains `kssMZb`; direct child of `AXSubrole=AXLandmarkMain` (classes `axUSnc`,`P9KVBf`). Real class lists: `["dkjMxf","kssMZb","iPFm3e","MVbbRb","tSl2vc"]`, `["tC2Wod","ACcyyc","iPFm3e","fdKMD","kssMZb","v5h6Xc"]`, `["lH9pqf","atLQQ","iPFm3e","kssMZb"]`. Frames ~240–340×200–330 (layout-dependent — never hardcode) | `macos/ax-dumps/20260703-212702/chrome-meet-1.json` |
| **Guest equalizer** | classes `["DYfzY","cYKTje","gjg47c"]` silent; nested under tile → `oZRSLe` descendants; ~87×0 silent → ~48×24 speaking | same dump |
| **Host equalizer** | **NOT under AXLandmarkMain** — outer container `["jb1oQc","VeFZv"]` @ ~23×22, child meter `["IisKdb","GF8M7d","gjg47c",…]`. Per-tile descendant walks MISS it → whole-tree scan + geometry attribution required | same dump |
| **Roster gate** | `AXList` + `AXSubrole=AXContentList` + `AXDescription="Participants"`; rows = `AXGroup` with `AXDescription=<name>`, classes `["cxdMu","KV1GEc"]`; exists only while People panel open (0 AXList when closed = clean gate) | same dump |
| **Name text** | `AXStaticText.AXValue` = name, empty class list, bottom ~36px strip of tile (e.g. 83×18 @ tile bottom) | same dump |

Do NOT subscribe to: AXFocused (see §5b), tile geometry as identity, tile-only equalizer descendants (misses host meter).

## 2. Equalizer class states (all dump-verified)

| State | DYfzY node | IisKdb node | Dump |
|---|---|---|---|
| Silence | `["DYfzY","cYKTje","gjg47c"]` | `["IisKdb","GF8M7d","gjg47c","KUNJSe","x9nQ6","VeFZv"]` | 20260703-212702 |
| Guest speaking | `["DYfzY","cYKTje","Oaajhc","sxlEM"]` | — | 20260703-193118 |
| Host speaking | — | `["IisKdb","GF8M7d","HX2H7","KUNJSe","x9nQ6","VeFZv"]` | 20260703-193109 |
| Overlap | `["DYfzY","cYKTje","wEsLMd","sxlEM"]` | — | 20260703-193123 |

Durable anchor: `gjg47c` present = silent; **absence of gjg47c = speaking**. Level tokens are a loudness ladder — never anchor on a specific one.

## 3. Subscription capacity (real node counts)

| Scenario | Total AX nodes | kssMZb tiles | Equalizers | Targets |
|---|---|---|---|---|
| 3-person host, all visible | 315 | 3 | 3 | 6 (1.9%) |
| 3-person guest | 193 | 3 | 2 | 5 |
| 2-person host | 168 | **0** | **0** | 0 |
| 2-person guest | 77 | 0 | 1 | 1 |
| ~5-person (extrapolated) | ~500 | ~5 | ~5 | ~10 |

→ the ≤64-node cap is safe with wide margin.

## 4. Key reference dumps

- Silent 3-person: `macos/ax-dumps/20260703-212702/chrome-meet-1.json`
- Host speaking: `macos/ax-dumps/20260703-193109/chrome-meet-1.json`
- Guest speaking: `macos/ax-dumps/20260703-193118/chrome-meet-2.json`
- Overlap: `macos/ax-dumps/20260703-193123/chrome-meet-1.json`
- 2-person (no kssMZb): `macos/ax-dumps/20260703-061530/chrome-meet-1.json`
- Readable trees: `ax-pattern-diff/M-3person-speech.txt`, `ax-pattern-diff/D-speaking.txt`

## 5. Handoff-claim verification verdicts

- (a) **kssMZb absent 2-person / present 3-person: CONFIRMED** — 3/3/3 tiles in all three 3-person dumps; 0 in both 2-person dumps; zero false positives across 5 dumps.
- (b) **AXFocused never a speaker signal: CONFIRMED** — in the 3-person dumps the only `AXFocused=true` node is an `AXButton "Close"`; tiles are never focused.
- (c) **Equalizer class states match handoff §2 exactly: CONFIRMED** (table above).