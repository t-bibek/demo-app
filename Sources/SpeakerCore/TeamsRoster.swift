import Foundation

/// Parses a Microsoft Teams People/Participants-panel ROW into (name, mute).
///
/// Discovered live (2026-06-23, `MeetProbe teams roster`): each roster row's
/// AXDescription/AXTitle reads `"<Name>, …role tags…, Muted|Unmuted"`, e.g.
///   "David Thapa (Guest), Has context menu, Meeting guest, Unmuted"
///   "Bibek Thapa, Has context menu, Organizer, Muted"
/// This is the ONLY reliable per-participant **remote** mute source in Teams AX —
/// the video tiles don't carry it dependably. It requires the Participants panel
/// to be OPEN (otherwise the rows aren't in the AX tree). Mirrors the Zoom-native
/// roster path (see ZoomNativeAttribution / zoomMuteGateSpeakers).
///
/// Returns nil when the text isn't a mute-bearing roster row.
public func parseTeamsRosterRow(_ raw: String) -> (name: String, unmuted: Bool)? {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty else { return nil }
    let low = s.lowercased()

    // Mute state — check "unmuted" FIRST ("unmuted" contains "muted").
    let unmuted: Bool
    if low.contains("unmuted") { unmuted = true }
    else if low.contains("muted") { unmuted = false }
    else { return nil }   // not a mute-bearing row (skip "Mute all", headers, etc.)

    // The name is everything before the first appended tag. Cut at the EARLIEST
    // tag separator we know Teams appends.
    let tagSeparators = [
        ", has context menu", ", has ", ", meeting guest", ", guest",
        ", organizer", ", co-organizer", ", presenter", ", attendee",
        ", muted", ", unmuted", ", in this meeting",
    ]
    var cut = s.endIndex
    for sep in tagSeparators {
        if let r = s.range(of: sep, options: .caseInsensitive), r.lowerBound < cut {
            cut = r.lowerBound
        }
    }
    var name = String(s[..<cut])
    // Strip a trailing role parenthetical: "David Thapa (Guest)" -> "David Thapa".
    name = name.replacingOccurrences(of: #"\s*\([^)]*\)\s*$"#, with: "", options: .regularExpression)
    name = name.trimmingCharacters(in: CharacterSet(charactersIn: " ,\u{2019}'"))

    // Reject standalone status icons ("Muted"/"Unmuted" with no name) and the
    // bulk-action / header rows ("Mute all", "In this meeting, 2 total…").
    guard !["muted", "unmuted", "mute", "unmute"].contains(name.lowercased()) else { return nil }
    guard isLikelyPersonName(name) else { return nil }
    return (name, unmuted)
}
