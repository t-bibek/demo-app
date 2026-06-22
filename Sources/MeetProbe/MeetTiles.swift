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
    /// True if the tile subtree text carries a Zoom-style speaking marker
    /// ("…, active speaker" etc.). Complements the Meet class rule.
    var markerSpeaking: Bool = false
    /// AXSubrole + AXDOMIdentifier + AXDescription tokens across the tile subtree
    /// (separator: US \u{1f}) — the structural selector surface Recall matches its
    /// "active speaker indicator" node on (role/subrole/identifier/description),
    /// NOT a CSS class. This is the Phase-4 indicator-child hunt.
    var structureTokens: String = ""
    /// True if a hover-control class (Bz112c/LgbsSe/…) is in the subtree — the
    /// cursor is over this tile, so any structural change is hover, not speech.
    var hovered: Bool = false
    /// The FULL non-class AX surface of the tile subtree (separator: US \u{1f}):
    /// every attribute NAME present (`n:<AXName>`, minus ubiquitous tree/geometry
    /// attrs) + bucketed VALUES of state-carrying attributes (`v:<AXName>=…`).
    /// Mined against the kssMZb oracle to find a rotation-proof structural handle
    /// — Recall's "container → indicator" route — that ISN'T the obfuscated class.
    var stateFacts: String = ""

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

    /// Native WebView apps that expose a Chromium AX tree but NO address-bar URL,
    /// so the platform is forced by bundle id. New Microsoft Teams is one (the
    /// whole client is a WebView2/Chromium app — see docs/teams-active-speaker-detection.md).
    static let nativeWebviewApps: [String: String] = [
        "com.microsoft.teams2": "teams",
        "com.microsoft.teams": "teams",
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

    /// Platform detected from a page URL.
    static let platformNeedles: [(token: String, needle: String)] = [
        ("meet", "meet.google.com"), ("zoom", "zoom.us"),
        ("teams", "teams.microsoft.com"), ("teams", "teams.live.com"),
    ]

    /// Find meeting web-area root(s) across running browsers (foreground tab only —
    /// background tabs have frozen/absent trees, the documented Chromium limitation).
    /// `wanted` filters to one platform ("meet"/"zoom"/"teams") or nil for any.
    /// Force every meeting app (browsers + native WebView clients) to build its
    /// FULL accessibility tree by writing AXEnhancedUserInterface +
    /// AXManualAccessibility. Chromium/WebView2/Electron apps serve a DEGRADED,
    /// mostly-static tree to passive readers until a client sets these — so a
    /// dynamic state like active-speaker may never appear without it. Recall does
    /// this (it imports AXUIElementSetAttributeValue). Idempotent; call at startup
    /// and let the tree repopulate (~1s) before trusting the diff.
    static func enableEnhancedAccessibility() {
        guard AX.isTrusted else { return }
        for app in NSWorkspace.shared.runningApplications {
            guard let bid = app.bundleIdentifier, !app.isTerminated,
                  browserBundleIDs.contains(bid) || nativeWebviewApps[bid] != nil else { continue }
            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            AX.setBool(axApp, "AXManualAccessibility", true)     // Electron / WebView2
            AX.setBool(axApp, "AXEnhancedUserInterface", true)   // Chromium / Cocoa AT flag
        }
    }

    static func findMeetingWebAreas(platform wanted: String?) -> [(web: AXUIElement, platform: String)] {
        guard AX.isTrusted else { return [] }
        var roots: [(AXUIElement, String)] = []
        for app in NSWorkspace.shared.runningApplications {
            guard let bid = app.bundleIdentifier, !app.isTerminated else { continue }
            let nativePlat = nativeWebviewApps[bid]
            guard browserBundleIDs.contains(bid) || nativePlat != nil else { continue }
            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            // Keep the enhanced tree on (some apps reset it) — idempotent.
            AX.setBool(axApp, "AXManualAccessibility", true)
            AX.setBool(axApp, "AXEnhancedUserInterface", true)
            for window in AX.windows(axApp) {
                if let nativePlat {
                    // Native WebView (new Teams): no URL to detect — force the
                    // platform by bundle id and take the window's largest AXWebArea.
                    // Returns every window so the compact/PIP overlay is captured too.
                    if let web = largestWebArea(in: window),
                       wanted == nil || wanted == nativePlat {
                        roots.append((web, nativePlat))
                    }
                    continue
                }
                let title = (AX.string(window, "AXTitle") ?? "").lowercased()
                let pre = title.contains("meet") || title.contains("zoom") || title.contains("teams") || title.isEmpty
                guard pre else { continue }
                if let (web, plat) = findMeetingWebArea(in: window) {
                    if wanted == nil || wanted == plat { roots.append((web, plat)) }
                }
            }
        }
        return roots
    }

    /// The largest AXWebArea anywhere in a window subtree (the main page, not a
    /// tiny iframe). Used for native WebView apps where platform is known a priori.
    static func largestWebArea(in window: AXUIElement) -> AXUIElement? {
        var best: (el: AXUIElement, area: CGFloat)?
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= maxScanNodes || depth > 70 { return }
            n += 1
            if AX.string(el, "AXRole") == "AXWebArea" {
                let f = AX.frame(el)
                let area = (f?.width ?? 0) * (f?.height ?? 0)
                if best == nil || area > best!.area { best = (el, area) }
            }
            for c in AX.children(el) { rec(c, depth + 1) }
        }
        rec(window, 0)
        return best?.el
    }

    /// One traversal of the window: collect every AXWebArea (with area) and detect
    /// the platform from any URL/text (AXURL is an NSURL, not a String). Returns the
    /// largest web area (the main page, not small iframes) + the detected platform.
    private static func findMeetingWebArea(in window: AXUIElement) -> (AXUIElement, String)? {
        var webAreas: [(el: AXUIElement, area: CGFloat)] = []
        var detected: String?
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= maxScanNodes || depth > 70 { return }
            n += 1
            if AX.string(el, "AXRole") == "AXWebArea" {
                let f = AX.frame(el)
                webAreas.append((el, (f?.width ?? 0) * (f?.height ?? 0)))
            }
            if detected == nil {
                for s in [AX.urlString(el, "AXURL"), AX.urlString(el, "AXDocument"), AX.string(el, "AXValue")].compactMap({ $0?.lowercased() }) {
                    for (tok, needle) in platformNeedles where s.contains(needle) { detected = tok; break }
                    if detected != nil { break }
                }
            }
            for c in AX.children(el) { rec(c, depth + 1) }
        }
        rec(window, 0)
        guard let plat = detected, let web = webAreas.max(by: { $0.area < $1.area })?.el else { return nil }
        return (web, plat)
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
                var webCount = 0, n = 0, plat = "-"
                func rec(_ el: AXUIElement, _ d: Int) {
                    if n >= 4000 || d > 70 { return }; n += 1
                    if AX.string(el, "AXRole") == "AXWebArea" { webCount += 1 }
                    if plat == "-" {
                        for s in [AX.urlString(el, "AXURL"), AX.urlString(el, "AXDocument"), AX.string(el, "AXValue")].compactMap({ $0?.lowercased() }) {
                            for (tok, needle) in platformNeedles where s.contains(needle) { plat = tok; break }
                            if plat != "-" { break }
                        }
                    }
                    for c in AX.children(el) { rec(c, d + 1) }
                }
                rec(w, 0)
                lines.append("   • \"\(title.prefix(70))\"  webAreas=\(webCount) platform=\(plat) scanned=\(n)")
            }
        }
        return lines.isEmpty ? "No supported browser apps running." : lines.joined(separator: "\n")
    }

    /// Build the current tile set under a Meet web area (features + the live
    /// element, so callers can dump a tile's raw subtree at a transition).
    static func tiles(in webArea: AXUIElement) -> [(features: TileFeatures, element: AXUIElement)] {
        // 1) Collect candidate name nodes. Meet puts the name in an AXStaticText
        //    value; Zoom puts it in an element's AXDescription ("Name, Computer
        //    audio unmuted, active speaker"). So check value/desc/title of any node.
        var nameNodes: [(node: AXUIElement, name: String)] = []
        var scanned = 0
        func collect(_ el: AXUIElement, _ depth: Int) {
            if scanned >= maxScanNodes || depth > 60 { return }
            scanned += 1
            for raw in [AX.string(el, "AXValue"), AX.string(el, "AXDescription"), AX.string(el, "AXTitle")].compactMap({ $0 }) {
                if let name = cleanParticipantName(raw), looksLikeName(name) {
                    nameNodes.append((el, name))
                    break
                }
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

    /// Attribute names too ubiquitous / structural to ever discriminate speech —
    /// excluded from the fact set so a co-varying signal isn't buried. The class
    /// (AXDOMClassList) is excluded too: we already have it; the hunt is for a
    /// NON-class handle.
    private static let factNameDenylist: Set<String> = [
        "AXRole", "AXSubrole", "AXParent", "AXChildren", "AXPosition", "AXSize",
        "AXFrame", "AXTopLevelUIElement", "AXWindow", "AXEnabled", "AXDOMClassList",
        "AXVisibleChildren", "AXSelectedChildren", "AXSelectedTextRanges",
        "AXLinkedUIElements", "AXFrameInWindow",
    ]

    /// State-carrying attributes whose VALUE may flip with speech (an audio-level
    /// AXValue, a role description like "is speaking", an ARIA invalid/busy flag).
    private static let factValueAttrs: [String] = [
        "AXValue", "AXRoleDescription", "AXHelp", "AXInvalid", "AXBusy",
        "AXSelected", "AXDescription", "AXTitle",
    ]

    /// Collect the FULL non-class AX surface of one element into `facts`: the
    /// presence of every attribute NAME (a rare attr may be the indicator's tell),
    /// plus bucketed VALUES of state-carrying attrs (numbers → +/0 to catch an
    /// audio-level meter; short strings digit-folded, optionally name-stripped).
    /// Shared by the per-tile hunt and the page-level "container/indicator" hunt.
    static func collectFacts(_ el: AXUIElement, into facts: inout Set<String>, stripName: String) {
        for a in AX.attributeNames(el) where !factNameDenylist.contains(a) {
            facts.insert("n:\(a)")
        }
        for a in factValueAttrs {
            guard let raw = AX.valueString(el, a), !raw.isEmpty else { continue }
            var norm = raw.lowercased()
            if !stripName.isEmpty { norm = norm.replacingOccurrences(of: stripName, with: "") }
            norm = norm.trimmingCharacters(in: .whitespaces)
            if let num = Double(norm) {
                norm = num != 0 ? "num+" : "num0"
            } else {
                norm = norm.replacingOccurrences(of: #"\d+"#, with: "#", options: .regularExpression)
                    .trimmingCharacters(in: CharacterSet(charactersIn: " ,.:;|-_"))
                norm = String(norm.prefix(32))
            }
            if !norm.isEmpty { facts.insert("v:\(a)=\(norm)") }
        }
    }

    /// Page-level structural surface: the full non-class fact set across the WHOLE
    /// web area (bounded). This is the "active-speaker container → indicator" hunt
    /// for an element living OUTSIDE the video tiles — the surface the per-tile
    /// hunt can't reach. Names are NOT stripped (a page-level indicator may name
    /// the active speaker, which is itself the signal).
    static func pageFacts(in webArea: AXUIElement) -> Set<String> {
        var facts = Set<String>()
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= 6000 || depth > 70 { return }   // reach the People/roster panel rows too (R1)
            n += 1
            collectFacts(el, into: &facts, stripName: "")
            for c in AX.children(el) { rec(c, depth + 1) }
        }
        rec(webArea, 0)
        return facts
    }

    /// Hover-control classes Meet adds to the tile under the cursor (and the
    /// auto-shown controls). Their presence means "this tile is hovered."
    static func isHoverChromeToken(_ t: String) -> Bool {
        t.contains("Bz112c") || t.contains("LgbsSe") || t.contains("OWXEXe")
            || t.contains("Jh9lGc") || t == "MSqqjf" || t == "S5GDme"
            // Teams: controls revealed on tile hover (so any change is hover, not speech).
            || t == "show-only-on-stream-hover"
    }

    private static func extractFeatures(name: String, tile: AXUIElement) -> TileFeatures {
        var roleCount: [String: Int] = [:]
        var classes = Set<String>()
        var structure = Set<String>()
        var facts = Set<String>()
        var count = 0
        var focusedOrSelected = false
        var micOff = false
        var markerSpeaking = false
        var n = 0
        let lowName = name.lowercased()

        func walk(_ el: AXUIElement, _ depth: Int) {
            if n >= maxTileSubtreeNodes || depth > 40 { return }
            n += 1; count += 1
            let role = AX.string(el, "AXRole") ?? "?"
            let sub = AX.string(el, "AXSubrole")
            roleCount[sub != nil ? "\(role)/\(sub!)" : role, default: 0] += 1
            for t in AX.classList(el) { classes.insert(t) }
            if AX.bool(el, "AXFocused") || AX.bool(el, "AXSelected") { focusedOrSelected = true }

            // Recall's selector surface: subrole, DOM identifier, description.
            if let sub { structure.insert("s:\(role)/\(sub)") }
            if let id = AX.string(el, "AXDOMIdentifier"), !id.isEmpty { structure.insert("id:\(id)") }
            if let d = AX.string(el, "AXDescription"), !d.isEmpty {
                var norm = d.lowercased().replacingOccurrences(of: lowName, with: "")
                norm = norm.replacingOccurrences(of: #"\d+"#, with: "#", options: .regularExpression)
                    .trimmingCharacters(in: CharacterSet(charactersIn: " ,.:;|-_"))
                if norm.count >= 2 { structure.insert("d:\(String(norm.prefix(40)))") }
            }

            // FULL non-class AX surface for the kssMZb oracle-diff (see collectFacts).
            collectFacts(el, into: &facts, stripName: lowName)

            let combined = [AX.string(el, "AXDescription"), AX.string(el, "AXValue"), AX.string(el, "AXTitle")]
                .compactMap { $0 }.joined(separator: " ")
            let text = combined.lowercased()
            if text.contains("microphone is off") || text.contains("mic is off")
                || text.contains("is muted") || (text.contains("muted") && !text.contains("unmuted")) {
                micOff = true
            }
            if isSpeakingMarker(combined) { markerSpeaking = true }
            for c in AX.children(el) { walk(c, depth + 1) }
        }
        walk(tile, 0)

        let roleCounts = roleCount.keys.sorted().map { "\($0):\(roleCount[$0]!)" }.joined(separator: "|")
        let classTokens = classes.sorted().joined(separator: ",")
        let structureTokens = structure.sorted().joined(separator: "\u{1f}")
        let stateFacts = facts.sorted().joined(separator: "\u{1f}")
        let hovered = classes.contains(where: isHoverChromeToken)
        let frame = AX.frame(tile) ?? .zero
        return TileFeatures(name: name, frame: frame, orderIndex: 0,
                            roleCounts: roleCounts, classTokens: classTokens,
                            descendantCount: count, focusedOrSelected: focusedOrSelected,
                            micOff: micOff, markerSpeaking: markerSpeaking,
                            structureTokens: structureTokens, hovered: hovered,
                            stateFacts: stateFacts)
    }

    /// All AXDOMClassList tokens across the whole web area (bounded). Used to hunt
    /// a speaking signal that lives OUTSIDE the video-tile subtrees (e.g. Zoom's
    /// audio-* classes in the footer / participants panel).
    static func allClassTokens(in webArea: AXUIElement) -> Set<String> {
        var toks = Set<String>()
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= 6000 || depth > 70 { return }
            n += 1
            for t in AX.classList(el) { toks.insert(t) }
            for c in AX.children(el) { rec(c, depth + 1) }
        }
        rec(webArea, 0)
        return toks
    }

    /// Targeted NEEDLE hunt across the FULL (enhanced) web-area tree: every element
    /// whose any text attribute contains one of `needles` (case-insensitive),
    /// reported as "role.attr=value". This hunts the EXACT string Recall's
    /// TeamsScraper matches for the speaking flag — `" is active speaker"` — which a
    /// blind class/attr diff can miss (it survived name-stripping/bucketing, or it's
    /// on an element outside the per-tile walk). Reads the full attribute-name list
    /// per node so an aria-label on any attribute is caught, not just desc/value/title.
    static func needleScan(in webArea: AXUIElement, needles: [String]) -> Set<String> {
        var hits = Set<String>()
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= 7000 || depth > 80 { return }
            n += 1
            let role = AX.string(el, "AXRole") ?? "?"
            for attr in AX.attributeNames(el) {
                guard let v = AX.valueString(el, attr), !v.isEmpty else { continue }
                let lv = v.lowercased()
                for needle in needles where lv.contains(needle) {
                    hits.insert("\(role).\(attr)=\(String(v.prefix(90)))")
                }
            }
            for c in AX.children(el) { rec(c, depth + 1) }
        }
        rec(webArea, 0)
        return hits
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
