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
check(cleanParticipantName("Bidheyak Thapa") == "Bidheyak Thapa", "real name still passes after control filters")
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

print(failures == 0 ? "\nALL PASSED" : "\n\(failures) FAILURE(S)")
exit(failures == 0 ? 0 : 1)
