import SwiftUI
import SpeakerCore

/// "Event log" — the live Recall-style event stream (meeting + participant +
/// speech lifecycle), newest first. The same events are appended to the NDJSON
/// log file.
struct EventLogView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Card(title: "Event log",
             accessory: AnyView(
                Text("\(model.eventLog.count) event\(model.eventLog.count == 1 ? "" : "s")")
                    .font(.caption).foregroundStyle(.secondary)
             )) {
            if model.eventLog.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(model.eventLog) { row in
                            HStack(spacing: 8) {
                                Text(formatClock(row.ts))
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .frame(width: 64, alignment: .leading)
                                Text(row.type)
                                    .font(.system(.caption2, design: .monospaced).weight(.semibold))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(tint(row.kind).opacity(0.16), in: Capsule())
                                    .foregroundStyle(tint(row.kind))
                                Text(row.summary)
                                    .font(.caption)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 3)
                            Divider().opacity(0.4)
                        }
                    }
                }
                .frame(maxHeight: .infinity)
            }
        }
    }

    private func tint(_ kind: AppModel.EventRow.Kind) -> Color {
        switch kind {
        case .meeting:     return .orange
        case .participant: return .blue
        case .speech:      return .green
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "dot.radiowaves.up.forward")
                .font(.largeTitle)
                .foregroundStyle(.tertiary)
            Text("meeting_initialized, participant_joined, speech_on …")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 160)
    }
}
