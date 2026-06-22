import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

// Thin Accessibility helpers shared by the probe. Mirrors the attribute set the
// Recall ui_recorder reads (AXRole/AXSubrole/AXFrame/AXPosition/AXSize/
// AXDOMClassList/AXChildren/AXDocument) per docs/recall-and-demo-extraction.md §1.10(c).

enum AX {
    static func copy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v : nil
    }

    static func string(_ el: AXUIElement, _ attr: String) -> String? {
        copy(el, attr) as? String
    }

    /// WRITE a boolean attribute. Used to set AXEnhancedUserInterface /
    /// AXManualAccessibility, which force Chromium/WebView2 apps (Teams, Meet,
    /// Electron) to build their FULL a11y tree — without it they serve a degraded,
    /// mostly-static tree to passive readers and dynamic state may never appear.
    /// Recall does this (it imports AXUIElementSetAttributeValue).
    @discardableResult
    static func setBool(_ el: AXUIElement, _ attr: String, _ value: Bool) -> Bool {
        AXUIElementSetAttributeValue(el, attr as CFString, (value ? kCFBooleanTrue : kCFBooleanFalse)) == .success
    }

    /// AXURL / AXDocument come back as NSURL/CFURL, not String — handle both.
    static func urlString(_ el: AXUIElement, _ attr: String) -> String? {
        guard let v = copy(el, attr) else { return nil }
        if let s = v as? String { return s }
        if let u = v as? URL { return u.absoluteString }
        if let u = v as? NSURL { return u.absoluteString }
        return nil
    }

    static func bool(_ el: AXUIElement, _ attr: String) -> Bool {
        (copy(el, attr) as? NSNumber)?.boolValue ?? (copy(el, attr) as? Bool ?? false)
    }

    static func classList(_ el: AXUIElement) -> [String] {
        (copy(el, "AXDOMClassList") as? [String]) ?? []
    }

    /// Full list of attribute NAMES this element exposes. The prior structure
    /// hunt only read a fixed handful (subrole/id/description); this is how we
    /// catch an indicator keyed on an attribute we never thought to query
    /// (AXRoleDescription, AXHelp, an audio-level AXValue, an ARIA-derived attr).
    static func attributeNames(_ el: AXUIElement) -> [String] {
        var arr: CFArray?
        return AXUIElementCopyAttributeNames(el, &arr) == .success ? (arr as? [String] ?? []) : []
    }

    /// Generic attribute value → compact string (String / NSNumber / Bool) for
    /// the structural fact set. Returns nil for element/array/AXValue types.
    static func valueString(_ el: AXUIElement, _ attr: String) -> String? {
        guard let v = copy(el, attr) else { return nil }
        if let s = v as? String { return s }
        if let b = v as? Bool { return b ? "true" : "false" }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
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
