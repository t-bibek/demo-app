import SwiftUI
import AppKit

/// Ensures the app launches as a regular, foreground GUI app.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct MeetSpeakerDetectorApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup("Meeting Speaker Logger") {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 940, minHeight: 640)
        }
        .windowResizability(.contentMinSize)
    }
}
