import SwiftUI
import SpeakerCore

/// Footer with the latest engine status message and an expandable history,
/// mirroring the original's "footer with expandable engine status messages".
struct StatusFooterView: View {
    @EnvironmentObject var model: AppModel
    @State private var expanded = false

    private var latest: EngineStatus? { model.statusMessages.last }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: icon(latest?.level))
                    .foregroundStyle(color(latest?.level))
                Text(latest?.message ?? "Engine idle.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                if let url = model.logURL {
                    Button {
                        NSWorkspace.shared.activateFileViewerSelecting([url])
                    } label: {
                        Label("Log file", systemImage: "doc.text")
                    }
                    .controlSize(.small)
                    .buttonStyle(.borderless)
                }
                if model.statusMessages.count > 1 {
                    Button(expanded ? "Hide" : "Details") { expanded.toggle() }
                        .controlSize(.small)
                        .buttonStyle(.borderless)
                }
            }

            if expanded {
                ScrollView {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(model.statusMessages.suffix(50).reversed()) { s in
                            HStack(alignment: .top, spacing: 6) {
                                Text(formatClock(s.ts))
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                                Image(systemName: icon(s.level))
                                    .font(.caption2)
                                    .foregroundStyle(color(s.level))
                                Text(s.message)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                Spacer()
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 120)
            }
        }
        .padding(10)
        .background(Theme.cardBackground, in: RoundedRectangle(cornerRadius: 10))
    }

    private func icon(_ level: StatusLevel?) -> String {
        switch level {
        case .warn:  return "exclamationmark.triangle.fill"
        case .error: return "xmark.octagon.fill"
        default:     return "info.circle.fill"
        }
    }

    private func color(_ level: StatusLevel?) -> Color {
        switch level {
        case .warn:  return .orange
        case .error: return .red
        default:     return .secondary
        }
    }
}
