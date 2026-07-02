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

// MARK: Teams rules (stable aria_*/calling_* tokens; speaking markers seeded)
print("TeamsSpeakerRules:")
let tr = TeamsSpeakerRules.builtin
check(tr.tileIsSpeaking(textBlob: "wedding thapas is active speaker", classTokens: []),
      "is-active-speaker text marker -> speaking")
check(!tr.tileIsSpeaking(textBlob: "wedding thapas", classTokens: []),
      "plain name -> not speaking")
check(tr.tileIsSpeaking(textBlob: "", classTokens: ["vdi-frame-occlusion", "fui-Flex"]),
      "vdi-frame-occlusion class -> speaking (shipped Teams active-speaker anchor)")
check(!tr.tileIsSpeaking(textBlob: "", classTokens: ["vdi-occlusion", "fui-Flex"]),
      "vdi-occlusion (bare, on every tile) -> NOT speaking")
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
// 1) VAD gate closed -> nobody.
equal(teamsActiveSpeaker(tiles: ttSpeaking, prevAreas: [:], vadSpeechActive: false).names, [],
      "vad silent -> no speaker even with is-speaking token")
// 2) structural token wins when speaking.
equal(teamsActiveSpeaker(tiles: ttSpeaking, prevAreas: [:], vadSpeechActive: true).names, ["Alice"],
      "is-speaking token -> name")
equal(teamsActiveSpeaker(tiles: ttSpeaking, prevAreas: [:], vadSpeechActive: true).via, .structural,
      "is-speaking token -> via structural")
// 3) geometry is OFF by default (unverified build must not guess a name).
equal(teamsActiveSpeaker(tiles: ttSpotlight, prevAreas: [:], vadSpeechActive: true).names, ["Someone"],
      "spotlight, no token, geometry off -> Someone floor")
// 3b) geometry ON (post-verification) -> dominant tile named.
equal(teamsActiveSpeaker(tiles: ttSpotlight, prevAreas: [:], vadSpeechActive: true, useGeometry: true).names, ["Alice"],
      "spotlight, geometry on -> dominant tile")
// 4) gallery, no token -> Someone floor.
equal(teamsActiveSpeaker(tiles: ttGallery, prevAreas: [:], vadSpeechActive: true).via, .someoneFloor,
      "gallery, no token -> via someoneFloor")

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

print(failures == 0 ? "\nALL PASSED" : "\n\(failures) FAILURE(S)")
exit(failures == 0 ? 0 : 1)
