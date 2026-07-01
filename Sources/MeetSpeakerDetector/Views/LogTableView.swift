import SwiftUI
import SpeakerCore

/// "Speaking log" — the live speech event feed: one row per `speech_on` and
/// `speech_off`, newest first (not just completed sessions).
struct LogTableView: View {
    @EnvironmentObject var model: AppModel

    private var speech: [AppModel.EventRow] { model.eventLog.filter { $0.kind == .speech } }

    var body: some View {
        Card(title: "Speaking log",
             accessory: AnyView(
                Text("\(speech.count) event\(speech.count == 1 ? "" : "s")")
                    .font(.caption).foregroundStyle(.secondary)
             )) {
            if speech.isEmpty {
                emptyState
            } else {
                Table(speech) {
                    TableColumn("Time") { row in
                        Text(formatClock(row.ts))
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    .width(min: 72, ideal: 80)
                    TableColumn("Platform") { row in
                        if let p = row.platform { PlatformBadge(platform: p) }
                    }
                    .width(min: 96, ideal: 120)
                    TableColumn("Speaker") { row in
                        Text(row.name ?? "—")
                    }
                    TableColumn("Event") { row in
                        HStack(spacing: 6) {
                            Image(systemName: row.isSpeechOn ? "mic.fill" : "mic.slash")
                                .font(.caption2)
                                .foregroundStyle(row.isSpeechOn ? Color.green : Color.secondary)
                            Text(row.isSpeechOn
                                 ? "speech_on"
                                 : "speech_off · \(formatDuration(row.durationMs ?? 0))")
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(row.isSpeechOn ? .primary : .secondary)
                        }
                    }
                    .width(min: 140, ideal: 170)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "list.bullet.rectangle")
                .font(.largeTitle)
                .foregroundStyle(.tertiary)
            Text("speech_on / speech_off events will appear here.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 160)
    }
}
