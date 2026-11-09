#!/usr/bin/env bash
# bin/limit-keep-it-up.sh — put a limiter on the KEEP IT UP songs.
#
# WHY
#
# MEASURED on the generated files: every one of the four songs peaks
# ABOVE 0 dBFS — +3.01, +3.08, +2.12 and +3.08 dBFS — and the peaks
# are FLAT: 995, 716, 102 and 408 samples sit over full scale, with
# 1851, 1356, 252 and 838 samples in flat-topped runs. That is real
# clipping, baked in by the encoder, and it is audible as a hard edge
# on every transient.
#
# A limiter, not a gain cut. Turning the whole mix down by 4 dB would
# remove the distortion but would also bury the song; alimiter only
# touches what is over the ceiling, so the quiet parts stay where
# they are.
#
# THE ENCODER OVERSHOOTS.
#
# Limiting to −1 dBFS and encoding to MP3 decodes at +1.9 dBFS: LAME
# puts the overshoot back. So the ceiling has to be set BELOW the
# target by that overshoot, and the overshoot is MEASURED, not
# guessed — this script encodes, measures the DECODED peak, and
# lowers the ceiling until the decoded file is under the line.
#
# Each attempt encodes from the PRISTINE original (kept aside), so
# the file is never a re-encode of a re-encode.
#
# Run:  bash bin/limit-keep-it-up.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
AUDIO="$REPO/assets/keep-it-up/audio"
TARGET_DB="-1.0"

peak_of() {
  # The DECODED peak — the only one that matters.
  python3 - "$1" <<'PY'
import math, subprocess, sys
import numpy as np
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', sys.argv[1], '-f', 'f32le',
                      '-ac', '1', '-ar', '44100', '-'],
                     capture_output=True, check=True).stdout
x = np.frombuffer(raw, dtype=np.float32)
p = float(np.abs(x).max())
print(f"{20 * math.log10(max(p, 1e-12)):.2f}")
PY
}

for mp3 in "$AUDIO"/*.mp3; do
  [ -e "$mp3" ] || continue
  base="$(basename "$mp3")"
  pristine="$(mktemp -t keepitup-pristine).mp3"
  cp "$mp3" "$pristine"

  ceiling=0.891          # start at −1 dBFS
  best=""
  bestpeak=""

  for attempt in 1 2 3 4 5; do
    out="$(mktemp -t keepitup-out).mp3"
    ffmpeg -v error -y -i "$pristine" \
      -af "alimiter=level_in=1:level_out=1:limit=${ceiling}:attack=5:release=50:level=disabled" \
      -c:a libmp3lame -b:a 256k "$out"
    peak="$(peak_of "$out")"
    if [ -z "$best" ]; then best="$out"; bestpeak="$peak"; fi
    if python3 -c "import sys; sys.exit(0 if float('$peak') <= float('$TARGET_DB') else 1)"; then
      best="$out"; bestpeak="$peak"; break
    fi
    rm -f "$out"
    # Lower the ceiling by exactly the overshoot we just measured.
    ceiling="$(python3 -c "print(max(0.05, $ceiling * (10 ** ((float('$TARGET_DB') - float('$peak')) / 20.0))))")"
  done

  cp "$best" "$mp3"
  echo "limited: $base  ->  decoded peak ${bestpeak} dBFS"
  rm -f "$pristine" "$best"
done

echo
echo "checking the result:"
python3 "$REPO/tools/check-keep-it-up-songs.py"
