// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MeetSpeakerDetector",
    platforms: [.macOS(.v13)],
    targets: [
        // Pure, UI-free logic ported 1:1 from the original src/shared/* modules.
        // Kept separate so it can be unit-tested without AppKit/AVFoundation.
        .target(
            name: "SpeakerCore",
            path: "Sources/SpeakerCore"
        ),
        // The macOS app: SwiftUI UI + the native detection engine
        // (AVAudioEngine + ScreenCaptureKit + Accessibility API).
        .executableTarget(
            name: "MeetSpeakerDetector",
            dependencies: ["SpeakerCore"],
            path: "Sources/MeetSpeakerDetector"
        ),
        // Dependency-free self-test (XCTest-free) so the core logic can be
        // verified without a full Xcode install. Run: `swift run SpeakerCoreSelfTest`.
        .executableTarget(
            name: "SpeakerCoreSelfTest",
            dependencies: ["SpeakerCore"],
            path: "Sources/SpeakerCoreSelfTest"
        ),
        // AX tree inspector (macOS equivalent of the original `npm run dump`).
        // Run: `swift run AXDump zoom` to see what Zoom exposes.
        .executableTarget(
            name: "AXDump",
            path: "Sources/AXDump"
        ),
        // Per-tile structural probe for Google Meet (the decisive experiment from
        // docs/recall-and-demo-extraction.md §4). Models each participant tile and
        // tracks geometry + AXDOMClassList + subtree shape over time so we can see
        // whether ANY per-tile AX feature moves with speech. Run: `swift run MeetProbe`.
        .executableTarget(
            name: "MeetProbe",
            dependencies: ["SpeakerCore"],
            path: "Sources/MeetProbe"
        ),
        // Native-Zoom (us.zoom.xos) analog of MeetProbe. Zoom's grid is Metal /
        // AX-opaque (recall-and-demo-extraction.md §1.11), so this fingerprints
        // the Participants-panel rows (roles + text + state, no AXDOMClassList)
        // and reports which tokens toggle with speech. Run: `swift run ZoomProbe`.
        .executableTarget(
            name: "ZoomProbe",
            dependencies: ["SpeakerCore"],
            path: "Sources/ZoomProbe"
        ),
        .testTarget(
            name: "SpeakerCoreTests",
            dependencies: ["SpeakerCore"],
            path: "Tests/SpeakerCoreTests"
        ),
    ]
)
