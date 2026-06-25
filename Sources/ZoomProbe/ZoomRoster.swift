import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import SpeakerCore

// Models NATIVE Zoom (us.zoom.xos) participants for the speaker probe.
//
// Why this differs from MeetProbe: native Zoom's video grid is Metal-rendered
// and OPAQUE to Accessibility (docs/recall-and-demo-extraction.md §1.11), and
// there is no AXDOMClassList (that's a Chrome-web attribute). So the only
// readable surface is the Participants panel + any name overlays — plain AppKit
// AX. Recall reads exactly that (`ZoomScraper` over the AX tree) and fuses audio
// VAD for the active speaker; it does NOT read the tiles.
//
// The probe therefore fingerprints each NAMED ROW's subtree by its
//   • roles + role COUNTS  (rc:AXImage=2 vs =1 — an extra "speaking" glyph?)
//   • text on desc/value/title/help (name-stripped, digits collapsed to #)
//   • selected/focused state
// and tracks which tokens TOGGLE over a narrated run. If a token's on-windows
// match who you narrated speaking -> that's the native-Zoom speaking signal. If
// nothing toggles in lockstep with speech -> it isn't in AX on this build, and
// the timeline must lean on the Phase 5 audio-VAD spine.

struct RowFeatures {
    var name: String
    var frame: CGRect
    var window: String           // which Zoom window the row came from
    var roleSig: String          // role:count signature of the row subtree
    var tokens: Set<String>      // full normalized fingerprint (roles + counts + text + state)
    var micState: String         // "on" (unmuted) / "off" (muted) / "?" (unknown)
    var micOff: Bool
    var markerSpeaking: Bool     // text marker ("…, active speaker" / "is speaking")
}

enum ZoomRoster {
    static let bundleID = "us.zoom.xos"

    private static let maxScanNodes = 12000
    private static let maxRowSubtreeNodes = 500
    private static let maxClimb = 8
    private static let maxGlobalNodes = 12000
    /// A participant row is small; the window container is huge. Cap the climb so
    /// rowAncestor stops at the row, not a 371-button window container.
    private static let rowMaxNodes = 40

    // MARK: app / windows

    static func zoomApp() -> (axApp: AXUIElement, name: String)? {
        for app in NSWorkspace.shared.runningApplications {
            if app.bundleIdentifier == bundleID, !app.isTerminated {
                return (AXUIElementCreateApplication(app.processIdentifier), app.localizedName ?? bundleID)
            }
        }
        return nil
    }

    /// Top-level Zoom windows (meeting window, popped-out panels, etc.).
    static func zoomWindows() -> [(win: AXUIElement, title: String)] {
        guard let (axApp, _) = zoomApp() else { return [] }
        var wins = AX.windows(axApp).map { ($0, AX.string($0, "AXTitle") ?? "<untitled>") }
        if wins.isEmpty, let v = AX.copy(axApp, "AXFocusedWindow"), CFGetTypeID(v) == AXUIElementGetTypeID() {
            let w = (v as! AXUIElement)
            wins = [(w, AX.string(w, "AXTitle") ?? "<focused>")]
        }
        return wins
    }

    /// Windows that are an actual MEETING (participant mic-state text present, or a
    /// meeting-ish title) — so we DON'T scrape the **Zoom Workplace home/shell**
    /// window (Home / Team Chat / Scheduler / Hub / Calendar + promo banners),
    /// whose button labels otherwise leak in as fake participant rows. Falls back
    /// to all windows if none qualify (e.g. participants panel closed).
    static func meetingWindows() -> [(win: AXUIElement, title: String)] {
        let all = zoomWindows()
        let meeting = all.filter { looksLikeMeetingWindow($0.win, title: $0.title) }
        return meeting.isEmpty ? all : meeting
    }

