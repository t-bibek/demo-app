import Foundation

/// One participant row read from native Zoom's Participants panel (AX): a name,
/// whether their mic is unmuted, and whether it's the local user ("(me)").
///
/// Native Zoom exposes the roster + per-participant mute in AX but NOT a speaking
/// signal — the video grid is Metal/GPU-rendered and opaque to Accessibility
/// (verified; see docs/zoom-native-detection.md, corroborated by Recall's binary
/// which ships AX speaking scanners for Meet/Teams but none for Zoom). So we
/// attribute the speaker by fusing audio activity with this mute state.
public struct ZoomRosterEntry: Equatable, Sendable {
    public var name: String
    public var unmuted: Bool
    public var isMe: Bool
    public init(name: String, unmuted: Bool, isMe: Bool) {
        self.name = name
        self.unmuted = unmuted
        self.isMe = isMe
    }
}

/// Mute-gated speaker attribution for native Zoom (B1) — there is no AX speaking
/// signal, so audio *direction* disambiguates who is talking:
///
///  - `micActive` (local microphone) + you're unmuted → YOU (your roster name).
///  - `remoteActive` (system / meeting audio = remote voices) + exactly ONE
///    remote participant unmuted → that participant by name; otherwise
///    `someoneLabel` (0 or 2+ unmuted remotes are ambiguous from a single mixed
///    stream — the same ceiling Recall's Desktop SDK hits).
///
/// Returns the names to pulse this tick (possibly empty). The local mic captures
/// only *your* voice; the system tap captures only *remote* voices — that split
/// is what lets a 1:1 where both stay unmuted still resolve correctly.
public func zoomMuteGateSpeakers(
    micActive: Bool,
    localUnmuted: Bool,
    localName: String,
    remoteActive: Bool,
    remoteUnmutedNames: [String],
    someoneLabel: String = "Someone"
) -> [String] {
    var out: [String] = []
    if micActive && localUnmuted {
        out.append(localName)
    }
    if remoteActive {
        out.append(remoteUnmutedNames.count == 1 ? remoteUnmutedNames[0] : someoneLabel)
    }
    return out
}
