import Foundation
import ApplicationServices
import CoreGraphics
#if canImport(AppKit)
import AppKit
#endif

// AXKit — the thin Accessibility (AX) I/O layer, hoisted verbatim out of
// AccessibilityScanner.swift so BOTH the scanner and the new event-driven
// MeetTileObserver read the AX tree through ONE implementation (a diverging copy
// would drift the two detection paths apart — memory `macos-window-parallel-ports`).
//
// This target is deliberately AppKit-light (only `forceActivateForCapture` and
// `forceFullAXTree` touch AppKit / process activation) and carries ZERO detection
// logic — it is pure AX plumbing. `monotonicMs()` lives here (NOT in SpeakerCore),
// so SpeakerCore stays clock-free and deterministic (review invariant INV-6).
public enum AXKit {

    // MARK: Scalar / collection reads (hoisted from AccessibilityScanner)

    public static func axString(_ el: AXUIElement, _ attr: String) -> String? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
        return v as? String
    }

    public static func axArray(_ el: AXUIElement, _ attr: String) -> [AXUIElement] {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return [] }
        return (v as? [AXUIElement]) ?? []
    }

    public static func axClassList(_ el: AXUIElement) -> [String] {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, "AXDOMClassList" as CFString, &v) == .success else { return [] }
        return (v as? [String]) ?? []
    }

    /// Read a boolean AX attribute (e.g. AXFocused). Meet marks the promoted/spotlit
    /// tile with AXFocused:true (live-verified 2026-07-03).
    public static func axBool(_ el: AXUIElement, _ attr: String) -> Bool {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return false }
        if let n = v as? NSNumber { return n.boolValue }
        if CFGetTypeID(v!) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
        return false
    }

    /// The element's on-screen frame (AXFrame → AXSize fallback), in screen points.
    public static func axFrame(_ el: AXUIElement) -> CGRect? {
        var v: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, "AXFrame" as CFString, &v) == .success,
           let v, CFGetTypeID(v) == AXValueGetTypeID() {
            var r = CGRect.zero
            if AXValueGetValue(v as! AXValue, .cgRect, &r) { return r }
        }
        var sv: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, "AXSize" as CFString, &sv) == .success,
           let sv, CFGetTypeID(sv) == AXValueGetTypeID() {
            var s = CGSize.zero
            if AXValueGetValue(sv as! AXValue, .cgSize, &s) { return CGRect(origin: .zero, size: s) }
        }
        return nil
    }

    public static func axParent(_ el: AXUIElement) -> AXUIElement? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, "AXParent" as CFString, &v) == .success, let v,
              CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    /// The AXURL of an element as a string (URL / NSURL / String).
    public static func axURL(_ el: AXUIElement) -> String? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, "AXURL" as CFString, &v) == .success, let v else { return nil }
        if let u = v as? URL { return u.absoluteString }
        if let u = v as? NSURL { return u.absoluteString }
        return v as? String
    }

    // MARK: Materialization side-effects (Chromium AX)

    /// Force the FULL Chromium/Electron a11y tree on the app element. Without these
    /// two flags a Chromium/WebView2 process serves a degraded, mostly-static tree to
    /// passive readers, so dynamic roster/mute/geometry state can be stale or missing.
    /// Idempotent + cheap. (Hoisted so the observer subscribes on the SAME tree the
    /// scanner reads.)
    public static func forceFullAXTree(pid: pid_t) {
        let axApp = AXUIElementCreateApplication(pid)
        AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }

    /// CAPTURE FIX (2026-07-03) — force-activate the target process by PID so Chrome
    /// materializes the LIVE equalizer state. The AXManual/AXEnhanced flags alone are
    /// NOT sufficient: Chrome only publishes the animating equalizer classes when its
    /// window is genuinely frontmost, and System Events' set-frontmost snaps back to a
    /// different same-bundle background Chrome. `NSRunningApplication.activate` targets
    /// THIS exact PID. AppKit-guarded so callers stay platform-portable.
    ///
    /// NOTE (event mode): this pins Chrome frontmost and is a known UX blocker, so the
    /// event path activates AROUND reconcile/subscription (not every 500ms tick) —
    /// handoff §5/§6. Legacy polling keeps its per-scan activation unchanged.
    public static func forceActivateForCapture(pid: pid_t) {
        #if canImport(AppKit)
        guard let running = NSRunningApplication(processIdentifier: pid) else { return }
        if #available(macOS 14.0, *) {
            running.activate()
        } else {
            running.activate(options: [.activateIgnoringOtherApps])
        }
        #endif
    }

    // MARK: Monotonic clock (lives OUTSIDE SpeakerCore — INV-6)

    /// A monotonically non-decreasing millisecond clock for decay/edge math. Uses the
    /// system uptime (unaffected by wall-clock jumps), so `TransitionConfidence`'s
    /// half-life decay is stable across NTP steps / DST. SpeakerCore is deliberately
    /// clock-free (all timestamps are INJECTED); this is the app/AXKit-side source.
    public static func monotonicMs() -> Int {
        Int(DispatchTime.now().uptimeNanoseconds / 1_000_000)
    }
}
