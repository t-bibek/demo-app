import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

// Thin Accessibility helpers (standalone copy, per the per-tool convention).

enum AX {
    static func copy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v : nil
    }

    static func string(_ el: AXUIElement, _ attr: String) -> String? {
        copy(el, attr) as? String
    }

    @discardableResult
    static func setBool(_ el: AXUIElement, _ attr: String, _ value: Bool) -> Bool {
        AXUIElementSetAttributeValue(el, attr as CFString, (value ? kCFBooleanTrue : kCFBooleanFalse)) == .success
    }

    static func classList(_ el: AXUIElement) -> [String] {
        (copy(el, "AXDOMClassList") as? [String]) ?? []
    }

    static func children(_ el: AXUIElement) -> [AXUIElement] {
        (copy(el, "AXChildren") as? [AXUIElement]) ?? []
    }

    /// AXChildren UNION the alternate child-bearing relationships some native apps
    /// populate instead, deduped by identity; skips role-less placeholders.
    static func allChildren(_ el: AXUIElement) -> [AXUIElement] {
        var out = children(el)
        for attr in ["AXChildrenInNavigationOrder", "AXContents", "AXSections", "AXRows", "AXVisibleChildren"] {
            guard let more = copy(el, attr) as? [AXUIElement] else { continue }
            for c in more where !out.contains(where: { CFEqual($0, c) }) {
                if let r = string(c, "AXRole"), !r.isEmpty { out.append(c) }
            }
        }
        return out
    }

    static func windows(_ app: AXUIElement) -> [AXUIElement] {
        (copy(app, "AXWindows") as? [AXUIElement]) ?? []
    }

    static var isTrusted: Bool { AXIsProcessTrusted() }

    static func requestTrust() {
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }
}
