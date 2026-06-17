import XCTest
@testable import SpeakerCore

final class NdjsonTests: XCTestCase {
    func testParsesWholeLines() {
        var values: [Any] = []
        let p = NdjsonParser(onValue: { values.append($0) })
        p.push("{\"a\":1}\n{\"b\":2}\n")
        XCTAssertEqual(values.count, 2)
        XCTAssertEqual((values[0] as? [String: Any])?["a"] as? Int, 1)
        XCTAssertEqual((values[1] as? [String: Any])?["b"] as? Int, 2)
    }

    func testHandlesSplitChunks() {
        var values: [Any] = []
        let p = NdjsonParser(onValue: { values.append($0) })
        p.push("{\"a\"")
        p.push(":1}\n{\"b")
        p.push("\":2}\n")
        XCTAssertEqual(values.count, 2)
        XCTAssertEqual((values[1] as? [String: Any])?["b"] as? Int, 2)
    }

    func testStripsCarriageReturns() {
        var values: [Any] = []
        let p = NdjsonParser(onValue: { values.append($0) })
        p.push("{\"a\":1}\r\n")
        XCTAssertEqual(values.count, 1)
    }

    func testFlushHandlesTrailingLine() {
        var values: [Any] = []
        let p = NdjsonParser(onValue: { values.append($0) })
        p.push("{\"a\":1}")   // no trailing newline
        XCTAssertEqual(values.count, 0)
        p.flush()
        XCTAssertEqual(values.count, 1)
    }

    func testBadLineReported() {
        var bad: [String] = []
        let p = NdjsonParser(onValue: { _ in }, onBadLine: { line, _ in bad.append(line) })
        p.push("not json\n")
        XCTAssertEqual(bad, ["not json"])
    }
}
