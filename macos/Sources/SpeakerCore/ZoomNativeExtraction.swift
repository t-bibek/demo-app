import Foundation

/// PURE native-Zoom window extraction — the single implementation behind both
/// the live scanner (AX tree in) and the deterministic fixture replay (captured
/// AXSnapshot JSON in), so the harness exercises EXACTLY the shipping logic and
/// the two paths can never drift (the Teams `teamsExtractWindow` pattern).
///
/// Native Zoom's Metal grid exposes NO speaking signal (docs/zoom-native-
/// detection.md — verified live + against Recall's binary), so everything here
/// is participant STRUCTURE for the engine's mute-gated attribution:
///   P1 — combined roster LINES anywhere in the window: grid-tile overlays and
///        single-node panel rows read "<Name>[ (Host, me)], Computer audio
///        muted|unmuted[, active speaker]". The trailing ", active speaker" is
///        tolerated/stripped but NOTHING depends on it — it is Zoom's lazy
///        promoted-tile tag, not a live speech signal.
///   P2 — SPLIT panel rows: the Participants panel (docked or DETACHED into its
///        own window) renders each AXRow as an AXStaticText name ("David Thapa
///        (Host, me)") plus SIBLING AXImage status ("Computer audio unmuted") —
///        ax-dump 20260625-200432. The name and the mic state must be joined at
///        the ROW, and the bare status image must never leak as a "name".
///   P3 — the PIP thumbnail (subrole AXSystemDialog): no roster, but Zoom names
///        the current talker in a "Talking: <name>" static text (Zoom's own VAD).
///   P4 — the app-wide "(me)" self hint: the panel carrying "(me)" is often a
///        DIFFERENT window than the one the roster is read from.
/// `zoomFuseWindows` unions those surfaces per scan tick into ONE result, so a
/// layout that hides one pattern still resolves from the others, and multiple
/// Zoom windows can never double-attribute into the same `zoom::meeting`.

/// The platform-free AX node native-Zoom extraction consumes — same node the
/// Teams extractor reads (documented platform-free in TeamsTileExtraction.swift).
public typealias ZoomAXNode = TeamsAXNode

// MARK: Line parsers (each independently unit-tested)

private let zoomParenTagPattern = #"\s*\([^)]*\)"#

/// "<Name>[ (Host, me)], Computer audio muted|unmuted[, active speaker]" → entry.
/// The text BEFORE the audio-status clause must itself clean to a name — a
/// standalone status node ("Computer audio unmuted", the panel row's mic
/// AXImage) has nothing before the marker and is NOT a participant. This is the
/// guard that kills the phantom-roster-entry bug.
public func parseZoomRosterLine(_ raw: String, rules: ZoomSpeakerRules = .builtin) -> ZoomRosterEntry? {
    guard let marker = raw.range(of: rules.audioStatusMarker, options: .caseInsensitive) else { return nil }
    let head = String(raw[..<marker.lowerBound])
        .trimmingCharacters(in: CharacterSet(charactersIn: " ,\t"))
    guard !head.isEmpty else { return nil }
    // Strip a "(Host, me)" / "(Guest)" role tag, then let cleanParticipantName
    // reject control labels ("Join With" → stopword, toolbar chrome → rejects).
    let noParen = head.replacingOccurrences(
        of: zoomParenTagPattern, with: "", options: .regularExpression)
    guard let name = cleanParticipantName(noParen) else { return nil }
    let low = raw.lowercased()
    // Muted unless the line explicitly reads unmuted (unmuted wins — doc §8).
    return ZoomRosterEntry(name: name,
                           unmuted: rules.audioStatus(low) ?? false,
                           isMe: rules.isSelfMarker(low))
}

/// "<Name> (me)" / "(Host, me)" / "(Co-host, me)" → the local user's name.
public func parseZoomSelfLine(_ raw: String, rules: ZoomSpeakerRules = .builtin) -> String? {
    guard rules.isSelfMarker(raw.lowercased()) else { return nil }
    let noParen = raw.replacingOccurrences(
        of: zoomParenTagPattern, with: "", options: .regularExpression)
    return cleanParticipantName(noParen)
}

/// PIP static text "Talking: <name>" → name (Zoom's own VAD read; the ONE place
/// native Zoom names the current talker).
public func parseZoomPipTalking(_ raw: String, rules: ZoomSpeakerRules = .builtin) -> String? {
    guard let r = raw.range(of: rules.pipTalkingPrefix, options: .caseInsensitive) else { return nil }
    let after = String(raw[r.upperBound...]).trimmingCharacters(in: .whitespaces)
    guard !after.isEmpty else { return nil }
    return cleanParticipantName(after)
}

