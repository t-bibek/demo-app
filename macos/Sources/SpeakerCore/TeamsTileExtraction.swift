import Foundation

/// PURE Microsoft Teams window extraction — the single implementation behind
/// both the live scanner (AX tree in) and the deterministic fixture replay
/// (captured ax-dump JSON in), so the harness exercises EXACTLY the shipping
/// logic and the two paths can never drift. See
/// docs/teams-active-speaker-detection.md §7: Teams exposes NO who-is-speaking
/// signal, so everything here is participant STRUCTURE — names, self, mute,
/// geometry — for the engine's VAD + mute-gate resolution.

/// A platform-free AX node: what `AccessibilityScanner` reads live and what a
/// distilled ax-dump fixture decodes to. Codable so fixtures are plain JSON.
public struct TeamsAXNode: Codable, Sendable {
    public var role: String?
    public var subrole: String?
    public var desc: String?
    public var title: String?
    public var value: String?
    /// AXHelp — native Zoom's PIP thumbnail carries its content markers here.
    /// Optional + defaulted so existing distilled Teams fixtures decode unchanged.
    public var help: String?
    public var classes: [String]
    /// AXFrame as plain doubles (x, y, w, h) — keeps SpeakerCore AppKit-free.
    public var x: Double?
    public var y: Double?
    public var w: Double?
    public var h: Double?
    public var children: [TeamsAXNode]

    public init(role: String? = nil, subrole: String? = nil, desc: String? = nil,
                title: String? = nil, value: String? = nil, help: String? = nil,
                classes: [String] = [],
                x: Double? = nil, y: Double? = nil, w: Double? = nil, h: Double? = nil,
                children: [TeamsAXNode] = []) {
        self.role = role
        self.subrole = subrole
        self.desc = desc
        self.title = title
        self.value = value
        self.help = help
        self.classes = classes
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.children = children
    }

    var area: Double { max(0, (w ?? 0)) * max(0, (h ?? 0)) }
}

/// Everything the engine needs from one Teams window, in one walk.
public struct TeamsWindowExtraction: Equatable, Sendable {
    public var tiles: [TeamsTileObservation]
    /// People-panel roster rows (panel open only) — the reliable remote-mute
    /// source. Empty when the panel is closed. Reuses ZoomRosterEntry (same shape).
    public var roster: [ZoomRosterEntry]
    /// Union of tile + roster names, reading order.
    public var participants: [String]
    /// In-call gate: Leave button / "Shared content" main landmark / Attendees outline.
    public var callActive: Bool
    /// Teams' own "<name> is speaking" note (main + compact windows), nil when
    /// absent or "Nobody is speaking". A text note — NOT a CSS class.
    public var speakingNote: String?

    public init(tiles: [TeamsTileObservation] = [], roster: [ZoomRosterEntry] = [],
                participants: [String] = [], callActive: Bool = false,
                speakingNote: String? = nil) {
        self.tiles = tiles
        self.roster = roster
        self.participants = participants
        self.callActive = callActive
        self.speakingNote = speakingNote
    }
}

/// Extracts tiles + roster + call gate + speaking note from a Teams window tree.
///
/// MULTI-PATTERN STRUCTURAL FUSION (no CSS class, no geometry constants) — a
/// participant is admitted only on independent structural evidence, and the
/// evidence sources are UNIONED so a layout that drops one pattern still
/// resolves from the others:
///   P1 — the participant TILE row: an `AXMenuItem` whose description carries a
///        context-menu affordance ("Context menu is available" native tiles).
///        Every real tile has it; meeting-stage chrome / toasts / the home-tab
///        "Meeting link …, card" rows do not. The camera state ("video is on")
///        and mute (", muted") ride the same description WHEN PRESENT but are
///        NOT required — a camera-off remote reads just
///        "<Name> (Guest), muted, Context menu is available" (fixture
///        20260701-182800) and must still be admitted.
///   P2 — the SELF tile: any node whose text matches a self token — the
///        "Myself video, <Name>, …" description (an AXImage, NOT an AXMenuItem
///        — fixture-proven), a "(you)" suffix, or the `calling_is_me_video`
///        class. Merged by name with a P1 tile when Teams also shows self in
///        the gallery, so self is never double-counted or named as a remote.
///   P3 — the People-panel ROSTER rows, scoped to the panel container (the
///        "Attendees"/"Participants" outline/list) so tile rows can't
///        masquerade as panel rows. Grammar via `parseTeamsRosterRow`.
/// Name hygiene stays in `cleanParticipantName` (chrome/control labels → nil),
/// so a structural anchor with a junk label still extracts nothing.
/// The signed-in user's display name from the Teams profile button — the app
/// labels it "Profile picture of <Name>." (an AXImage inside the "Your profile"
/// button, present on the home window even mid-call). This is the SELF signal
/// for layouts that expose no "Myself video" tile and no "(you)" row — the
/// current build's solo-call Participants panel row is just
/// "Bibek Thapa, Organizer, Unmuted" (live-verified 2026-07-03). Mirrors
/// `zoomSelfNameHint`. Returns nil for any other label.
public func teamsSelfNameFromProfileLabel(_ raw: String) -> String? {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let r = s.range(of: "profile picture of ", options: .caseInsensitive) else { return nil }
    let base = String(s[r.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: " ."))
    return cleanParticipantName(base, structuralAnchor: true)
}

