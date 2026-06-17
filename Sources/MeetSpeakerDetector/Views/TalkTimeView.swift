import SwiftUI
import SpeakerCore

/// "Talk time" — cumulative speaking time per person across active and
/// completed sessions, sorted by duration (the original's stats column).
struct TalkTimeView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Card(title: "Talk time") {
            let rows = model.talkTime
            if rows.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "chart.bar.fill")
                        .font(.largeTitle)
                        .foregroundStyle(.tertiary)
                    Text("Per-person totals will appear here.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 160)
            } else {
                let maxMs = max(1, rows.first?.totalMs ?? 1)
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(rows) { row in
                            TalkTimeRowView(row: row, fraction: Double(row.totalMs) / Double(maxMs))
                        }
                    }
                }
            }
        }
    }
}

struct TalkTimeRowView: View {
    let row: AppModel.TalkTimeRow
    let fraction: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(row.name)
                    .font(.callout.weight(.medium))
                Spacer()
                Text(formatDuration(row.totalMs))
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.15))
                    Capsule()
                        .fill(Color.accentColor.opacity(0.7))
                        .frame(width: max(4, fraction * geo.size.width))
                }
            }
            .frame(height: 6)
        }
    }
}
