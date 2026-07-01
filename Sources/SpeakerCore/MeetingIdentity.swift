import Foundation

/// Derives a STABLE meeting id from a window's URL (preferred) or title.
///
/// The raw title is unsafe as a key: Google Meet prepends a `"(2) "` unread-count
/// prefix that flips mid-call, PWAs often have an empty title, and the browser
/// suffix / "Camera and microphone recording" clause change without the meeting
/// changing. So we key on the meeting CODE parsed from the URL when present, and
/// fall back to a normalized title otherwise.
public func meetingId(platform: Platform, url: String?, title: String) -> String {
    if let code = meetingCode(platform: platform, url: url), !code.isEmpty {
        return "\(platform.rawValue)::\(code)"
    }
    // The URL sometimes lacks the code (e.g. "meet.google.com" mid-navigation).
    // For Meet the code is ALSO in the title ("Meet - kkr-ytwy-yzg - …"), so pull
    // it from there rather than keying on the volatile full title — otherwise the
    // same call splits into two meeting ids.
    if platform == .meet,
       let r = title.lowercased().range(of: #"[a-z]{3}-[a-z]{3,4}-[a-z]{3}"#, options: .regularExpression) {
        return "meet::\(String(title.lowercased()[r]))"
    }
    return "\(platform.rawValue)::\(normalizedMeetingTitle(title))"
}

/// Deterministic per-participant id. AX exposes no real per-user id, so identity
/// is the normalized display name namespaced by the meeting. A genuine rename
/// therefore reads as leave+join — documented, and the best AX allows.
public func participantId(meetingId: String, name: String) -> String {
    let clean = cleanParticipantName(name)
        ?? name.trimmingCharacters(in: .whitespacesAndNewlines)
    return "\(meetingId)::\(clean.lowercased())"
}

/// Extracts the platform's meeting code from a page URL, e.g.
///   `meet.google.com/xza-ddbx-ebn`    -> `"xza-ddbx-ebn"`
///   `app.zoom.us/wc/89012345678/join` -> `"89012345678"`
///   `…/l/meetup-join/19:meeting_AbC…` -> `"19:meeting_AbC…"`
/// Returns nil when no code is present (caller falls back to the title).
public func meetingCode(platform: Platform, url: String?) -> String? {
    guard let u = url?.lowercased() else { return nil }
    switch platform {
    case .meet:
        // Meet codes are xxx-xxxx-xxx (3-4-3, sometimes 3-3-3) letters.
        if let r = u.range(of: #"[a-z]{3}-[a-z]{3,4}-[a-z]{3}"#, options: .regularExpression) {
            return String(u[r])
        }
        return nil
    case .zoom:
        // .../j/<digits> or /wc/<digits>/...
        if let r = u.range(of: #"/(?:j|wc)/(\d+)"#, options: .regularExpression),
           let d = u[r].range(of: #"\d+"#, options: .regularExpression) {
            return String(u[r][d])
        }
        return nil
    case .teams:
        if let r = u.range(of: #"meetup-join/[^/?#]+"#, options: .regularExpression) {
            return String(u[r]).replacingOccurrences(of: "meetup-join/", with: "")
        }
        return nil
    }
}

/// Strips the volatile chrome from a window title so two reads of the SAME call
/// produce the same key: the leading `"(2) "` unread-count prefix, the recording
/// clause, and the trailing browser-name segment.
public func normalizedMeetingTitle(_ title: String) -> String {
    var s = title.replacingOccurrences(of: #"^\(\d+\)\s*"#, with: "",
                                        options: .regularExpression)
    s = cutAtFirst(s, markers: [
        " - Camera and microphone recording",
        " - Microphone recording",
        " - Camera recording",
        " - Google Chrome", " - Chrome",
        " - Microsoft Edge", " - Microsoft\u{00A0}Edge",
        " - Brave", " - Vivaldi", " - Opera", " - Safari",
        " - Mozilla Firefox", " - Firefox",
    ])
    return s.trimmingCharacters(in: .whitespaces)
}

/// Truncates `s` at the earliest case-insensitive occurrence of any marker.
private func cutAtFirst(_ s: String, markers: [String]) -> String {
    var cut = s.endIndex
    for m in markers {
        if let r = s.range(of: m, options: .caseInsensitive), r.lowerBound < cut {
            cut = r.lowerBound
        }
    }
    return String(s[..<cut])
}
