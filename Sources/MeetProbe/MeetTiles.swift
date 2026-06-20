import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import SpeakerCore

// Locates the Google Meet AXWebArea and models each participant tile, extracting
// the per-tile structural features the experiment needs (geometry, order, the
// tile's own DOM class set, subtree role-shape, focus/selected, mic state).

struct TileFeatures {
    var name: String
    var frame: CGRect
    var orderIndex: Int
    /// role:count signature of the tile subtree (composition-sensitive, order-free).
    var roleCounts: String
    /// sorted unique AXDOMClassList tokens found anywhere in the tile subtree.
    var classTokens: String
    /// sorted unique class tokens on the NAME-PILL chain only (small ancestors of
    /// the name text, height < 80px) — isolates the speaking/active modifier from
    /// hover-control / layout noise elsewhere in the tile.
    var pillTokens: String = ""
    var descendantCount: Int
    var focusedOrSelected: Bool
    var micOff: Bool

    /// Everything except geometry — the "did the structure change" key.
    var structuralKey: String {
        "\(roleCounts)::\(classTokens)::\(focusedOrSelected ? "F" : "-")\(micOff ? "M" : "-")"
    }
}

enum MeetTiles {
    static let browserBundleIDs: Set<String> = [
        "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary",
        "com.apple.Safari", "com.microsoft.edgemac", "com.brave.Browser",
        "company.thebrowser.Browser", "com.vivaldi.Vivaldi", "org.mozilla.firefox",
    ]

    private static let maxScanNodes = 9000
    private static let maxTileSubtreeNodes = 800
    private static let maxClimb = 14
    // Tile container sizing. The strict name filter (looksLikeName) already
    // removes the clock / meeting code / toasts, so geometry only needs to pick
    // a sensible container level: a real box (not the tiny name text node, not
    // the whole web-area/grid), excluding wide caption/name bars by aspect.
    private static let tileMinArea: CGFloat = 8_000
    private static let tileMaxArea: CGFloat = 1_800_000
    private static let tileAspectMax: CGFloat = 4.0

