import Foundation

/// Decorations meeting platforms append to a participant's accessible name.
/// Derived from real macOS accessibility trees (see `swift run AXDump`):
///   Zoom web tile:  "Bidheyak Thapa, Computer audio unmuted, active speaker"
///   Google Meet:    "Jane Doe’s video"
private let nameCutSeparators = [
    ", computer audio",      // Zoom web video tiles
    ", audio",
    ", active speaker",
    ", speaking",
    " is speaking",
    "’s video", "'s video",  // Google Meet tiles
    ", muted", ", unmuted",
    ", video on", ", video off",
    ", video is on", ", video is off", ", video is",   // Teams roster status
    ", more options", ", pinned",
    ", context menu",        // Teams: "<Name> (Guest), Context menu is available"
]

/// Extracts a clean participant name from a raw accessibility string, or nil if
/// the string isn't a plausible person name.
///
/// `structuralAnchor: true` = the CALLER already proved the string is a
/// participant row (a Teams AXMenuItem tile / roster row with a context-menu
/// affordance, a "Myself video" self tile). The ALL-CAPS token heuristic is
/// skipped then — it exists to reject un-anchored chrome (USD, FAQ, OFF), but
/// it also rejected real shouty display names ("BIDHEYAK THAPA", live-captured
/// fixture 20260701-180520). Every other filter (chrome labels, digits,
/// stopwords, sentences) still applies.
public func cleanParticipantName(_ raw: String, structuralAnchor: Bool = false) -> String? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { return nil }

    // "View <Name>'s profile" / "View <Name>’s profile" -> <Name>
    for apostrophe in ["'s profile", "’s profile"] {
        if let lo = s.range(of: "view ", options: .caseInsensitive),
           let hi = s.range(of: apostrophe, options: .caseInsensitive),
           lo.upperBound < hi.lowerBound {
            s = String(s[lo.upperBound..<hi.lowerBound])
            break
        }
    }

    // Teams self tile: "Myself video, <Name>, unmuted, …" -> drop the prefix so
    // the name resolves (self is detected separately via the "myself video" token).
    for prefix in ["myself video, ", "my video, "] {
        if s.lowercased().hasPrefix(prefix) { s = String(s.dropFirst(prefix.count)); break }
    }

    // Cut at the earliest decoration clause.
    var cut = s.endIndex
    for sep in nameCutSeparators {
        if let r = s.range(of: sep, options: .caseInsensitive), r.lowerBound < cut {
            cut = r.lowerBound
        }
    }
    s = String(s[..<cut])

    // Strip a trailing role/status parenthetical: "David Thapa (Guest)" ->
    // "David Thapa", "(You)" -> "" (then rejected). Mirrors the Zoom roster strip.
    s = s.replacingOccurrences(of: #"\s*\([^)]*\)\s*$"#, with: "", options: .regularExpression)
    s = s.trimmingCharacters(in: CharacterSet(charactersIn: " ,\u{2019}'"))

    return isLikelyPersonName(s, structuralAnchor: structuralAnchor) ? s : nil
}

/// True when `text` carries a "this tile/participant is speaking" marker.
public func isSpeakingMarker(_ text: String) -> Bool {
    let l = text.lowercased()
    return l.contains("active speaker")
        || l.contains("is speaking")
        || l.contains(", speaking")
        || l.contains("speaking,")
        || l.contains("voice level")
        || l.contains("is talking")
}

