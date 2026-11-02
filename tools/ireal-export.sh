#!/bin/bash
# tools/ireal-export.sh — drive iReal Pro's export GUI.
#
# WHY GUI AND NOT AX
# iReal Pro's AX tree is pathological: a full `entire contents` walk
# times out, and reading the File menu's items all at once times out.
# Worse, MEASURED 2026-11-02: walking the tree is what made the app
# spin its CPU (a 90 s/120 s CPU-resource diagnostic report landed in
# ~/Library/Logs/DiagnosticReports). So this driver stays OUT of the AX
# tree: it posts real mouse and keyboard events, and reads the screen
# back with OCR.
#
# WHAT WAS FOUND (measured 2026-11-02)
#   - The library table is 1702 rows, sorted naturally by title, and the
#     AX row index maps 1:1 onto `SELECT ZTITLE FROM ZSONG ORDER BY
#     ZTITLE` in iRealPro.sqlite. Verified: row 301 = Caravan,
#     row 452 = Doxy, row 760 = In a Sentimental Mood, row 777 = Infant Eyes.
#   - The export is NOT under File > Export Audio in the toolbar sense:
#     it lives in the SHARE popover (toolbar button #7, description
#     "Share"), which opens a menu with Export Chord Chart / Export
#     Audio / Export Playlist.
#   - Clicking that menu item with a real mouse opens a NEW window
#     (a CGWindow of its own, ~232x390), not a sheet.
#   - The export format is already WAV — the app persists
#     IRP_AUDIO_EXPORT_FORMAT_PERSISTENCE = WAV in its defaults.
#
# USAGE
#   ireal-export.sh build          compile the Swift helpers
#   ireal-export.sh wins           list iReal's on-screen windows
#   ireal-export.sh rows           print the library table (index<TAB>title)
#   ireal-export.sh share          open the Share popover and OCR it
#   ireal-export.sh title <row>    print one row's title
#   ireal-export.sh ocr <png>      OCR a png
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${IREAL_BIN:-$HOME/.cache/digital-twin/ireal}"
mkdir -p "$BIN"

AX="$BIN/ax"
GUI="$BIN/gui"
OUT="${IREAL_OUT:-$HOME/Documents/ireal-export}"

build() {
  echo "building helpers into $BIN"
  swiftc -O "$HERE/ax.swift"  -o "$AX"
  swiftc -O "$HERE/gui.swift" -o "$GUI"
}

ocr() {
  if command -v tesseract >/dev/null 2>&1; then
    tesseract "$1" - --psm 6 2>/dev/null
  else
    echo "(tesseract not installed — install with: brew install tesseract)"
  fi
}

ensure() {
  [ -x "$AX" ] && [ -x "$GUI" ] || build
}

case "${1:-}" in
build) build ;;
wins) ensure; "$GUI" wins ;;
rows) ensure; "$AX" rows ;;
title) ensure; "$AX" title "${2:?row index required}" ;;
rowdump) ensure; "$AX" rowdump "${2:?row index required}" ;;
toolbar) ensure; "$AX" toolbar ;;
find) ensure; "$AX" find "${2:?needle required}" ;;
pressMenu) ensure; "$AX" pressMenu "${2:?menu item name required}" ;;
share)
  ensure
  "$GUI" front; sleep 1
  "$GUI" click 1413 56; sleep 2
  screencapture -x -o /tmp/ireal-share.png
  ocr /tmp/ireal-share.png
  ;;
click) ensure; "$GUI" click "${2:?x}" "${3:?y}" ;;
move)  ensure; "$GUI" move  "${2:?x}" "${3:?y}" ;;
type)  ensure; "$GUI" type  "${2:?text}" ;;
key)   ensure; "$GUI" key  "${2:?key}" ${3:-} ${4:-} ${5:-} ;;
shot)
  ensure
  "$GUI" shot "${2:-/tmp/ireal-win.png}"
  echo "$2"
  ;;
ocr) ocr "${2:?png required}" ;;
*)
  echo "usage: $0 build|wins|rows|title <row>|rowdump <row>|toolbar|find <s>|pressMenu <name>|share|click <x> <y>|move <x> <y>|type <s>|key <k>|shot <png>|ocr <png>" >&2
  exit 1
  ;;
esac
