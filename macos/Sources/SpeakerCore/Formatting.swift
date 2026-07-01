import Foundation

/// `formatDuration` ported from src/shared/types.ts.
///
/// Uses the displayed (rounded) value for the branch so 59.96s doesn't render
/// as "60.0s" and the minute path never shows "1m 60s".
public func formatDuration(_ ms: Int) -> String {
    let totalSeconds = Double(ms) / 1000.0
    if Int((totalSeconds * 10).rounded()) < 600 {
        return String(format: "%.1fs", totalSeconds)
    }
    var minutes = Int(totalSeconds / 60.0)            // floor for positive values
    var seconds = Int((totalSeconds.truncatingRemainder(dividingBy: 60.0)).rounded())
    if seconds == 60 {
        minutes += 1
        seconds = 0
    }
    return "\(minutes)m \(String(format: "%02d", seconds))s"
}

/// `formatClock` ported from src/shared/types.ts — 24-hour wall clock.
public func formatClock(_ ts: Int) -> String {
    let date = Date(timeIntervalSince1970: Double(ts) / 1000.0)
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US")
    f.dateFormat = "HH:mm:ss"
    return f.string(from: date)
}
