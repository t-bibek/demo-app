import Foundation
import SpeakerCore

// A tiny, dependency-free check runner (mirrors the original engine:selftest).
// Exits non-zero on the first failure.

setbuf(stdout, nil)   // unbuffered so output survives a crash

var failures = 0
func check(_ cond: Bool, _ label: String) {
    if cond {
        print("  ok   - \(label)")
    } else {
        failures += 1
        print("  FAIL - \(label)")
    }
}

func equal<T: Equatable>(_ a: T, _ b: T, _ label: String) {
    check(a == b, "\(label) (got \(a), want \(b))")
}

print("SpeakerCore self-test")

// MARK: formatDuration
print("formatDuration:")
equal(formatDuration(0), "0.0s", "0ms")
equal(formatDuration(500), "0.5s", "500ms")
equal(formatDuration(12340), "12.3s", "12.34s")
equal(formatDuration(59960), "1m 00s", "59.96s rounds into minute path")
equal(formatDuration(60000), "1m 00s", "60s")
equal(formatDuration(90000), "1m 30s", "90s")
equal(formatDuration(119960), "2m 00s", "119.96s carries seconds")
equal(formatDuration(3599000), "59m 59s", "59m59s")

// MARK: SessionTracker
print("SessionTracker:")
do {
    var events: [TrackerEvent] = []
    let t = SessionTracker(opts: TrackerOptions(endSilenceMs: 2000, pulseWidthMs: 500)) { events.append($0) }

    t.pulse(.meet, "Alice", 1000)
    check(events.count == 1, "first pulse emits one event")
    if case let .start(p, n, s, _) = events.first {
        check(p == .meet && n == "Alice" && s == 1000, "start payload correct")
    } else { check(false, "first event is .start") }

    t.pulse(.meet, "Alice", 1400)
    t.pulse(.meet, "Alice", 1500)   // lastSeen = 1500, no new start
    let starts = events.filter { if case .start = $0 { return true }; return false }.count
    equal(starts, 1, "repeated pulses don't restart")

    t.update(1500 + 2001)           // silence > endSilenceMs closes it
    let ends = events.compactMap { e -> Int? in
        if case let .end(_, _, _, _, d, _) = e { return d }; return nil
    }
    equal(ends, [1000], "duration = lastSeen - start + pulseWidth")
    equal(t.activeCount, 0, "session closed")
}

do {
    var events: [TrackerEvent] = []
    let t = SessionTracker { events.append($0) }
    t.pulse(.zoom, "   ", 1000)
    equal(events.count, 0, "blank name ignored")

    t.pulse(.zoom, "A", 2000)
    t.pulse(.zoom, "A", 1000)       // out of order, must not move lastSeen back
    t.update(2000 + 2001)
    let d = events.compactMap { e -> Int? in
        if case let .end(_, _, _, _, dd, _) = e { return dd }; return nil
    }
    equal(d, [500], "lastSeen never moves backwards")
}

// MARK: NdjsonParser
print("NdjsonParser:")
do {
    var values: [Any] = []
    let p = NdjsonParser(onValue: { values.append($0) })
    p.push("{\"a\"")
    p.push(":1}\n{\"b")
    p.push("\":2}\r\n")
    equal(values.count, 2, "split chunks + CRLF parsed")
    equal((values[1] as? [String: Any])?["b"] as? Int, 2, "second object value")

    var bad: [String] = []
    let p2 = NdjsonParser(onValue: { _ in }, onBadLine: { line, _ in bad.append(line) })
    p2.push("not json\n")
    equal(bad, ["not json"], "bad line reported")

    var v3: [Any] = []
    let p3 = NdjsonParser(onValue: { v3.append($0) })
    p3.push("{\"x\":1}")            // no trailing newline
    equal(v3.count, 0, "no value before flush")
    p3.flush()
    equal(v3.count, 1, "flush emits trailing line")
}

// MARK: NameParsing (real macOS AX strings from `swift run AXDump`)
print("NameParsing:")
check(cleanParticipantName("Bidheyak Thapa, Computer audio unmuted, active speaker") == "Bidheyak Thapa", "zoom active-speaker tile -> clean name")
check(cleanParticipantName("Neymar Thapa, Computer audio muted") == "Neymar Thapa", "zoom muted tile -> clean name")
check(cleanParticipantName("View Bidheyak Thapa's profile") == "Bidheyak Thapa", "zoom profile button -> name")
check(cleanParticipantName("Jane Doe’s video") == "Jane Doe", "meet video tile -> name")
check(cleanParticipantName("Unmute") == nil, "control label rejected")
check(cleanParticipantName("Bidheyak Thapa's Zoom Meeting - Camera and microphone recording - Google Chrome") == nil, "window title rejected")
check(cleanParticipantName("Address and search bar") == nil, "browser chrome rejected")
check(cleanParticipantName("Share screen") == nil, "control label 'Share screen' rejected")
check(cleanParticipantName("Present now") == nil, "control label 'Present now' rejected")
check(cleanParticipantName("AI Companion") == nil, "zoom 'AI Companion' rejected")
check(cleanParticipantName("React") == nil, "zoom 'React' rejected")
check(cleanParticipantName("stop my video") == nil, "zoom 'stop my video' rejected")
check(cleanParticipantName("You are muted") == nil, "zoom 'You are muted' rejected")
check(cleanParticipantName("Audio options") == nil, "zoom native 'Audio options' rejected")
check(cleanParticipantName("Participants options") == nil, "zoom native 'Participants options' rejected")
check(cleanParticipantName("Mute my audio") == nil, "zoom native 'Mute my audio' rejected")
check(cleanParticipantName("Stop video") == nil, "zoom native 'Stop video' rejected")
check(cleanParticipantName("My notes off") == nil, "zoom native 'My notes off' rejected")
check(cleanParticipantName("Upgrade to Pro") == nil, "zoom native 'Upgrade to Pro' banner rejected")
// Meet screen-share / chrome button labels that were leaking in as fake tiles.
check(cleanParticipantName("Enter Full Screen") == nil, "meet 'Enter Full Screen' button rejected")
check(cleanParticipantName("Show my screen anyway") == nil, "meet 'Show my screen anyway' button rejected")
check(cleanParticipantName("2 others") == nil, "meet '2 others' overflow label rejected")
check(cleanParticipantName("User profile picture") == nil, "meet 'User profile picture' rejected")
check(cleanParticipantName("David's Iphone") == "David's Iphone", "zoom native phone participant still a name")
// Zoom NATIVE (us.zoom.xos) DOES expose the active speaker — verified live in an
// AXTabGroup description with 3 participants (ax-dumps/20260625-200432). The web
// format and native format are identical, so the same parse path attributes it.
check(cleanParticipantName("David's Iphone, Computer audio unmuted, active speaker") == "David's Iphone", "zoom NATIVE active-speaker tile -> name")
check(isSpeakingMarker("David's Iphone, Computer audio unmuted, active speaker"), "zoom NATIVE active-speaker marker -> speaking")
check(!isSpeakingMarker("David Thapa, Computer audio unmuted"), "zoom tile without marker -> not speaking")
// Google Meet UI chrome (People panel open) leaked in as fake speaking tiles:
check(cleanParticipantName("People") == nil, "meet 'People' panel label rejected")
check(cleanParticipantName("Contributors 2") == nil, "meet 'Contributors 2' rejected")
check(cleanParticipantName("In call") == nil, "meet 'In call' rejected")
check(cleanParticipantName("Search for people") == nil, "meet 'Search for people' rejected")
check(cleanParticipantName("Call feature notifications and actions") == nil, "meet feature-bar label rejected")
check(cleanParticipantName("You can't unmute someone else") == nil, "meet 'can't unmute' toast rejected")
check(cleanParticipantName("You’re continuously framed") == nil, "meet framing toast rejected")
check(cleanParticipantName("Meet - stw-emif-czt") == nil, "meet title + code rejected")
check(cleanParticipantName("(You)") == nil, "meet '(You)' label rejected")
check(cleanParticipantName("Erin Callahan") == "Erin Callahan", "name containing 'in call' substring still passes")
check(cleanParticipantName("Wedding Thapas") == "Wedding Thapas", "real name 'Wedding Thapas' still passes")
check(cleanParticipantName("An Nguyen") == "An Nguyen", "short given name 'An' not clipped")
check(cleanParticipantName("Bidheyak Thapa") == "Bidheyak Thapa", "real name still passes after control filters")
check(cleanParticipantName("Wedding thapas") == "Wedding thapas", "real name 'Wedding thapas' still passes")
check(isSpeakingMarker("Bidheyak Thapa, Computer audio unmuted, active speaker"), "active-speaker marker detected")
check(!isSpeakingMarker("Neymar Thapa, Computer audio muted"), "muted tile is not speaking")
// Microsoft Teams name formats (real AX strings from docs/teams-probe.md):
check(cleanParticipantName("Myself video, Bibek Thapa") == "Bibek Thapa", "teams self tile -> name (drop 'Myself video,')")
check(cleanParticipantName("Myself video, Bibek Thapa, unmuted, has context menu") == "Bibek Thapa", "teams self tile w/ mute clause -> name")
check(cleanParticipantName("David Thapa (Guest)") == "David Thapa", "teams '(Guest)' suffix stripped")
check(cleanParticipantName("David Thapa (Guest), muted, context menu is available") == "David Thapa", "teams remote tile w/ mute + context -> name")
check(cleanParticipantName("David Thapa (Guest), Context menu is available") == "David Thapa", "teams remote tile w/ context-menu only -> name")
check(cleanParticipantName("Share content") == nil, "teams 'Share content' chrome rejected")
check(cleanParticipantName("Shared content view") == nil, "teams 'Shared content view' chrome rejected")
check(cleanParticipantName("Mute mic") == nil, "teams 'Mute mic' chrome rejected")
check(cleanParticipantName("Mute mic (⇧ ⌘ M)") == nil, "teams 'Mute mic (shortcut)' chrome rejected")
check(cleanParticipantName("Encryption status") == nil, "teams 'Encryption status' chrome rejected")
check(cleanParticipantName("Calling indicators") == nil, "teams 'Calling indicators' chrome rejected")
check(cleanParticipantName("Elapsed time 05:13") == nil, "teams 'Elapsed time' chrome rejected")
check(cleanParticipantName("Turn audio on?") == nil, "teams 'Turn audio on?' dialog rejected")
check(cleanParticipantName("Cancel") == nil, "teams 'Cancel' button rejected")
check(cleanParticipantName("David's Iphone") == "David's Iphone", "trailing-paren strip leaves a no-paren name intact")

// MARK: Platform detection (real titles/URLs from `swift run AXDump`)
print("PlatformDetection:")
check(platformForBrowserTitle("Meet - xza-ddbx-ebn - Camera and microphone recording - Google Chrome - Bibek (Bibek922)") == .meet, "meet title prefix detected")
check(platformForBrowserTitle("(2) Meet - abc-defg-hij - Google Chrome") == .meet, "meet title with notification count")
check(platformForBrowserTitle("Bidheyak Thapa's Zoom Meeting - Google Chrome") == .zoom, "zoom title (not misread as meet)")
check(platformForBrowserTitle("Chat | Microsoft Teams") == .teams, "teams title")
check(platformForBrowserTitle("Installing Xcode - Claude - Google Chrome") == nil, "non-meeting tab ignored")
check(platformForURL("meet.google.com/xza-ddbx-ebn") == .meet, "meet url")
check(platformForURL("app.zoom.us/wc/123/join") == .zoom, "zoom url")
check(platformForURL(nil) == nil, "nil url")
check(platformExposesSpeakerNames(.zoom) == true, "zoom exposes speaker names")
check(platformExposesSpeakerNames(.meet) == true, "meet exposes speaker names (kssMZb via AXDOMClassList)")
check(platformExposesSpeakerNames(.teams) == false, "teams not yet verified -> audio-only")

// MARK: MeetSpeakerRules (STRICT kssMZb-only — self/hover cluster removed)
print("MeetSpeakerRules:")
check(meetTileIsSpeaking(classTokens: ["kssMZb", "OFfHfd", "urlhDe"]), "kssMZb (thumbnail speaker) -> speaking")
check(!meetTileIsSpeaking(classTokens: ["eT1oJ", "hk9qKe"]), "self/hover cluster -> NOT speaking (removed: lit on hover & for muted-silent self)")
check(!meetTileIsSpeaking(classTokens: ["FTMc0c", "OFfHfd", "urlhDe"]), "silent state -> not speaking")
check(!meetTileIsSpeaking(classTokens: []), "empty -> not speaking")
check(meetTileIsSpeaking(classTokens: ["xyz"], rules: MeetSpeakerRules(speakingClasses: ["xyz"], version: "test")), "custom remote-config ruleset works")

