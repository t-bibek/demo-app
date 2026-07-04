import Foundation
import AVFoundation

/// Microphone peak meter — the macOS equivalent of the original's WASAPI
/// mic-capture peak. Tells the engine whether *you* are speaking.
///
/// Uses `AVAudioEngine` to tap the default input device and track the most
/// recent sample peak (0..1).
final class MicMeter {
    private let engine = AVAudioEngine()
    private let peak = AtomicPeak()
    private var running = false

    /// RMS frame accumulator for the shared SchmittVad (plan B4). Fed in the same
    /// realtime tap that updates `currentPeak`; the engine drains 50ms frames.
    let rmsFrames = RmsFrameMeter()

    /// Latest microphone peak in 0..1.
    var currentPeak: Float { peak.current }
    var isRunning: Bool { running }

    /// Requests microphone permission (no-op if already granted/denied).
    static func requestAccess(_ completion: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            completion(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                DispatchQueue.main.async { completion(ok) }
            }
        default:
            completion(false)
        }
    }

    static var isAuthorized: Bool {
        AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    }

    func start() {
        guard !running else { return }
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        // No usable input (e.g. permission denied or no device) — bail quietly.
        guard format.channelCount > 0, format.sampleRate > 0 else { return }

        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.peak.set(MicMeter.peak(of: buffer))
            self?.rmsFrames.ingest(buffer)
        }
        do {
            try engine.start()
            running = true
        } catch {
            input.removeTap(onBus: 0)
            running = false
        }
    }

    func stop() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        peak.set(0)
        rmsFrames.reset()
        running = false
    }

    static func peak(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channels = buffer.floatChannelData else { return 0 }
        let frames = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        var maxValue: Float = 0
        for c in 0..<channelCount {
            let data = channels[c]
            for i in 0..<frames {
                let v = abs(data[i])
                if v > maxValue { maxValue = v }
            }
        }
        return maxValue
    }
}
