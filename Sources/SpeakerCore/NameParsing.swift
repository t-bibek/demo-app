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
    ", more options", ", pinned",
]

/// Extracts a clean participant name from a raw accessibility string, or nil if
/// the string isn't a plausible person name.
public func cleanParticipantName(_ raw: String) -> String? {
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

    // Cut at the earliest decoration clause.
    var cut = s.endIndex
    for sep in nameCutSeparators {
        if let r = s.range(of: sep, options: .caseInsensitive), r.lowerBound < cut {
            cut = r.lowerBound
        }
    }
    s = String(s[..<cut])
    s = s.trimmingCharacters(in: CharacterSet(charactersIn: " ,\u{2019}'"))

    return isLikelyPersonName(s) ? s : nil
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
public func isLikelyPersonName(_ s: String) -> Bool {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard t.count >= 2, t.count <= 50 else { return false }
    let lower = t.lowercased()

    let rejectExact: Set<String> = [
        "mute", "unmute", "camera", "share", "chat", "participants", "leave",
        "join", "settings", "more", "reactions", "raise", "stop", "start",
        "video", "audio", "view", "present", "record", "menu", "close",
        "minimize", "search", "send", "someone", "you", "host", "co-host",
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
    ]
    if rejectSubstrings.contains(where: { lower.contains($0) }) { return false }

    // Notifications/toasts (sentences), clock times, and Meet meeting codes
    // (e.g. "ryv-ppcs-qpb") are not participant names.
    if t.hasSuffix(".") { return false }
    if lower == "pm" || lower == "am" { return false }
    if t.range(of: #"^[a-z]{3}-[a-z]{3,4}-[a-z]{3}$"#, options: .regularExpression) != nil { return false }
    if t.range(of: #"^\d{1,2}:\d{2}"#, options: .regularExpression) != nil { return false }

    return t.rangeOfCharacter(from: .letters) != nil
}