    private static func looksLikeMeetingWindow(_ win: AXUIElement, title: String) -> Bool {
        if title.lowercased().contains("meeting") { return true }
        var found = false
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if found || n >= 6000 || d > 60 { return }
            n += 1
            for attr in ["AXDescription", "AXValue", "AXTitle"] {
                if let s = AX.string(el, attr), s.range(of: "computer audio", options: .caseInsensitive) != nil {
                    found = true; return
                }
            }
            for c in AX.children(el) { rec(c, d + 1); if found { return } }
        }
        rec(win, 0)
        return found
    }

    // MARK: name discovery

    /// Strip a trailing parenthetical role tag — "Bibek Thapa (Host, me)" -> "Bibek Thapa" —
    /// then run the shared cleaner. Returns a clean person name or nil.
    private static func personName(from raw: String) -> String? {
        let noParen = raw.replacingOccurrences(of: #"\s*\([^)]*\)\s*$"#, with: "",
                                               options: .regularExpression)
        guard let name = cleanParticipantName(noParen) else { return nil }
        // Extra guard: panel rows can surface short control words the cleaner lets
        // through; require at least one space OR >= 3 letters and no obvious verb-y UI.
        let low = name.lowercased()
        let uiWords = ["unmute", "mute all", "invite", "more", "raise", "lower",
                       "rename", "remove", "search", "waiting", "participants ("]
        if uiWords.contains(where: { low.contains($0) }) { return nil }
        // Reject Zoom Workplace HOME-shell chrome (left nav rail, promo banners,
        // calendar) — these pass the generic name cleaner and otherwise masquerade
        // as participants when the probe locks onto the home window instead of the
        // meeting (the "Back in Chat / Hub, 5 of 6 / Redeem offer" leak).
        if homeChromeWords.contains(where: { low.contains($0) }) { return nil }
        // Tab-position labels ("Home, selected, 1 of 6") and weekday/date headers
        // ("Wednesday, 24 June") are never people.
        if low.range(of: #"\b\d+\s+of\s+\d+\b"#, options: .regularExpression) != nil { return nil }
        if low.contains(", selected") || low.contains("selected,") { return nil }
        // Participants-panel STATE images (panel open) — "Computer audio muted",
        // "Video on/off" — have AXDescriptions that pass the generic cleaner but
        // are not people. (Tiles like "David's Iphone, Computer audio…" are already
        // cut to the name before this, so this only drops the bare state strings.)
        if low.contains("computer audio") || low.contains("video on") || low.contains("video off") { return nil }
        // Participants-panel header / outline chrome (these AXButton/AXOutline
        // descriptions pass the generic cleaner but are not people).
        let panelChrome: Set<String> = ["button", "pop out", "participants list", "close", "invite"]
        if panelChrome.contains(low) { return nil }
        return name
    }

    /// Labels from the Zoom Workplace HOME window that the name cleaner lets
    /// through. A meeting roster never contains these — so dropping them stops the
    /// home shell from posing as participants (see personName).
    private static let homeChromeWords = [
        "back in", "forward in", "history", "create new", "activity center",
        "new messages", "team chat", "chat", "hub", "scheduler", "navigation",
        "redeem", "offer", "calendar", "contacts", "whiteboard", "apps", "settings",
        "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    ]

    // MARK: per-row fingerprint

    /// Collapse digit runs to '#' and strip the participant's own name so the
    /// fingerprint reflects STATE changes, not the (static) name or audio-level
    /// numbers. Lowercased, punctuation-trimmed, length-capped.
    private static func normalizeText(_ s: String, name: String) -> String {
        var t = s.lowercased()
        let n = name.lowercased()
        if !n.isEmpty { t = t.replacingOccurrences(of: n, with: "") }
        t = t.replacingOccurrences(of: #"\d+"#, with: "#", options: .regularExpression)
        t = t.trimmingCharacters(in: CharacterSet(charactersIn: " ,.:;|-_()/'\u{2019}\""))
        t = t.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return String(t.prefix(48))
    }

    private static func extractRow(name: String, row: AXUIElement, window: String) -> RowFeatures {
        var roleCount: [String: Int] = [:]
        var tokens = Set<String>()
        var fullText = ""
        var markerSpeaking = false
        var n = 0

        func walk(_ el: AXUIElement, _ depth: Int) {
            if n >= maxRowSubtreeNodes || depth > 30 { return }
            n += 1
            let role = AX.string(el, "AXRole") ?? "?"
            let rk = AX.string(el, "AXSubrole").map { "\(role)/\($0)" } ?? role
            roleCount[rk, default: 0] += 1
            tokens.insert("r:\(rk)")
            if AX.bool(el, "AXSelected") { tokens.insert("sel") }
            if AX.bool(el, "AXFocused") { tokens.insert("foc") }

            for attr in ["AXDescription", "AXValue", "AXTitle", "AXHelp"] {
                guard let s = AX.string(el, attr), !s.isEmpty else { continue }
                fullText += " " + s
                let norm = normalizeText(s, name: name)
                if !norm.isEmpty { tokens.insert("t:\(norm)") }
                if isSpeakingMarker(s) { markerSpeaking = true }
            }
            for c in AX.children(el) { walk(c, depth + 1) }
        }
        walk(row, 0)

        // Role COUNTS as tokens: an extra image/group on the speaking row shows up
        // as rc:AXImage=2 replacing rc:AXImage=1 — a set diff the analysis catches.
        for (rk, c) in roleCount { tokens.insert("rc:\(rk)=\(c)") }
        let roleSig = roleCount.keys.sorted().map { "\($0):\(roleCount[$0]!)" }.joined(separator: "|")
        let frame = AX.frame(row) ?? .zero

        // Mic state keyed on the panel's EXPLICIT phrase, not any "muted" substring
        // — so a stray "Mute" button or the "unmute my audio" toolbar label can't
        // flip it (that was the false-🔇 bug). "audio unmuted" wins when present.
        let low = fullText.lowercased()
        let micState = low.contains("audio unmuted") ? "on"
            : (low.contains("audio muted") ? "off" : "?")

        return RowFeatures(name: name, frame: frame, window: window, roleSig: roleSig,
                           tokens: tokens, micState: micState, micOff: micState == "off",
                           markerSpeaking: markerSpeaking)
    }

    /// Bounded count of a subtree (stops at `cap`), so we can tell a small row
    /// container from the giant window container.
    private static func subtreeCount(_ el: AXUIElement, cap: Int) -> Int {
        var n = 0
        func rec(_ e: AXUIElement, _ d: Int) {
            if n >= cap || d > 20 { return }
            n += 1
            for c in AX.children(e) { rec(c, d + 1); if n >= cap { return } }
        }
        rec(el, 0)
        return n
    }

    /// Climb from a name node to its ROW container — the highest ancestor whose
    /// subtree is still SMALL (<= rowMaxNodes). This stops at the row, not the
    /// whole window: an over-climb previously grabbed a 371-button container and
    /// made every participant's fingerprint identical. Prefers an AXRow/AXCell.
    private static func rowAncestor(of node: AXUIElement) -> AXUIElement {
        var cur = node
        var best = node
        var steps = 0
        while steps < maxClimb {
            if subtreeCount(cur, cap: rowMaxNodes + 1) > rowMaxNodes { break }
            best = cur
            let role = AX.string(cur, "AXRole") ?? ""
            if role == "AXRow" || role == "AXCell" { return cur }
            guard let p = AX.parent(cur) else { break }
            cur = p
            steps += 1
        }
        return best
    }

    // MARK: public sampling API

    /// Current participants across all Zoom windows (one entry per name).
    ///
    /// A participant shows up as SEVERAL elements — spotlight tile + thumbnail tile
    /// + Participants-panel row — and the state is NOT all on the biggest one:
    /// Zoom puts the `", active speaker"` marker on the small ACTIVE thumbnail and
    /// mute on the panel row. So we gather every instance per name and MERGE their
    /// state, keeping the largest box only as the representative frame. (The old
    /// keep-largest-box-only logic silently dropped the active-speaker marker.)
    static func rows() -> [(features: RowFeatures, element: AXUIElement)] {
        struct Inst { var feats: RowFeatures; var el: AXUIElement; var area: CGFloat }
        var byName: [String: [Inst]] = [:]
        for (win, wtitle) in meetingWindows() {
            var nameNodes: [(AXUIElement, String)] = []
            var scanned = 0
            func collect(_ el: AXUIElement, _ depth: Int) {
                if scanned >= maxScanNodes || depth > 60 { return }
                scanned += 1
                for attr in ["AXTitle", "AXDescription", "AXValue"] {
                    if let raw = AX.string(el, attr), let name = personName(from: raw) {
                        nameNodes.append((el, name)); break
                    }
                }
                for c in AX.children(el) { collect(c, depth + 1) }
            }
            collect(win, 0)

            for (node, name) in nameNodes {
                // Read state from the tile's OWN node — do NOT climb. Native Zoom's
                // entire window is only ~tens of nodes (< rowMaxNodes), so climbing
                // to find a "row" returned the WHOLE WINDOW for every name, whose
                // subtree contains every tile's text → the ", active speaker" marker
                // then matched for EVERY participant. A tile's own AXDescription
                // already carries name + mute + active-speaker, so the node itself is
                // the correct, per-participant scope.
                let f = AX.frame(node) ?? .zero
                let feats = extractRow(name: name, row: node, window: wtitle)
                byName[name, default: []].append(Inst(feats: feats, el: node, area: f.width * f.height))
            }
        }

        var out: [(RowFeatures, AXUIElement)] = []
        for (_, insts) in byName {
            let rep = insts.max(by: { $0.area < $1.area })!   // biggest box = representative frame
            var feats = rep.feats
            // MERGE state across all of this participant's tiles/rows:
            feats.markerSpeaking = insts.contains { $0.feats.markerSpeaking }   // speaking on ANY tile ⇒ speaking
            if feats.micState == "?", let m = insts.first(where: { $0.feats.micState != "?" })?.feats {
                feats.micState = m.micState; feats.micOff = m.micOff
            }
            out.append((feats, rep.el))
        }
        return out.sorted { ($0.0.frame.minY, $0.0.frame.minX) < ($1.0.frame.minY, $1.0.frame.minX) }
    }

    /// All fingerprint tokens across every Zoom window (no name-strip) — catches a
    /// speaking signal that lives OUTSIDE the rows (a spotlight banner, a toolbar
    /// "X is speaking", an active-speaker frame). Bounded.
    static func allTokens() -> Set<String> {
        var toks = Set<String>()
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= maxGlobalNodes || depth > 70 { return }
            n += 1
            let role = AX.string(el, "AXRole") ?? "?"
            let rk = AX.string(el, "AXSubrole").map { "\(role)/\($0)" } ?? role
            toks.insert("r:\(rk)")
            for attr in ["AXDescription", "AXValue", "AXTitle", "AXHelp"] {
                guard let s = AX.string(el, attr), !s.isEmpty else { continue }
                let norm = normalizeText(s, name: "")
                if !norm.isEmpty, norm.count >= 2 { toks.insert("t:\(norm)") }
            }
            for c in AX.children(el) { rec(c, depth + 1) }
        }
        for (win, _) in meetingWindows() { rec(win, 0) }
        return toks
    }

    /// Diagnostic when no rows are found: list Zoom windows + a role census.
    static func debugSummary() -> String {
        guard AX.isTrusted else { return "Accessibility NOT trusted." }
        guard zoomApp() != nil else {
            return "Zoom (us.zoom.xos) is not running. Launch Zoom and JOIN a meeting."
        }
        var lines: [String] = []
        let wins = zoomWindows()
        lines.append("Zoom windows: \(wins.count)")
        for (win, title) in wins {
            var roleCount: [String: Int] = [:]
            var n = 0
            func rec(_ el: AXUIElement, _ d: Int) {
                if n >= 4000 || d > 60 { return }; n += 1
                let role = AX.string(el, "AXRole") ?? "?"
                roleCount[role, default: 0] += 1
                for c in AX.children(el) { rec(c, d + 1) }
            }
            rec(win, 0)
            let top = roleCount.sorted { $0.value > $1.value }.prefix(8)
                .map { "\($0.key)=\($0.value)" }.joined(separator: " ")
            lines.append("  • \"\(title.prefix(60))\"  nodes=\(n)  \(top)")
        }
        lines.append("If you see few nodes / no AXRow: OPEN the Participants panel, then re-run.")
        return lines.joined(separator: "\n")
    }

    /// Up-front inventory of every Zoom window: title, size, node count, whether it
    /// looks like a meeting, whether per-participant mute text ("computer audio") is
    /// present, and any candidate person-names found. Printed ALWAYS at startup so
    /// it's obvious when the probe is looking at the Workplace HOME shell (no
    /// meeting) rather than a meeting — and, crucially, when the meeting isn't in
    /// the native app at all (it's in the browser: app.zoom.us web client).
    static func windowInventory() -> String {
        guard AX.isTrusted else { return "Accessibility NOT trusted." }
        guard zoomApp() != nil else {
            return "Native Zoom (us.zoom.xos) is not running. If your meeting is at "
                 + "app.zoom.us (web client / PWA), use MeetProbe instead: `swift run MeetProbe zoom`."
        }
        let wins = zoomWindows()
        var lines = ["Native-Zoom windows: \(wins.count)"]
        var anyMeeting = false
        for (win, title) in wins {
            var n = 0, hasCA = false
            var names = Set<String>()
            func rec(_ el: AXUIElement, _ d: Int) {
                if n >= 8000 || d > 60 { return }; n += 1
                for attr in ["AXDescription", "AXValue", "AXTitle"] {
                    guard let s = AX.string(el, attr) else { continue }
                    if s.range(of: "computer audio", options: .caseInsensitive) != nil { hasCA = true }
                    if let nm = personName(from: s) { names.insert(nm) }
                }
                for c in AX.children(el) { rec(c, d + 1) }
            }
            rec(win, 0)
            let meeting = looksLikeMeetingWindow(win, title: title)
            anyMeeting = anyMeeting || meeting
            let f = AX.frame(win) ?? .zero
            lines.append(String(format: "  • \"%@\"  %.0fx%.0f  nodes=%d  meeting=%@  computerAudio=%@",
                                String(title.prefix(50)), f.width, f.height, n,
                                meeting ? "YES" : "no", hasCA ? "YES" : "no"))
            lines.append("      participant-name candidates: \(names.isEmpty ? "—" : names.sorted().prefix(10).joined(separator: ", "))")
        }
        if !anyMeeting {
            lines.append("⚠️ No native-Zoom MEETING window found (no \"computer audio\" rows, no \"meeting\" title).")
            lines.append("   If you joined via app.zoom.us (web/PWA), this is EXPECTED — the meeting is in the")
            lines.append("   browser, not us.zoom.xos. Use: swift run MeetProbe zoom 45 250")
        }
        return lines.joined(separator: "\n")
    }

    /// Raw subtree dump (role + subrole + text + frame) for eyeballing a row.
    static func dumpSubtree(_ row: AXUIElement) -> String {
        var out = ""
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= maxRowSubtreeNodes || depth > 30 { return }
            n += 1
            let role = AX.string(el, "AXRole") ?? "?"
            var parts = [role]
            if let s = AX.string(el, "AXSubrole") { parts.append("[\(s)]") }
            for (label, attr) in [("title", "AXTitle"), ("desc", "AXDescription"),
                                  ("val", "AXValue"), ("help", "AXHelp")] {
                if let s = AX.string(el, attr), !s.isEmpty { parts.append("\(label)=\"\(s.prefix(60))\"") }
            }
            if let f = AX.frame(el) {
                parts.append(String(format: "@%.0f,%.0f %.0fx%.0f", f.minX, f.minY, f.width, f.height))
            }
            out += String(repeating: "  ", count: depth) + parts.joined(separator: " ") + "\n"
            for c in AX.children(el) { rec(c, depth + 1) }
        }
        rec(row, 0)
        return out
    }
}