// MARK: Meet equalizer node rule (PROTOTYPE — fresh-capture 2026-07-03).
// A node is a SPEAKING equalizer iff it carries an anchor {DYfzY,IisKdb,QgSmzd}
// AND does NOT carry the silence class "gjg47c". Absence-of-gjg47c is the durable
// rule; the level tokens (OgVli/HX2H7/Oaajhc/wEsLMd) only corroborate. Fixtures are
// the REAL dumps from the finding.
print("Meet equalizer node rule:")
check(!meetNodeIsSpeakingEqualizer(classList: ["DYfzY", "cYKTje", "gjg47c"]),
      "SILENCE classlist (has gjg47c) -> not speaking")
check(meetNodeIsSpeakingEqualizer(classList: ["DYfzY", "cYKTje", "Oaajhc", "sxlEM"]),
      "GUEST speaking classlist (DYfzY anchor, no gjg47c) -> speaking")
check(meetNodeIsSpeakingEqualizer(classList: ["IisKdb", "GF8M7d", "HX2H7", "KUNJSe", "x9nQ6", "VeFZv"]),
      "HOST speaking classlist (IisKdb anchor, no gjg47c) -> speaking")
check(meetNodeIsSpeakingEqualizer(classList: ["QgSmzd", "wEsLMd"]),
      "QgSmzd anchor + overlap token, no gjg47c -> speaking")
check(!meetNodeIsSpeakingEqualizer(classList: ["oZRSLe"]),
      "non-equalizer classlist (no anchor) -> not speaking")
check(!meetNodeIsSpeakingEqualizer(classList: []),
      "empty classlist -> not speaking")
// Overridable via config (mirror the speakingClasses override test above).
check(meetNodeIsSpeakingEqualizer(classList: ["ZZanchor"],
        rules: MeetSpeakerRules(speakingClasses: ["kssMZb"],
            equalizerAnchorClasses: ["ZZanchor"], equalizerSilenceClass: "ZZsilent", version: "test")),
      "custom equalizer anchor works (no custom silence token -> speaking)")
check(!meetNodeIsSpeakingEqualizer(classList: ["ZZanchor", "ZZsilent"],
        rules: MeetSpeakerRules(speakingClasses: ["kssMZb"],
            equalizerAnchorClasses: ["ZZanchor"], equalizerSilenceClass: "ZZsilent", version: "test")),
      "custom equalizer silence token suppresses speaking")

// MARK: Zoom native mute-gate attribution (B1)
print("Zoom mute-gate:")
// 1:1, both unmuted, remote talking (system audio up, mic quiet) -> name the remote.
equal(zoomMuteGateSpeakers(micActive: false, localUnmuted: true, localName: "You",
        remoteActive: true, remoteUnmutedNames: ["Neymar junior"]),
      ["Neymar junior"], "remote talks (1:1 both unmuted) -> remote named")
// You talking (mic up, you unmuted), no remote audio -> name you by roster name.
equal(zoomMuteGateSpeakers(micActive: true, localUnmuted: true, localName: "Bibek Thapa",
        remoteActive: false, remoteUnmutedNames: ["Neymar junior"]),
      ["Bibek Thapa"], "you talk -> local named")
// Muted local + mic picks up echo -> not logged.
equal(zoomMuteGateSpeakers(micActive: true, localUnmuted: false, localName: "Bibek Thapa",
        remoteActive: false, remoteUnmutedNames: []),
      [], "muted local not logged on echo")
// 2+ remotes unmuted, remote audio -> ambiguous -> Someone.
equal(zoomMuteGateSpeakers(micActive: false, localUnmuted: true, localName: "You",
        remoteActive: true, remoteUnmutedNames: ["A", "B"]),
      ["Someone"], "2+ unmuted remotes -> Someone")
// Remote audio but nobody read as unmuted -> Someone (mute read lagged / panel partial).
equal(zoomMuteGateSpeakers(micActive: false, localUnmuted: true, localName: "You",
        remoteActive: true, remoteUnmutedNames: []),
      ["Someone"], "remote audio, none unmuted -> Someone")
// Silence -> nothing.
equal(zoomMuteGateSpeakers(micActive: false, localUnmuted: true, localName: "You",
        remoteActive: false, remoteUnmutedNames: ["A"]),
      [], "silence -> nothing")
// You + a single remote both audibly active -> both logged.
equal(zoomMuteGateSpeakers(micActive: true, localUnmuted: true, localName: "Bibek Thapa",
        remoteActive: true, remoteUnmutedNames: ["Neymar junior"]),
      ["Bibek Thapa", "Neymar junior"], "overlap -> both named")

// MARK: Meet fused active-speaker resolver (geometry + class + VAD gate)
print("Meet fused resolver:")
let mtGallery = [
    MeetTileObservation(name: "Alice", area: 10_000, orderIndex: 0, classSpeaking: false),
    MeetTileObservation(name: "Bob",   area: 10_000, orderIndex: 1, classSpeaking: false),
]
let mtClass = [
    MeetTileObservation(name: "Alice", area: 10_000, orderIndex: 0, classSpeaking: true),
    MeetTileObservation(name: "Bob",   area: 10_000, orderIndex: 1, classSpeaking: false),
]
let mtSpotlight = [
    MeetTileObservation(name: "Alice", area: 200_000, orderIndex: 0, classSpeaking: false),
    MeetTileObservation(name: "Bob",   area: 10_000,  orderIndex: 1, classSpeaking: false),
]
// 1) VAD gate closed -> nobody (kills stale-class false positives).
equal(meetActiveSpeaker(tiles: mtClass, prevAreas: [:], vadSpeechActive: false).names, [],
      "vad silent -> no speaker even with class match")
// 2) class match wins when speaking.
equal(meetActiveSpeaker(tiles: mtClass, prevAreas: [:], vadSpeechActive: true).names, ["Alice"],
      "class match -> name")
equal(meetActiveSpeaker(tiles: mtClass, prevAreas: [:], vadSpeechActive: true).via, .cssClass,
      "class match -> via cssClass")
// 3) no class, dominant tile -> geometry (survives a class rotation in speaker view).
equal(meetActiveSpeaker(tiles: mtSpotlight, prevAreas: [:], vadSpeechActive: true).names, ["Alice"],
      "no class, spotlight -> geometry name")
equal(meetActiveSpeaker(tiles: mtSpotlight, prevAreas: [:], vadSpeechActive: true).via, .geometry,
      "spotlight -> via geometry")
// 4) gallery (equal tiles), no class -> Someone floor (geometry must NOT guess).
equal(meetActiveSpeaker(tiles: mtGallery, prevAreas: [:], vadSpeechActive: true).names, ["Someone"],
      "gallery, no class -> Someone floor")
equal(meetActiveSpeaker(tiles: mtGallery, prevAreas: [:], vadSpeechActive: true).via, .someoneFloor,
      "gallery, no class -> via someoneFloor")
// 5) presentation active -> geometry SUPPRESSED (the big tile is the shared
//    screen, not the speaker). No class either -> Someone floor, not the screen.
equal(meetActiveSpeaker(tiles: mtSpotlight, prevAreas: [:], vadSpeechActive: true, presentationActive: true).names, ["Someone"],
      "presentation on -> geometry suppressed -> Someone floor")
equal(meetActiveSpeaker(tiles: mtSpotlight, prevAreas: [:], vadSpeechActive: true, presentationActive: true).via, .someoneFloor,
      "presentation on -> via someoneFloor (not geometry)")
// 5b) presentation on but a class names a tile -> class still wins (the speaker's
//     kssMZb is independent of the share; only geometry is unsafe under share).
equal(meetActiveSpeaker(tiles: mtClass, prevAreas: [:], vadSpeechActive: true, presentationActive: true).names, ["Alice"],
      "presentation on + class match -> class still names the speaker")

// 6) AXFocused promoted-tile signal (live-verified 2026-07-03: Meet marks the
//    spotlit tile with AXFocused). Cleaner than the geometry ratio.
let mtFocused = [
    MeetTileObservation(name: "Alice", area: 10_000, orderIndex: 0, classSpeaking: false, isFocused: true),
    MeetTileObservation(name: "Bob",   area: 10_000, orderIndex: 1, classSpeaking: false, isFocused: false),
]
equal(meetActiveSpeaker(tiles: mtFocused, prevAreas: [:], vadSpeechActive: true).names, ["Alice"],
      "AXFocused tile -> named (equal geometry, no ring)")
equal(meetActiveSpeaker(tiles: mtFocused, prevAreas: [:], vadSpeechActive: true).via, .focused,
      "AXFocused tile -> via .focused")
// kssMZb ring beats AXFocused (ring is the active-speaker signal; focus may be a pin)
let mtRingVsFocus = [
    MeetTileObservation(name: "Alice", area: 10_000, orderIndex: 0, classSpeaking: false, isFocused: true),
    MeetTileObservation(name: "Bob",   area: 10_000, orderIndex: 1, classSpeaking: true,  isFocused: false),
]
equal(meetActiveSpeaker(tiles: mtRingVsFocus, prevAreas: [:], vadSpeechActive: true).names, ["Bob"],
      "kssMZb ring beats AXFocused")
// AXFocused on the SELF tile is NOT named (self is mic-driven)
let mtFocusSelf = [
    MeetTileObservation(name: "Me",  area: 10_000, orderIndex: 0, classSpeaking: false, isFocused: true, isMe: true),
    MeetTileObservation(name: "Bob", area: 10_000, orderIndex: 1, classSpeaking: false, isFocused: false),
]
equal(meetActiveSpeaker(tiles: mtFocusSelf, prevAreas: [:], vadSpeechActive: true).names, ["Someone"],
      "AXFocused on SELF -> not named (falls to Someone floor)")
// presentation suppresses AXFocused too (the shared screen is the focused surface)
equal(meetActiveSpeaker(tiles: mtFocused, prevAreas: [:], vadSpeechActive: true, presentationActive: true).via, .someoneFloor,
      "presentation on -> AXFocused suppressed -> Someone floor")

// 7) SELF-EXCLUSION on the ring path (adversarial-review find 2026-07-03). The
//    ring (kssMZb) is empirically never on the self tile, but the resolver must
//    not DEPEND on that: a self ring (or a remote-config rule matching a self
//    class) must never name the local user — self is mic-attributed separately,
//    exactly like the focused/geometry paths. Regression guard: before the fix
//    the ring filter lacked `!isMe` and this returned ["Me"].
let mtRingSelfOnly = [
    MeetTileObservation(name: "Me",  area: 10_000, orderIndex: 0, classSpeaking: true, isMe: true),
    MeetTileObservation(name: "Bob", area: 10_000, orderIndex: 1, classSpeaking: false),
]
equal(meetActiveSpeaker(tiles: mtRingSelfOnly, prevAreas: [:], vadSpeechActive: true).names, ["Someone"],
      "ring on SELF only -> not named (falls to Someone floor)")
equal(meetActiveSpeaker(tiles: mtRingSelfOnly, prevAreas: [:], vadSpeechActive: true).via, .someoneFloor,
      "ring on SELF only -> via someoneFloor (self is mic-attributed)")
// Overlap-safe: self ring + remote ring -> only the REMOTE is named.
let mtRingSelfPlusRemote = [
    MeetTileObservation(name: "Me",    area: 10_000, orderIndex: 0, classSpeaking: true, isMe: true),
    MeetTileObservation(name: "Alice", area: 10_000, orderIndex: 1, classSpeaking: true),
]
equal(meetActiveSpeaker(tiles: mtRingSelfPlusRemote, prevAreas: [:], vadSpeechActive: true).names, ["Alice"],
      "ring on self + remote -> only remote named (self excluded)")