// MARK: Per-window extraction

/// Everything the fusion step needs from one Zoom window, in bounded walks that
/// mirror the live scanner budgets 1:1.
public struct ZoomWindowExtraction: Equatable, Sendable {
    /// Roster entries in reading/insertion order (deterministic — first sighting
    /// wins the mute read; `isMe` ORs across sightings of the same name).
    public var roster: [ZoomRosterEntry]
    /// First "(me)" line in THIS window (the panel may be a different window —
    /// fusion resolves across all of them).
    public var selfNameHint: String?
    /// Window title carries a meeting-title token ("Zoom Meeting" / "Meeting -").
    public var titleIsMeeting: Bool
    /// A Leave/End-Meeting button exists (vanishes post-call → meeting_ended).
    public var callActive: Bool
    /// This is the PIP thumbnail (subrole AXSystemDialog + PIP content markers).
    public var isPip: Bool
    /// PIP "Talking: <name>" read (nil when nobody talks); `pipNames` are the
    /// other static-text names shown (the speaker fallback is the first).
    public var pipSpeaker: String?
    public var pipNames: [String]

    public init(roster: [ZoomRosterEntry] = [], selfNameHint: String? = nil,
                titleIsMeeting: Bool = false, callActive: Bool = false,
                isPip: Bool = false, pipSpeaker: String? = nil, pipNames: [String] = []) {
        self.roster = roster
        self.selfNameHint = selfNameHint
        self.titleIsMeeting = titleIsMeeting
        self.callActive = callActive
        self.isPip = isPip
        self.pipSpeaker = pipSpeaker
        self.pipNames = pipNames
    }
}

