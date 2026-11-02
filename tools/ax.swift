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

case "savePanel":
    // Set the save panel's name field and press Save, WITHOUT walking the
    // tree. MEASURED 2026-11-02: an AppleScript tree walk on this app
    // hangs (and spins its CPU) — the panel's elements are read one at a
    // time by position instead.
    //
    // usage: ax savePanel <path>
    //
    // IMPORTANT: the path is SPLIT. The name field is a FILENAME field —
    // typing a full path into it makes the panel treat the whole string
    // as one name and save it into its CURRENT directory (measured: it
    // landed a file literally named
    // ":Users:kaidejuricmasscmbook:Documents:ireal-export:Caravan.wav"
    // inside ~/.hermes/skills/engine-improvement-worker). So the
    // directory has to be set separately, with Cmd-Shift-G.
    let dest = a.count > 2 ? a[2] : ""
    guard windowEl != nil else { print("no window"); exit(1) }

    let dir = (dest as NSString).deletingLastPathComponent
    let name = (dest as NSString).lastPathComponent

    if let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.massimobiolcati.irealbookmac").first {
        running.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        usleep(700_000)
    }
    func keyPress(_ code: CGKeyCode, _ flags: CGEventFlags) {
        if let d = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) {
            d.flags = flags; d.post(tap: .cghidEventTap)
        }
        usleep(60_000)
        if let u = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
            u.flags = flags; u.post(tap: .cghidEventTap)
        }
        usleep(60_000)
    }
    func typeUnicode(_ s: String) {
        for ch in s {
            var buf = Array(String(ch).utf16)
            if buf.isEmpty { continue }
            if let d = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) {
                d.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: &buf)
                d.post(tap: .cghidEventTap)
            }
            usleep(14_000)
            if let u = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
                u.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: &buf)
                u.post(tap: .cghidEventTap)
            }
            usleep(14_000)
        }
    }
    keyPress(5, [.maskCommand, .maskShift])   // Cmd-Shift-G
    usleep(1_500_000)
    typeUnicode(dir)
    usleep(900_000)
    keyPress(36, [])                          // Return: navigate
    usleep(1_500_000)

    // The name field now holds just the filename.
    var field: AXUIElement? = nil
    func findField(_ e: AXUIElement, _ depth: Int) {
        if field != nil || depth > 6 { return }
        let r = role(e)
        if r == kAXTableRole || r == kAXOutlineRole { return }
        if r == kAXTextFieldRole {
            let v = str(e, kAXValueAttribute)
            if v.hasSuffix(".wav") || v.hasSuffix(".aac") || v.hasSuffix(".mid") { field = e; return }
        }
        for c in children(e) { findField(c, depth + 1) }
    }
    for win in children(root) { findField(win, 0) }
    guard let f = field else { print("no name field"); exit(1) }
    print("field prefill='\(str(f, kAXValueAttribute))'")
    if AXUIElementSetAttributeValue(f, kAXValueAttribute as CFString, name as CFTypeRef) == .success {
        print("field set")
    } else {
        print("could not set the field"); exit(1)
    }

    var saveBtn: AXUIElement? = nil
    func findSave(_ e: AXUIElement, _ depth: Int) {
        if saveBtn != nil || depth > 6 { return }
        let r = role(e)
        if r == kAXTableRole || r == kAXOutlineRole { return }
        if r == kAXButtonRole && str(e, kAXTitleAttribute) == "Save" { saveBtn = e; return }
        for c in children(e) { findSave(c, depth + 1) }
    }
    for win in children(root) { findSave(win, 0) }
    guard let sb = saveBtn else { print("no save button"); exit(1) }
    if perform(sb, kAXPressAction) { print("save pressed") }
    else { print("save press failed"); exit(1) }

