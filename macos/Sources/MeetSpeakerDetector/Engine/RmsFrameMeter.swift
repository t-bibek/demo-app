import Foundation
import AVFoundation

/// RMS frame accumulator shared by `MicMeter` and `SystemAudioMeter` (plan B4).
///
/// The realtime audio callbacks deliver PCM buffers of arbitrary size; the
/// `SchmittVad` state machine wants a steady stream of ~50ms-frame RMS values. This
/// bridges the two: each incoming buffer contributes its sum-of-squares + sample
/// count to a running frame; when the accumulated samples cross the frame boundary
/// (`sampleRate * frameMs/1000`), one frame's RMS is finalized and queued. The
/// engine drains the queue each poll tick and feeds each frame to a `SchmittVad`
/// with `AXKit.monotonicMs()`.
///
/// Frame boundaries are counted in SAMPLES (not wall time), so the accumulation is
/// independent of any clock — it just re-buckets the realtime stream. The queue is
/// bounded so a stalled reader can't grow it without limit.
final class RmsFrameMeter {
    private let lock = NSLock()
    private let frameMs: Int
    /// Samples that make up one frame at the current format's sample rate.
    private var frameSamples: Int = Int(48_000 * 50 / 1000)   // 50ms @ 48kHz until first buffer sets it
    private var sumSquares: Double = 0
    private var sampleCount: Int = 0
    private var frames: [Float] = []
    private let maxQueuedFrames = 256   // ~12.8s of 50ms frames — plenty; drop oldest past it

    init(frameMs: Int = 50) {
        self.frameMs = frameMs
    }

    /// Feed one PCM buffer (realtime thread). Accumulates sum-of-squares over all
    /// channels/samples and finalizes 50ms frames as boundaries are crossed.
    func ingest(_ buffer: AVAudioPCMBuffer) {
        guard let channels = buffer.floatChannelData else { return }
        let frames = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        guard frames > 0, channelCount > 0 else { return }
        let sr = buffer.format.sampleRate
        let fSamples = sr > 0 ? Int(sr * Double(frameMs) / 1000.0) : self.frameSamples

        var localSum: Double = 0
        for c in 0..<channelCount {
            let data = channels[c]
            for i in 0..<frames {
                let v = Double(data[i])
                localSum += v * v
            }
        }

        lock.lock()
        if fSamples > 0 { frameSamples = fSamples }
        sumSquares += localSum
        // Count one "sample slot" per frame per channel so the mean-square divides
        // by the right population (channels averaged, not summed twice).
        sampleCount += frames * channelCount
        let boundary = frameSamples * max(1, channelCount)
        while sampleCount >= boundary && boundary > 0 {
            let meanSquare = sumSquares / Double(boundary)
            let rms = Float(meanSquare.squareRoot())
            appendFrameLocked(rms)
            sumSquares -= meanSquare * Double(boundary)   // carry the remainder forward
            if sumSquares < 0 { sumSquares = 0 }
            sampleCount -= boundary
        }
        lock.unlock()
    }

    private func appendFrameLocked(_ rms: Float) {
        frames.append(min(1, max(0, rms)))
        if frames.count > maxQueuedFrames { frames.removeFirst(frames.count - maxQueuedFrames) }
    }

    /// Drain and clear the completed frames since the last call (engine, per poll).
    func drainFrames() -> [Float] {
        lock.lock(); defer { lock.unlock() }
        let out = frames
        frames.removeAll(keepingCapacity: true)
        return out
    }

    /// Reset all accumulation (meter stop).
    func reset() {
        lock.lock()
        sumSquares = 0
        sampleCount = 0
        frames.removeAll(keepingCapacity: true)
        lock.unlock()
    }
}