// 8) Concurrent ring speakers (overlap) -> ALL non-self ring tiles named. Guards
//    the set-return at line 111 (every prior fixture had exactly one ring tile).
let mtRingOverlap = [
    MeetTileObservation(name: "Alice", area: 10_000, orderIndex: 0, classSpeaking: true),
    MeetTileObservation(name: "Carol", area: 10_000, orderIndex: 1, classSpeaking: true),
    MeetTileObservation(name: "Bob",   area: 10_000, orderIndex: 2, classSpeaking: false),
]
equal(meetActiveSpeaker(tiles: mtRingOverlap, prevAreas: [:], vadSpeechActive: true).names.sorted(), ["Alice", "Carol"],
      "concurrent rings -> both remotes named (overlap)")

// 9) Geometry promote is a RATIO threshold (>= 1.5x the next tile). Assert BOTH
//    sides of the boundary so a Meet tile-sizing change can't silently slip past.
let mtGeomBelow = [   // 1.49x -> NOT dominant -> Someone floor
    MeetTileObservation(name: "Alice", area: 14_900, orderIndex: 0, classSpeaking: false),
    MeetTileObservation(name: "Bob",   area: 10_000, orderIndex: 1, classSpeaking: false),
]
equal(meetActiveSpeaker(tiles: mtGeomBelow, prevAreas: [:], vadSpeechActive: true).names, ["Someone"],
      "geometry 1.49x (below 1.5x) -> not promoted -> Someone floor")
let mtGeomAt = [      // exactly 1.5x -> promoted
    MeetTileObservation(name: "Alice", area: 15_000, orderIndex: 0, classSpeaking: false),
    MeetTileObservation(name: "Bob",   area: 10_000, orderIndex: 1, classSpeaking: false),
]
equal(meetActiveSpeaker(tiles: mtGeomAt, prevAreas: [:], vadSpeechActive: true).names, ["Alice"],
      "geometry exactly 1.5x -> promoted")
equal(meetActiveSpeaker(tiles: mtGeomAt, prevAreas: [:], vadSpeechActive: true).via, .geometry,
      "geometry 1.5x -> via geometry")

// 10) A big PINNED self tile is not evidence you're speaking: geometry skips self.
let mtSelfDominant = [
    MeetTileObservation(name: "Me",  area: 200_000, orderIndex: 0, classSpeaking: false, isMe: true),
    MeetTileObservation(name: "Bob", area: 10_000,  orderIndex: 1, classSpeaking: false),
]
equal(meetActiveSpeaker(tiles: mtSelfDominant, prevAreas: [:], vadSpeechActive: true).names, ["Someone"],
      "self is the dominant tile -> geometry skips self -> Someone floor")

// 11) PROTOTYPE equalizer path (fresh-capture 2026-07-03). Runs right after the VAD
//     gate, BEFORE the kssMZb ring — the equalizer level class is a DIRECT
//     per-utterance read; kssMZb is layout/sticky. Overlap-capable; excludes self.
// 11a) non-self tile w/ equalizerSpeaking + VAD on -> named via .equalizer.
let mtEq = [
    MeetTileObservation(name: "Alice", area: 10_000, orderIndex: 0, classSpeaking: false, equalizerSpeaking: true),
    MeetTileObservation(name: "Bob",   area: 10_000, orderIndex: 1, classSpeaking: false, equalizerSpeaking: false),
]
equal(meetActiveSpeaker(tiles: mtEq, prevAreas: [:], vadSpeechActive: true).names, ["Alice"],
      "equalizer speaking tile -> named")
equal(meetActiveSpeaker(tiles: mtEq, prevAreas: [:], vadSpeechActive: true).via, .equalizer,
      "equalizer speaking tile -> via .equalizer")
// VAD gate still governs: silence -> nobody, even with a live equalizer read.
equal(meetActiveSpeaker(tiles: mtEq, prevAreas: [:], vadSpeechActive: false).names, [],
      "vad silent -> no speaker even with equalizerSpeaking")
// 11b) equalizer on the SELF tile is NOT named (self is mic-attributed).
let mtEqSelf = [
    MeetTileObservation(name: "Me",  area: 10_000, orderIndex: 0, classSpeaking: false, isMe: true, equalizerSpeaking: true),
    MeetTileObservation(name: "Bob", area: 10_000, orderIndex: 1, classSpeaking: false, equalizerSpeaking: false),
]
equal(meetActiveSpeaker(tiles: mtEqSelf, prevAreas: [:], vadSpeechActive: true).names, ["Someone"],
      "equalizer on SELF only -> not named (falls through to Someone floor)")
equal(meetActiveSpeaker(tiles: mtEqSelf, prevAreas: [:], vadSpeechActive: true).via, .someoneFloor,
      "equalizer on SELF only -> via someoneFloor (self is mic-attributed)")
// 11c) two non-self tiles w/ equalizerSpeaking -> BOTH named (overlap).
let mtEqOverlap = [
    MeetTileObservation(name: "Alice", area: 10_000, orderIndex: 0, classSpeaking: false, equalizerSpeaking: true),
    MeetTileObservation(name: "Carol", area: 10_000, orderIndex: 1, classSpeaking: false, equalizerSpeaking: true),
    MeetTileObservation(name: "Bob",   area: 10_000, orderIndex: 2, classSpeaking: false, equalizerSpeaking: false),
]
equal(meetActiveSpeaker(tiles: mtEqOverlap, prevAreas: [:], vadSpeechActive: true).names.sorted(), ["Alice", "Carol"],
      "concurrent equalizers -> both non-self tiles named (overlap)")
// 11d) equalizer BEATS kssMZb: a .equalizer tile + a classSpeaking tile both present
//      -> the equalizer tile leads (direct per-utterance read > sticky ring).
let mtEqVsClass = [
    MeetTileObservation(name: "Alice", area: 10_000, orderIndex: 0, classSpeaking: false, equalizerSpeaking: true),
    MeetTileObservation(name: "Bob",   area: 10_000, orderIndex: 1, classSpeaking: true,  equalizerSpeaking: false),
]
equal(meetActiveSpeaker(tiles: mtEqVsClass, prevAreas: [:], vadSpeechActive: true).names, ["Alice"],
      "equalizer beats kssMZb ring (equalizer leads)")
equal(meetActiveSpeaker(tiles: mtEqVsClass, prevAreas: [:], vadSpeechActive: true).via, .equalizer,
      "equalizer + ring both present -> via .equalizer")

// MARK: Meet participant control-label extraction (CLASS-FREE + GEOMETRY-FREE allowlist,
// panel-open capture 2026-07-03). The per-participant control's AXDescription embeds the
// name and is the structural allowlist for a real participant; browser chrome has none.
print("Meet participant control-label:")
equal(meetParticipantNameFromControl("More options for Guest Alpha"), "Guest Alpha", "'More options for X' -> name")
equal(meetParticipantNameFromControl("Pin Bob Smith to your main screen"), "Bob Smith", "'Pin X to your main screen' -> name")
equal(meetParticipantNameFromControl("Mute Guest Bravo's microphone"), "Guest Bravo", "'Mute X's microphone' -> name")
check(meetParticipantNameFromControl("Leave call") == nil, "control-bar 'Leave call' -> nil")
check(meetParticipantNameFromControl("Turn off microphone") == nil, "'Turn off microphone' -> nil")
check(meetParticipantNameFromControl("Contributors 3") == nil, "panel header 'Contributors 3' -> nil")
check(meetParticipantNameFromControl("") == nil, "empty label -> nil")
check(meetParticipantNameFromControl("More options for (You)") == nil, "'(You)' rejected via cleanParticipantName")
// Live-observed false-positive leaks (2026-07-03) — interim blocklist guards until
// the structural allowlist lands.
check(cleanParticipantName("More actions") == nil, "meet 'More actions' overflow rejected")
check(cleanParticipantName("Camera is off") == nil, "meet 'Camera is off' overlay rejected")
check(cleanParticipantName("Adjust view") == nil, "meet 'Adjust view' control rejected")
// Meet Adjust-view layout-menu option labels (transient leak, live-QA 2026-07-03):
check(cleanParticipantName("Auto") == nil, "meet layout 'Auto' rejected")
check(cleanParticipantName("Tiled") == nil, "meet layout 'Tiled' rejected")
check(cleanParticipantName("Sidebar") == nil, "meet layout 'Sidebar' rejected")
check(cleanParticipantName("Hide tiles without video") == nil, "meet 'Hide tiles without video' rejected")
// Guard the exact-match: a real name that merely CONTAINS a layout word still passes.
check(cleanParticipantName("Auti Sharma") == "Auti Sharma", "real name 'Auti Sharma' not clipped by 'auto'")

// MARK: Meet speech_on/speech_off events — VALIDATE the event pipeline against
// the DOM detector's LIVE-VERIFIED semantics (2026-07-03, structure-only run:
// single speakers named turn-wise 0.88-0.92, BOTH overlapping speakers named
// 0.81/0.88 on real Google Meet). Here the same shape is checked deterministically:
// a per-poll speaker set -> SessionTracker -> speech_on/speech_off transitions.
print("Meet speech events (turn-wise + overlap):")
do {
    // Collect emitted (type, name, source) event tuples.
    var evs: [(String, String, String?)] = []
    let t = SessionTracker(opts: TrackerOptions(endSilenceMs: 2000, pulseWidthMs: 500)) { e in
        switch e {
        case let .start(_, n, _, ctx): evs.append(("speech_on", n, ctx.source))
        case let .end(_, n, _, _, _, ctx): evs.append(("speech_off", n, ctx.source))
        case .tick: break
        }
    }
    // Drive the DOM detector's live semantics: the structural indicator names the
    // active REMOTE(s); self would come from the mic path. One pulse per 500ms poll.
    // Turn 1: Alice (remote) speaks t=0..1500 (source meet.structural).
    for ts in stride(from: 0, through: 1500, by: 500) {
        t.pulse(.meet, "Alice", ts, meetingId: "m1", participantId: "meet::m1::alice", source: "meet.structural")
    }
    // Gap: Alice goes silent; advance clock past endSilence -> speech_off Alice.
    t.update(1500 + 2001)
    // Turn 2: Bob (remote) speaks; then OVERLAP with Alice (both named same poll).
    for ts in stride(from: 4000, through: 5500, by: 500) {
        t.pulse(.meet, "Bob", ts, meetingId: "m1", participantId: "meet::m1::bob", source: "meet.structural")
    }
    for ts in stride(from: 5000, through: 5500, by: 500) {   // overlap window
        t.pulse(.meet, "Alice", ts, meetingId: "m1", participantId: "meet::m1::alice", source: "meet.structural")
    }
    t.endAll()

    let ons  = evs.filter { $0.0 == "speech_on" }
    let offs = evs.filter { $0.0 == "speech_off" }
    // Alice on (turn1), Bob on (turn2), Alice on again (overlap re-start) = 3 speech_on.
    equal(ons.map { $0.1 }.sorted(), ["Alice", "Alice", "Bob"], "3 speech_on: Alice(turn1), Bob, Alice(overlap)")
    // Every started session must close exactly once (turn1 Alice, then Bob+Alice at endAll).
    equal(offs.count, ons.count, "every speech_on is matched by exactly one speech_off")
    equal(offs.map { $0.1 }.sorted(), ["Alice", "Alice", "Bob"], "speech_off names mirror speech_on")
    // Source attribution threads through to the event (so telemetry can tell which
    // signal named the speaker — the structural read here).
    check(evs.allSatisfy { $0.2 == "meet.structural" }, "every speech event carries source=meet.structural")
    // Overlap: at endAll, Bob AND the re-started Alice are BOTH active concurrently.
    check(t.activeCount == 0, "endAll closed all overlapping sessions")
}
// Self + remote are distinct participants (self via mic path, remote via structural).
do {
    var names: [String] = []
    let t = SessionTracker { e in if case let .start(_, n, _, _) = e { names.append(n) } }
    t.pulse(.meet, "Bibek Thapa", 0, meetingId: "m1", participantId: "meet::m1::self", source: "meet.self_mic")
    t.pulse(.meet, "Alice", 0, meetingId: "m1", participantId: "meet::m1::alice", source: "meet.structural")
    equal(names.sorted(), ["Alice", "Bibek Thapa"], "self(mic) + remote(structural) = two concurrent speakers")
    equal(t.activeCount, 2, "self and remote tracked as distinct sessions")
}

