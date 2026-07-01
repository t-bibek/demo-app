import SwiftUI
import SpeakerCore

/// "Now speaking" — active speakers with a live elapsed timer. Mirrors the
/// original's live-duration section driven by `speaker-tick` events.
struct NowSpeakingView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Card(title: "Now speaking") {
            if model.active.isEmpty {
                Text(model.running ? "No one is speaking right now." : "Press Start to begin detecting.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 6)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(model.active.sorted { $0.durationMs > $1.durationMs }) { speaker in
                            NowSpeakingChip(speaker: speaker)
                        }
                    }
                }
            }
        }
    }
}

struct NowSpeakingChip: View {
    let speaker: AppModel.ActiveSpeaker
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Theme.color(speaker.platform))
                .frame(width: 10, height: 10)
                .opacity(pulse ? 0.35 : 1.0)
                .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: pulse)
            VStack(alignment: .leading, spacing: 1) {
                Text(speaker.name)
                    .font(.body.weight(.semibold))
                Text(speaker.platform.label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Text(formatDuration(speaker.durationMs))
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(Theme.color(speaker.platform))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.color(speaker.platform).opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.color(speaker.platform).opacity(0.3)))
        .onAppear { pulse = true }
    }
}