public func zoomExtractWindow(_ root: ZoomAXNode,
                              rules: ZoomSpeakerRules = .builtin,
                              maxNodes: Int = 6000, maxDepth: Int = 80) -> ZoomWindowExtraction {
    // Insertion-ordered accumulator: first sighting wins the mute read (a tile
    // overlay and a panel row of the same participant agree within one tick);
    // isMe ORs; a P2 row without a status image stays `nil` → materialized as
    // muted (not gate-eligible) rather than guessed unmuted.
    struct Entry { var unmuted: Bool?; var isMe: Bool }
    var byName: [String: Entry] = [:]
    var order: [String] = []
    var selfName: String?
    var visited = 0

    func merge(name: String, unmuted: Bool?, isMe: Bool) {
        if var e = byName[name] {
            if e.unmuted == nil { e.unmuted = unmuted }
            e.isMe = e.isMe || isMe
            byName[name] = e
        } else {
            byName[name] = Entry(unmuted: unmuted, isMe: isMe)
            order.append(name)
        }
    }

    // P2 — one split panel row: join the AXStaticText name with the sibling
    // AXImage mic status. Names are taken from static text ONLY (the status /
    // "Video on" images carry state, not names).
    func collectPanelRow(_ row: ZoomAXNode) {
        var rowName: String?
        var rowIsMe = false
        var rowUnmuted: Bool?
        func rec(_ n: ZoomAXNode, _ d: Int) {
            if visited >= maxNodes || d > maxDepth { return }
            visited += 1
            for raw in [n.desc, n.value, n.title].compactMap({ $0 }) {
                let low = raw.lowercased()
                if rules.isSelfMarker(low) {
                    rowIsMe = true
                    if selfName == nil { selfName = parseZoomSelfLine(raw, rules: rules) }
                }
                if rowUnmuted == nil, low.contains(rules.audioStatusMarker) {
                    rowUnmuted = rules.audioStatus(low)
                }
            }
            if rowName == nil, n.role == "AXStaticText",
               let raw = n.value ?? n.title,
               raw.range(of: rules.audioStatusMarker, options: .caseInsensitive) == nil {
                let noParen = raw.replacingOccurrences(
                    of: zoomParenTagPattern, with: "", options: .regularExpression)
                rowName = cleanParticipantName(noParen)
            }
            for c in n.children { rec(c, d + 1) }
        }
        rec(row, 0)
        if let name = rowName { merge(name: name, unmuted: rowUnmuted, isMe: rowIsMe) }
    }

    func collectPanelRows(_ n: ZoomAXNode, _ d: Int) {
        if visited >= maxNodes || d > maxDepth { return }
        if n.role == "AXRow" { collectPanelRow(n); return }
        for c in n.children { collectPanelRows(c, d + 1) }
    }

    // Pass A — roster lines (P1) + split panel rows (P2) + self hint (P4).
    func walkRoster(_ n: ZoomAXNode, _ depth: Int) {
        if visited >= maxNodes || depth > maxDepth { return }
        visited += 1
        // P2 container: the Participants outline/list. Rows are joined here;
        // the normal walk still descends (bounded — combined-line rows and the
        // "(me)" hint ride the same subtree).
        if let role = n.role, role == "AXOutline" || role == "AXList" {
            let label = ((n.desc ?? "") + " " + (n.title ?? "")).lowercased()
            if label.contains(rules.participantsPanelToken) {
                for c in n.children { collectPanelRows(c, depth + 1) }
            }
        }
        for raw in [n.desc, n.value, n.title].compactMap({ $0 }) {
            if selfName == nil, let s = parseZoomSelfLine(raw, rules: rules) { selfName = s }
            if let e = parseZoomRosterLine(raw, rules: rules) {
                merge(name: e.name, unmuted: e.unmuted, isMe: e.isMe)
                break
            }
        }
        for c in n.children { walkRoster(c, depth + 1) }
    }
    walkRoster(root, 0)

    // Pass B — in-call gate: a Leave/End-Meeting button (early exit, own budget
    // like the live walk it replaces).
    var callActive = false
    var bVisited = 0
    func walkCall(_ n: ZoomAXNode, _ d: Int) {
        if callActive || bVisited >= maxNodes || d > maxDepth { return }
        bVisited += 1
        if n.role == "AXButton" {
            let label = ((n.title ?? "") + " " + (n.desc ?? "")).lowercased()
            if rules.isLeaveLabel(label) { callActive = true; return }
        }
        for c in n.children { walkCall(c, d + 1); if callActive { return } }
    }
    walkCall(root, 0)

    // Pass C — PIP detection: floating AXSystemDialog window whose subtree
    // carries a PIP content marker (title is EMPTY when collapsed — never key
    // on it). Bounds match the live check (800 nodes / depth 20).
    var isPip = false
    if root.subrole == "AXSystemDialog" {
        var cVisited = 0
        func walkPip(_ n: ZoomAXNode, _ d: Int) {
            if isPip || cVisited >= 800 || d > 20 { return }
            cVisited += 1
            for raw in [n.value, n.desc, n.help].compactMap({ $0 }) {
                if rules.hasPipMarker(raw.lowercased()) { isPip = true; return }
            }
            for c in n.children { walkPip(c, d + 1); if isPip { return } }
        }
        walkPip(root, 0)
    }

    // Pass D — PIP content: the "Talking: <name>" note + shown names. Static
    // text only, so the "Show video render" button doesn't leak in.
    var pipSpeaker: String?
    var pipNames: [String] = []
    if isPip {
        var seen = Set<String>()
        var dVisited = 0
        func walkPipContent(_ n: ZoomAXNode, _ d: Int) {
            if dVisited >= 800 || d > 20 { return }
            dVisited += 1
            if n.role == "AXStaticText", let raw = n.value ?? n.title, !raw.isEmpty {
                if let talker = parseZoomPipTalking(raw, rules: rules) {
                    pipSpeaker = talker
                } else if raw.range(of: rules.pipTalkingPrefix, options: .caseInsensitive) == nil,
                          let clean = cleanParticipantName(raw), seen.insert(clean).inserted {
                    pipNames.append(clean)
                }
            }
            for c in n.children { walkPipContent(c, d + 1) }
        }
        walkPipContent(root, 0)
        // Nobody talking but a name label shown → that's who the PIP tracks.
        if pipSpeaker == nil { pipSpeaker = pipNames.first }
    }

    let roster = order.map { name -> ZoomRosterEntry in
        let e = byName[name]!
        return ZoomRosterEntry(name: name, unmuted: e.unmuted ?? false, isMe: e.isMe)
    }
    return ZoomWindowExtraction(
        roster: roster, selfNameHint: selfName,
        titleIsMeeting: rules.isMeetingTitle((root.title ?? "").lowercased()),
        callActive: callActive, isPip: isPip,
        pipSpeaker: pipSpeaker, pipNames: pipNames)
}

