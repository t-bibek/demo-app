import XCTest
@testable import SpeakerCore

final class MeetingIdentityTests: XCTestCase {
    func testMeetCodeFromURL() {
        XCTAssertEqual(meetingCode(platform: .meet, url: "https://meet.google.com/xza-ddbx-ebn"), "xza-ddbx-ebn")
    }

    func testZoomCodeFromURL() {
        XCTAssertEqual(meetingCode(platform: .zoom, url: "https://app.zoom.us/wc/89012345678/join"), "89012345678")
    }

    func testURLCodeDrivesIdOverVolatileTitle() {
        XCTAssertEqual(
            meetingId(platform: .meet, url: "https://meet.google.com/xza-ddbx-ebn",
                      title: "(2) Meet - xza-ddbx-ebn - Google Chrome"),
            "meet::xza-ddbx-ebn")
    }

    func testTitleNormalizationStableAcrossChrome() {
        // (2) unread prefix + recording clause + browser suffix all normalize away.
        XCTAssertEqual(
            meetingId(platform: .meet, url: nil, title: "(2) Meet - abc-defg-hij - Google Chrome"),
            meetingId(platform: .meet, url: nil,
                      title: "Meet - abc-defg-hij - Camera and microphone recording - Google Chrome - Bibek"))
    }

    func testDistinctCodesDoNotCollapse() {
        XCTAssertNotEqual(
            meetingId(platform: .meet, url: "https://meet.google.com/aaa-bbbb-ccc", title: ""),
            meetingId(platform: .meet, url: "https://meet.google.com/ddd-eeee-fff", title: ""))
    }

    func testParticipantIdNamespacedAndNormalized() {
        XCTAssertEqual(participantId(meetingId: "meet::abc", name: "Wedding Thapas"),
                       "meet::abc::wedding thapas")
    }
}

final class MeetingStateTrackerTests: XCTestCase {
    private let mid = "meet::abc"

    private func part(_ name: String, muted: Bool? = nil, speaking: Bool? = nil, local: Bool? = nil) -> MeetingParticipant {
        MeetingParticipant(id: participantId(meetingId: mid, name: name), name: name,
                           isLocal: local, isMuted: muted, isSpeaking: speaking)
    }

    private func snap(_ parts: [MeetingParticipant]) -> MeetingSnapshot {
        MeetingSnapshot(id: mid, platform: .meet, title: "Meet - abc",
                        participants: parts, startedAt: 0, updatedAt: 0)
    }

    private func tracker(grace: Int = 1000) -> (MeetingStateTracker, () -> [MeetingEvent]) {
        var ev: [MeetingEvent] = []
        let mt = MeetingStateTracker(opts: .init(graceMs: grace)) { ev.append($0) }
        return (mt, { ev })
    }

    func testInitEmitsMeetingAndJoins() {
        let (mt, ev) = tracker()
        mt.observe([snap([part("Alice"), part("Bob")])], 1000)
        XCTAssertTrue(ev().contains { if case .meetingInitialized = $0 { return true }; return false })
        XCTAssertEqual(ev().filter { if case .participantJoined = $0 { return true }; return false }.count, 2)
    }

    func testFlickerWithinGraceNoLeave() {
        let (mt, ev) = tracker()
        mt.observe([snap([part("Alice"), part("Bob"), part("Carol")])], 1000)
        mt.observe([snap([part("Alice"), part("Bob")])], 1500)   // Carol missing < grace
        XCTAssertEqual(ev().filter { if case .participantLeft = $0 { return true }; return false }.count, 0)
    }

    func testAbsentPastGraceLeaves() {
        let (mt, ev) = tracker()
        mt.observe([snap([part("Alice"), part("Bob"), part("Carol")])], 1000)
        mt.observe([snap([part("Alice"), part("Bob")])], 3000)   // Carol unseen > grace
        XCTAssertTrue(ev().contains { if case let .participantLeft(_, _, name, _) = $0 { return name == "Carol" }; return false })
    }

    func testMuteFlipEmitsOneUpdate() {
        let (mt, ev) = tracker()
        mt.observe([snap([part("Alice"), part("Bob")])], 1000)
        mt.observe([snap([part("Alice", muted: true), part("Bob")])], 1200)
        XCTAssertEqual(ev().filter { if case let .participantUpdated(_, p, _) = $0 { return p.name == "Alice" }; return false }.count, 1)
    }

    func testNilMuteReadIsSticky() {
        let (mt, ev) = tracker()
        mt.observe([snap([part("Alice", muted: false), part("Bob")])], 1000)
        let before = ev().count
        mt.observe([snap([part("Alice", muted: nil), part("Bob")])], 1200)   // panel closed -> unknown
        XCTAssertEqual(ev().count - before, 0, "value->nil keeps last known, no churn")
    }

    func testSpeakingFlipDoesNotEmitParticipantUpdate() {
        let (mt, ev) = tracker()
        mt.observe([snap([part("Alice"), part("Bob")])], 1000)
        let before = ev().count
        mt.observe([snap([part("Alice", speaking: true), part("Bob")])], 1200)
        XCTAssertEqual(ev().filter { if case .participantUpdated = $0 { return true }; return false }.count, 0)
        _ = before
    }

    func testTwoSameIdSnapshotsMergeToOneMeeting() {
        var ev: [MeetingEvent] = []
        let mt = MeetingStateTracker { ev.append($0) }
        func one(_ n: String) -> MeetingSnapshot {
            MeetingSnapshot(id: mid, platform: .meet, title: "Meet",
                            participants: [part(n)], startedAt: 0, updatedAt: 0)
        }
        mt.observe([one("Alice"), one("Bob")], 1000)
        XCTAssertEqual(mt.meetingCount, 1)
        XCTAssertEqual(ev().filter { if case .participantJoined = $0 { return true }; return false }.count, 2)
    }

    func testEmptyRosterTickDoesNotEvict() {
        let (mt, ev) = tracker(grace: 500)
        mt.observe([snap([part("Alice")])], 1000)
        mt.observe([snap([])], 5000)   // empty/unreadable tree, well past grace
        XCTAssertEqual(ev().filter { if case .participantLeft = $0 { return true }; return false }.count, 0)
        XCTAssertEqual(mt.meetingCount, 1)
    }

    func testEndAllEndsMeetings() {
        let (mt, ev) = tracker()
        mt.observe([snap([part("Alice")])], 1000)
        mt.endAll(2000)
        XCTAssertTrue(ev().contains { if case .meetingEnded = $0 { return true }; return false })
        XCTAssertEqual(mt.meetingCount, 0)
    }
}
