import Foundation
import ApplicationServices
import CoreGraphics
import SpeakerCore

// ZoomProbe — native Zoom (us.zoom.xos) active-speaker probe, the Zoom-native
// analog of MeetProbe.
//
// Native Zoom's video grid is Metal-rendered and OPAQUE to Accessibility
// (docs/recall-and-demo-extraction.md §1.11), with no AXDOMClassList. So the
// readable surface is the Participants panel / name overlays — plain AppKit AX.
// This fingerprints each NAMED ROW's subtree (roles + role-counts + text +
// state) every ~250 ms and, at the end, reports which tokens TOGGLE and their
// on-windows — so a narrated run reveals whether ANY AX feature tracks who is
// speaking. If nothing toggles in lockstep with speech, native Zoom's active
// speaker is NOT in AX on this build -> Phase 5 (audio VAD).
//
//   swift run ZoomProbe [durationSeconds] [intervalMs]
//   swift run ZoomProbe 45 250
//
// LIVE SETUP: be IN a Zoom meeting, OPEN the Participants panel (View ▸
// Participants), Gallery view, 2-3 people. Narrate turns out loud (e.g. "me
// 0-10s, other 10-20s, silent 20-30s"). KEEP THE MOUSE STILL and off the rows.

setbuf(stdout, nil)

let args = Array(CommandLine.arguments.dropFirst())
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
let outDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("zoom-probe-\(stamp)")
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let jsonlURL = outDir.appendingPathComponent("timeline.jsonl")
FileManager.default.createFile(atPath: jsonlURL.path, contents: nil)
let jsonl = try? FileHandle(forWritingTo: jsonlURL)

struct Sample { var t: Double; var tokens: Set<String>; var micState: String; var micOff: Bool; var speaking: Bool; var window: String }
var history: [String: [Sample]] = [:]
var globalHistory: [(t: Double, tokens: Set<String>)] = []
var sampleCount = 0
var sawAnyRow = false
let t0 = Date()

func tick() {
    let elapsed = Date().timeIntervalSince(t0)
    let rows = ZoomRoster.rows()
    if rows.isEmpty && sampleCount == 0 {
        print(String(format: "t=%5.1fs  (no Zoom participant rows found) — diagnostic:", elapsed))
        print(ZoomRoster.debugSummary()); print("")
    }
    globalHistory.append((elapsed, ZoomRoster.allTokens()))
    sampleCount += 1
    if !rows.isEmpty { sawAnyRow = true }

    var rowsJson: [[String: Any]] = []
    var line = String(format: "t=%5.1fs ", elapsed)
    for r in rows {
        let f = r.features
        let speaking = f.markerSpeaking   // only the text marker is unambiguous up front
        history[f.name, default: []].append(Sample(t: elapsed, tokens: f.tokens, micState: f.micState, micOff: f.micOff, speaking: speaking, window: f.window))
        rowsJson.append([
            "name": f.name, "window": f.window,
            "roleSig": f.roleSig, "micState": f.micState, "micOff": f.micOff,
            "markerSpeaking": f.markerSpeaking,
            "tokens": f.tokens.sorted(),
        ])
        // Live mic state per participant: 🎙️ unmuted (candidate speaker until VAD),
        // 🔇 muted, · unknown. 🔊 if a text speaking-marker is ever present.
        let glyph = speaking ? "🔊SPEAKING"
            : (f.micState == "on" ? "🎙️on" : f.micState == "off" ? "🔇off" : "·")
        line += "| \(f.name) \(glyph) "
    }
    if let data = try? JSONSerialization.data(withJSONObject: ["t": elapsed, "rows": rowsJson]), let jsonl {
        jsonl.write(data); jsonl.write(Data([0x0a]))
    }
    print(line)
}

print("ZoomProbe — native Zoom (us.zoom.xos) speaker probe")
print("duration=\(Int(duration))s interval=\(intervalMs)ms  output=\(outDir.path)")
print("🎙️on = unmuted (candidate speaker until VAD)   🔇off = muted   🔊SPEAKING = text marker")
print("OPEN the Participants panel, Gallery view. Narrate turns; KEEP THE MOUSE STILL.\n")