// MARK: Teams rules — SPEAKING via vdi-frame-occlusion (structural, live-verified 2026-07-04)
print("TeamsSpeakerRules:")
let tr = TeamsSpeakerRules.builtin
check(tr.speakingClasses == ["vdi-frame-occlusion"],
      "builtin speakingClasses = [vdi-frame-occlusion] — the live-verified per-speaker ring")
check(tr.tileIsSpeaking(textBlob: "", classTokens: ["vdi-frame-occlusion", "fui-Flex"]),
      "vdi-frame-occlusion class -> speaking (the ring token, read STRUCTURALLY per tile)")
check(!tr.tileIsSpeaking(textBlob: "", classTokens: ["vdi-occlusion", "fui-Flex"]),
      "vdi-occlusion (bare, on non-tile groups) -> NOT speaking")
check(!tr.tileIsSpeaking(textBlob: "", classTokens: ["vdi-dynamic-occlusion"]),
      "vdi-dynamic-occlusion (the SELF tile's token) -> NOT speaking")
check(!tr.tileIsSpeaking(textBlob: "wedding thapas", classTokens: []),
      "plain name, no ring -> not speaking")
check(tr.tileIsSelf(textBlob: "bibek thapa (you)", classTokens: []),
      "(you) suffix -> self")
check(tr.tileIsSelf(textBlob: "", classTokens: ["calling_is_me_video"]),
      "calling_is_me_video token -> self")
check(tr.muteState(textBlob: "ana, muted", classTokens: []) == false, "', muted' -> muted")
check(tr.muteState(textBlob: "ana, unmuted", classTokens: []) == true, "', unmuted' -> unmuted")
check(tr.muteState(textBlob: "", classTokens: ["aria_calling_roster_unmuted"]) == true,
      "aria_calling_roster_unmuted token -> unmuted")
check(tr.muteState(textBlob: "ana", classTokens: []) == nil, "no mute token -> unknown")
// config override round-trips through Codable (remote-config drop)
do {
    let custom = TeamsSpeakerRules(speakingTextMarkers: [], speakingClasses: ["xyz"],
        selfTokens: ["me"], mutedTokens: ["m"], unmutedTokens: ["u"], version: "test")
    let data = try! JSONEncoder().encode(custom)
    let back = try! JSONDecoder().decode(TeamsSpeakerRules.self, from: data)
    equal(back, custom, "TeamsSpeakerRules Codable round-trip")
    check(back.tileIsSpeaking(textBlob: "", classTokens: ["xyz"]), "custom speakingClasses token works")
}

// MARK: Teams roster row parsing (real AX strings from `MeetProbe teams roster`)
print("TeamsRoster:")
do {
    let david = parseTeamsRosterRow("David Thapa (Guest), Has context menu, Meeting guest, Unmuted")
    check(david?.name == "David Thapa" && david?.unmuted == true, "remote roster row -> (David Thapa, unmuted)")
    let bibek = parseTeamsRosterRow("Bibek Thapa, Has context menu, Organizer, Muted")
    check(bibek?.name == "Bibek Thapa" && bibek?.unmuted == false, "self roster row -> (Bibek Thapa, muted)")
    // Camera-ON variant: ", video is on" tag must not leak into the name.
    let davCam = parseTeamsRosterRow("David Thapa (Guest), video is on, Muted")
    check(davCam?.name == "David Thapa" && davCam?.unmuted == false, "camera-on row -> (David Thapa, muted) [no 'video is on' leak]")
    let davCamUn = parseTeamsRosterRow("David Thapa (Guest), video is on, Unmuted")
    check(davCamUn?.name == "David Thapa" && davCamUn?.unmuted == true, "camera-on unmuted row -> (David Thapa, unmuted)")
    let myself = parseTeamsRosterRow("Myself video, Bibek Thapa, Muted, Has context menu")
    check(myself?.name == "Bibek Thapa" && myself?.unmuted == false, "self video tile -> (Bibek Thapa, muted) [drop 'Myself video,']")
    let myselfUn = parseTeamsRosterRow("Myself video, Bibek Thapa, Unmuted, Has context menu")
    check(myselfUn?.name == "Bibek Thapa" && myselfUn?.unmuted == true, "self video tile unmuted -> (Bibek Thapa, unmuted)")

    // CURRENT native build (live-verified 2026-07-03): the panel row dropped the
    // "Has context menu" phrase entirely — the mic word is the only anchor left.
    let bare = parseTeamsRosterRow("Bibek Thapa, Organizer, Unmuted")
    check(bare?.name == "Bibek Thapa" && bare?.unmuted == true,
          "current-build row (no context-menu phrase) -> (Bibek Thapa, unmuted)")
    let bareMuted = parseTeamsRosterRow("David Thapa (Guest), Meeting guest, Muted")
    check(bareMuted?.name == "David Thapa" && bareMuted?.unmuted == false,
          "current-build guest row -> (David Thapa, muted)")

    // WEB client (teams.microsoft.com) real strings: the row anchor is "Context
    // menu is available", and the UNMUTED form DROPS the mic word entirely.
    let webMuted = parseTeamsRosterRow("David Thapa (Guest), muted, Context menu is available")
    check(webMuted?.name == "David Thapa" && webMuted?.unmuted == false, "web muted row -> (David Thapa, muted)")
    let webUnmuted = parseTeamsRosterRow("David Thapa (Guest), Context menu is available")
    check(webUnmuted?.name == "David Thapa" && webUnmuted?.unmuted == true, "web row, no mic word -> (David Thapa, UNMUTED) [the bug fix]")

    check(parseTeamsRosterRow("Muted") == nil, "standalone 'Muted' icon rejected")
    check(parseTeamsRosterRow("Unmuted") == nil, "standalone 'Unmuted' icon rejected")
    check(parseTeamsRosterRow("In this meeting, 2 total Mute all") == nil, "'Mute all' header rejected")
    check(parseTeamsRosterRow("David Thapa (Guest)") == nil, "bare name label (no context-menu anchor) -> nil")
}

// MARK: Teams fused active-speaker resolver
print("Teams fused resolver:")
let ttGallery = [
    TeamsTileObservation(name: "Alice", area: 10_000, orderIndex: 0, isSpeaking: false),
    TeamsTileObservation(name: "Bob",   area: 10_000, orderIndex: 1, isSpeaking: false),
]
let ttSpeaking = [
    TeamsTileObservation(name: "Alice", area: 10_000, orderIndex: 0, isSpeaking: true),
    TeamsTileObservation(name: "Bob",   area: 10_000, orderIndex: 1, isSpeaking: false),
]
let ttSpotlight = [
    TeamsTileObservation(name: "Alice", area: 200_000, orderIndex: 0, isSpeaking: false),
    TeamsTileObservation(name: "Bob",   area: 10_000,  orderIndex: 1, isSpeaking: false),
]
// 1) The RING is Teams' OWN VAD — trusted DIRECTLY, ahead of our audio gate: a
//    lit ring names the speaker even when our peak meter is quiet.
equal(teamsActiveSpeaker(tiles: ttSpeaking, prevAreas: [:], vadSpeechActive: false).names, ["Alice"],
      "ring lit + our audio quiet -> STILL named (ring is Teams' VAD, trusted directly)")
// 2) ring names the speaker.
equal(teamsActiveSpeaker(tiles: ttSpeaking, prevAreas: [:], vadSpeechActive: true).names, ["Alice"],
      "ring (vdi-frame-occlusion) -> name")
equal(teamsActiveSpeaker(tiles: ttSpeaking, prevAreas: [:], vadSpeechActive: true).via, .structural,
      "ring -> via structural")
// 2b) OVERLAP: two lit rings -> BOTH named (the real multi-talker timeline, no "Someone").
let ttBothRing = [
    TeamsTileObservation(name: "Alice", area: 10_000, orderIndex: 0, isSpeaking: true),
    TeamsTileObservation(name: "Bob",   area: 10_000, orderIndex: 1, isSpeaking: true),
]
equal(teamsActiveSpeaker(tiles: ttBothRing, prevAreas: [:], vadSpeechActive: true).names.sorted(), ["Alice", "Bob"],
      "two lit rings -> BOTH remotes named (overlap timeline, not Someone)")
// 3) no ring, our audio silent -> nobody (NOT Someone — the engine gates Someone on unreadable-only).
equal(teamsActiveSpeaker(tiles: ttGallery, prevAreas: [:], vadSpeechActive: false).names, [],
      "no ring + no audio -> nobody (.none)")
equal(teamsActiveSpeaker(tiles: ttGallery, prevAreas: [:], vadSpeechActive: false).via, .none,
      "no ring + no audio -> via .none")
// 4) no ring but geometry ON -> dominant tile (camera-off / older-build fallback).
equal(teamsActiveSpeaker(tiles: ttSpotlight, prevAreas: [:], vadSpeechActive: true, useGeometry: true).names, ["Alice"],
      "no ring, geometry on -> dominant tile")
// 5) SELF-EXCLUSION (mirrors the Meet ring fix): a lit ring on the SELF tile must
//    never name the local user — self is mic-attributed. (The resolver still
//    returns the someoneFloor when our audio is active + nobody attributable; the
//    ENGINE ignores that floor and gates "Someone" on an unreadable tree instead.)
let ttSelfSpeaking = [
    TeamsTileObservation(name: "Me",  area: 10_000, orderIndex: 0, isSpeaking: true, isMe: true),
    TeamsTileObservation(name: "Bob", area: 10_000, orderIndex: 1, isSpeaking: false),
]
check(!teamsActiveSpeaker(tiles: ttSelfSpeaking, prevAreas: [:], vadSpeechActive: true).names.contains("Me"),
      "ring on SELF only -> local user NEVER named (self excluded)")
equal(teamsActiveSpeaker(tiles: ttSelfSpeaking, prevAreas: [:], vadSpeechActive: false).names, [],
      "ring on SELF only + audio quiet -> nobody (.none)")
let ttSelfPlusRemote = [
    TeamsTileObservation(name: "Me",    area: 10_000, orderIndex: 0, isSpeaking: true, isMe: true),
    TeamsTileObservation(name: "Alice", area: 10_000, orderIndex: 1, isSpeaking: true),
]
equal(teamsActiveSpeaker(tiles: ttSelfPlusRemote, prevAreas: [:], vadSpeechActive: true).names, ["Alice"],
      "ring on self + remote -> only the remote named (self excluded)")
// 6) geometry never promotes SELF (a big pinned self-view isn't speech evidence).
let ttSelfDominant = [
    TeamsTileObservation(name: "Me",  area: 200_000, orderIndex: 0, isSpeaking: false, isMe: true),
    TeamsTileObservation(name: "Bob", area: 10_000,  orderIndex: 1, isSpeaking: false),
]
equal(teamsActiveSpeaker(tiles: ttSelfDominant, prevAreas: [:], vadSpeechActive: true, useGeometry: true).names, ["Someone"],
      "geometry on, SELF dominant -> not named (Someone floor, mirrors Meet)")

// MARK: Teams pure extraction — REAL captured fixtures (macos/Fixtures/teams,
// distilled from ax-dumps 20260701-*). The SAME teamsExtractWindow the scanner
// ships runs here, so the deterministic loop tests the shipping extraction.
print("Teams extraction (captured fixtures):")
func loadTeamsFixture(_ name: String) -> TeamsAXNode? {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // SpeakerCoreSelfTest/
        .deletingLastPathComponent()   // Sources/
        .deletingLastPathComponent()   // macos/
        .appendingPathComponent("Fixtures/teams/\(name).json")
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(TeamsAXNode.self, from: data)
}