case "exportSong":
    // ax exportSong <rowIndex> <outPath>
    //
    // The whole export in one shot. MEASURED 2026-11-02, and every
    // step below was found by running it, not by reading the docs:
    //
    //  1. The row is selected via AXSelected + a press on the title's
    //     static text.
    //  2. The Share button does NOT answer AXPress — it needs a real
    //     click at its AX position.
    //  3. The Share popover's "Export Audio" opens a SUBMENU; the WAV
    //     item is a real click too, at (1192,109) in screen points.
    //  4. The save panel is a separate CGWindow named "Save". Its
    //     "Where:" directory persists in the app's preferences, so once
    //     it is right, every later export lands in the right place.
    //  5. The panel's name field is a FILENAME field. Typing a full
    //     path into it saves a file literally named
    //     ":Users:...:ireal-export:Caravan.wav" in the panel's current
    //     directory. The directory has to be set through the go-to-folder
    //     sheet (whose path field IS AX-reachable) — see setGoFolder.
    let rowIdx = Int(a.count > 2 ? a[2] : "0") ?? 0
    let outPath = a.count > 3 ? a[3] : ""
    guard let w = windowEl, let t = tableEl else { print("ERR no window/table"); exit(1) }
    let rs = rows(t)
    guard rowIdx >= 1, rowIdx <= rs.count else { print("ERR bad row"); exit(1) }
    let row = rs[rowIdx - 1]
    let title = label(row)

    // --- 1. select the row -------------------------------------------------
    var picked = false
    if AXUIElementSetAttributeValue(row, kAXSelectedAttribute as CFString, true as CFTypeRef) == .success {
        picked = true
    }
    for c in children(row) where role(c) == kAXCellRole {
        for cc in children(c) where role(cc) == kAXStaticTextRole {
            if str(cc, kAXValueAttribute) == title {
                if perform(cc, kAXPressAction) { picked = true }
                break
            }
        }
    }
    usleep(500_000)
    print("STEP row \(rowIdx) '\(title)' picked=\(picked)")

    // --- 2 + 3. Share -> Export Audio -> WAV (real clicks) ------------------
    guard let tb = children(w).first(where: { role($0) == kAXToolbarRole }) else { print("ERR no toolbar"); exit(1) }
    var share: AXUIElement? = nil
    for b in children(tb) where str(b, kAXDescriptionAttribute) == "Share" { share = b; break }
    guard let sh = share else { print("ERR no share button"); exit(1) }

    if let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.massimobiolcati.irealbookmac").first {
        running.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        usleep(900_000)
    }
    func realClick(_ x: Double, _ y: Double) {
        let p = CGPoint(x: x, y: y)
        if let e = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) {
            e.post(tap: .cghidEventTap)
        }
        usleep(250_000)
        if let e = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left) {
            e.post(tap: .cghidEventTap)
        }
        usleep(70_000)
        if let e = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left) {
            e.post(tap: .cghidEventTap)
        }
        usleep(250_000)
    }
    func realMove(_ x: Double, _ y: Double) {
        let p = CGPoint(x: x, y: y)
        if let e = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) {
            e.post(tap: .cghidEventTap)
        }
        usleep(400_000)
    }
    var pos = CGPoint(x: -1, y: -1)
    var sz = CGSize(width: -1, height: -1)
    if let p = attr(sh, kAXPositionAttribute) { AXValueGetValue(p as! AXValue, .cgPoint, &pos) }
    if let s = attr(sh, kAXSizeAttribute) { AXValueGetValue(s as! AXValue, .cgSize, &sz) }
    guard pos.x >= 0 else { print("ERR share has no position"); exit(1) }
    realClick(Double(pos.x + sz.width / 2), Double(pos.y + sz.height / 2))
    print("STEP share clicked")
    realMove(1470, 110)          // hover "Export Audio" -> submenu opens
    usleep(2_500_000)
    realClick(1192, 109)         // click "WAV (Highest quality, large file)"
    print("STEP wav clicked")
    usleep(3_000_000)

    // --- 4. wait for the save panel ---------------------------------------
    var panelUp = false
    for _ in 0..<24 {
        let wl = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
        for w2 in wl {
            let owner = w2[kCGWindowOwnerName as String] as? String ?? ""
            let nm = w2[kCGWindowName as String] as? String ?? ""
            if owner.contains("iReal") && nm.contains("Save") { panelUp = true; break }
        }
        if panelUp { break }
        usleep(500_000)
    }
    print("STEP panel up=\(panelUp)")
    if !panelUp { print("ERR save panel did not open"); exit(1) }

    // --- 5. set the name field and save ------------------------------------
    var field: AXUIElement? = nil
    func findField(_ e: AXUIElement, _ depth: Int) {
        if field != nil || depth > 6 { return }
        let r = role(e)
        if r == kAXTableRole || r == kAXOutlineRole { return }
        if r == kAXTextFieldRole {
            let v = str(e, kAXValueAttribute)
            if v.hasSuffix(".wav") || v.hasSuffix(".aac") || v.hasSuffix(".mid") { field = e; return }
        }
        for c in children(e) { findField(c, depth + 1) }
    }
    for win in children(root) { findField(win, 0) }
    guard let f = field else { print("ERR no name field"); exit(1) }
    let name = (outPath as NSString).lastPathComponent
    print("STEP name field prefill='\(str(f, kAXValueAttribute))'")
    if AXUIElementSetAttributeValue(f, kAXValueAttribute as CFString, name as CFTypeRef) == .success {
        print("STEP field set")
    } else {
        print("ERR could not set field"); exit(1)
    }
    var saveBtn: AXUIElement? = nil
    func findSave(_ e: AXUIElement, _ depth: Int) {
        if saveBtn != nil || depth > 6 { return }
        let r = role(e)
        if r == kAXTableRole || r == kAXOutlineRole { return }
        if r == kAXButtonRole && str(e, kAXTitleAttribute) == "Save" { saveBtn = e; return }
        for c in children(e) { findSave(c, depth + 1) }
    }
    for win in children(root) { findSave(win, 0) }
    guard let sb = saveBtn else { print("ERR no save button"); exit(1) }
    if perform(sb, kAXPressAction) { print("STEP save pressed") }
    else { print("ERR save press failed"); exit(1) }

