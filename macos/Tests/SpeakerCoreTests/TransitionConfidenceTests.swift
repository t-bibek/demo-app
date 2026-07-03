import XCTest
@testable import SpeakerCore

/// XCTest mirror of the SpeakerCoreSelfTest TransitionConfidence / meetEdgesFromDiff
/// blocks (event-driven ring/focus plan, 2026-07-03). Decay math is time-injected —
/// no clock is read here, so these are fully deterministic.
final class TransitionConfidenceTests: XCTestCase {

    // MARK: decay curve

    func testDefaults() {
        let c = TransitionConfidenceConfig()
        XCTAssertEqual(c.spike, 1.0)
        XCTAssertEqual(c.floor, 0.25)
        XCTAssertEqual(c.halfLifeMs, 1200)
    }

    func testDecayValues() {
        var tc = TransitionConfidence()
        tc.edge(to: "Alice", at: 0)
        XCTAssertEqual(tc.confidence(of: "Alice", at: 0), 1.0, accuracy: 1e-9)          // t=0 -> spike
        XCTAssertEqual(tc.confidence(of: "Alice", at: 1200), 0.625, accuracy: 1e-9)     // t=halfLife -> midpoint
        XCTAssertEqual(tc.confidence(of: "Alice", at: 1_000_000), 0.25, accuracy: 1e-6) // t->inf -> floor
    }

    func testNonHolderIsZero() {
        var tc = TransitionConfidence()
        tc.edge(to: "Alice", at: 0)
        XCTAssertEqual(tc.confidence(of: "Bob", at: 0), 0)
        XCTAssertEqual(tc.confidence(of: "Bob", at: 5000), 0)
    }

    func testMonotonicNonIncrease() {
        var tc = TransitionConfidence()
        tc.edge(to: "Alice", at: 0)
        var prev = tc.confidence(of: "Alice", at: 0)
        for t in stride(from: 100, through: 6000, by: 100) {
            let c = tc.confidence(of: "Alice", at: t)
            XCTAssertLessThanOrEqual(c, prev + 1e-12, "confidence must not increase between edges (t=\(t))")
            prev = c
        }
    }

    func testHolderSwitchRespike() {
        var tc = TransitionConfidence()
        tc.edge(to: "Alice", at: 0)
        tc.edge(to: "Bob", at: 100)
        XCTAssertEqual(tc.confidence(of: "Alice", at: 100), 0)              // old holder drops to 0
        XCTAssertEqual(tc.confidence(of: "Bob", at: 100), 1.0, accuracy: 1e-9)  // new holder re-spikes
    }

    func testSameHolderReEdgeRespikes() {
        var tc = TransitionConfidence()
        tc.edge(to: "Bob", at: 0)
        XCTAssertEqual(tc.confidence(of: "Bob", at: 1200), 0.625, accuracy: 1e-9)
        tc.edge(to: "Bob", at: 1200)   // fresh burst
        XCTAssertEqual(tc.confidence(of: "Bob", at: 1200), 1.0, accuracy: 1e-9)
    }

    func testZeroHalfLifeIsFlatFloor() {
        var tc = TransitionConfidence(config: TransitionConfidenceConfig(spike: 1.0, floor: 0.25, halfLifeMs: 0))
        tc.edge(to: "X", at: 0)
        XCTAssertEqual(tc.confidence(of: "X", at: 500), 0.25)
    }

    // MARK: meetEdgesFromDiff

    func testRingMovedEdge() {
        let e = meetEdgesFromDiff(prev: MeetTileSnapshot(ringHolder: "Alice"),
                                  next: MeetTileSnapshot(ringHolder: "Bob"), at: 500)
        XCTAssertEqual(e.count, 1)
        XCTAssertEqual(e.first?.kind, .ringMoved)
        XCTAssertEqual(e.first?.from, "Alice")
        XCTAssertEqual(e.first?.to, "Bob")
        XCTAssertEqual(e.first?.kindToken, "ring-moved")
    }