// MARK: SPEAKER TIMELINE — real 3-party captures (2026-07-04 co-variance run:
// host Bibek Thapa + guests Alice Talker + Bob Speaker, mics toggled). These
// prove the vdi-frame-occlusion ring, read structurally per tile, names EXACTLY
// the audible remote(s) — single, overlap, and silence — with NO "Someone".
print("Teams SPEAKER TIMELINE (real 3-party ring captures):")
func teamsSpeakers(_ ex: TeamsWindowExtraction) -> [String] {
    teamsActiveSpeaker(tiles: ex.tiles, prevAreas: [:], vadSpeechActive: true).names.sorted()
}
// GALLERY, only Alice audible -> ring on Alice only.
if let root = loadTeamsFixture("gallery-3p-alice-speaking") {
    let ex = teamsExtractWindow(root, selfHint: "Bibek Thapa")
    equal(ex.participants.sorted(), ["Alice Talker", "Bibek Thapa", "Bob Speaker"],
          "gallery/alice: exact 3-party roster")
    equal(ex.tiles.first(where: { $0.name == "Alice Talker" })?.isSpeaking, true,
          "gallery/alice: Alice ring lit (vdi-frame-occlusion, structural)")
    equal(ex.tiles.first(where: { $0.name == "Bob Speaker" })?.isSpeaking, false,
          "gallery/alice: muted Bob NOT speaking")
    check(ex.tiles.first(where: { $0.name == "Bibek Thapa" })?.isMe == true,
          "gallery/alice: self (Bibek) flagged, carries vdi-dynamic-occlusion not the ring")
    equal(teamsSpeakers(ex), ["Alice Talker"],
          "gallery/alice: resolver names EXACTLY Alice — no Someone")
} else { check(false, "fixture gallery-3p-alice-speaking.json missing") }

// GALLERY, both audible -> BOTH rings lit -> overlap timeline.
if let root = loadTeamsFixture("gallery-3p-both-speaking") {
    let ex = teamsExtractWindow(root, selfHint: "Bibek Thapa")
    equal(teamsSpeakers(ex), ["Alice Talker", "Bob Speaker"],
          "gallery/both: resolver names BOTH remotes (overlap) — the case that used to be 'Someone'")
    check(ex.tiles.first(where: { $0.isMe })?.isSpeaking == false,
          "gallery/both: self never joins the ring set")
} else { check(false, "fixture gallery-3p-both-speaking.json missing") }

// GALLERY, silence (both muted) -> no ring -> nobody, NOT Someone.
if let root = loadTeamsFixture("gallery-3p-silence") {
    let ex = teamsExtractWindow(root, selfHint: "Bibek Thapa")
    equal(ex.participants.sorted(), ["Alice Talker", "Bibek Thapa", "Bob Speaker"],
          "gallery/silence: roster intact")
    check(ex.tiles.allSatisfy { !$0.isSpeaking },
          "gallery/silence: NO ring on any tile")
    equal(teamsActiveSpeaker(tiles: ex.tiles, prevAreas: [:], vadSpeechActive: false).names, [],
          "gallery/silence: nobody speaking -> [] (no Someone)")
} else { check(false, "fixture gallery-3p-silence.json missing") }

// SPEAKER VIEW, only Bob audible -> Bob promoted to the big tile + ring.
if let root = loadTeamsFixture("speaker-3p-bob-speaking") {
    let ex = teamsExtractWindow(root, selfHint: "Bibek Thapa")
    equal(ex.tiles.first(where: { $0.name == "Bob Speaker" })?.isSpeaking, true,
          "speaker-view/bob: Bob ring lit")
    equal(ex.tiles.first(where: { $0.name == "Alice Talker" })?.isSpeaking, false,
          "speaker-view/bob: muted Alice NOT speaking")
    equal(teamsSpeakers(ex), ["Bob Speaker"],
          "speaker-view/bob: resolver names EXACTLY Bob")
    // Bob is the promoted big tile — geometry corroborates the ring HERE.
    let big = ex.tiles.max(by: { $0.area < $1.area })
    equal(big?.name, "Bob Speaker", "speaker-view/bob: the audible remote is the promoted big tile (geometry corroborates)")
    // REGRESSION GUARD — why the ring MUST stay class-anchored, not geometric
    // (research 2026-07-04): muted Alice is a small filmstrip tile that DOES carry
    // a near-tile-sized AXGroup overlay (the base video container). A class-free
    // "tile-sized overlay ⇒ speaking" heuristic would FALSE-POSITIVE her; only the
    // vdi-frame-occlusion CLASS excludes her. Locks the design against a future
    // "detect the ring structurally" change that would regress.
    equal(ex.tiles.filter { $0.isSpeaking }.map { $0.name }, ["Bob Speaker"],
          "speaker-view/bob: exactly ONE ring (class-anchored) — the muted filmstrip tile is NOT mismarked")
} else { check(false, "fixture speaker-3p-bob-speaking.json missing") }

// MARK: TeamsMeetingMemory — a call SURVIVES its window becoming unreadable
// (backgrounded / WebView2-throttled). Readable ticks record the roster keyed by
// the title-derived meetingId; throttled ticks keep the meeting alive from it and
// the ring resumes on recovery. Pure + time-injected.
print("TeamsMeetingMemory (unreadable/backgrounded recovery):")
do {
    var mem = TeamsMeetingMemory()
    let mid = "teams::meetingwithbibekthapa"
    let roster = [ZoomRosterEntry(name: "Alice Talker", unmuted: true, isMe: false),
                  ZoomRosterEntry(name: "Bibek Thapa", unmuted: true, isMe: true)]
    // t=1000: readable — record roster + pid.
    mem.observeReadable(meetingId: mid, roster: roster,
                        participants: ["Alice Talker", "Bibek Thapa"], pid: 4242, nowMs: 1000)
    equal(mem.entry(mid)?.participants, ["Alice Talker", "Bibek Thapa"], "readable tick -> roster remembered")
    equal(mem.entry(mid)?.pid, 4242, "readable tick -> pid remembered")
    // t=2000: THROTTLED (window title still resolves to mid) — still within TTL, so
    // the scanner would keep it alive.
    check(mem.activeIds(nowMs: 2000, ttlMs: 300_000).contains(mid),
          "throttled 1s later -> meeting still ACTIVE (kept alive, not dropped)")
    equal(mem.entry(mid)?.roster.first(where: { $0.isMe })?.name, "Bibek Thapa",
          "throttled -> last-known roster (incl. self) persists")
    // Long throttle past the TTL -> no longer kept alive (a genuinely-ended call clears).
    check(!mem.activeIds(nowMs: 1000 + 300_001, ttlMs: 300_000).contains(mid),
          "throttled past TTL -> meeting clears (no phantom call forever)")
    // Recovery: a fresh readable tick refreshes lastReadable + roster.
    mem.observeReadable(meetingId: mid, roster: roster, participants: ["Alice Talker", "Bibek Thapa", "Bob Speaker"], pid: 4242, nowMs: 305_000)
    equal(mem.entry(mid)?.participants.count, 3, "recovery -> roster refreshed from the live tree")
    check(mem.activeIds(nowMs: 305_500, ttlMs: 300_000).contains(mid), "recovery -> active again")
    // prune drops stale entries.
    mem.prune(nowMs: 305_000 + 300_001, maxAgeMs: 300_000)
    equal(mem.count, 0, "prune -> stale meeting evicted")
}

// CAMERA-OFF SPEAKERS — the ring is CAMERA-INDEPENDENT (live-verified 2026-07-04,
// SUPERSEDES the earlier "no video frame ⇒ no ring" limitation). A camera-off
// speaker's AVATAR tile still carries vdi-frame-occlusion, and camera-off OVERLAP
// marks both avatars — so there is no camera-off gap. The tile desc drops
// "video is on" ("Alice Talker (Guest), Context menu is available") but the P1
// context-menu anchor still admits it and the per-tile ring scan still fires.
print("Teams CAMERA-OFF ring (avatar, no video frame):")
if let root = loadTeamsFixture("gallery-3p-camoff-alice-speaking") {
    let ex = teamsExtractWindow(root, selfHint: "Bibek Thapa")
    equal(ex.participants.sorted(), ["Alice Talker", "Bibek Thapa", "Bob Speaker"],
          "camoff/alice: roster intact (camera-off tile still admitted)")
    equal(ex.tiles.first(where: { $0.name == "Alice Talker" })?.isSpeaking, true,
          "camoff/alice: camera-OFF Alice's AVATAR ring lit (vdi-frame-occlusion, no video frame)")
    equal(ex.tiles.first(where: { $0.name == "Bob Speaker" })?.isSpeaking, false,
          "camoff/alice: muted Bob not speaking")
    equal(teamsSpeakers(ex), ["Alice Talker"],
          "camoff/alice: resolver names the camera-off speaker — no Someone, no mute-gate needed")
} else { check(false, "fixture gallery-3p-camoff-alice-speaking.json missing") }
if let root = loadTeamsFixture("gallery-3p-camoff-both-speaking") {
    let ex = teamsExtractWindow(root, selfHint: "Bibek Thapa")
    equal(teamsSpeakers(ex), ["Alice Talker", "Bob Speaker"],
          "camoff/both: camera-OFF OVERLAP -> BOTH avatars named (the case documented as the ceiling, now covered)")
} else { check(false, "fixture gallery-3p-camoff-both-speaking.json missing") }

// CELL: 2 participants × speaker/large view (screen-share stage) — the remote's
// camera is OFF, so its tile desc has NO "video is" token ("David Tgapa (Guest),
// muted, Context menu is available"); the OLD extractor required one and missed
// the only remote. Self is an AXImage ("Myself video, …"), NOT an AXMenuItem.
if let root = loadTeamsFixture("native-2p-share-cameraoff-remote") {
    let ex = teamsExtractWindow(root)
    equal(ex.participants.sorted(), ["Bibek Thapa", "David Tgapa"],
          "2p/share: exactly the real roster — camera-OFF remote NOT missed, zero chrome FPs")
    check(ex.callActive, "2p/share: call gate ACTIVE (Leave button / Shared content)")
    let me2 = ex.tiles.first(where: { $0.isMe })
    check(me2?.name == "Bibek Thapa", "2p/share: self via 'Myself video' AXImage (role-independent)")
    equal(me2?.unmuted, true, "2p/share: self explicit Unmuted read")
    let david = ex.tiles.first(where: { $0.name == "David Tgapa" })
    check(david != nil && david?.isMe == false, "2p/share: remote tile present, not self")
    equal(david?.unmuted, false, "2p/share: remote explicit 'muted' read")
    check(ex.roster.isEmpty, "2p/share: roster EMPTY (panel closed — tile rows can't masquerade)")
    // Engine cell semantics: remote speech while the only remote is MUTED can't
    // be attributed -> honest Someone (the engine debounces it via someoneGrace).
    let remotes2 = ex.tiles.filter { !$0.isMe && ($0.unmuted ?? true) }.map { $0.name }
    equal(zoomMuteGateSpeakers(micActive: false, localUnmuted: me2?.unmuted ?? false,
            localName: me2?.name ?? "You", remoteActive: true, remoteUnmutedNames: remotes2),
          ["Someone"], "2p/share: remote speech w/ only-remote muted -> honest Someone")
    // Self speech: mic active + self unmuted -> the REAL name, never "You".
    equal(zoomMuteGateSpeakers(micActive: true, localUnmuted: me2?.unmuted ?? false,
            localName: me2?.name ?? "You", remoteActive: false, remoteUnmutedNames: remotes2),
          ["Bibek Thapa"], "2p/share: self speech -> real roster name via self tile")
} else { check(false, "fixture native-2p-share-cameraoff-remote.json missing") }

// CELL: 3 participants × side-gallery + share. Self appears TWICE (a gallery
// AXMenuItem "Bibek Thapa, video is on, Context menu is available" AND the
// "Myself video" AXImage) — must merge to ONE isMe entry. "BIDHEYAK THAPA" is a
// real ALL-CAPS display name (was rejected by the un-anchored caps heuristic).
if let root = loadTeamsFixture("native-3p-sidegallery-share") {
    let ex = teamsExtractWindow(root)
    equal(ex.participants, ["BIDHEYAK THAPA", "Bibek Thapa", "Biheyak Thapa"],
          "3p/side-gallery: exactly the real roster, reading order, ALL-CAPS name kept")
    check(ex.callActive, "3p/side-gallery: call gate ACTIVE")
    equal(ex.tiles.count, 3, "3p/side-gallery: 3 tiles (self gallery tile + Myself image MERGED)")
    let me3 = ex.tiles.filter { $0.isMe }
    equal(me3.map { $0.name }, ["Bibek Thapa"], "3p/side-gallery: exactly one self entry")
    equal(me3.first?.unmuted, true, "3p/side-gallery: self Unmuted from the Myself image (explicit beats default)")
    equal(ex.tiles.first(where: { $0.name == "BIDHEYAK THAPA" })?.unmuted, false,
          "3p/side-gallery: main-stage remote explicit muted")
    equal(ex.tiles.first(where: { $0.name == "Biheyak Thapa" })?.unmuted, false,
          "3p/side-gallery: side-gallery remote explicit muted")
    // Engine cell: both remotes muted + remote speech -> honest Someone.
    let remotes3 = ex.tiles.filter { !$0.isMe && ($0.unmuted ?? true) }.map { $0.name }
    equal(zoomMuteGateSpeakers(micActive: false, localUnmuted: true, localName: "Bibek Thapa",
            remoteActive: true, remoteUnmutedNames: remotes3),
          ["Someone"], "3p/side-gallery: remote speech, all remotes muted -> honest Someone")
} else { check(false, "fixture native-3p-sidegallery-share.json missing") }

