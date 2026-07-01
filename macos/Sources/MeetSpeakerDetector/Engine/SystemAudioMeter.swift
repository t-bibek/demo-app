import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreMedia

/// System-audio peak meter — the macOS equivalent of the original's WASAPI
/// *playback* peak. Tells the engine whether remote participants are producing
/// sound, regardless of which app/tab owns it.
///
/// macOS does not let you read another process's output level directly, so we
/// capture system audio with ScreenCaptureKit (excluding our own process) and
/// meter the combined output peak. Requires Screen Recording permission.
@available(macOS 13.0, *)
final class SystemAudioMeter: NSObject, SCStreamOutput, SCStreamDelegate {
    private let peak = AtomicPeak()
    private var stream: SCStream?
    private let sampleQueue = DispatchQueue(label: "msd.system-audio")
    private(set) var running = false
    private(set) var lastError: String?

    /// Latest combined system-output peak in 0..1.
    var currentPeak: Float { peak.current }

    func start() async {
        guard !running else { return }
        do {
            // A content filter needs a display; we only care about its audio.
            let content = try await SCShareableContent.excludingDesktopWindows(false,
                                                                               onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                lastError = "No display available for audio capture."
                return
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])

            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true
            config.sampleRate = 48_000
            config.channelCount = 2
            // Keep the (unused) video path tiny and cheap.
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
            try await stream.startCapture()
            self.stream = stream
            running = true
            lastError = nil
        } catch {
            lastError = error.localizedDescription
            running = false
        }
    }

    func stop() {
        guard running, let stream else { return }
        let s = stream
        self.stream = nil
        running = false
        peak.set(0)
        Task { try? await s.stopCapture() }
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard let pcm = sampleBuffer.toPCMBuffer() else { return }
        peak.set(MicMeter.peak(of: pcm))
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lastError = error.localizedDescription
        running = false
        peak.set(0)
    }
}

extension CMSampleBuffer {
    /// Converts a Linear-PCM audio sample buffer (as delivered by
    /// ScreenCaptureKit) into an `AVAudioPCMBuffer` without copying samples.
    func toPCMBuffer() -> AVAudioPCMBuffer? {
        try? withAudioBufferList { audioBufferList, _ -> AVAudioPCMBuffer? in
            guard let absd = formatDescription?.audioStreamBasicDescription else { return nil }
            guard let format = AVAudioFormat(standardFormatWithSampleRate: absd.mSampleRate,
                                             channels: absd.mChannelsPerFrame) else { return nil }
            return AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: audioBufferList.unsafePointer)
        }
    }
}