    /// Reject anything that isn't a plausible participant display name: meeting
    /// codes (xxx-yyyy-zzz), clock times, sentences/toasts, and UI labels.
    private static func looksLikeName(_ cleaned: String) -> Bool {
        let t = cleaned.trimmingCharacters(in: .whitespaces)
        guard t.count >= 2 else { return false }
        if t.hasSuffix(".") { return false }
        let low = t.lowercased()
        if low == "pm" || low == "am" { return false }
        if t.range(of: #"^[a-z]{3}-[a-z]{3,4}-[a-z]{3}$"#, options: .regularExpression) != nil { return false }
        if t.range(of: #"^\d{1,2}:\d{2}"#, options: .regularExpression) != nil { return false }
        let uiWords = ["settings", "controls", "camera", "microphone", "background",
                       "replaced", "your ", "is off", "is on", "no longer", "present",
                       "caption", "host ", "more ", "leave", "raise", "reaction", "chat",
                       "joined", "left the", "the meeting", "is pinned", "pinned"]
        if uiWords.contains(where: { low.contains($0) }) { return false }
        return true
    }

    /// Find the Meet web-area root(s) across running browsers (foreground tab only —
    /// background tabs have frozen/absent trees, the documented Chromium limitation).
    static func findMeetWebAreas() -> [AXUIElement] {
        guard AX.isTrusted else { return [] }
        var roots: [AXUIElement] = []
        for app in NSWorkspace.shared.runningApplications {
            guard let bid = app.bundleIdentifier, browserBundleIDs.contains(bid), !app.isTerminated else { continue }
            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            for window in AX.windows(axApp) {
                let title = (AX.string(window, "AXTitle") ?? "").lowercased()
                let titleLooksMeet = title.contains("meet")
                guard titleLooksMeet || title.isEmpty else { continue }
                if let web = findMeetWebArea(in: window, titleLooksMeet: titleLooksMeet) {
                    roots.append(web)
                }
            }
        }
        return roots
    }

    /// One traversal of the window: collect every AXWebArea (with area) and detect
    /// whether anything in the tree references meet.google.com (AXURL is an NSURL,
    /// not a String; the address-bar value is a plain String). Pick the largest
    /// web area (the main page, not small iframes).
    private static func findMeetWebArea(in window: AXUIElement, titleLooksMeet: Bool) -> AXUIElement? {
        var webAreas: [(el: AXUIElement, area: CGFloat)] = []
        var mentionsMeet = false
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= maxScanNodes || depth > 70 { return }
            n += 1
            if AX.string(el, "AXRole") == "AXWebArea" {
                let f = AX.frame(el)
                webAreas.append((el, (f?.width ?? 0) * (f?.height ?? 0)))
            }
            if !mentionsMeet {
                for s in [AX.urlString(el, "AXURL"), AX.urlString(el, "AXDocument"), AX.string(el, "AXValue")] {
                    if let s, s.lowercased().contains("meet.google.com") { mentionsMeet = true; break }
                }
            }
            for c in AX.children(el) { rec(c, depth + 1) }
        }
        rec(window, 0)

        guard (titleLooksMeet || mentionsMeet), !webAreas.isEmpty else { return nil }
        return webAreas.max(by: { $0.area < $1.area })?.el
    }

    /// One-shot diagnostic for when no Meet web area is found.
    static func debugSummary() -> String {
        guard AX.isTrusted else { return "Accessibility NOT trusted." }
        var lines: [String] = []
        for app in NSWorkspace.shared.runningApplications {
            guard let bid = app.bundleIdentifier, browserBundleIDs.contains(bid), !app.isTerminated else { continue }
            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            let wins = AX.windows(axApp)
            lines.append("\(app.localizedName ?? bid): \(wins.count) window(s)")
            for w in wins {
                let title = AX.string(w, "AXTitle") ?? "<no title>"
                var webCount = 0, n = 0, mentions = false
                func rec(_ el: AXUIElement, _ d: Int) {
                    if n >= 4000 || d > 70 { return }; n += 1
                    if AX.string(el, "AXRole") == "AXWebArea" { webCount += 1 }
                    if !mentions, let u = AX.urlString(el, "AXURL"), u.lowercased().contains("meet.google.com") { mentions = true }
                    for c in AX.children(el) { rec(c, d + 1) }
                }
                rec(w, 0)
                lines.append("   • \"\(title.prefix(70))\"  webAreas=\(webCount) meetURL=\(mentions) scanned=\(n)")
            }
        }
        return lines.isEmpty ? "No supported browser apps running." : lines.joined(separator: "\n")
    }

    /// Build the current tile set under a Meet web area (features + the live
    /// element, so callers can dump a tile's raw subtree at a transition).
    static func tiles(in webArea: AXUIElement) -> [(features: TileFeatures, element: AXUIElement)] {
        // 1) Collect candidate name nodes (AXStaticText with a person-like value).
        var nameNodes: [(node: AXUIElement, name: String)] = []
        var scanned = 0
        func collect(_ el: AXUIElement, _ depth: Int) {
            if scanned >= maxScanNodes || depth > 60 { return }
            scanned += 1
            if AX.string(el, "AXRole") == "AXStaticText",
               let raw = AX.string(el, "AXValue") ?? AX.string(el, "AXTitle"),
               let name = cleanParticipantName(raw), looksLikeName(name) {
                nameNodes.append((el, name))
            }
            for c in AX.children(el) { collect(c, depth + 1) }
        }
        collect(webArea, 0)

        // 2) For each name, climb to a tile-sized ancestor; keep the largest tile per name.
        var byName: [String: (tile: AXUIElement, area: CGFloat, node: AXUIElement)] = [:]
        for (node, name) in nameNodes {
            guard let (tile, area) = tileAncestor(of: node) else { continue }
            if let existing = byName[name], existing.area >= area { continue }
            byName[name] = (tile, area, node)
        }

        // 3) Extract features; assign order index by reading order (y, then x).
        var rows: [(features: TileFeatures, element: AXUIElement)] = byName.map { (name, t) in
            var f = extractFeatures(name: name, tile: t.tile)
            f.pillTokens = pillTokens(from: t.node, upTo: t.tile)
            return (f, t.tile)
        }
        rows.sort {
            ($0.features.frame.minY, $0.features.frame.minX) < ($1.features.frame.minY, $1.features.frame.minX)
        }
        for i in rows.indices { rows[i].features.orderIndex = i }
        return rows
    }

    private static func tileAncestor(of node: AXUIElement) -> (AXUIElement, CGFloat)? {
        // Climb to the nearest tile-sized ancestor. Prefer a video-ish aspect
        // (<= 4.0, excludes wide name/caption bars); fall back to the first
        // reasonably-sized box if nothing matches the aspect (so a large
        // spotlight tile or square avatar tile is still captured).
        var cur: AXUIElement? = node
        var steps = 0
        var fallback: (AXUIElement, CGFloat)?
        while let el = cur, steps < maxClimb {
            if let f = AX.frame(el) {
                let area = f.width * f.height
                let aspect = f.height > 0 ? f.width / f.height : 99
                if area >= tileMinArea && area <= tileMaxArea {
                    if fallback == nil { fallback = (el, area) }
                    if aspect <= tileAspectMax { return (el, area) }
                }
            }
            cur = AX.parent(el)
            steps += 1
        }
        return fallback
    }

    /// Class tokens along the name-pill chain: the name node and its small
    /// ancestors (height < 80) up to the tile. This is where Meet puts the
    /// active/speaking modifier (e.g. the `vLRPrf` token on the OFfHfd,urlhDe pill).
    private static func pillTokens(from node: AXUIElement, upTo tile: AXUIElement) -> String {
        var tokens = Set<String>()
        var cur: AXUIElement? = node
        var steps = 0
        while let el = cur, steps < maxClimb {
            if let f = AX.frame(el), f.height < 80 {
                for t in AX.classList(el) { tokens.insert(t) }
            }
            if CFEqual(el, tile) { break }
            cur = AX.parent(el)
            steps += 1
        }
        return tokens.sorted().joined(separator: ",")
    }

    private static func extractFeatures(name: String, tile: AXUIElement) -> TileFeatures {
        var roleCount: [String: Int] = [:]
        var classes = Set<String>()
        var count = 0
        var focusedOrSelected = false
        var micOff = false
        var n = 0

        func walk(_ el: AXUIElement, _ depth: Int) {
            if n >= maxTileSubtreeNodes || depth > 40 { return }
            n += 1; count += 1
            let role = AX.string(el, "AXRole") ?? "?"
            let sub = AX.string(el, "AXSubrole")
            roleCount[sub != nil ? "\(role)/\(sub!)" : role, default: 0] += 1
            for t in AX.classList(el) { classes.insert(t) }
            if AX.bool(el, "AXFocused") || AX.bool(el, "AXSelected") { focusedOrSelected = true }
            let text = [AX.string(el, "AXDescription"), AX.string(el, "AXValue"), AX.string(el, "AXTitle")]
                .compactMap { $0 }.joined(separator: " ").lowercased()
            if text.contains("microphone is off") || text.contains("mic is off")
                || text.contains("is muted") || (text.contains("muted") && !text.contains("unmuted")) {
                micOff = true
            }
            for c in AX.children(el) { walk(c, depth + 1) }
        }
        walk(tile, 0)

        let roleCounts = roleCount.keys.sorted().map { "\($0):\(roleCount[$0]!)" }.joined(separator: "|")
        let classTokens = classes.sorted().joined(separator: ",")
        let frame = AX.frame(tile) ?? .zero
        return TileFeatures(name: name, frame: frame, orderIndex: 0,
                            roleCounts: roleCounts, classTokens: classTokens,
                            descendantCount: count, focusedOrSelected: focusedOrSelected, micOff: micOff)
    }

    /// Raw subtree dump (role + subrole + classlist + text) for eyeballing transitions.
    static func dumpSubtree(_ tile: AXUIElement) -> String {
        var out = ""
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= maxTileSubtreeNodes || depth > 40 { return }
            n += 1
            let role = AX.string(el, "AXRole") ?? "?"
            var parts = [role]
            if let s = AX.string(el, "AXSubrole") { parts.append("[\(s)]") }
            let cls = AX.classList(el)
            if !cls.isEmpty { parts.append("cls=\(cls.joined(separator: ","))") }
            for (label, attr) in [("title", "AXTitle"), ("desc", "AXDescription"), ("val", "AXValue")] {
                if let s = AX.string(el, attr), !s.isEmpty { parts.append("\(label)=\"\(s.prefix(60))\"") }
            }
            if let f = AX.frame(el) { parts.append(String(format: "@%.0f,%.0f %.0fx%.0f", f.minX, f.minY, f.width, f.height)) }
            out += String(repeating: "  ", count: depth) + parts.joined(separator: " ") + "\n"
            for c in AX.children(el) { rec(c, depth + 1) }
        }
        rec(tile, 0)
        return out
    }
}