let timer = Timer(timeInterval: Double(intervalMs) / 1000.0, repeats: true) { t in
    tick()
    // Stop on ELAPSED time, not a fixed tick count: a heavy AX scan (e.g. when
    // the Zoom toolbar is showing) makes some ticks longer than the interval, so
    // a tick budget would overrun the requested duration (the t=49s overrun).
    if Date().timeIntervalSince(t0) >= duration { t.invalidate(); CFRunLoopStop(CFRunLoopGetCurrent()) }
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
func tokenWindows(_ history: [(t: Double, tokens: Set<String>)], _ tok: String) -> [(Double, Double)] {
    var out: [(Double, Double)] = []
    var st: Double? = nil, last: Double? = nil, miss = 0
    for (t, toks) in history {
        if toks.contains(tok) { if st == nil { st = t }; last = t; miss = 0 }
        else if st != nil { miss += 1; if miss > 1 { out.append((st!, last!)); st = nil } }
    }
    if let s = st, let l = last { out.append((s, l)) }
    return out
}

print("\n================ SESSION ANALYSIS (native Zoom) ================")
if !sawAnyRow {
    print("No participant rows detected across the run.")
    print("• Make sure you are IN a meeting and the Participants panel is OPEN.")
    print("• Native Zoom's video grid is AX-opaque; the panel is the only text source.")
    print("Diagnostic:"); print(ZoomRoster.debugSummary())
    print("samples: \(sampleCount)")
    exit(0)
}

// Per-row intermittent tokens (toggled during the run) + their on-windows.
for (name, samples) in history.sorted(by: { $0.key < $1.key }) {
    let n = samples.count
    print("\n● \(name)  (present \(n)/\(sampleCount))")
    let onWin = windows(samples) { $0.micState == "on" }
    if !onWin.isEmpty { print("   🎙️ UNMUTED (candidate-speaker) windows: \(fmtWindows(onWin))") }
    let micWin = windows(samples) { $0.micOff }
    if !micWin.isEmpty { print("   🔇 reads-muted windows: \(fmtWindows(micWin))") }
    let markWin = windows(samples) { $0.speaking }
    if !markWin.isEmpty { print("   🔊 text-marker SPEAKING windows: \(fmtWindows(markWin))") }

    var cnt: [String: Int] = [:]
    for s in samples { for tok in s.tokens { cnt[tok, default: 0] += 1 } }
    let inter = cnt.filter { $0.value >= max(1, n / 10) && $0.value <= n * 9 / 10 }
    if inter.isEmpty {
        print("   (no toggling tokens — this row's AX is static across the run)")
    } else {
        for (tok, c) in inter.sorted(by: { $0.value > $1.value }).prefix(14) {
            let ws = windows(samples) { $0.tokens.contains(tok) }
            print("   \(tok)  [\(c)/\(n)]  \(fmtWindows(ws))")
        }
    }
}

// WHOLE-WINDOW intermittent tokens — a speaking signal OUTSIDE the rows (spotlight
// banner / toolbar). Compare on-windows to who you narrated speaking.
if !globalHistory.isEmpty {
    let N = globalHistory.count
    var cnt: [String: Int] = [:]
    for (_, toks) in globalHistory { for t in toks { cnt[t, default: 0] += 1 } }
    let inter = cnt.filter { $0.value >= max(1, N / 10) && $0.value <= N * 9 / 10 }
    print("\nWHOLE-WINDOW intermittent tokens (anywhere in the Zoom windows):")
    if inter.isEmpty {
        print("   (none toggled — no readable speaking signal anywhere in AX on this build)")
    } else {
        for (tok, c) in inter.sorted(by: { $0.value > $1.value }).prefix(30) {
            print("   \(tok)  on \(c)/\(N)  \(fmtWindows(tokenWindows(globalHistory, tok)))")
        }
    }
}

print("""

HOW TO READ:
  • A token whose on-windows MATCH who you narrated speaking = native Zoom's
    active-speaker signal -> build the ZoomNativeSpeakerTracker on it (fuse VAD
    for precise on/off), mirroring the Meet rule.
  • Tokens that match MUTE/UNMUTE (not speech) are mic-state, not speaking —
    note them so the tracker doesn't conflate them (the Zoom-web lesson).
  • If NOTHING toggles with speech across a clean talk/silence cycle, native
    Zoom's active speaker is NOT in AX on this build -> Phase 5 (audio VAD).
  • Full timeline (JSONL): \(jsonlURL.path)
""")
print("samples: \(sampleCount)")
