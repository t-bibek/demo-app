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
    if case let .start(p, n, s) = events.first {
        check(p == .meet && n == "Alice" && s == 1000, "start payload correct")
    } else { check(false, "first event is .start") }

    t.pulse(.meet, "Alice", 1400)
    t.pulse(.meet, "Alice", 1500)   // lastSeen = 1500, no new start
    let starts = events.filter { if case .start = $0 { return true }; return false }.count
    equal(starts, 1, "repeated pulses don't restart")

    t.update(1500 + 2001)           // silence > endSilenceMs closes it
    let ends = events.compactMap { e -> Int? in
        if case let .end(_, _, _, _, d) = e { return d }; return nil
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
        if case let .end(_, _, _, _, dd) = e { return dd }; return nil
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
check(cleanParticipantName("David's Iphone") == "David's Iphone", "zoom native phone participant still a name")
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

// MARK: MeetSpeakerRules (verified active-speaker class cluster)
print("MeetSpeakerRules:")
check(meetTileIsSpeaking(classTokens: ["kssMZb", "OFfHfd", "urlhDe"]), "kssMZb (thumbnail speaker) -> speaking")
check(meetTileIsSpeaking(classTokens: ["eT1oJ", "hk9qKe"]), "self spotlight cluster -> speaking")
check(!meetTileIsSpeaking(classTokens: ["FTMc0c", "OFfHfd", "urlhDe"]), "silent state -> not speaking")
check(!meetTileIsSpeaking(classTokens: []), "empty -> not speaking")
check(meetTileIsSpeaking(classTokens: ["xyz"], rules: MeetSpeakerRules(speakingClasses: ["xyz"], version: "test")), "custom remote-config ruleset works")

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

print(failures == 0 ? "\nALL PASSED" : "\n\(failures) FAILURE(S)")
exit(failures == 0 ? 0 : 1)
