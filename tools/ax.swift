// tools/ax.swift — fast AX driver for iReal Pro.
// AppleScript times out on this app's AX tree; this talks to AXUIElement
// directly and does one thing per invocation.
//
// usage: ax <command> [args]
//   rows                 -> print every row title in the main table, 1-based
//   title <row>          -> print one row's title
//   select <row>         -> click a row
//   share                -> click the Share toolbar button, print its menu
//   shareMenuItem <name> -> click a named item in the Share popover menu
//   menus                -> print every AXMenu in the app with its items
//   panels               -> print any AXSheet / AXDialog / window kinds
//   tree                 -> print the whole tree (roles+labels), depth-limited

import ApplicationServices
import AppKit
import Foundation

func attr(_ e: AXUIElement, _ key: String) -> AnyObject? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, key as CFString, &v) == .success ? (v as AnyObject?) : nil
}
func str(_ e: AXUIElement, _ key: String) -> String { (attr(e, key) as? String) ?? "" }
func role(_ e: AXUIElement) -> String { str(e, kAXRoleAttribute) }
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func rows(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXRowsAttribute) as? [AXUIElement]) ?? [] }

func label(_ e: AXUIElement) -> String {
    if let t = attr(e, kAXTitleAttribute) as? String, !t.isEmpty { return t }
    if let d = attr(e, kAXDescriptionAttribute) as? String, !d.isEmpty {
        // AXCell descriptions look like "Caravan, Duke Ellington, Jazz-Latin, 180 BPM, f minor"
        // -> the first comma-separated field is the song title.
        return String(d.split(separator: ",").first ?? "").trimmingCharacters(in: .whitespaces)
    }
    if let v = attr(e, kAXValueAttribute) as? String, !v.isEmpty { return v }
    // A row's title is the SECOND static text in its cell (the first is the
    // selection checkbox), so prefer a non-empty static-text value.
    for c in children(e) where role(c) == kAXStaticTextRole {
        let v = str(c, kAXValueAttribute)
        if !v.isEmpty { return v }
    }
    for c in children(e) {
        let r = role(c)
        if r == kAXStaticTextRole || r == kAXCellRole {
            let v = label(c)
            if !v.isEmpty { return v }
        }
    }
    return ""
}

func perform(_ e: AXUIElement, _ action: String) -> Bool {
    return AXUIElementPerformAction(e, action as CFString) == .success
}

func findApp() -> AXUIElement? {
    var target: pid_t = 0
    var pids = [pid_t]()
    if AXIsProcessTrusted() {
        // use the running app's pid
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.massimobiolcati.irealbookmac")
        if let p = running.first { return AXUIElementCreateApplication(p.processIdentifier) }
    }
    _ = target; _ = pids
    return nil
}

// fall back to matching by bundle id via NSWorkspace
func appElement() -> AXUIElement? {
    let bundle = "com.massimobiolcati.irealbookmac"
    if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first {
        return AXUIElementCreateApplication(app.processIdentifier)
    }
    return nil
}

let app = appElement()
if app == nil {
    FileHandle.standardError.write("iReal Pro is not running\n".data(using: .utf8)!)
    exit(2)
}
let root = app!

var windowEl: AXUIElement? = nil
var tableEl: AXUIElement? = nil
var outlineEl: AXUIElement? = nil

func walk(_ e: AXUIElement, _ depth: Int) {
    if depth > 8 { return }
    let r = role(e)
    if r == kAXWindowRole && windowEl == nil { windowEl = e }
    if r == kAXTableRole && tableEl == nil { tableEl = e }
    if r == kAXOutlineRole && outlineEl == nil { outlineEl = e }
    for c in children(e) { walk(c, depth + 1) }
}
walk(root, 0)

let cmd = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "rows"
let a = CommandLine.arguments

