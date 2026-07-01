import Foundation
import AppKit
import ApplicationServices
import SpeakerCore

// Zoom WEB active-speaker probe (Chrome / any Chromium `app.zoom.us/wc/...`),
// the browser analogue of the native-Zoom panel probe in ZoomRoster.swift.
//
// Structure of the speaker bar (verified against a live AX dump + the DOM):
//
//   div .speaker-bar-container__horizontal-view-wrap
//     div .speaker-bar-container__video-frame .speaker-bar-container__video-frame--active   ← speaking
//       video-player …                         (present when the CAMERA is ON)
//       div .video-avatar__avatar
//         div .video-avatar__avatar-title       (present when the CAMERA is OFF)
//           img .video-avatar__avatar-img alt="Name"
//         div .video-avatar__avatar-footer
//           span role=none "Name"               → surfaces as AXStaticText value
//     div .speaker-bar-container__video-frame   … (idle tiles)
//     button .speaker-bar-container__switch-button   (nav arrows — NOT tiles)
//
// The `--active` modifier is the active speaker regardless of camera state. The
// NAME is the avatar-img alt (AXDescription) when the camera is off, else the
// footer label (an AXStaticText value) which is always present.
enum ZoomWebProbe {

    struct Result {
        var url: String
        var active: String?   // from the "--active" filmstrip tile
        var big: String?      // from the big "speaker-active-container" tile (fallback)
        var names: [String]   // full roster read off the tiles
    }

    private static let browserBundleIDs: Set<String> = [
        "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary",
        "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser",
        "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
    ]

    /// A real browser OR an installed PWA / "Add to Dock" web app (own app process
    /// with a `…app.<id>` bundle id but the same Chromium AX tree).
    private static func isBrowser(_ bid: String) -> Bool {
        if browserBundleIDs.contains(bid) { return true }
        guard bid.contains(".app.") else { return false }
        return browserBundleIDs.contains { bid.hasPrefix($0) }
    }

    /// Probe every browser window for a Zoom web area and read its speaker bar.
    static func probe() -> Result? {
        for app in NSWorkspace.shared.runningApplications {
            guard let bid = app.bundleIdentifier, !app.isTerminated, isBrowser(bid) else { continue }
            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            for window in AX.windows(axApp) {
                guard let (url, webArea) = zoomWebArea(in: window) else { continue }
                let bar = speakerBar(in: webArea)
                return Result(url: url, active: bar.active, big: bar.big, names: bar.names)
            }
        }
        return nil
    }

    /// The AXWebArea whose AXURL is a zoom.us meeting URL (works for PWAs — the URL
    /// comes off the web area, not an address bar).
    private static func zoomWebArea(in window: AXUIElement) -> (String, AXUIElement)? {
        var found: (String, AXUIElement)?
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if found != nil || n >= 4000 || d > 80 { return }
            n += 1
            if AX.role(el) == "AXWebArea", let u = AX.url(el), u.contains("zoom.us") {
                found = (u, el); return
            }
            for c in AX.children(el) { rec(c, d + 1); if found != nil { return } }
        }
        rec(window, 0)
        return found
    }

    /// A tile's display name: prefer the avatar image alt (camera off), fall back to
    /// the footer label (an AXStaticText, always present — the only source with the
    /// camera on).
    private static func tileName(_ frame: AXUIElement) -> String? {
        var imgName: String?
        var footerName: String?
        func rec(_ el: AXUIElement, _ d: Int) {
            if imgName != nil || d > 60 { return }
            let cls = AX.classList(el)
            if imgName == nil,
               cls.contains("video-avatar__avatar-img") || cls.contains("video-avatar__avatar-title") {
                for a in ["AXDescription", "AXTitle", "AXValue"] {
                    if let s = AX.string(el, a), let clean = cleanParticipantName(s) { imgName = clean; break }
                }
            }
            if footerName == nil, AX.role(el) == "AXStaticText",
               let s = AX.string(el, "AXValue"), let clean = cleanParticipantName(s) {
                footerName = clean
            }
            for c in AX.children(el) { rec(c, d + 1); if imgName != nil { return } }
        }
        rec(frame, 0)
        return imgName ?? footerName
    }

    /// Walk the web area for the speaker-bar / speaker-view tiles.
    static func speakerBar(in webArea: AXUIElement) -> (active: String?, big: String?, names: [String]) {
        var barActive: String?
        var bigActive: String?
        var names: [String] = []
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if n >= 8000 || d > 80 { return }
            n += 1
            let cls = AX.classList(el)
            let isBar = cls.contains { $0.hasPrefix("speaker-bar-container__video-frame") }
            let isBig = cls.contains { $0.hasPrefix("speaker-active-container__video-frame") }
            if isBar || isBig {
                if let nm = tileName(el) {
                    names.append(nm)
                    if cls.contains("speaker-bar-container__video-frame--active") { barActive = nm }
                    else if isBig { bigActive = nm }
                }
                return   // a tile is a leaf here; don't descend further
            }
            for c in AX.children(el) { rec(c, d + 1) }
        }
        rec(webArea, 0)
        var seen = Set<String>()
        return (barActive, bigActive, names.filter { seen.insert($0).inserted })
    }
}
