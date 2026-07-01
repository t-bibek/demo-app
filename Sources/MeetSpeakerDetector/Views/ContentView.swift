import SwiftUI

/// Top-level layout: header, "Now speaking", a two-column (log | talk time)
/// body, and the status footer — the same structure as the original renderer.
struct ContentView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 14) {
            HeaderView()
            NowSpeakingView()
            HStack(alignment: .top, spacing: 14) {
                LogTableView()
                    .frame(maxWidth: .infinity)
                EventLogView()
                    .frame(maxWidth: .infinity)
                TalkTimeView()
                    .frame(width: 260)
            }
            .frame(maxHeight: .infinity)
            StatusFooterView()
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}
