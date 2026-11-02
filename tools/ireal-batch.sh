#!/bin/bash
# tools/ireal-batch.sh — export every song in the plan as a WAV.
#
# The plan (~/Documents/ireal-export/plan.tsv) is written by
# tools/ireal-plan.py: one line per song, "row<TAB>filename<TAB>title".
#
# Each song costs about a minute of iReal's own rendering, so 95 songs is
# roughly an hour and a half. The runner:
#   - skips songs whose file already exists (so it is re-runnable)
#   - verifies each exported file is a real WAV with a sane duration
#   - logs one line per song to the log file
#
# usage: ireal-batch.sh [plan.tsv] [outdir]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${IREAL_BIN:-$HOME/.cache/digital-twin/ireal}"
AX="$BIN/ax"

PLAN="${1:-$HOME/Documents/ireal-export/plan.tsv}"
OUTDIR="${2:-$HOME/Documents/ireal-export}"
LOG="$OUTDIR/batch.log"

[ -x "$AX" ] || { bash "$HERE/ireal-export.sh" build; }

mkdir -p "$OUTDIR"
echo "plan=$PLAN" >> "$LOG"
echo "outdir=$OUTDIR" >> "$LOG"

total=0; ok=0; skip=0; fail=0
while IFS=$'\t' read -r row file title; do
  case "$row" in \#*|"") continue ;; esac
  total=$((total + 1))
  dest="$OUTDIR/$file"

  if [ -f "$dest" ] && [ "$(wc -c < "$dest" | tr -d ' ')" -gt 1000000 ]; then
    echo "[skip] $title -> $file (already there)" >> "$LOG"
    skip=$((skip + 1)); continue
  fi

  # iReal must be frontmost for the real clicks to land.
  osascript -e 'tell application "iReal Pro" to activate' >/dev/null 2>&1
  sleep 2

  out="$("$AX" exportSong "$row" "$dest" 2>&1)"
  if [ $? -ne 0 ] || ! printf '%s' "$out" | grep -q "save pressed"; then
    echo "[FAIL] $title (row $row) -> $file :: $(printf '%s' "$out" | tr '\n' ' ')" >> "$LOG"
    fail=$((fail + 1)); continue
  fi

  # iReal renders in the background; the file appears when it is done.
  # A 3-minute song is ~50 MB and takes ~40 s to render.
  waited=0
  while [ $waited -lt 180 ]; do
    if [ -f "$dest" ]; then
      bytes="$(wc -c < "$dest" | tr -d ' ')"
      if [ "$bytes" -gt 1000000 ]; then
        dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$dest" 2>/dev/null)"
        echo "[ok] $title (row $row) -> $file ${bytes}B ${dur}s" >> "$LOG"
        ok=$((ok + 1))
        break
      fi
    fi
    sleep 3; waited=$((waited + 3))
  done

  if [ $waited -ge 180 ]; then
    echo "[TIMEOUT] $title (row $row) -> $file" >> "$LOG"
    fail=$((fail + 1))
  fi
done < "$PLAN"

echo "=== done: total=$total ok=$ok skip=$skip fail=$fail ===" >> "$LOG"
echo "total=$total ok=$ok skip=$skip fail=$fail"
