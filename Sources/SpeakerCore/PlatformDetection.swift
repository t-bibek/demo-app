import Foundation

/// Infers the meeting platform from a browser window/tab title. Title forms
/// seen on macOS (via `swift run AXDump`):
///   Google Meet: "Meet - xza-ddbx-ebn - ... - Google Chrome - <profile>"
///   Zoom web:    "<host>'s Zoom Meeting - ... - Google Chrome"
///   Teams web:   "... | Microsoft Teams"
public func platformForBrowserTitle(_ title: String) -> Platform? {
    let t = title.lowercased()
    // Most specific first so "Zoom Meeting" never matches Meet's "meeting".
    if t.contains("zoom") { return .zoom }
    if t.contains("microsoft teams") || t.contains("| teams") || t.contains("- teams") { return .teams }
    if t.contains("google meet") || t.contains("meet.google")
        || t.contains("meet - ") || t.contains("meet \u{2013} ") /* en-dash */ {
        return .meet
    }
    return nil
}

/// Infers the platform from a page URL — the most reliable signal, taken from
/// the browser's address-bar value when available.
public func platformForURL(_ url: String?) -> Platform? {
    guard let u = url?.lowercased() else { return nil }
    if u.contains("meet.google.com") { return .meet }
    if u.contains("zoom.us") { return .zoom }
    if u.contains("teams.microsoft.com") || u.contains("teams.live.com") { return .teams }
    return nil
}

/// Whether a platform exposes *who is speaking* in its macOS accessibility tree.
/// - Zoom web tags the active-speaker tile ("…, active speaker") in AXDescription.
/// - Google Meet adds an active-speaker CSS class (`kssMZb`, see MeetSpeakerRules)
///   to the speaking tile, readable via AXDOMClassList — verified cross-tile
///   (self + remote) and disambiguated from mute. Detected per-tile in the scanner.
/// - Teams: not yet verified — still audio-only "Someone".
public func platformExposesSpeakerNames(_ platform: Platform) -> Bool {
    switch platform {
    case .zoom:  return true
    case .meet:  return true
    case .teams: return false
    }
}