// NEGATIVE CELL: the Teams home "Meet" tab — meeting-link cards ("Meeting link,
// Meeting with Bibek Thapa, …, card"), Join buttons, headings. Zero participants,
// call gate INACTIVE (this window must never start a meeting). It DOES carry the
// profile button, so it's also the self-name-hint source fixture.
if let root = loadTeamsFixture("native-home-meet-tab-negative") {
    let ex = teamsExtractWindow(root)
    equal(ex.participants, [], "home tab: ZERO participants (cards/buttons are not tiles)")
    check(!ex.callActive, "home tab: call gate INACTIVE (no Leave/Shared content/Attendees)")
    check(ex.tiles.isEmpty && ex.roster.isEmpty && ex.speakingNote == nil,
          "home tab: no tiles, no roster, no speaking note")
    equal(teamsSelfNameHint(root), "Bibek Thapa",
          "home tab: self-name hint from 'Profile picture of <Name>.' label")
} else { check(false, "fixture native-home-meet-tab-negative.json missing") }

// CELL: SOLO call (1 participant) × Participants panel open — the CURRENT build
// (captured 2026-07-03): no "Myself video" tile, no self marker in the panel row
// ("Bibek Thapa, Organizer, Unmuted"). Self resolves via the app-wide profile
// HINT; the header row ("In this meeting, 1 total") is rejected.
if let root = loadTeamsFixture("native-1p-panel-open") {
    let ex = teamsExtractWindow(root, selfHint: "Bibek Thapa")
    equal(ex.participants, ["Bibek Thapa"], "solo/panel: exactly the one real participant")
    check(ex.callActive, "solo/panel: call gate ACTIVE (Leave + Attendees outline)")
    equal(ex.roster.count, 1, "solo/panel: one roster row (header/invite rows rejected)")
    equal(ex.roster.first?.unmuted, true, "solo/panel: self row Unmuted")
    equal(ex.roster.first?.isMe, true, "solo/panel: self flagged via the profile hint (no Myself tile in this layout)")
    check(ex.speakingNote == nil, "solo/panel: no speaking note")
    // Hint unavailable (occluded home window throttles its tree): SOLO-ATTENDEE
    // inference still resolves self — an in-call window with exactly one attendee
    // and no stage tiles can only be showing the local user.
    let noHint = teamsExtractWindow(root)
    equal(noHint.roster.first?.isMe, true, "solo/panel: hint absent -> self via solo-attendee inference")
} else { check(false, "fixture native-1p-panel-open.json missing") }

// Solo-attendee inference stays HONEST: with 2+ attendees (and no self tile or
// hint) nobody is guessed as self.
do {
    let panel2 = TeamsAXNode(role: "AXOutline", desc: "Attendees", children: [
        TeamsAXNode(role: "AXRow", title: "Alice Kumar, Meeting guest, Unmuted"),
        TeamsAXNode(role: "AXRow", title: "Bibek Thapa, Organizer, Unmuted"),
    ])
    let win = TeamsAXNode(role: "AXWindow", children: [
        TeamsAXNode(role: "AXButton", desc: "Leave"), panel2,
    ])
    let ex = teamsExtractWindow(win)
    equal(ex.roster.count, 2, "2-attendee panel, no tiles: both rows extracted")
    check(ex.roster.allSatisfy { !$0.isMe }, "2-attendee panel, no self signal -> NOBODY guessed as self")
    // …and the hint disambiguates it.
    let exH = teamsExtractWindow(win, selfHint: "Bibek Thapa")
    equal(exH.roster.first(where: { $0.name == "Bibek Thapa" })?.isMe, true,
          "2-attendee panel + hint -> self flagged by name")
}

// Self-name hint parsing (the profile-button label, home window).
print("Teams self-name hint:")
equal(teamsSelfNameFromProfileLabel("Profile picture of Bibek Thapa."), "Bibek Thapa",
      "'Profile picture of <Name>.' -> name")
check(teamsSelfNameFromProfileLabel("Your profile, status In a call") == nil, "status label -> nil")
check(teamsSelfNameFromProfileLabel("Profile picture of .") == nil, "empty name -> nil")
check(teamsSelfNameFromProfileLabel("Bibek Thapa") == nil, "bare name (no profile prefix) -> nil")

// MARK: Teams extraction — SYNTHETIC matrix cells (grammar from the live
// captures + docs/teams-probe.md; cells we can't capture offline are modeled on
// the proven AXMenuItem/"Myself video"/roster-row grammar and re-verified in the
// LIVE pass, qa/qa.teams.config.mjs).
print("Teams extraction (synthetic matrix):")
func synTile(_ desc: String, x: Double, y: Double, w: Double, h: Double) -> TeamsAXNode {
    TeamsAXNode(role: "AXMenuItem", desc: desc, x: x, y: y, w: w, h: h)
}
func synSelf(_ desc: String, x: Double, y: Double, w: Double, h: Double) -> TeamsAXNode {
    TeamsAXNode(role: "AXImage", desc: desc, x: x, y: y, w: w, h: h)
}
func synWindow(_ kids: [TeamsAXNode], leave: Bool = true) -> TeamsAXNode {
    var children = kids
    if leave { children.append(TeamsAXNode(role: "AXButton", desc: "Leave", x: 1061, y: 64, w: 48, h: 48)) }
    return TeamsAXNode(role: "AXWindow", children: [TeamsAXNode(role: "AXGroup", children: children)])
}

// CELL: gallery × 2p (equal tiles, no share). Unmuted remote carries NO mic word
// (the Teams convention) -> reads unmuted; single unmuted remote + remote speech
// -> named. Window-size independence: the SAME tree scaled 0.3× must extract
// identically (no geometry constants anywhere).
for scale in [1.0, 0.3] {
    let s = { (v: Double) in v * scale }
    let g2 = synWindow([
        synTile("Alice Kumar, video is on, Context menu is available", x: s(3), y: s(121), w: s(560), h: s(600)),
        synSelf("Myself video, Bibek Thapa, Unmuted, Has context menu", x: s(570), y: s(121), w: s(560), h: s(600)),
    ])
    let ex = teamsExtractWindow(g2)
    equal(ex.participants, ["Alice Kumar", "Bibek Thapa"],
          "gallery/2p @\(scale)x: exact roster (size-independent)")
    equal(ex.tiles.first(where: { $0.isMe })?.name, "Bibek Thapa", "gallery/2p @\(scale)x: self resolved")
    let remotes = ex.tiles.filter { !$0.isMe && ($0.unmuted ?? true) }.map { $0.name }
    equal(zoomMuteGateSpeakers(micActive: false, localUnmuted: true, localName: "Bibek Thapa",
            remoteActive: true, remoteUnmutedNames: remotes),
          ["Alice Kumar"], "gallery/2p @\(scale)x: remote speech -> the single unmuted remote NAMED")
}

// CELL: gallery × 3p (2 remotes: one unmuted, one muted). Mute-gate names the
// single unmuted remote; flipping BOTH unmuted degrades honestly to Someone.
do {
    let g3 = synWindow([
        synTile("Alice Kumar, video is on, Context menu is available", x: 3, y: 121, w: 370, h: 300),
        synTile("Bob Rai (Guest), muted, Context menu is available", x: 380, y: 121, w: 370, h: 300),
        synSelf("Myself video, Bibek Thapa, Unmuted, Has context menu", x: 760, y: 121, w: 370, h: 300),
    ])
    let ex = teamsExtractWindow(g3)
    equal(ex.participants, ["Alice Kumar", "Bob Rai", "Bibek Thapa"], "gallery/3p: exact roster")
    equal(ex.tiles.first(where: { $0.name == "Bob Rai" })?.unmuted, false, "gallery/3p: camera-off muted remote read")
    let remotes = ex.tiles.filter { !$0.isMe && ($0.unmuted ?? true) }.map { $0.name }
    equal(zoomMuteGateSpeakers(micActive: false, localUnmuted: true, localName: "Bibek Thapa",
            remoteActive: true, remoteUnmutedNames: remotes),
          ["Alice Kumar"], "gallery/3p: mute-gate names the single unmuted remote")
    equal(zoomMuteGateSpeakers(micActive: false, localUnmuted: true, localName: "Bibek Thapa",
            remoteActive: true, remoteUnmutedNames: ["Alice Kumar", "Bob Rai"]),
          ["Someone"], "gallery/3p: 2+ unmuted remotes -> honest Someone (multi-talker ceiling)")
}

// CELL: speaker/large view × 3p — one promoted tile + strip. Extraction must be
// IDENTICAL to gallery (structure-keyed, not geometry-keyed).
do {
    let sp = synWindow([
        synTile("Alice Kumar, video is on, Context menu is available", x: 3, y: 121, w: 900, h: 560),
        synTile("Bob Rai (Guest), muted, Context menu is available", x: 910, y: 121, w: 160, h: 90),
        synSelf("Myself video, Bibek Thapa, Unmuted, Has context menu", x: 910, y: 220, w: 160, h: 90),
    ])
    let ex = teamsExtractWindow(sp)
    equal(ex.participants, ["Alice Kumar", "Bob Rai", "Bibek Thapa"],
          "speaker-view/3p: exact roster (promoted tile changes nothing)")
    equal(ex.tiles.first(where: { $0.isMe })?.name, "Bibek Thapa", "speaker-view/3p: self resolved")
}

// CELL: together mode × 3p — one shared canvas, equal/overlapping per-person
// rows (same AXMenuItem grammar; re-verified live).
do {
    let tg = synWindow([
        synTile("Alice Kumar, video is on, Context menu is available", x: 100, y: 200, w: 300, h: 300),
        synTile("Bob Rai, video is on, Context menu is available", x: 400, y: 200, w: 300, h: 300),
        synTile("Bibek Thapa, video is on, Context menu is available", x: 700, y: 200, w: 300, h: 300),
        synSelf("Myself video, Bibek Thapa, Unmuted, Has context menu", x: 986, y: 600, w: 156, h: 86),
    ])
    let ex = teamsExtractWindow(tg)
    equal(ex.participants, ["Alice Kumar", "Bob Rai", "Bibek Thapa"],
          "together/3p: exact roster (canvas rows, self merged)")
    equal(ex.tiles.filter { $0.isMe }.map { $0.name }, ["Bibek Thapa"], "together/3p: one self entry")
}

// CELL: compact/PIP window — no tiles; Teams' own "<name> is speaking" note
// names the speaker (the scanner keeps the call alive via the window title).
do {
    let speaking = TeamsAXNode(role: "AXWindow", children: [
        TeamsAXNode(role: "AXGroup", desc: "Alice Kumar is speaking"),
        TeamsAXNode(role: "AXButton", desc: "Turn camera on"),
    ])
    let ex = teamsExtractWindow(speaking)
    equal(ex.speakingNote, "Alice Kumar", "compact: '<name> is speaking' note -> speaker named")
    equal(ex.participants, [], "compact: chrome ('Turn camera on') never a participant")
    let idle = TeamsAXNode(role: "AXWindow", children: [
        TeamsAXNode(role: "AXGroup", desc: "Nobody is speaking"),
    ])
    check(teamsExtractWindow(idle).speakingNote == nil, "compact: 'Nobody is speaking' -> nil (keep-alive only)")
}

