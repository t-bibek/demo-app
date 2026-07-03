import Foundation

/// Parses a Microsoft Teams People/Participants-panel ROW into (name, mute).
///
/// Discovered live (`MeetProbe teams roster`). The string form differs by client:
///   Native (com.microsoft.teams2): "<Name>, Has context menu, <role>, Muted|Unmuted"
///     "David Thapa (Guest), Has context menu, Meeting guest, Unmuted"
///   Web (teams.microsoft.com):     "<Name>, [muted,] Context menu is available"
///     muted:   "David Thapa (Guest), muted, Context menu is available"
///     UNMUTED: "David Thapa (Guest), Context menu is available"   ← no mic word!
///   Self video tile (both):        "Myself video, <Name>, Unmuted, Has context menu"
///
/// CRITICAL (2026-06-23 web run): the web client DROPS the mic descriptor entirely
/// when a remote is UNMUTED — mic state is announced only when muted. So a row is
/// identified by STRUCTURE (a context-menu affordance, or an explicit mic word),
/// NOT by the presence of a mute word, and an absent descriptor reads as UNMUTED
/// (the default). Requiring the word made us blind to exactly the unmuted speaker
/// the diarizer must name (it vanished from the roster → misread as "left").
///
/// This is the only reliable per-participant **remote** mute source in Teams AX —
/// video tiles don't carry it dependably — and needs the Participants panel OPEN
/// (rows aren't in the AX tree otherwise). Mirrors the Zoom-native roster path.
///
/// Returns nil when the text isn't a participant roster row.
public func parseTeamsRosterRow(_ raw: String) -> (name: String, unmuted: Bool)? {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty else { return nil }
    let low = s.lowercased()

    // A roster row is identified by structure: a context-menu affordance ("Has
    // context menu" / "Context menu is available") OR an explicit mic word — the
    // anchor that survives the unmuted case, where the mic descriptor is absent.
    // Without it, plain name labels and chrome would masquerade as rows.
    guard low.contains("context menu") || low.contains("muted") else { return nil }

    // Mute state — "unmuted" FIRST ("unmuted" contains "muted"); then "muted";
    // else (a roster row with no mic descriptor) = UNMUTED, the web default.
    let unmuted: Bool
    if low.contains("unmuted") { unmuted = true }
    else if low.contains("muted") { unmuted = false }
    else { unmuted = true }

    // Self tile reads "Myself video, <Name>, …" — drop that prefix first.
    var body = s
    for prefix in ["myself video, ", "my video, "] {
        if body.lowercased().hasPrefix(prefix) { body = String(body.dropFirst(prefix.count)); break }
    }

    // The name is everything before the first appended tag. Cut at the EARLIEST
    // tag separator Teams appends — including VIDEO/camera/share/status tags
    // (a camera-on row is "<Name> (Guest), video is on, Muted").
    let tagSeparators = [
        ", has context menu", ", context menu", ", has ", ", meeting guest", ", guest",
        ", organizer", ", co-organizer", ", presenter", ", attendee",
        ", video is on", ", video is off", ", video ", ", camera",
        ", sharing", ", presenting", ", screen", ", hand", ", raised",
        ", pinned", ", spotlight", ", muted", ", unmuted", ", in this meeting",
    ]
    var cut = body.endIndex
    for sep in tagSeparators {
        if let r = body.range(of: sep, options: .caseInsensitive), r.lowerBound < cut {
            cut = r.lowerBound
        }
    }
    var name = String(body[..<cut])
    // Strip role parentheticals anywhere: "David Thapa (Guest)" -> "David Thapa".
    name = name.replacingOccurrences(of: #"\s*\([^)]*\)"#, with: "", options: .regularExpression)
    name = name.trimmingCharacters(in: CharacterSet(charactersIn: " ,\u{2019}'"))

    // Reject standalone status icons ("Muted"/"Unmuted" with no name) and the
    // bulk-action / header rows ("Mute all", "In this meeting, 2 total…").
    guard !["muted", "unmuted", "mute", "unmute"].contains(name.lowercased()) else { return nil }
    // Anchored: the context-menu / mic-word guard above already proved this is a
    // participant row, so shouty display names (all-caps) are not rejected.
    guard isLikelyPersonName(name, structuralAnchor: true) else { return nil }
    return (name, unmuted)
}