// MARK: App-level fusion

/// One fused result per Zoom app per scan tick — the fix for per-window double
/// attribution (a detached panel / PIP used to emit its OWN ScannedWindow into
/// the same `zoom::meeting` and pulse conflicting speakers against the same
/// audio).
public struct ZoomAppFusion: Equatable, Sendable {
    /// Some window evidences an active call (title / Leave button / roster /
    /// PIP). False for the Zoom Workplace home shell → nothing is emitted.
    public var inMeeting: Bool
    /// Index (into the input array) of the window that carries the meeting —
    /// the one the scanner emits as the single ScannedWindow.
    public var carrierIndex: Int?
    /// Union roster across all windows: window order, first sighting wins the
    /// mute read, isMe ORs, self resolved app-wide.
    public var roster: [ZoomRosterEntry]
    /// The resolved local-user name (roster "(me)" row, any window).
    public var selfName: String?
    /// PIP "Talking:" read — surfaced ONLY when no roster was readable, so the
    /// engine's ladder stays: full roster → PIP note → audio-only "Someone".
    public var pipSpeaker: String?
    public var pipNames: [String]

    public init(inMeeting: Bool = false, carrierIndex: Int? = nil,
                roster: [ZoomRosterEntry] = [], selfName: String? = nil,
                pipSpeaker: String? = nil, pipNames: [String] = []) {
        self.inMeeting = inMeeting
        self.carrierIndex = carrierIndex
        self.roster = roster
        self.selfName = selfName
        self.pipSpeaker = pipSpeaker
        self.pipNames = pipNames
    }
}

/// Fuses per-window extractions for ONE Zoom app. `selfHint` is an external
/// self-name signal when no window carried "(me)" this tick (kept for parity
/// with the old app-wide pre-pass; normally the panel window supplies it).
public func zoomFuseWindows(_ windows: [ZoomWindowExtraction],
                            selfHint: String? = nil,
                            rules: ZoomSpeakerRules = .builtin) -> ZoomAppFusion {
    // Roster union in window order: the main meeting window is enumerated
    // before the detached panel, and both read the SAME live state, so
    // first-wins is a tie-break, not a data loss. isMe ORs so the panel's
    // "(me)" row upgrades a tile-overlay entry.
    var byName: [String: ZoomRosterEntry] = [:]
    var order: [String] = []
    for w in windows {
        for e in w.roster {
            if var existing = byName[e.name] {
                existing.isMe = existing.isMe || e.isMe
                byName[e.name] = existing
            } else {
                byName[e.name] = e
                order.append(e.name)
            }
        }
    }

    // Self resolution (objective: self speech gets the real roster name, never
    // "You", and self is never counted as a remote): first per-window "(me)"
    // hit, else the external hint. Mark the matching entry; if the roster never
    // showed the name (panel closed, hint from elsewhere), append a synthetic
    // unmuted self entry — same semantics the old per-window read had.
    let resolvedSelf = windows.compactMap { $0.selfNameHint }.first ?? selfHint
    if let selfName = resolvedSelf {
        if var e = byName[selfName] {
            e.isMe = true
            byName[selfName] = e
        } else {
            byName[selfName] = ZoomRosterEntry(name: selfName, unmuted: true, isMe: true)
            order.append(selfName)
        }
    }

    // Carrier: the strongest meeting evidence wins — title/Leave button, else a
    // window that actually read a roster, else the PIP (minimal view is the
    // only window left). No carrier → the home shell / no call → emit nothing.
    let carrier = windows.firstIndex(where: { $0.titleIsMeeting || $0.callActive })
        ?? windows.firstIndex(where: { !$0.roster.isEmpty })
        ?? windows.firstIndex(where: { $0.isPip })

    // The extracted roster (pre-synthetic-self) decides whether the PIP note is
    // needed: with a readable roster the mute-gate is the better source.
    let extractedEmpty = windows.allSatisfy { $0.roster.isEmpty }
    let pipWindow = windows.first(where: { $0.isPip })
    let pipSpeaker = extractedEmpty ? pipWindow?.pipSpeaker : nil
    let pipNames = extractedEmpty ? (pipWindow?.pipNames ?? []) : []

    return ZoomAppFusion(
        inMeeting: carrier != nil,
        carrierIndex: carrier,
        roster: order.compactMap { byName[$0] },
        selfName: resolvedSelf,
        pipSpeaker: pipSpeaker,
        pipNames: pipNames)
}