switch cmd {
case "rows":
    guard let t = tableEl else { print("no table"); exit(1) }
    let rs = rows(t)
    print("COUNT=\(rs.count)")
    for (i, r) in rs.enumerated() { print("\(i + 1)\t\(label(r))") }

case "title":
    let idx = Int(CommandLine.arguments[2]) ?? 1
    guard let t = tableEl, idx >= 1, idx <= rows(t).count else { print("bad row"); exit(1) }
    print(label(rows(t)[idx - 1]))

case "select":
    let idx = Int(CommandLine.arguments[2]) ?? 1
    guard let t = tableEl, idx >= 1, idx <= rows(t).count else { print("bad row"); exit(1) }
    let r = rows(t)[idx - 1]
    if perform(r, kAXPressAction) { print("pressed \(idx): \(label(r))") }
    else {
        // try selecting the row's cell / static text instead
        let st = children(r).first { role($0) == kAXStaticTextRole }
        if let st = st, perform(st, kAXPressAction) { print("pressed text \(idx): \(label(r))") }
        else { print("press failed \(idx)") }
    }

case "share":
    guard let w = windowEl, let tb = children(w).first(where: { role($0) == kAXToolbarRole }) else { print("no toolbar"); exit(1) }
    let btns = children(tb)
    for (i, b) in btns.enumerated() {
        let d = str(b, kAXDescriptionAttribute)
        if d == "Share" {
            _ = perform(b, kAXPressAction)
            print("clicked Share (toolbar idx \(i + 1))")
            Thread.sleep(forTimeInterval: 1.5)
            // find the menu that appeared
            var found = false
            func findMenu(_ e: AXUIElement, _ depth: Int) {
                if found || depth > 8 { return }
                if role(e) == kAXMenuRole {
                    found = true
                    print("MENU:")
                    for (i, mi) in children(e).enumerated() {
                        print("  \(i + 1)\t\(label(mi))\tenabled=\(str(mi, kAXEnabledAttribute))")
                    }
                    return
                }
                for c in children(e) { findMenu(c, depth + 1) }
            }
            findMenu(root, 0)
            if !found { print("no menu appeared") }
            exit(0)
        }
    }
    print("Share button not found; toolbar children:")
    for (i, b) in btns.enumerated() { print("  \(i + 1)\t\(role(b))\t\(str(b, kAXDescriptionAttribute))") }

case "menus":
    func findMenus(_ e: AXUIElement, _ depth: Int) {
        if depth > 8 { return }
        if role(e) == kAXMenuRole {
            print("MENU:")
            for (i, mi) in children(e).enumerated() {
                print("  \(i + 1)\t\(label(mi))\tenabled=\(str(mi, kAXEnabledAttribute))")
            }
        }
        for c in children(e) { findMenus(c, depth + 1) }
    }
    findMenus(root, 0)

case "panels":
    for w in children(root) where role(w) == kAXWindowRole {
        print("WINDOW: \(str(w, kAXTitleAttribute)) role=\(role(w)) sub=\(str(w, kAXSubroleAttribute))")
        for c in children(w) {
            print("  child \(role(c)) \(str(c, kAXDescriptionAttribute)) \(str(c, kAXTitleAttribute))")
        }
    }
    func findSheets(_ e: AXUIElement, _ depth: Int) {
        if depth > 8 { return }
        let r = role(e)
        if r == kAXSheetRole || r == "AXDialog" {
            print("PANEL \(r):")
            for c in children(e) { print("  \(role(c)) | \(label(c))") }
        }
        for c in children(e) { findSheets(c, depth + 1) }
    }
    findSheets(root, 0)

case "tree":
    func dump(_ e: AXUIElement, _ depth: Int) {
        if depth > 9 { return }
        let r = role(e)
        let l = label(e)
        if r != "AXGroup" && r != "AXUnknown" && r != "AXSplitGroup" {
            print(String(repeating: "  ", count: depth) + r + " | " + l)
        }
        for c in children(e) { dump(c, depth + 1) }
    }
    dump(root, 0)

case "pressMenu":
    let needle = a.count > 2 ? a[2] : ""
    var hit = false
    func scanMenu(_ e: AXUIElement, _ depth: Int) {
        if hit || depth > 12 { return }
        if role(e) == kAXMenuItemRole {
            let t = str(e, kAXTitleAttribute)
            let d = str(e, kAXDescriptionAttribute)
            if t == needle || d == needle {
                if perform(e, kAXPressAction) { print("pressed menu item: \(t)"); hit = true }
                else { print("press action failed: \(t)") }
                return
            }
        }
        for c in children(e) { scanMenu(c, depth + 1) }
    }
    scanMenu(root, 0)
    if !hit { print("not found: \(needle)") }

case "find":
    let needle = a.count > 2 ? a[2] : ""
    func scan(_ e: AXUIElement, _ depth: Int) {
        if depth > 12 { return }
        let r = role(e)
        let t = str(e, kAXTitleAttribute)
        let d = str(e, kAXDescriptionAttribute)
        let v = str(e, kAXValueAttribute)
        if (t.contains(needle) || d.contains(needle) || v.contains(needle)) && !needle.isEmpty {
            var pos = CGPoint(x: -1, y: -1)
            var sz = CGSize(width: -1, height: -1)
            if let p = attr(e, kAXPositionAttribute) { AXValueGetValue(p as! AXValue, .cgPoint, &pos) }
            if let s = attr(e, kAXSizeAttribute) { AXValueGetValue(s as! AXValue, .cgSize, &sz) }
            print("\(r)\ttitle=\(t)\tdesc=\(d)\tval=\(v)\tx=\(Int(pos.x))\ty=\(Int(pos.y))\tw=\(Int(sz.width))\th=\(Int(sz.height))")
        }
        for c in children(e) { scan(c, depth + 1) }
    }
    scan(root, 0)

case "toolbar":
    guard let w = windowEl, let tb = children(w).first(where: { role($0) == kAXToolbarRole }) else { print("no toolbar"); exit(1) }
    for (i, b) in children(tb).enumerated() {
        let d = str(b, kAXDescriptionAttribute)
        let t = str(b, kAXTitleAttribute)
        var pos = CGPoint(x: -1, y: -1)
        var sz = CGSize(width: -1, height: -1)
        if let p = attr(b, kAXPositionAttribute) {
            AXValueGetValue(p as! AXValue, .cgPoint, &pos)
        }
        if let s = attr(b, kAXSizeAttribute) {
            AXValueGetValue(s as! AXValue, .cgSize, &sz)
        }
        print("\(i + 1)\trole=\(role(b))\tdesc=\(d)\ttitle=\(t)\tx=\(Int(pos.x))\ty=\(Int(pos.y))\tw=\(Int(sz.width))\th=\(Int(sz.height))")
    }

case "rowdump":
    let idx = Int(CommandLine.arguments[2]) ?? 1
    guard let t = tableEl, idx >= 1, idx <= rows(t).count else { print("bad row"); exit(1) }
    let r = rows(t)[idx - 1]
    print("ROW role=\(role(r)) title=\(str(r, kAXTitleAttribute)) desc=\(str(r, kAXDescriptionAttribute)) value=\(str(r, kAXValueAttribute))")
    func dump(_ e: AXUIElement, _ d: Int) {
        if d > 5 { return }
        let rr = role(e)
        print(String(repeating: "  ", count: d) + rr + " | title=" + str(e, kAXTitleAttribute) + " | desc=" + str(e, kAXDescriptionAttribute) + " | val=" + str(e, kAXValueAttribute) + " | kids=" + String(children(e).count))
        for c in children(e) { dump(c, d + 1) }
    }
    dump(r, 1)

case "outline":
    guard let o = outlineEl else { print("no outline"); exit(1) }
    let rs = rows(o)
    print("OUTLINE COUNT=\(rs.count)")
    for (i, r) in rs.enumerated() { print("\(i + 1)\t\(label(r))") }

default:
    print("unknown command")
}
