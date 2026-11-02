// tools/gui.swift — real mouse + keyboard driver for iReal Pro.
//
// The AX tree cannot trigger iReal's own menus/panels reliably, so this
// posts real CGEvents. Coordinates are in SCREEN points (top-left origin),
// the same space AXPosition uses.
//
//   gui click <x> <y>
//   gui type <text>
//   gui key <keycode> [cmd|shift|opt|ctrl ...]
//   gui shot <out.png>            capture the iReal window by CGWindow id
//   gui wins                      list iReal's CGWindows (id|title|x|y|w|h)
//   gui front                     activate iReal Pro
//   gui ocr <png>                 OCR a png (not here; use tesseract)

import AppKit
import CoreGraphics
import Foundation

func postMouse(_ type: CGEventType, _ x: Double, _ y: Double) {
    let p = CGPoint(x: x, y: y)
    if let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left) {
        e.post(tap: .cghidEventTap)
    }
}

func click(_ x: Double, _ y: Double) {
    postMouse(.mouseMoved, x, y)
    usleep(120_000)
    postMouse(.leftMouseDown, x, y)
    usleep(60_000)
    postMouse(.leftMouseUp, x, y)
    usleep(120_000)
}

func move(_ x: Double, _ y: Double) {
    postMouse(.mouseMoved, x, y)
    usleep(200_000)
}

func typeText(_ s: String) {
    // Use the Unicode path so accents (Zingaro, Zim) survive.
    for ch in s {
        var buf = Array(String(ch).utf16)
        guard !buf.isEmpty else { continue }
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: &buf)
        down?.post(tap: .cghidEventTap)
        usleep(12_000)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: &buf)
        up?.post(tap: .cghidEventTap)
        usleep(12_000)
    }
}

let keyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51,
    "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "cmd+s": 1, "cmd+g": 5, "shift+g": 5,
]

func keyPress(_ code: CGKeyCode, _ flags: CGEventFlags) {
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)!
    down.flags = flags
    down.post(tap: .cghidEventTap)
    usleep(40_000)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)!
    up.flags = flags
    up.post(tap: .cghidEventTap)
    usleep(40_000)
}

func listWindows() {
    let wl = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
    for w in wl {
        let owner = w[kCGWindowOwnerName as String] as? String ?? ""
        if owner.contains("iReal") {
            let num = w[kCGWindowNumber as String] as? Int ?? -1
            let name = w[kCGWindowName as String] as? String ?? ""
            let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
            print("\(num)|\(name)|x=\(b["X"] ?? 0)|y=\(b["Y"] ?? 0)|w=\(b["Width"] ?? 0)|h=\(b["Height"] ?? 0)")
        }
    }
}

func shot(_ path: String) {
    // The window id changes every launch, so look it up rather than
    // hardcoding one. Fall back to a full-screen capture if iReal has
    // no on-screen window right now.
    let wl = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
    var id: Int? = nil
    for w in wl {
        let owner = w[kCGWindowOwnerName as String] as? String ?? ""
        if owner.contains("iReal") {
            let n = w[kCGWindowNumber as String] as? Int ?? -1
            if n > 0 { id = n; break }
        }
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    if let id = id {
        p.arguments = ["-x", "-o", "-l", String(id), path]
    } else {
        p.arguments = ["-x", "-o", path]
    }
    try? p.run()
    p.waitUntilExit()
}

let a = CommandLine.arguments
let cmd = a.count > 1 ? a[1] : ""

switch cmd {
case "click":
    guard a.count >= 4 else { exit(1) }
    click(Double(a[2])!, Double(a[3])!)
    print("clicked \(a[2]),\(a[3])")

case "move":
    guard a.count >= 4 else { exit(1) }
    move(Double(a[2])!, Double(a[3])!)
    print("moved \(a[2]),\(a[3])")

case "type":
    guard a.count >= 3 else { exit(1) }
    typeText(a[2...].joined(separator: " "))
    print("typed")

case "key":
    guard a.count >= 3 else { exit(1) }
    let spec = a[2]
    var flags: CGEventFlags = []
    var code = keyCodes[spec.lowercased()]
    for f in a[3...] {
        switch f.lowercased() {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "opt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        default: break
        }
    }
    if code == nil {
        // "cmd+g" style
        let parts = spec.lowercased().split(separator: "+")
        code = keyCodes[String(parts.last!)]
        for p in parts.dropLast() {
            switch p {
            case "cmd", "command": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "opt", "option": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            default: break
            }
        }
    }
    guard let c = code else { print("unknown key \(spec)"); exit(1) }
    keyPress(c, flags)
    print("key \(spec)")

case "wins":
    listWindows()

case "shot":
    shot(a.count > 2 ? a[2] : "/tmp/ireal-win.png")
    print("saved")

case "front":
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.massimobiolcati.irealbookmac")
    running.first?.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    print("activated")

default:
    print("usage: gui click|type|key|wins|shot|front")
}