// CELL: FALSIFICATION — unmuted-but-SILENT (the open-mic state the tone rig could
// never produce, and the one that dominates real meetings). `isSpeaking` must come
// ONLY from the ring (vdi-frame-occlusion), NEVER from mute-state: an UNMUTED tile
// with no ring reads NOT speaking, and adding the ring (changing nothing else) is
// the ONLY thing that flips it. This locks the qa/teams-live --probe contract
// offline — the live probe proves Teams leaves the ring DARK for a silent open mic;
// this proves our extractor never invents a speaker from one. See docs/…detection.md.
do {
    func ring() -> TeamsAXNode { TeamsAXNode(role: "AXGroup", classes: ["vdi-frame-occlusion"]) }
    // Two UNMUTED remotes + self, NO ring anywhere -> nobody speaking.
    let silent = synWindow([
        synTile("Alice Kumar, video is on, Context menu is available", x: 3, y: 121, w: 370, h: 300),
        synTile("Bob Rai, video is on, Context menu is available", x: 380, y: 121, w: 370, h: 300),
        synSelf("Myself video, Bibek Thapa, Unmuted, Has context menu", x: 760, y: 121, w: 370, h: 300),
    ])
    let exSilent = teamsExtractWindow(silent)
    equal(exSilent.participants, ["Alice Kumar", "Bob Rai", "Bibek Thapa"], "open-mic SILENT: roster intact")
    check(exSilent.tiles.allSatisfy { !$0.isSpeaking },
          "open-mic SILENT: unmuted tiles, no ring -> NO tile isSpeaking (mute-state never names)")
    equal(teamsActiveSpeaker(tiles: exSilent.tiles, prevAreas: [:], vadSpeechActive: true).names, ["Someone"],
          "open-mic SILENT + our audio active -> Someone floor only (engine gates it on unreadable), NEVER the silent remote")
    check(!teamsActiveSpeaker(tiles: exSilent.tiles, prevAreas: [:], vadSpeechActive: true).names.contains("Alice Kumar"),
          "open-mic SILENT: the unmuted remote is NEVER named by our resolver")
    // Same tree, ONLY difference: Alice's tile subtree gains the ring -> now named.
    let aliceRinging = synWindow([
        TeamsAXNode(role: "AXMenuItem", desc: "Alice Kumar, video is on, Context menu is available",
                    x: 3, y: 121, w: 370, h: 300, children: [ring()]),
        synTile("Bob Rai, video is on, Context menu is available", x: 380, y: 121, w: 370, h: 300),
        synSelf("Myself video, Bibek Thapa, Unmuted, Has context menu", x: 760, y: 121, w: 370, h: 300),
    ])
    let exRing = teamsExtractWindow(aliceRinging)
    equal(exRing.tiles.first(where: { $0.name == "Alice Kumar" })?.isSpeaking, true,
          "ring added to Alice's subtree (nothing else changed) -> Alice isSpeaking")
    equal(exRing.tiles.first(where: { $0.name == "Bob Rai" })?.isSpeaking, false,
          "…while still-silent Bob stays NOT speaking (ring is per-tile, no leak)")
    equal(teamsActiveSpeaker(tiles: exRing.tiles, prevAreas: [:], vadSpeechActive: true).names, ["Alice Kumar"],
          "unmuted + RING -> named; the ring, not the open mic, is what speaks")
}

// CELL: People panel OPEN — roster rows live under the Attendees outline ONLY.
// A roster-only participant (gallery overflow) still reaches `participants`
// (fusion: roster ∪ tiles), and the self row is flagged from the self tile.
do {
    let panel = TeamsAXNode(role: "AXOutline", desc: "Attendees", children: [
        TeamsAXNode(role: "AXGroup", desc: "Alice Kumar, Has context menu, Meeting guest, Unmuted"),
        TeamsAXNode(role: "AXGroup", desc: "Bob Rai (Guest), Has context menu, Meeting guest, Muted"),
        TeamsAXNode(role: "AXGroup", desc: "Carol Overflow, Has context menu, Meeting guest, Muted"),
        TeamsAXNode(role: "AXGroup", desc: "Bibek Thapa, Has context menu, Organizer, Unmuted"),
        TeamsAXNode(role: "AXGroup", desc: "In this meeting, 4 total Mute all"),
    ])
    let win = synWindow([
        synTile("Alice Kumar, video is on, Context menu is available", x: 3, y: 121, w: 370, h: 300),
        synTile("Bob Rai (Guest), muted, Context menu is available", x: 380, y: 121, w: 370, h: 300),
        synSelf("Myself video, Bibek Thapa, Unmuted, Has context menu", x: 760, y: 121, w: 370, h: 300),
        panel,
    ])
    let ex = teamsExtractWindow(win)
    equal(ex.roster.count, 4, "panel-open: 4 roster rows (header/bulk rows rejected)")
    equal(ex.roster.first(where: { $0.name == "Bob Rai" })?.unmuted, false, "panel-open: remote mute from the ROSTER row")
    equal(ex.roster.first(where: { $0.name == "Bibek Thapa" })?.isMe, true, "panel-open: self row flagged from the self tile")
    check(ex.participants.contains("Carol Overflow"),
          "panel-open: roster-only participant reaches participants (roster ∪ tiles fusion)")
    equal(ex.participants.count, 4, "panel-open: exactly the real 4 participants")
    // Engine cell: panel roster drives the mute-gate -> single unmuted remote named.
    let remotes = ex.roster.filter { !$0.isMe && $0.unmuted }.map { $0.name }
    equal(zoomMuteGateSpeakers(micActive: false, localUnmuted: true, localName: "Bibek Thapa",
            remoteActive: true, remoteUnmutedNames: remotes),
          ["Alice Kumar"], "panel-open: roster mute-gate names the single unmuted remote")
}

// FALSE-POSITIVE regression net: progressive name fragments, lobby chrome,
// toasts, un-anchored menu items, anchored-but-chrome labels -> ZERO tiles.
do {
    let junk = synWindow([
        TeamsAXNode(role: "AXStaticText", value: "Bib"),
        TeamsAXNode(role: "AXStaticText", value: "Bibe"),
        TeamsAXNode(role: "AXStaticText", value: "Bibek Th"),
        TeamsAXNode(role: "AXButton", desc: "Join now"),
        TeamsAXNode(role: "AXStaticText", value: "Computer audio"),
        TeamsAXNode(role: "AXGroup", desc: "Your camera is turned on"),
        TeamsAXNode(role: "AXMenuItem", desc: "Alice Kumar"),                        // no context-menu anchor
        TeamsAXNode(role: "AXMenuItem", desc: "More options, Context menu is available"), // anchored chrome
        TeamsAXNode(role: "AXGroup", desc: "Waiting in lobby, David Thapa"),
        TeamsAXNode(role: "AXGroup", desc: "David Thapa (Guest), muted, Context menu is available"), // right text, WRONG role
    ])
    let ex = teamsExtractWindow(junk)
    equal(ex.participants, [], "FP net: fragments/lobby/toasts/un-anchored rows -> ZERO participants")
    equal(ex.tiles.count, 0, "FP net: zero tiles")
}

// Anchored name hygiene: the structural anchor admits shouty REAL names but
// never chrome; un-anchored reads keep the strict caps rejection.
print("Teams anchored name parsing:")
equal(cleanParticipantName("BIDHEYAK THAPA, video is on, muted, Context menu is available", structuralAnchor: true),
      "BIDHEYAK THAPA", "anchored: ALL-CAPS real display name kept")
check(cleanParticipantName("BIDHEYAK THAPA") == nil, "un-anchored: ALL-CAPS still rejected (chrome heuristic)")
check(cleanParticipantName("USD") == nil, "un-anchored: caps label 'USD' still rejected")
check(cleanParticipantName("Mute mic (⇧ ⌘ M)", structuralAnchor: true) == nil, "anchored: chrome labels still rejected")
check(cleanParticipantName("Elapsed time 05:13", structuralAnchor: true) == nil, "anchored: digit chrome still rejected")
let capsRow = parseTeamsRosterRow("BIDHEYAK THAPA, Has context menu, Meeting guest, Unmuted")
check(capsRow?.name == "BIDHEYAK THAPA" && capsRow?.unmuted == true,
      "roster row: ALL-CAPS name parsed (anchored) with mute state")

// MARK: Meeting identity (stable id from URL code / normalized title)
print("MeetingIdentity:")
equal(meetingCode(platform: .meet, url: "https://meet.google.com/xza-ddbx-ebn"),
      "xza-ddbx-ebn", "meet code from url")
equal(meetingCode(platform: .zoom, url: "https://app.zoom.us/wc/89012345678/join"),
      "89012345678", "zoom code from /wc/ url")
equal(meetingId(platform: .meet, url: "https://meet.google.com/xza-ddbx-ebn",
                title: "(2) Meet - xza-ddbx-ebn - Google Chrome"),
      "meet::xza-ddbx-ebn", "url code drives the id (ignores volatile title)")
// The (2) unread prefix + recording clause + browser suffix all normalize away,
// so two title reads of the SAME call produce ONE id (no churn).
equal(meetingId(platform: .meet, url: nil, title: "(2) Meet - abc-defg-hij - Google Chrome"),
      meetingId(platform: .meet, url: nil,
                title: "Meet - abc-defg-hij - Camera and microphone recording - Google Chrome - Bibek"),
      "meet (2)-prefix + recording clause normalize to the same id")
check(meetingId(platform: .meet, url: "https://meet.google.com/aaa-bbbb-ccc", title: "")
      != meetingId(platform: .meet, url: "https://meet.google.com/ddd-eeee-fff", title: ""),
      "distinct meet codes -> distinct ids (no collapse)")
equal(participantId(meetingId: "meet::abc", name: "Wedding Thapas"),
      "meet::abc::weddingthapas", "participant id is meeting-namespaced + alphanumeric-normalized")
equal(participantId(meetingId: "z::m", name: "David's Iphone"),
      participantId(meetingId: "z::m", name: "David'sIphone"),
      "participant id stable across spacing/apostrophe variance")

// MARK: MeetingStateTracker (lifecycle diff + grace + sticky flags)
print("MeetingStateTracker:")
do {
    let mid = "meet::abc"
    func part(_ name: String, muted: Bool? = nil, speaking: Bool? = nil, local: Bool? = nil) -> MeetingParticipant {
        MeetingParticipant(id: participantId(meetingId: mid, name: name), name: name,
                           isLocal: local, isMuted: muted, isSpeaking: speaking)
    }
    func snap(_ parts: [MeetingParticipant]) -> MeetingSnapshot {
        MeetingSnapshot(id: mid, platform: .meet, title: "Meet - abc",
                        participants: parts, startedAt: 0, updatedAt: 0)
    }
    func count(_ ev: [MeetingEvent], _ pred: (MeetingEvent) -> Bool) -> Int { ev.filter(pred).count }

    var ev: [MeetingEvent] = []
    let mt = MeetingStateTracker(opts: .init(graceMs: 1000)) { ev.append($0) }

    mt.observe([snap([part("Alice"), part("Bob")])], 1000)
    check(ev.contains { if case .meetingInitialized = $0 { return true }; return false },
          "first snapshot -> meetingInitialized")
    equal(count(ev) { if case .participantJoined = $0 { return true }; return false }, 2, "two joins on init")

    ev.removeAll()
    mt.observe([snap([part("Alice"), part("Bob"), part("Carol")])], 1500)
    equal(count(ev) { if case let .participantJoined(_, p, _) = $0 { return p.name == "Carol" }; return false },
          1, "new participant -> one join (Carol)")

    ev.removeAll()
    mt.observe([snap([part("Alice"), part("Bob")])], 1800)   // Carol missing, within grace
    equal(count(ev) { if case .participantLeft = $0 { return true }; return false }, 0,
          "flicker within grace -> no leave")

    ev.removeAll()
    mt.observe([snap([part("Alice"), part("Bob")])], 3000)   // Carol unseen > grace
    check(ev.contains { if case let .participantLeft(_, _, name, _) = $0 { return name == "Carol" }; return false },
          "absent past grace -> participantLeft (Carol)")

    ev.removeAll()
    mt.observe([snap([part("Alice", muted: true), part("Bob")])], 3200)
    equal(count(ev) { if case let .participantUpdated(_, p, _) = $0 { return p.name == "Alice" }; return false },
          1, "mute flip -> one participantUpdated")

    ev.removeAll()
    mt.observe([snap([part("Alice", muted: nil), part("Bob")])], 3400)
    equal(count(ev) { if case .participantUpdated = $0 { return true }; return false }, 0,
          "nil mute read -> no update (sticky last-known)")

    ev.removeAll()
    mt.observe([snap([part("Alice", muted: true, speaking: true), part("Bob")])], 3600)
    equal(count(ev) { if case .participantUpdated = $0 { return true }; return false }, 0,
          "isSpeaking flip alone -> no participantUpdated (speech events cover it)")

    ev.removeAll()
    mt.endAll(4000)
    check(ev.contains { if case let .meetingEnded(m, _) = $0 { return m == mid }; return false },
          "endAll -> meetingEnded")
    equal(mt.meetingCount, 0, "no meetings after endAll")
}
do {
    // Two same-id snapshots in one tick (two tabs of one call) -> one meeting, union roster.
    var ev: [MeetingEvent] = []
    let mt = MeetingStateTracker { ev.append($0) }
    let mid = "meet::dup"
    func one(_ n: String) -> MeetingSnapshot {
        MeetingSnapshot(id: mid, platform: .meet, title: "Meet",
                        participants: [MeetingParticipant(id: participantId(meetingId: mid, name: n), name: n)],
                        startedAt: 0, updatedAt: 0)
    }
    mt.observe([one("Alice"), one("Bob")], 1000)
    equal(mt.meetingCount, 1, "two same-id snapshots -> one meeting")
    equal(ev.filter { if case .participantJoined = $0 { return true }; return false }.count, 2,
          "merged roster -> two joins (Alice + Bob)")
}
do {
    // An empty/unreadable roster tick must NOT evict the known roster.
    var ev: [MeetingEvent] = []
    let mt = MeetingStateTracker(opts: .init(graceMs: 500)) { ev.append($0) }
    let mid = "meet::bg"
    mt.observe([MeetingSnapshot(id: mid, platform: .meet, title: "Meet",
        participants: [MeetingParticipant(id: participantId(meetingId: mid, name: "Alice"), name: "Alice")],
        startedAt: 0, updatedAt: 0)], 1000)
    ev.removeAll()
    mt.observe([MeetingSnapshot(id: mid, platform: .meet, title: "Meet",
        participants: [], startedAt: 0, updatedAt: 0)], 5000)   // empty tree, well past grace
    equal(ev.filter { if case .participantLeft = $0 { return true }; return false }.count, 0,
          "empty-tree tick -> no false leave")
    equal(mt.meetingCount, 1, "empty-tree tick -> meeting stays alive")
}

