import SwiftUI
import SpeakerCore

enum Theme {
    static func color(_ p: Platform) -> Color {
        switch p {
        case .meet:  return Color(red: 0.00, green: 0.66, blue: 0.42)
        case .zoom:  return Color(red: 0.13, green: 0.46, blue: 0.99)
        case .teams: return Color(red: 0.42, green: 0.40, blue: 0.85)
        }
    }

    static let cardBackground = Color(nsColor: .controlBackgroundColor)
}

/// Small colored platform pill, like the platform labels in the original UI.
struct PlatformBadge: View {
    let platform: Platform
    var body: some View {
        Text(platform.label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Theme.color(platform).opacity(0.18), in: Capsule())
            .foregroundStyle(Theme.color(platform))
    }
}

/// A reusable titled card container.
struct Card<Content: View>: View {
    let title: String
    var accessory: AnyView? = nil
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(title)
                    .font(.headline)
                Spacer()
                if let accessory { accessory }
            }
            content
        }
        .padding(14)
        .background(Theme.cardBackground, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.primary.opacity(0.06))
        )
    }
}
