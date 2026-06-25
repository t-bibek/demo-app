import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

// Thin Accessibility helpers (copy of the probe helpers — each tool keeps its own
// so it stays a standalone executable). Mirrors the attribute set Recall's
// ui_recorder reads (AXRole/AXSubrole/AXFrame/AXPosition/AXSize/AXDOMClassList/
// AXChildren/AXDocument) per docs/recall-and-demo-extraction.md §1.10(c).

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

    static func classList(_ el: AXUIElement) -> [String] {
        (copy(el, "AXDOMClassList") as? [String]) ?? []
    }

    /// Full list of attribute NAMES this element exposes — the key to "dump
    /// everything": we query each one generically instead of a fixed handful.
    static func attributeNames(_ el: AXUIElement) -> [String] {
        var arr: CFArray?
        return AXUIElementCopyAttributeNames(el, &arr) == .success ? (arr as? [String] ?? []) : []
    }

    static func children(_ el: AXUIElement) -> [AXUIElement] {
        (copy(el, "AXChildren") as? [AXUIElement]) ?? []
    }

    /// Maximal child set: `AXChildren` UNION the alternate child-bearing
    /// relationships that NATIVE apps sometimes populate INSTEAD of (or in
    /// addition to) AXChildren — so we don't miss nodes a plain AXChildren walk
    /// drops. Deduped by element identity (CFEqual). Web apps just return
    /// AXChildren; this only adds for native trees (e.g. Zoom's AXTabGroups).
    static func allChildren(_ el: AXUIElement) -> [AXUIElement] {
        var out = children(el)
        for attr in ["AXChildrenInNavigationOrder", "AXContents", "AXSections", "AXRows", "AXVisibleChildren"] {
            guard let more = copy(el, attr) as? [AXUIElement] else { continue }
            for c in more where !out.contains(where: { CFEqual($0, c) }) {
                // Only augment with REAL elements — skip role-less section/placeholder
                // refs (e.g. Zoom's AXSections returns abstract nodes with no AXRole)
                // so the dump isn't padded with empty `?` phantoms.
                if let r = string(c, "AXRole"), !r.isEmpty { out.append(c) }
            }
        }
        return out
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