/// Cheap heuristic to reject UI chrome / window titles / URLs.
/// `structuralAnchor` — see `cleanParticipantName`; skips only the ALL-CAPS rule.
public func isLikelyPersonName(_ s: String, structuralAnchor: Bool = false) -> Bool {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard t.count >= 2, t.count <= 50 else { return false }
    // Structural junk (mirrors the product's isPlausibleName): real names never
    // contain braces/brackets/quotes/markup, pipes, bullets or dash separators —
    // rejects JSON blobs, API responses, and marketing/toast rows that leak in
    // (e.g. {"message":"Missing Authentication Token"}, "… · recurring monthly").
    if t.rangeOfCharacter(from: CharacterSet(charactersIn: "{}[]<>\"=|•·–—:")) != nil { return false }
    // Display names don't contain digits — rejects countdown/UI chrome like
    // "55 seconds left", "2 others", "Contributors 2", "Elapsed time 05:13".
    if t.rangeOfCharacter(from: .decimalDigits) != nil { return false }
    // A display name is at most a few words; long runs are sentences / toasts.
    let words = t.split(whereSeparator: { $0.isWhitespace })
    if words.count > 6 { return false }
    // Reject ALL-CAPS tokens of 3+ letters (USD, FAQ, OFF, VOIP…): labels, not
    // names — EXCEPT under a structural anchor, where shouty real display names
    // ("BIDHEYAK THAPA") are already proven to be participant rows.
    if !structuralAnchor {
        for w in words {
            let letters = String(w.filter { $0.isLetter })
            if letters.count >= 3, letters == letters.uppercased() { return false }
        }
    }
    let lower = t.lowercased()

    let rejectExact: Set<String> = [
        "mute", "unmute", "camera", "share", "chat", "participants", "leave",
        "join", "settings", "more", "reactions", "raise", "stop", "start",
        "video", "audio", "view", "present", "record", "menu", "close",
        "minimize", "search", "send", "someone", "you", "host", "co-host",
        // Zoom web toolbar labels that leak in as fake tiles:
        "react", "switch", "avatar", "end", "home", "apps", "notes", "whiteboard",
        // Google Meet panel / chrome labels that leak in as fake tiles:
        "people", "contributors", "in call",
        // Meet "Adjust view" LAYOUT-MENU option labels — leak TRANSIENTLY when the
        // layout panel is open during a window reflow (live-QA 2026-07-03). Exact-match
        // (never clips a real display name); the durable fix is fallback hysteresis so
        // the graceful fallback can't admit overlay labels mid-reflow.
        "auto", "tiled", "tiles", "sidebar",
        // Teams meeting-stage chrome that leaks in as fake tiles:
        "cancel", "nobody",
        // Browser/PWA chrome + Meet call-control buttons that leak as fake people
        // (seen as participant rows on the Meet PWA): "Reload", "Back", "Extensions"…
        "reload", "back", "forward", "refresh", "extensions", "extension",
        "lock", "bookmark", "bookmarks", "downloads", "history", "profile",
    ]
    if rejectExact.contains(lower) { return false }

    // Window chrome / browser / URL fragments + meeting CONTROL labels that are
    // never a person's name (Meet/Zoom toolbar buttons leak in as 2-word labels).
    let rejectSubstrings = [
        "meeting", "zoom", "teams", "google", "chrome", "safari", "edge",
        "http", "://", "search bar", "address", "microphone", "webcam",
        "joined", "left the",
        "share screen", "screen share", "sharing", "present", "everyone",
        "view all", "add people", "host control", "call control", "more option",
        "activities", "settings", "captions", "reaction",
        // Meet/browser call-control button phrases (leak as fake participant rows):
        "turn on", "turn off", "leave call", "leave now", "leave meeting",
        "raise hand", "lower hand", "more options", "show everyone",
        // Live-observed Meet leaks (2026-07-03, meeting kmw-reho-hxx / edj-mwje-adv):
        // the roster-row overflow "More actions" popup, the avatar overlay
        // "Camera is off", and the "Adjust view" layout control. INTERIM band-aid —
        // the durable fix is the structural allowlist (roster row / tile-with-mic).
        "more actions", "adjust view", "camera is off", "camera is on",
        "hide tiles", "without video",
        // Teams meeting-stage / pre-join chrome buttons & labels:
        "turn camera", "camera on", "camera off", "raise your", "your hand",
        "calling control", "join info", "copy join", "learn more", "passcode",
        "meeting compact", "meeting options", "people invited", "waiting in",
        "resize", "gallery", "top gallery", "pin ", "spotlight", "reframe",
        // Browser/PWA chrome phrases (seen leaking from non-meeting popups/tabs):
        "incognito", "new tab", "this tab", "site information", "cookies",
        "pretty-print", "bookmark", "address bar", "missing authentication",
        "reload", "extensions",
        // Meet toast / announcement banners (climb to a tile-sized ancestor and get
        // fabricated into fake speakers): "Background is now replaced",
        // "You're presenting", "… is no longer …", "… pinned". These words never
        // occur in a human display name, so a plain substring match is safe.
        "background", "replaced", "no longer", "presenting", "pinned",
        "is now on", "is now off", "recording", "transcription",
        // Zoom web control phrases:
        "companion", "my video", "you are", "permission", "ellipsis", "panel",
        // Zoom NATIVE toolbar / banner labels (leak in as fake participant rows):
        "options", "upgrade to", "my notes", "my audio", "stop video", "start video",
        // Zoom NATIVE Participants-panel SECTION HEADERS (an AXStaticText inside the
        // roster outline that isn't a person): "Waiting room", "In the meeting (2)",
        // "In this meeting". A waiting guest sits under the first; the header itself
        // must never become a participant.
        "waiting room", "in the meeting", "in this meeting",
        // Teams meeting-stage chrome (leak in as fake tiles — see docs/teams-probe.md):
        "share content", "shared content", "content view", "mute mic", "unmute mic",
        "encryption status", "calling indicator", "turn audio on", "elapsed time",
    ]
    if rejectSubstrings.contains(where: { lower.contains($0) }) { return false }

    // Multi-word UI labels (Meet/Google chrome, toasts) contain function words a
    // display name never has as a STANDALONE token. Reject on a whole-token match
    // — so "Erin Callahan" is NOT caught by "in" — or on a token that is itself a
    // meeting code ("Meet - stw-emif-czt").
    let stopwordTokens: Set<String> = [
        "and", "for", "with", "the", "you", "you're", "you\u{2019}re",
        "can't", "can\u{2019}t", "someone", "else", "people", "contributors",
        "notifications", "feature", "search", "continuously", "framed",
        "meet", "unmute",
        // Meet/Zoom control + chrome button labels that leak in as fake tiles
        // ("Enter Full Screen", "Show my screen anyway", "2 others",
        // "User profile picture"). Whole-token match, so real names are unaffected.
        "screen", "fullscreen", "picture", "profile", "others", "anyway",
    ]
    for tok in lower.split(whereSeparator: { " ,()".contains($0) }).map(String.init) {
        if stopwordTokens.contains(tok) { return false }
        if tok.range(of: #"^[a-z]{3}-[a-z]{3,4}-[a-z]{3}$"#, options: .regularExpression) != nil { return false }
    }

    // Notifications/toasts (sentences), clock times, and Meet meeting codes
    // (e.g. "ryv-ppcs-qpb") are not participant names.
    if t.hasSuffix(".") { return false }
    if lower == "pm" || lower == "am" { return false }
    if t.range(of: #"^[a-z]{3}-[a-z]{3,4}-[a-z]{3}$"#, options: .regularExpression) != nil { return false }
    if t.range(of: #"^\d{1,2}:\d{2}"#, options: .regularExpression) != nil { return false }

    return t.rangeOfCharacter(from: .letters) != nil
}
