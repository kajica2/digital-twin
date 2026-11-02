# tools/ — iReal Pro drivers

Three helpers for driving iReal Pro (the jazz chart app) on macOS from
the terminal, plus the batch export path they were built for.

## The problem this solves

iReal Pro has no scripting dictionary and no CLI. Its Accessibility tree
is also pathological: a full `entire contents` walk times out, and
reading the File menu's items all at once times out.

Worse — MEASURED 2026-11-02 — **walking the tree is what makes the app
spin**. A `iReal Pro_2026-11-02-071959_...cpu_resource.diag` landed in
`~/Library/Logs/DiagnosticReports`: 90 s of CPU over a 120 s window.
Every AppleScript tree-dump attempt reproduced it.

So the rule for this directory: **stay out of the AX tree.** Read
individual elements by index; drive the rest with real mouse and
keyboard events.

## The files

| file | what it is |
|---|---|
| `ireal-export.sh` | the entry point. Builds the Swift helpers, then exposes `rows` / `title` / `share` / `click` / `type` / `key` / `shot` / `ocr`. |
| `ax.swift` | direct AXUIElement access. One command per invocation: `rows`, `title N`, `select N`, `toolbar`, `find <needle>`, `pressMenu <name>`, `rowdump N`. |
| `gui.swift` | real CGEvents: `click x y`, `move x y`, `type <text>`, `key <spec>`, `wins`, `shot`, `front`. |
| `ireal.js` | the original AppleScript driver. Kept for the calls that work fine one-at-a-time (`osa`, `clickRow`, `fileMenuItems`). |
| `ireal-index.js` | reads the library table's titles/composers in paged ranges, so no single Apple event runs too long. |

## Build

```bash
bash tools/ireal-export.sh build
```

The binaries land in `~/.cache/digital-twin/ireal/` (override with
`IREAL_BIN`). `swiftc` comes from the Xcode command line tools.

## What was found (measured 2026-11-02)

**Row mapping is exact.** The library table is 1702 rows sorted
naturally by title, and the AX row index maps 1:1 onto the database:

```sql
SELECT ZTITLE FROM ZSONG ORDER BY ZTITLE
```

Verified against the live table:

| AX row | title | AX row | title |
|---|---|---|---|
| 301 | Caravan | 452 | Doxy |
| 760 | In a Sentimental Mood | 777 | Infant Eyes |

The database lives at:

```
~/Library/Containers/com.massimobiolcati.irealbookmac/Data/Library/
  Application Support/iReal Pro/iRealPro.sqlite
```

**The export is under Share, not File.** The File menu has
`Export Audio` (item 9, enabled), but clicking it does nothing visible.
The working path is the **Share** toolbar button — description
`"Share"`, toolbar child #7, at screen x=1395 y=30, 37×52 — which
opens a popover menu with:

```
Export Chord Chart  >
Export Audio        >
Export Playlist     >
```

`Export Audio` and `Export Playlist` have submenus (the `>` marker).
Pressing the Share button's menu item opens a **new CGWindow**
(~232×390 at x=117 y=31), not a sheet — which is why `count of windows`
staying at 1 was misleading during earlier probing.

**The export format is already WAV.** The app persists it:

```
defaults read com.massimobiolcati.irealbookmac
  "IRP_AUDIO_EXPORT_FORMAT_PERSISTENCE" = WAV;
```

**The table does not filter from the search field.** Typing into
`UI element 1 of UI element 1 of window 1` updates the field's value
but the AX table still reports all 1702 rows. The row-index mapping
above is the reliable way to reach a specific song.

## The known-good sequence

```bash
export PATH="$HOME/.cache/digital-twin/ireal:$PATH"

# 1. find the song's row
bash tools/ireal-export.sh rows | grep -i "^301"

# 2. open the Share popover
bash tools/ireal-export.sh share

# 3. click Export Audio in the popover, then the NSSavePanel:
#    Cmd-Shift-G -> type the full path -> Return -> Return
```

## Caveats

- Screen coordinates are **screen points**, top-left origin — the same
  space AXPosition uses. On a Retina display the *screenshot pixels* are
  2× the points, so divide OCR coordinates by 2 before clicking.
- `shot` looks the window id up at call time (`CGWindowListCopyWindowInfo`)
  rather than hardcoding it; the id changes on every launch.
- `type` uses `CGEventKeyboardSetUnicodeString`, so non-Latin characters
  survive.
- These helpers drive a real GUI. Nothing here is a headless renderer —
  iReal's own synthesiser produces the audio.
