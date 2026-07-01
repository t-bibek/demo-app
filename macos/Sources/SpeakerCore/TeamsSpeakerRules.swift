import Foundation

/// Microsoft Teams active-speaker / roster detection rules.
///
/// New Teams (`com.microsoft.teams2`) is a React/Chromium WebView app, so its DOM
/// is exposed to the macOS AX tree exactly like Google Meet — it behaves like a
/// web platform, NOT like native Zoom (Metal, opaque). See
/// docs/teams-active-speaker-detection.md.
///
/// Recall's binary keys its Teams scan on **stable Microsoft localization tokens**
/// (`aria_*` / `calling_*`), matched structurally — the opposite of Meet's
/// obfuscated, rotating `kssMZb`. Two confidence tiers:
///   • PROVEN (literal strings in the shipping binary): self = `calling_is_me_video`;
///     mute = `aria_calling_roster_muted` / `aria_calling_roster_unmuted`.
///   • OPAQUE (the exact is-speaking selector is compiled out): the indicator the
///     scan reads to mark a tile "is active speaker". We seed plausible text
///     markers; a Teams probe run pins the real handle.
///
/// Everything here is `Codable` + remote-config'able (`resolved()` loads an
/// override JSON), so a token change is a config drop, not an app release —
/// re-derive with a narrated `swift run MeetProbe teams` co-variance run.
public struct TeamsSpeakerRules: Codable, Sendable, Equatable {
    /// Substrings in a tile's AX text (AXDescription/AXValue/AXTitle) that mark it
    /// as the active speaker. OPAQUE — best-guess; verify with the probe.
    public var speakingTextMarkers: [String]
    /// AXDOMClassList / structural tokens that mark the active-speaker tile. Empty
    /// by default (the real token is unknown until the probe pins it).
    public var speakingClasses: [String]
    /// Tokens marking the LOCAL user's tile (self). PROVEN: `calling_is_me_video`;
    /// plus the visible "(you)" suffix Teams renders.
    public var selfTokens: [String]
    /// Tokens/substrings marking a MUTED participant. PROVEN: `aria_calling_roster_muted`.
    public var mutedTokens: [String]
    /// Tokens/substrings marking an UNMUTED participant. PROVEN: `aria_calling_roster_unmuted`.
    public var unmutedTokens: [String]
    /// Provenance (date or remote-config version).
    public var version: String

    public init(speakingTextMarkers: [String],
                speakingClasses: [String] = [],
                selfTokens: [String],
                mutedTokens: [String],
                unmutedTokens: [String],
                version: String) {
        self.speakingTextMarkers = speakingTextMarkers
        self.speakingClasses = speakingClasses
        self.selfTokens = selfTokens
        self.mutedTokens = mutedTokens
        self.unmutedTokens = unmutedTokens
        self.version = version
    }