// MARK: TransitionConfidence (event-driven ring/focus — pure, time-injected).
// Decay: floor + (spike-floor)·0.5^(elapsed/halfLife). Defaults spike 1.0, floor
// 0.25, halfLife 1200ms → t=0:1.0, t=halfLife:0.625, t→∞:0.25. All clocks injected
// (no Date()/monotonic call inside SpeakerCore — INV-6). Epsilon compare on doubles.
print("TransitionConfidence:")
do {
    func approx(_ a: Double, _ b: Double, _ eps: Double = 1e-9) -> Bool { abs(a - b) < eps }
    let cfg = TransitionConfidenceConfig()   // 1.0 / 0.25 / 1200
    equal(cfg.spike, 1.0, "default spike 1.0")
    equal(cfg.floor, 0.25, "default floor 0.25")
    equal(cfg.halfLifeMs, 1200, "default halfLife 1200ms")

    var tc = TransitionConfidence(config: cfg)
    tc.edge(to: "Alice", at: 0)
    // t=0 -> spike 1.0
    check(approx(tc.confidence(of: "Alice", at: 0), 1.0), "decay t=0 -> 1.0 (spike)")
    // t=halfLife -> floor + (spike-floor)*0.5 = 0.25 + 0.75*0.5 = 0.625
    check(approx(tc.confidence(of: "Alice", at: 1200), 0.625), "decay t=halfLife -> 0.625 (midpoint)")
    // t -> infinity -> floor 0.25 (stickiness; never 0 while holder unchanged)
    check(approx(tc.confidence(of: "Alice", at: 1_000_000), 0.25, 1e-6), "decay t->inf -> 0.25 (floor)")
    // Non-holder is always exactly 0.
    equal(tc.confidence(of: "Bob", at: 0), 0.0, "non-holder confidence = 0 (t=0)")
    equal(tc.confidence(of: "Bob", at: 1200), 0.0, "non-holder confidence = 0 (later)")
    // Monotonic non-increase over the decay while the holder is unchanged.
    var prev = tc.confidence(of: "Alice", at: 0)
    var monotone = true
    for t in stride(from: 100, through: 6000, by: 100) {
        let c = tc.confidence(of: "Alice", at: t)
        if c > prev + 1e-12 { monotone = false; break }
        prev = c
    }
    check(monotone, "holder confidence is monotonically non-increasing between edges")

    // Holder-switch re-spike: Alice@0 -> Bob@100 => Alice 0, Bob 1.0.
    tc.edge(to: "Bob", at: 100)
    equal(tc.confidence(of: "Alice", at: 100), 0.0, "holder switched -> old holder Alice = 0")
    check(approx(tc.confidence(of: "Bob", at: 100), 1.0), "holder switched -> new holder Bob re-spikes to 1.0")
    // A repeat edge to the SAME holder re-spikes (fresh burst = fresh evidence).
    tc.edge(to: "Bob", at: 1300)   // 1200ms after the last Bob edge (was at 0.625)
    check(approx(tc.confidence(of: "Bob", at: 1300), 1.0), "same-holder re-edge re-spikes to 1.0")
    // halfLife of 0 -> flat floor (guard against divide-by-zero).
    var flat = TransitionConfidence(config: TransitionConfidenceConfig(spike: 1.0, floor: 0.25, halfLifeMs: 0))
    flat.edge(to: "X", at: 0)
    equal(flat.confidence(of: "X", at: 500), 0.25, "halfLife 0 -> flat floor (no divide-by-zero)")
    // holderConfidence convenience mirrors confidence(of: holder).
    check(approx(tc.holderConfidence(at: 1300), tc.confidence(of: "Bob", at: 1300)), "holderConfidence == confidence(of: holder)")
    equal(TransitionConfidence().holderConfidence(at: 5000), 0.0, "no holder -> holderConfidence 0")
}

// MARK: meetEdgesFromDiff (snapshot diff -> ring-moved / focus-moved / equalizer-onset).
// Pure: no AX, no clock. Self already excluded when the snapshot is built.
print("meetEdgesFromDiff:")
do {
    // ring Alice -> Bob => exactly one ring-moved edge (from Alice, to Bob).
    let a = MeetTileSnapshot(ringHolder: "Alice")
    let b = MeetTileSnapshot(ringHolder: "Bob")
    let e1 = meetEdgesFromDiff(prev: a, next: b, at: 500)
    equal(e1.count, 1, "ring Alice->Bob -> one edge")
    equal(e1.first?.kind, .ringMoved, "ring move -> kind ringMoved")
    equal(e1.first?.from, "Alice", "ring move -> from Alice")
    equal(e1.first?.to, "Bob", "ring move -> to Bob")
    equal(e1.first?.kindToken, "ring-moved", "ring move -> token 'ring-moved'")
    // no change => [].
    equal(meetEdgesFromDiff(prev: b, next: b, at: 600).count, 0, "no change -> []")
    // nil -> focus Carol => one focus-moved edge (from nil, to Carol).
    let e2 = meetEdgesFromDiff(prev: nil, next: MeetTileSnapshot(focusHolder: "Carol"), at: 700)
    equal(e2.count, 1, "nil->focus Carol -> one edge")
    equal(e2.first?.kind, .focusMoved, "focus appear -> kind focusMoved")
    equal(e2.first?.from ?? "<nil>", "<nil>", "focus appear from nothing -> from nil")
    equal(e2.first?.to, "Carol", "focus appear -> to Carol")
    // equalizer silent->speaking onset for a NEW speaker only (existing speaker not re-emitted).
    let e3 = meetEdgesFromDiff(prev: MeetTileSnapshot(equalizerSpeakers: ["Alice"]),
                               next: MeetTileSnapshot(equalizerSpeakers: ["Alice", "Bob"]), at: 800)
    equal(e3.map { $0.to }, ["Bob"], "equalizer onset only for the NEW speaker (Bob)")
    equal(e3.first?.kind, .equalizerOnset, "equalizer onset -> kind equalizerOnset")
    // holder -> nil (signal lost) emits NO edge (a lost signal is not a move).
    equal(meetEdgesFromDiff(prev: MeetTileSnapshot(ringHolder: "Alice"),
                            next: MeetTileSnapshot(ringHolder: nil), at: 900).count, 0,
          "ring lost (->nil) -> no edge")
    // SELF-EXCLUSION (INV-5): a snapshot built from tiles where the only ring/focus
    // is the SELF tile yields no holder -> no edge (self-focus-edge-yields-no-name).
    let selfOnly = MeetTileSnapshot.from(tiles: [
        MeetTileObservation(name: "Me", area: 10_000, orderIndex: 0, classSpeaking: true,
                            isFocused: true, isMe: true, equalizerSpeaking: true),
    ])
    equal(selfOnly.ringHolder ?? "<nil>", "<nil>", "self ring excluded from snapshot (isMe)")
    equal(selfOnly.focusHolder ?? "<nil>", "<nil>", "self focus excluded from snapshot (isMe)")
    equal(selfOnly.equalizerSpeakers, [], "self equalizer excluded from snapshot (isMe)")
    equal(meetEdgesFromDiff(prev: nil, next: selfOnly, at: 1000).count, 0,
          "self-only snapshot -> no edges (self-focus-edge yields no name)")
}

// MARK: Meet rapid-swap disambiguation via .ringTransition (event-driven).
// Two STALE rings the AX tree left lit after a fast swap: with a fresh transition
// holder=Bob the resolver returns EXACTLY ["Bob"] via .ringTransition; the SAME
// tiles with transition:nil return today's overlap set (opt-in non-regression twin).
print("Meet rapid-swap disambiguation (.ringTransition):")
do {
    let staleRings = [
        MeetTileObservation(name: "Alice", area: 10_000, orderIndex: 0, classSpeaking: true),
        MeetTileObservation(name: "Bob",   area: 10_000, orderIndex: 1, classSpeaking: true),
    ]
    // transition holder=Bob, high confidence -> disambiguate to just Bob.
    let toBob = MeetTransitionState(holder: "Bob", confidence: 1.0, nowMs: 1000)
    let r = meetActiveSpeaker(tiles: staleRings, prevAreas: [:], vadSpeechActive: true, transition: toBob)
    equal(r.names, ["Bob"], "two stale rings + transition holder=Bob -> ['Bob']")
    equal(r.via, .ringTransition, "rapid-swap disambiguation -> via .ringTransition")
    check(r.confidence != nil, "ringTransition result carries a confidence")
    // NON-REGRESSION TWIN: same tiles, transition:nil -> today's overlap set (both rings).
    let legacy = meetActiveSpeaker(tiles: staleRings, prevAreas: [:], vadSpeechActive: true, transition: nil)
    equal(legacy.names.sorted(), ["Alice", "Bob"], "transition:nil -> today's overlap set (opt-in non-regression)")
    equal(legacy.via, .cssClass, "transition:nil -> via .cssClass (unchanged)")
    // A self-holder transition must NOT name self (self-exclusion on the edge path).
    let staleWithSelf = [
        MeetTileObservation(name: "Me",  area: 10_000, orderIndex: 0, classSpeaking: true, isMe: true),
        MeetTileObservation(name: "Bob", area: 10_000, orderIndex: 1, classSpeaking: true),
    ]
    let toSelf = MeetTransitionState(holder: "Me", confidence: 1.0, nowMs: 1000)
    let rs = meetActiveSpeaker(tiles: staleWithSelf, prevAreas: [:], vadSpeechActive: true, transition: toSelf)
    check(!rs.names.contains("Me"), "transition holder = SELF -> self never named (falls back to remote ring)")
    equal(rs.names, ["Bob"], "self-holder transition -> remote ring wins (Bob)")
    // transition holder present but NOT among the ring tiles -> fall through to ring set.
    let toGhost = MeetTransitionState(holder: "Nobody", confidence: 1.0, nowMs: 1000)
    let rg = meetActiveSpeaker(tiles: staleRings, prevAreas: [:], vadSpeechActive: true, transition: toGhost)
    equal(rg.names.sorted(), ["Alice", "Bob"], "transition holder not in ring tiles -> ring overlap set (no phantom)")
}

print(failures == 0 ? "\nALL PASSED" : "\n\(failures) FAILURE(S)")
exit(failures == 0 ? 0 : 1)
