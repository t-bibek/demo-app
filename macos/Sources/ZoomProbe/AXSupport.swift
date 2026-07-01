import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

// Thin Accessibility helpers shared by the probe. Mirrors the attribute set the
// Recall ui_recorder reads (AXRole/AXSubrole/AXFrame/AXPosition/AXSize/
// AXChildren) per docs/recall-and-demo-extraction.md §1.10(c). For NATIVE Zoom
// there is no AXDOMClassList (that's a Chrome-web thing) — the signal, if any,
// lives in AppKit roles + text + child-icon descriptions.

enum AX {
    static func copy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v : nil
    }

    static func string(_ el: AXUIElement, _ attr: String) -> String? {
        copy(el, attr) as? String
    }

    static func bool(_ el: AXUIElement, _ attr: String) -> Bool {
        (copy(el, attr) as? NSNumber)?.boolValue ?? (copy(el, attr) as? Bool ?? false)
    }

    static func children(_ el: AXUIElement) -> [AXUIElement] {
        (copy(el, "AXChildren") as? [AXUIElement]) ?? []
    }

    static func parent(_ el: AXUIElement) -> AXUIElement? {
        guard let v = copy(el, "AXParent") else { return nil }
        guard CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    static func windows(_ app: AXUIElement) -> [AXUIElement] {
        (copy(app, "AXWindows") as? [AXUIElement]) ?? []
    }

    static func rect(_ el: AXUIElement, _ attr: String) -> CGRect? {
        guard let v = copy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var r = CGRect.zero
        return AXValueGetValue(v as! AXValue, .cgRect, &r) ? r : nil
    }

    static func point(_ el: AXUIElement, _ attr: String) -> CGPoint? {
        guard let v = copy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
    }

    static func size(_ el: AXUIElement, _ attr: String) -> CGSize? {
        guard let v = copy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
    }

    /// Best-effort frame: AXFrame if present, else AXPosition + AXSize.
    static func frame(_ el: AXUIElement) -> CGRect? {
        if let r = rect(el, "AXFrame") { return r }
        if let p = point(el, "AXPosition"), let s = size(el, "AXSize") {
            return CGRect(origin: p, size: s)
        }
        return nil
    }

    static var isTrusted: Bool { AXIsProcessTrusted() }

    static func requestTrust() {
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }
}
