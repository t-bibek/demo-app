import XCTest
@testable import SpeakerCore

final class FormattingTests: XCTestCase {
    func testSecondsPath() {
        XCTAssertEqual(formatDuration(0), "0.0s")
        XCTAssertEqual(formatDuration(500), "0.5s")
        XCTAssertEqual(formatDuration(1000), "1.0s")
        XCTAssertEqual(formatDuration(12340), "12.3s")
    }

    func testNoSixtySecondRendering() {
        // 59.96s would round to 60.0s under naive formatting; the branch uses
        // the rounded value so this crosses into the minute path cleanly.
        XCTAssertEqual(formatDuration(59960), "1m 00s")
    }

    func testMinutesPath() {
        XCTAssertEqual(formatDuration(60000), "1m 00s")
        XCTAssertEqual(formatDuration(90000), "1m 30s")
        XCTAssertEqual(formatDuration(3599000), "59m 59s")
    }

    func testNeverShowsSixtySecondsInMinutePath() {
        // 119.96s -> minutes path, seconds rounds to 60 then carries.
        XCTAssertEqual(formatDuration(119960), "2m 00s")
    }
}
