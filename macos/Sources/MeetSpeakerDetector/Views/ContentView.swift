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
        .onAppear {
            // Headless/live-run harness hook: auto-start detection when
            // MSD_AUTOSTART=1 so the app can run under `swift run` in the
            // background without a human clicking Start. No-op otherwise.
            if ProcessInfo.processInfo.environment["MSD_AUTOSTART"] == "1", !model.running {
                model.startEngine()
            }
        }
    }
}
