import Foundation

/// Thread-safe latest-value holder for an audio peak written from a realtime
/// audio callback and read from the engine poll loop.
final class AtomicPeak {
    private var value: Float = 0
    private let lock = NSLock()

    func set(_ v: Float) {
        lock.lock()
        value = max(0, min(1, v))
        lock.unlock()
    }

    var current: Float {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}