    /// Built-in defaults. Self/mute tokens are PROVEN literal strings from
    /// Recall's `@recallai/desktop-sdk` v2.0.19 binary. The is-speaking determinant
    /// is NOT yet established — and deliberately conservative here:
    ///
    ///  - NO confirmed speaking class. `vdi-frame-occlusion` correlated with a
    ///    remote's speech in ONE camera-on run, but VDI frame-occlusion is a
    ///    video-rectangle PLACEMENT token — it likely tracks the video tile, not
    ///    the speaking state (the binary has no `aria_*_speaking` token, only
    ///    `roster_muted/unmuted`). Treating it as "speaking" was unproven, so it is
    ///    NOT shipped. Re-add via config only after the R4 probe confirms it tracks
    ///    the SPEAKER (not just any active video). See docs/teams-probe.md.
    ///  - Teams exposes no text speaking-marker on the video stage (the markers
    ///    below never fired live; kept only as a harmless secondary check). The
    ///    real determinant is opaque + LOCALIZED (binary: `TEAMS - determine
    ///    locale`), i.e. likely a localized aria-label, not a fixed class.
    ///  - OPEN QUESTION (R1/R3): a camera-INDEPENDENT signal may exist that we
    ///    have NOT ruled out — the People-panel per-row voice-level indicator, and
    ///    an aria-live announcement channel (`aria_announce_video_on` proves one
    ///    exists). Until probed, the engine uses VAD + mute-gate (proven), with
    ///    mic for self.
    ///
    /// All config-overridable (`teams-rules.json`).
    public static let builtin = TeamsSpeakerRules(
        speakingTextMarkers: ["is active speaker", "active speaker", "is speaking", ", speaking"],
        // Active-speaker className. `vdi-frame-occlusion` is the video-frame
        // occlusion token that tracked the speaking remote in camera-on runs —
        // enabled here as the "for now" class signal (mirrors the Windows engine's
        // TeamsSpeakingClass). The OLD obfuscated speaking-ring tokens tried
        // previously (from the `swift run MeetProbe teams` oracle-diff token set;
        // they ROTATE every Teams build, so re-derive with the probe before use):
        //   ___1vvhwjq, fn8mz29, f1ky4vpe, frwhdur, ftevtku, f1qyaz97, f14rmoke,
        //   fm03cl5, f3ve9t9
        // Also seen but rejected — `vdi-occlusion` / `vdi-dynamic-occlusion` sit on
        // EVERY video tile (not speaker-specific), so they'd mark everyone speaking.
        speakingClasses: ["vdi-frame-occlusion"],
        selfTokens: ["calling_is_me_video", "myself video", "(you)"],
        mutedTokens: ["aria_calling_roster_muted", ", muted"],
        unmutedTokens: ["aria_calling_roster_unmuted", ", unmuted"],
        version: "2026-07-01-vdi-frame-occlusion"
    )
}

extension TeamsSpeakerRules {
    /// Load a config'd override (so a token change is a config drop, not a
    /// release): reads `MeetSpeakerDetector/teams-rules.json` from Application
    /// Support; falls back to `builtin`. Mirrors `MeetSpeakerRules.resolved()`.
    public static func resolved() -> TeamsSpeakerRules {
        guard let url = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("MeetSpeakerDetector/teams-rules.json"),
            let data = try? Data(contentsOf: url),
            let rules = try? JSONDecoder().decode(TeamsSpeakerRules.self, from: data)
        else { return .builtin }
        return rules
    }

    /// True when a tile's collected AX text / class tokens mark it as speaking.
    /// `textBlob` is the lowercased concatenation of the tile subtree's AX text;
    /// `classTokens` is the union of its AXDOMClassList tokens.
    public func tileIsSpeaking(textBlob: String, classTokens: Set<String>) -> Bool {
        if speakingClasses.contains(where: { classTokens.contains($0) }) { return true }
        let l = textBlob.lowercased()
        return speakingTextMarkers.contains { !$0.isEmpty && l.contains($0.lowercased()) }
    }

    /// True when a tile's text/classes mark it as the local user's.
    public func tileIsSelf(textBlob: String, classTokens: Set<String>) -> Bool {
        if selfTokens.contains(where: { classTokens.contains($0) }) { return true }
        let l = textBlob.lowercased()
        return selfTokens.contains { !$0.isEmpty && l.contains($0.lowercased()) }
    }

    /// Mute read for a roster row's text/classes: true = unmuted, false = muted,
    /// nil = unknown (no mute token present).
    public func muteState(textBlob: String, classTokens: Set<String>) -> Bool? {
        let l = textBlob.lowercased()
        let isUnmuted = unmutedTokens.contains { !$0.isEmpty && (classTokens.contains($0) || l.contains($0.lowercased())) }
        if isUnmuted { return true }
        let isMuted = mutedTokens.contains { !$0.isEmpty && (classTokens.contains($0) || l.contains($0.lowercased())) }
        if isMuted { return false }
        return nil
    }
}
