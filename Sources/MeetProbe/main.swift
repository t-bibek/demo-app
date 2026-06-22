import Foundation
import ApplicationServices
import CoreGraphics
import SpeakerCore

// MeetProbe — per-tile speaker probe for Meet / Zoom / Teams (web).
//
// Detects "who is speaking" per tile via BOTH signals and reports which fired:
//   • marker  — Zoom-style text in AXDescription ("…, active speaker")
//   • class   — Meet-style AXDOMClassList token (MeetSpeakerRules: kssMZb, …)
// Plus the §4 structural analysis (intermittent class tokens + on-windows) so a
// narrated run reveals/​verifies the signal on any platform.
//
//   swift run MeetProbe [meet|zoom|teams] [durationSeconds] [intervalMs]
//   swift run MeetProbe zoom 45 250
//   swift run MeetProbe 45 250          # auto-detect platform
//
// Best signal: GALLERY view, 2-3 cameras on, narrate turns, DON'T hover tiles.

setbuf(stdout, nil)

let args = Array(CommandLine.arguments.dropFirst())
let knownPlatforms = ["meet", "zoom", "teams"]
let platformArg = args.first(where: { knownPlatforms.contains($0.lowercased()) })?.lowercased()
let nums = args.filter { Double($0) != nil }
let duration = Double(nums.first ?? "") ?? 45.0
let intervalMs = Int(nums.dropFirst().first ?? "") ?? 250

guard AX.isTrusted else {
    print("Accessibility permission is NOT granted. Grant it in System Settings >")
    print("Privacy & Security > Accessibility for Terminal/your IDE, then re-run.")
    AX.requestTrust()
    exit(2)
}

let stamp = Int(Date().timeIntervalSince1970)
let outDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("meet-probe-\(stamp)")
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let jsonlURL = outDir.appendingPathComponent("timeline.jsonl")
FileManager.default.createFile(atPath: jsonlURL.path, contents: nil)
let jsonl = try? FileHandle(forWritingTo: jsonlURL)

// Per-tile session history (gallery view keeps tiles persistent).
struct Sample { var t: Double; var pill: Set<String>; var full: Set<String>; var width: CGFloat; var order: Int; var micOff: Bool; var speaking: Bool }
var history: [String: [Sample]] = [:]
var firstPill: [String: Set<String>] = [:]
var globalHistory: [(t: Double, tokens: Set<String>)] = []   // whole web-area tokens per sample
var sampleCount = 0
var sawAnyTile = false

let t0 = Date()

var detectedPlatform = "?"

func tick() {
    let elapsed = Date().timeIntervalSince(t0)
    guard let hit = MeetTiles.findMeetingWebAreas(platform: platformArg).first else {
        if sampleCount == 0 {
            print(String(format: "t=%5.1fs  (no %@ web area found) — diagnostic:", elapsed, platformArg ?? "meeting"))
            print(MeetTiles.debugSummary()); print("")
        }
        sampleCount += 1
        return
    }
    detectedPlatform = hit.platform
    let rows = MeetTiles.tiles(in: hit.web)
    globalHistory.append((elapsed, MeetTiles.allClassTokens(in: hit.web)))
    sampleCount += 1
    if !rows.isEmpty { sawAnyTile = true }

    var tilesJson: [[String: Any]] = []
    var line = String(format: "t=%5.1fs ", elapsed)
    for r in rows {
        let f = r.features
        let pill = Set(f.pillTokens.split(separator: ",").map(String.init))
        let full = Set(f.classTokens.split(separator: ",").map(String.init))
        let classSpk = meetTileIsSpeaking(classTokens: full)     // Meet kssMZb rule
        let markerSpk = f.markerSpeaking                          // Zoom "…, active speaker"
        let speaking = classSpk || markerSpk
        history[f.name, default: []].append(Sample(t: elapsed, pill: pill, full: full, width: f.frame.width, order: f.orderIndex, micOff: f.micOff, speaking: speaking))
        tilesJson.append([
            "name": f.name, "order": f.orderIndex,
            "w": Int(f.frame.width), "h": Int(f.frame.height),
            "pillTokens": f.pillTokens, "classTokens": f.classTokens,
            "micOff": f.micOff, "speaking": speaking,
            "markerSpeaking": markerSpk, "classSpeaking": classSpk,
        ])
        let tag = speaking ? "🔊SPEAKING(\(markerSpk ? "mark" : "")\(markerSpk && classSpk ? "+" : "")\(classSpk ? "cls" : ""))" : "·"
        line += "| \(f.name) \(tag) "
    }
    if let data = try? JSONSerialization.data(withJSONObject: ["t": elapsed, "platform": detectedPlatform, "tiles": tilesJson]), let jsonl {
        jsonl.write(data); jsonl.write(Data([0x0a]))
    }
    print(line)
}

print("MeetProbe — per-tile speaker probe (\(platformArg ?? "auto-detect"))")
print("duration=\(Int(duration))s interval=\(intervalMs)ms  output=\(outDir.path)")
print("Per tile: 🔊SPEAKING(mark=Zoom text marker / cls=Meet class rule)")
print("GALLERY view, 2-3 cameras on. Narrate turns out loud; DON'T hover tiles/open settings.\n")

var ticksRemaining = Int(duration * 1000.0 / Double(intervalMs))
let timer = Timer(timeInterval: Double(intervalMs) / 1000.0, repeats: true) { t in
    tick()
    ticksRemaining -= 1
    if ticksRemaining <= 0 { t.invalidate(); CFRunLoopStop(CFRunLoopGetCurrent()) }
}
RunLoop.current.add(timer, forMode: .common)
timer.fire()
CFRunLoopRun()