case "setGoFolder":
    // ax setGoFolder <absolute-dir-with-trailing-slash>
    //
    // The save panel's go-to-folder sheet has an AXTextField whose value
    // is an ABSOLUTE path ending in "/". That is the ONLY AX-reachable
    // way to change the panel's destination directory — typing a path
    // into the panel's own name field does not navigate (it becomes part
    // of the filename).
    let dir = a.count > 2 ? a[2] : ""
    guard dir.hasSuffix("/") else { print("ERR dir needs a trailing slash"); exit(1) }
    var goField: AXUIElement? = nil
    func scan(_ e: AXUIElement, _ d: Int) {
        if goField != nil || d > 6 { return }
        let r = role(e)
        if r == kAXTableRole || r == kAXOutlineRole { return }
        if r == kAXTextFieldRole {
            let v = str(e, kAXValueAttribute)
            if v.hasSuffix("/") && v.contains("/") { goField = e; return }
        }
        for c in children(e) { scan(c, d + 1) }
    }
    scan(root, 0)
    guard let f = goField else { print("ERR no go-to-folder field (open the sheet with Cmd-Shift-G first)"); exit(1) }
    print("old='\(str(f, kAXValueAttribute))'")
    if AXUIElementSetAttributeValue(f, kAXValueAttribute as CFString, dir as CFTypeRef) == .success {
        print("set")
    } else {
        print("ERR set failed"); exit(1)
    }
    if let d = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true) { d.post(tap: .cghidEventTap) }
    usleep(80_000)
    if let u = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false) { u.post(tap: .cghidEventTap) }
    print("return sent")

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
