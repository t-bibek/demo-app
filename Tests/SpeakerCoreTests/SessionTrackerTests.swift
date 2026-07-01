import XCTest
@testable import SpeakerCore

final class SessionTrackerTests: XCTestCase {
    private func collector() -> (SessionTracker, () -> [TrackerEvent]) {
        var events: [TrackerEvent] = []
        let tracker = SessionTracker(opts: TrackerOptions(endSilenceMs: 2000, pulseWidthMs: 500)) {
            events.append($0)
        }
        return (tracker, { events })
    }

    func testEmitsStartOnFirstPulse() {
        let (t, events) = collector()
        t.pulse(.meet, "Alice", 1000)
        XCTAssertEqual(events().count, 1)
        if case let .start(platform, name, startTs, _) = events()[0] {
            XCTAssertEqual(platform, .meet)
            XCTAssertEqual(name, "Alice")
            XCTAssertEqual(startTs, 1000)
        } else {
            XCTFail("expected .start")
        }
        XCTAssertEqual(t.activeCount, 1)
    }

    func testRepeatedPulseDoesNotRestartSession() {
        let (t, events) = collector()
        t.pulse(.zoom, "Bob", 1000)
        t.pulse(.zoom, "Bob", 1400)
        t.pulse(.zoom, "Bob", 1800)
        // Only the initial start, no second start.
        XCTAssertEqual(events().filter { if case .start = $0 { return true }; return false }.count, 1)
        XCTAssertEqual(t.activeCount, 1)
    }

    func testDurationIncludesPulseWidth() {
        let (t, events) = collector()
        t.pulse(.teams, "Carol", 1000)
        t.pulse(.teams, "Carol", 1500)        // lastSeen = 1500
        // Silence longer than endSilenceMs (2000) closes the session.
        t.update(1500 + 2001)
        let end = events().compactMap { evt -> Int? in
            if case let .end(_, _, _, _, durationMs, _) = evt { return durationMs }
            return nil
        }
        // duration = lastSeen - start + pulseWidth = 1500 - 1000 + 500 = 1000
        XCTAssertEqual(end, [1000])
        XCTAssertEqual(t.activeCount, 0)
    }

    func testUpdateEmitsTickWhileActive() {
        let (t, events) = collector()
        t.pulse(.meet, "Dave", 1000)
        t.update(1200)   // still within endSilenceMs
        let ticks = events().filter { if case .tick = $0 { return true }; return false }
        XCTAssertEqual(ticks.count, 1)
        XCTAssertEqual(t.activeCount, 1)
    }

    func testBlankNameIgnored() {
        let (t, events) = collector()
        t.pulse(.meet, "   ", 1000)
        XCTAssertEqual(events().count, 0)
        XCTAssertEqual(t.activeCount, 0)
    }

    func testEndAllClosesEverything() {
        let (t, events) = collector()
        t.pulse(.meet, "A", 1000)
        t.pulse(.zoom, "B", 1000)
        t.endAll()
        let ends = events().filter { if case .end = $0 { return true }; return false }
        XCTAssertEqual(ends.count, 2)
        XCTAssertEqual(t.activeCount, 0)
    }

    func testLastSeenNeverMovesBackwards() {
        let (t, events) = collector()
        t.pulse(.meet, "A", 2000)
        t.pulse(.meet, "A", 1000)   // out-of-order, ignored for lastSeen
        t.update(2000 + 2001)
        let end = events().compactMap { evt -> Int? in
            if case let .end(_, _, _, _, durationMs, _) = evt { return durationMs }
            return nil
        }
        // lastSeen stayed at 2000, start 2000 => duration = 0 + 500
        XCTAssertEqual(end, [500])
    }
}