/// App-wide self-name hint: walk a window tree for the profile-picture label.
public func teamsSelfNameHint(_ root: TeamsAXNode, maxNodes: Int = 6000) -> String? {
    var found: String?
    var n = 0
    func rec(_ node: TeamsAXNode, _ depth: Int) {
        if found != nil || n >= maxNodes || depth > 80 { return }
        n += 1
        for s in [node.desc, node.title].compactMap({ $0 }) {
            if let name = teamsSelfNameFromProfileLabel(s) { found = name; return }
        }
        for c in node.children { rec(c, depth + 1) }
    }
    rec(root, 0)
    return found
}

public func teamsExtractWindow(_ root: TeamsAXNode,
                               rules: TeamsSpeakerRules = .builtin,
                               selfHint: String? = nil,
                               maxNodes: Int = 6000) -> TeamsWindowExtraction {
    // One accumulating pass; mirrors the bounded scanner walk.
    struct Acc {
        var area: Double
        var explicitUnmuted: Bool?   // an explicit mute/unmute token was read
        var isMe: Bool
        var speaking: Bool           // config-hook only: builtin rules never match (§7)
        var minY: Double
        var minX: Double
        var order: Int
    }
    var byName: [String: Acc] = [:]
    var order = 0
    var roster: [ZoomRosterEntry] = []
    var callActive = false
    var speakingNote: String?
    var visited = 0

    func nodeText(_ n: TeamsAXNode) -> String {
        [n.desc, n.title, n.value].compactMap { $0 }.joined(separator: " ")
    }

    func consider(name: String, node: TeamsAXNode, isMe: Bool, unmuted: Bool?, speaking: Bool) {
        let area = node.area
        if var ex = byName[name] {
            ex.isMe = ex.isMe || isMe
            ex.speaking = ex.speaking || speaking
            if ex.explicitUnmuted == nil { ex.explicitUnmuted = unmuted }
            if area > ex.area {
                ex.area = area
                ex.minY = node.y ?? ex.minY
                ex.minX = node.x ?? ex.minX
            }
            byName[name] = ex
        } else {
            byName[name] = Acc(area: area, explicitUnmuted: unmuted, isMe: isMe,
                               speaking: speaking, minY: node.y ?? 0, minX: node.x ?? 0,
                               order: order)
            order += 1
        }
    }

    /// P3 — roster rows, only inside the People/Attendees panel container.
    func collectRoster(_ n: TeamsAXNode, depth: Int) {
        if visited >= maxNodes || depth > 80 { return }
        visited += 1
        for raw in [n.desc, n.title, n.value].compactMap({ $0 }) {
            guard let row = parseTeamsRosterRow(raw) else { continue }
            if !roster.contains(where: { $0.name == row.name }) {
                roster.append(ZoomRosterEntry(name: row.name, unmuted: row.unmuted, isMe: false))
            }
            break
        }
        for c in n.children { collectRoster(c, depth: depth + 1) }
    }

    func walk(_ n: TeamsAXNode, depth: Int) {
        if visited >= maxNodes || depth > 80 { return }
        visited += 1
        let text = nodeText(n)
        let low = text.lowercased()

        // In-call gate (product parity; all three vanish post-call).
        if !callActive, let role = n.role {
            if role == "AXButton" {
                let label = ((n.title ?? "") + " " + (n.desc ?? "")).lowercased()
                if label.contains("leave") { callActive = true }
            }
            if role == "AXGroup", n.subrole == "AXLandmarkMain",
               (n.desc ?? "").lowercased().contains("shared content") { callActive = true }
            if role == "AXOutline", (n.desc ?? "").lowercased().contains("attendees") { callActive = true }
        }

        // Teams' own active-speaker note ("<name> is speaking" / "Nobody is speaking").
        if speakingNote == nil, let desc = n.desc {
            let l = desc.lowercased()
            if l.hasSuffix("is speaking"), !l.hasPrefix("nobody") {
                let base = String(desc.dropLast("is speaking".count))
                    .trimmingCharacters(in: CharacterSet(charactersIn: " ,"))
                if let clean = cleanParticipantName(base, structuralAnchor: true) { speakingNote = clean }
            }
        }

        // P3 — the People panel: an outline/list labeled attendees/participants/people.
        // Rows are parsed ONLY inside it, so tile descriptions (which also satisfy
        // the row grammar) can't masquerade as panel rows when the panel is closed.
        if let role = n.role, role == "AXOutline" || role == "AXList" || role == "AXGroup" {
            let label = ((n.desc ?? "") + " " + (n.title ?? ""))
                .lowercased().trimmingCharacters(in: .whitespaces)
            if label.contains("attendee") || label.contains("participant") || label == "people",
               !n.children.isEmpty {
                for c in n.children { collectRoster(c, depth: depth + 1) }
                // fall through — the subtree is walked again below for self/tile
                // patterns (bounded; panels are small).
            }
        }

        // P2 — self tile (any role; the live self tile is an AXImage). Uses the
        // config'd self tokens: "myself video", "(you)", calling_is_me_video.
        if rules.tileIsSelf(textBlob: low, classTokens: Set(n.classes)),
           let name = cleanParticipantName(text, structuralAnchor: true) {
            consider(name: name, node: n, isMe: true,
                     unmuted: rules.muteState(textBlob: low, classTokens: Set(n.classes)),
                     speaking: rules.tileIsSpeaking(textBlob: low, classTokens: Set(n.classes)))
        }
        // P1 — participant tile row: AXMenuItem + context-menu affordance. The
        // video/mute markers are corroborating, NOT required (camera-off tiles
        // drop "video is"; unmuted tiles drop the mic word entirely).
        else if n.role == "AXMenuItem", let desc = n.desc,
                desc.lowercased().contains("context menu"),
                let name = cleanParticipantName(desc, structuralAnchor: true) {
            let l = desc.lowercased()
            consider(name: name, node: n,
                     isMe: rules.tileIsSelf(textBlob: l, classTokens: Set(n.classes)),
                     unmuted: rules.muteState(textBlob: l, classTokens: Set(n.classes)),
                     speaking: rules.tileIsSpeaking(textBlob: l, classTokens: Set(n.classes)))
        }

        for c in n.children { walk(c, depth: depth + 1) }
    }
    walk(root, depth: 0)

    // Self resolution, fused across independent signals:
    //  1. a structural self tile (P2 / a self-token P1 row) wins;
    //  2. else the app-wide profile-label HINT (`teamsSelfNameHint`) flags the
    //     matching tile/row (readable only while the home window's tree is live —
    //     WebView2 throttles it when occluded);
    //  3. else SOLO-ATTENDEE inference: this is an IN-CALL window of THIS client
    //     (callActive), so the local user IS in the meeting — a panel showing
    //     exactly one attendee with no stage tiles can only be showing them.
    //     Set logic, not a name heuristic; 2+ attendees stay honestly unflagged.
    var selfName = byName.first(where: { $0.value.isMe })?.key
    if selfName == nil, let hint = selfHint {
        if let hit = byName.keys.first(where: { $0.lowercased() == hint.lowercased() }) {
            byName[hit]!.isMe = true
            selfName = hit
        } else if let row = roster.first(where: { $0.name.lowercased() == hint.lowercased() }) {
            selfName = row.name
        }
    }
    if selfName == nil, callActive, byName.isEmpty, roster.count == 1 {
        selfName = roster[0].name
    }
    if let selfName {
        roster = roster.map { e in
            var e = e
            if e.name == selfName { e.isMe = true }
            return e
        }
    }

    // Reading order (top-left first), then materialize. A real participant tile
    // with NO explicit mute token is UNMUTED — Teams omits the mic word for
    // unmuted tiles/rows (web-verified 2026-06-23; native fixture 20260701-180520).
    let ordered = byName.sorted {
        ($0.value.minY, $0.value.minX, $0.value.order) < ($1.value.minY, $1.value.minX, $1.value.order)
    }
    let tiles = ordered.enumerated().map { i, kv in
        TeamsTileObservation(name: kv.key, area: kv.value.area, orderIndex: i,
                             isSpeaking: kv.value.speaking, isMe: kv.value.isMe,
                             unmuted: kv.value.explicitUnmuted ?? true)
    }
    // Participants: tiles + roster UNIONED (fusion) — the roster covers tiles a
    // layout hides (e.g. gallery overflow), tiles cover a closed panel.
    var participants = ordered.map { $0.key }
    for e in roster where !participants.contains(e.name) { participants.append(e.name) }

    return TeamsWindowExtraction(tiles: tiles, roster: roster,
                                 participants: participants,
                                 callActive: callActive, speakingNote: speakingNote)
}