    func testNoChangeNoEdge() {
        let s = MeetTileSnapshot(ringHolder: "Bob", focusHolder: "Bob")
        XCTAssertEqual(meetEdgesFromDiff(prev: s, next: s, at: 600).count, 0)
    }

    func testFocusAppearEdge() {
        let e = meetEdgesFromDiff(prev: nil, next: MeetTileSnapshot(focusHolder: "Carol"), at: 700)
        XCTAssertEqual(e.count, 1)
        XCTAssertEqual(e.first?.kind, .focusMoved)
        XCTAssertNil(e.first?.from)
        XCTAssertEqual(e.first?.to, "Carol")
    }

    func testEqualizerOnsetOnlyForNewSpeaker() {
        let e = meetEdgesFromDiff(prev: MeetTileSnapshot(equalizerSpeakers: ["Alice"]),
                                  next: MeetTileSnapshot(equalizerSpeakers: ["Alice", "Bob"]), at: 800)
        XCTAssertEqual(e.map { $0.to }, ["Bob"])
        XCTAssertEqual(e.first?.kind, .equalizerOnset)
    }

    func testSelfExcludedFromSnapshotAndEdges() {
        let selfOnly = MeetTileSnapshot.from(tiles: [
            MeetTileObservation(name: "Me", area: 10_000, orderIndex: 0, classSpeaking: true,
                                isFocused: true, isMe: true, equalizerSpeaking: true),
        ])
        XCTAssertNil(selfOnly.ringHolder)
        XCTAssertNil(selfOnly.focusHolder)
        XCTAssertEqual(selfOnly.equalizerSpeakers, [])
        XCTAssertEqual(meetEdgesFromDiff(prev: nil, next: selfOnly, at: 1000).count, 0)
    }

    // MARK: rapid-swap disambiguation via .ringTransition

    func testRingTransitionDisambiguation() {
        let staleRings = [
            MeetTileObservation(name: "Alice", area: 10_000, orderIndex: 0, classSpeaking: true),
            MeetTileObservation(name: "Bob",   area: 10_000, orderIndex: 1, classSpeaking: true),
        ]
        let toBob = MeetTransitionState(holder: "Bob", confidence: 1.0, nowMs: 1000)
        let r = meetActiveSpeaker(tiles: staleRings, prevAreas: [:], vadSpeechActive: true, transition: toBob)
        XCTAssertEqual(r.names, ["Bob"])
        XCTAssertEqual(r.via, .ringTransition)
        XCTAssertNotNil(r.confidence)
    }

    func testTransitionNilIsNonRegression() {
        let staleRings = [
            MeetTileObservation(name: "Alice", area: 10_000, orderIndex: 0, classSpeaking: true),
            MeetTileObservation(name: "Bob",   area: 10_000, orderIndex: 1, classSpeaking: true),
        ]
        let r = meetActiveSpeaker(tiles: staleRings, prevAreas: [:], vadSpeechActive: true, transition: nil)
        XCTAssertEqual(r.names.sorted(), ["Alice", "Bob"])   // today's overlap set
        XCTAssertEqual(r.via, .cssClass)
        XCTAssertNil(r.confidence)
    }

    func testSelfHolderTransitionExcludesSelf() {
        let staleWithSelf = [
            MeetTileObservation(name: "Me",  area: 10_000, orderIndex: 0, classSpeaking: true, isMe: true),
            MeetTileObservation(name: "Bob", area: 10_000, orderIndex: 1, classSpeaking: true),
        ]
        let toSelf = MeetTransitionState(holder: "Me", confidence: 1.0, nowMs: 1000)
        let r = meetActiveSpeaker(tiles: staleWithSelf, prevAreas: [:], vadSpeechActive: true, transition: toSelf)
        XCTAssertFalse(r.names.contains("Me"))
        XCTAssertEqual(r.names, ["Bob"])
    }
}
