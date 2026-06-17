import SwiftUI
import SpeakerCore

/// Header: title, per-platform connection/audio status chips, permission
/// warnings, and the Start/Stop control. Mirrors the original header with
/// "platform status indicators showing connection health and audio activity".
struct HeaderView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Meeting Speaker Logger")
                        .font(.title2.weight(.bold))
                    Text("Logs who is speaking in Google Meet, Zoom & Teams — in real time.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(action: { model.toggle() }) {
                    Label(model.running ? "Stop" : "Start",
                          systemImage: model.running ? "stop.fill" : "play.fill")
                        .frame(minWidth: 64)
                }
                .keyboardShortcut(.defaultAction)
                .controlSize(.large)
                .tint(model.running ? .red : .accentColor)
            }

            statusChips
            permissionsBar
        }
    }

    private var statusChips: some View {
        HStack(spacing: 8) {
            if model.windows.isEmpty {
                Label(model.running ? "Listening — no meeting window detected"
                                    : "Idle — press Start",
                      systemImage: "dot.radiowaves.left.and.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.windows) { w in
                    PlatformStatusChip(window: w)
                }
            }
            Spacer()
        }
    }

    @ViewBuilder
    private var permissionsBar: some View {
        let needsMic = !model.micAuthorized
        let needsAX = !model.axTrusted
        let needsScreen = !model.screenAuthorized

        if model.needsRelaunch {
            HStack(spacing: 10) {
                Image(systemName: "arrow.clockwise.circle.fill")
                    .foregroundStyle(Color.accentColor)
                Text("Permission changed — relaunch to apply. Screen Recording & Accessibility only take effect after a restart.")
                    .font(.caption)
                Spacer()
                Button("Relaunch") { model.relaunch() }
                    .controlSize(.small)
                    .keyboardShortcut("r", modifiers: [.command])
            }
            .padding(8)
            .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        } else if needsMic || needsAX || needsScreen {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 1) {
                    if needsAX {
                        Text("Accessibility permission needed to read speaker names.")
                            .font(.caption)
                    }
                    if needsScreen {
                        Text("Screen Recording permission needed to detect remote audio.")
                            .font(.caption)
                    }
                    if needsMic {
                        Text("Microphone permission needed to log your own speech.")
                            .font(.caption)
                    }
                }
                Spacer()
                Button("Grant permissions") { model.requestPermissions() }
                    .controlSize(.small)
            }
            .padding(8)
            .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// One platform's live status: name, accessibility-tree health, audio level.
struct PlatformStatusChip: View {
    let window: EngineWindowInfo

    private var audioActive: Bool { (window.audioPeak ?? 0) > 0.02 }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(audioActive ? Theme.color(window.platform) : Color.secondary.opacity(0.4))
                .frame(width: 8, height: 8)
            Text(window.platform.label)
                .font(.caption.weight(.semibold))
            // Audio level meter.
            AudioLevelBar(level: window.audioPeak ?? 0, color: Theme.color(window.platform))
            // Accessibility-tree health (names readable?).
            Image(systemName: (window.treeOk ?? true) ? "text.magnifyingglass" : "eye.slash")
                .font(.caption2)
                .foregroundStyle((window.treeOk ?? true) ? Color.secondary : Color.orange)
                .help((window.treeOk ?? true)
                      ? "Accessibility names readable (\(window.nodeCount) nodes)"
                      : "Names unavailable — audio detection only")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Theme.cardBackground, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.08)))
    }
}

struct AudioLevelBar: View {
    let level: Double
    let color: Color
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.2))
                Capsule()
                    .fill(color)
                    .frame(width: max(2, min(1.0, level * 4) * geo.size.width))
            }
        }
        .frame(width: 40, height: 5)
    }
}
