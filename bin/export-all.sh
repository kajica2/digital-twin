#!/usr/bin/env bash
# bin/export-all.sh — wrapper for the full chart export pipeline.
#
# Runs the MusicXML splitter, PDF+MP3 render pass via MuseScore, and the
# multi-track MIDI export in sequence. npm script chains can't propagate
# the trailing input arg to both halves of an `&&` chain — npm only
# appends the user's args to the end of the whole script command — so
# this wrapper accepts the path once and forwards it to both stages.
#
# Usage:
#   bin/export-all.sh path/to/song.musicxml
#   npm run export-all -- path/to/song.musicxml    # delegates here

set -e

if [ -z "$1" ]; then
  echo "usage: bin/export-all.sh <path/to/song.musicxml>" >&2
  exit 2
fi

INPUT="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

node lib/chart-export.js --apply --yes --render "$INPUT"
node lib/midi-export.js --apply --yes "$INPUT"