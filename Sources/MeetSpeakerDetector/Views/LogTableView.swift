import SwiftUI
import SpeakerCore

/// "Speaking log" — one row per completed speaking session, newest first.
struct LogTableView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Card(title: "Speaking log",
             accessory: AnyView(
                Text("\(model.sessions.count) session\(model.sessions.count == 1 ? "" : "s")")
                    .font(.caption).foregroundStyle(.secondary)
             )) {
            if model.sessions.isEmpty {
                emptyState
            } else {
                Table(model.sessions) {
                    TableColumn("Time") { row in
                        Text(formatClock(row.startTs))
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    .width(min: 72, ideal: 80)
                    TableColumn("Platform") { row in
                        PlatformBadge(platform: row.platform)
                    }
                    .width(min: 96, ideal: 120)
                    TableColumn("Speaker") { row in
                        Text(row.name)
                    }
                    TableColumn("Duration") { row in
                        Text(formatDuration(row.durationMs))
                            .font(.system(.body, design: .monospaced))
                    }
                    .width(min: 72, ideal: 80)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "list.bullet.rectangle")
                .font(.largeTitle)
                .foregroundStyle(.tertiary)
            Text("Completed speaking turns will appear here.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 160)
    }
}