// ---------------- Session analysis ----------------
try? jsonl?.close()

func windows(_ samples: [Sample], on: (Sample) -> Bool, gap: Int = 1) -> [(Double, Double)] {
    var out: [(Double, Double)] = []
    var start: Double? = nil, last: Double? = nil, miss = 0
    for s in samples {
        if on(s) {
            if start == nil { start = s.t }
            last = s.t; miss = 0
        } else if start != nil {
            miss += 1
            if miss > gap { out.append((start!, last!)); start = nil }
        }
    }
    if let st = start, let lt = last { out.append((st, lt)) }
    return out
}
func fmtWindows(_ ws: [(Double, Double)]) -> String {
    ws.map { String(format: "%.1f-%.1f", $0.0, $0.1) }.joined(separator: ", ")
}

print("\n================ SESSION ANALYSIS  (platform: \(detectedPlatform)) ================")
if !sawAnyTile {
    print("No tiles detected. Use GALLERY view, the meeting tab FOREGROUND, cameras on.")
    print("samples: \(sampleCount)")
    exit(0)
}

// Meet's hover/control chrome (button styles) — appear when the cursor is over a
// tile, not when someone speaks. Strip them so they don't drown the signal.
func isChrome(_ t: String) -> Bool {
    t.contains("Bz112c") || t.contains("LgbsSe") || t.contains("OWXEXe")
        || t.contains("Jh9lGc") || t == "MSqqjf" || t == "S5GDme"
}

// Collect, per tile, intermittent NON-chrome full-class tokens + their windows;
// and record which tiles each token toggles on (to separate per-tile vs global).
var tileTokenWindows: [String: [String: [(Double, Double)]]] = [:]
var tokenTiles: [String: Set<String>] = [:]
var sawChrome = false
for (name, samples) in history {
    let n = samples.count
    var tc: [String: Int] = [:]
    for s in samples {
        for tok in s.full {
            if isChrome(tok) { sawChrome = true; continue }
            tc[tok, default: 0] += 1
        }
    }
    for (tok, c) in tc where c >= max(1, n / 10) && c <= n * 9 / 10 {
        tileTokenWindows[name, default: [:]][tok] = windows(samples) { $0.full.contains(tok) }
        tokenTiles[tok, default: []].insert(name)
    }
}

let perTileTokens = tokenTiles.filter { $0.value.count == 1 }   // candidate speaker signal
let sharedTokens = tokenTiles.filter { $0.value.count >= 2 }    // likely global / UI

for (name, samples) in history.sorted(by: { $0.key < $1.key }) {
    let n = samples.count
    let medianW = samples.map { $0.width }.sorted()[n / 2]
    print("\n● \(name)  (present \(n)/\(sampleCount), medianWidth=\(Int(medianW)))")
    // SPEAKING = Zoom text marker OR Meet class rule — compare to your narration.
    let spkWin = windows(samples) { $0.speaking }
    print("   🔊 SPEAKING (marker OR class) windows: \(spkWin.isEmpty ? "(never)" : fmtWindows(spkWin))")
    // All other per-tile intermittent tokens (to catch a separate MUTE class etc.)
    let cand = (tileTokenWindows[name] ?? [:]).filter { perTileTokens[$0.key] != nil }
    for (tok, ws) in cand.sorted(by: { $0.value.count > $1.value.count }) {
        print("   token \(tok)  windows: \(fmtWindows(ws))")
    }
}

// WHOLE-WEB-AREA token timeline — catches a speaking signal that lives OUTSIDE the
// video tiles (e.g. Zoom's audio-* classes in the footer / participants panel).
// Compare the windows below to who you narrated speaking.
if !globalHistory.isEmpty {
    let N = globalHistory.count
    var cnt: [String: Int] = [:]
    for (_, toks) in globalHistory { for t in toks where !isChrome(t) { cnt[t, default: 0] += 1 } }
    let inter = cnt.filter { $0.value >= max(1, N / 10) && $0.value <= N * 9 / 10 }
    print("\nWHOLE-PAGE intermittent tokens (anywhere in the web area — the Zoom signal likely hides here):")
    if inter.isEmpty {
        print("   (none toggled — no readable speaking signal anywhere in AX on this build)")
    } else {
        for (tok, c) in inter.sorted(by: { $0.value > $1.value }).prefix(30) {
            var out: [(Double, Double)] = []
            var st: Double? = nil, last: Double? = nil, miss = 0
            for (t, toks) in globalHistory {
                if toks.contains(tok) { if st == nil { st = t }; last = t; miss = 0 }
                else if st != nil { miss += 1; if miss > 1 { out.append((st!, last!)); st = nil } }
            }
            if let s = st, let l = last { out.append((s, l)) }
            print("   \(tok)  on \(c)/\(N)  \(fmtWindows(out))")
        }
    }
}

if !sharedTokens.isEmpty {
    print("\nper-tile tokens shared across >1 tile (likely UI state): \(sharedTokens.keys.sorted().joined(separator: ", "))")
}
if sawChrome {
    print("⚠️  Hover-control chrome detected (Bz112c/LgbsSe/MSqqjf). KEEP THE MOUSE STILL and off the tiles next run — those classes are cursor-driven noise.")
}

print("""

HOW TO READ:
  • A CANDIDATE token whose windows match who you narrated speaking = Meet's
    active-speaker class -> Phase 4 (MeetSpeakerTracker, remote-config'd).
  • If there are NO candidate tokens across a clean talk/silence cycle (mouse
    still, narrated), Meet's active speaker is NOT in the AX tree on this build
    -> Phase 5 (audio VAD).
  • Full timeline (JSONL): \(jsonlURL.path)
""")
print("samples: \(sampleCount)")
