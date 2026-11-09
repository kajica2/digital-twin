#!/usr/bin/env bash
# Generate the four KEEP IT UP songs.
#
#   bash bin/keep-it-up-songs.sh            # dry run (prints the plan)
#   bash bin/keep-it-up-songs.sh --go       # generate
#
# Each song's lyrics and tags come from lib/keep-it-up-songs.js, which
# splits the source text into the generator's two inputs.
set -uo pipefail
REPO="/Users/kaidejuricmasscmbook/Documents/digital_twin"
cd "$REPO" || exit 1

GO=0
[ "${1:-}" = "--go" ] && GO=1

# The source -> lyrics + tags, per song.
node lib/keep-it-up-songs.js || exit 1

# The length of each song.
#
# The lyrics decide how long a song wants to be: a half-spoken delivery
# runs about 150 words a minute, and the instrumental sections (32-64
# bars at ~100 BPM is 25-40 seconds) are time the word count cannot
# see. So each song gets its own length, and the script REPORTS the
# length that came out — a song shorter than its words need means the
# ending was cut, and that is worth knowing.
#
#   song 1  593 words + a 32-bar instrumental -> 240 s
#   song 2  350 words + a 32-bar instrumental -> 180 s
#   song 3  333 words + a 48-bar instrumental -> 175 s
#   song 4  371 words + a 64-bar instrumental -> 180 s
seconds_for() {
  case "$1" in
    keep-it-up) echo "${SECONDS_KEEP_IT_UP:-240}" ;;
    needle-drop-healer) echo "${SECONDS_NEEDLE_DROP_HEALER:-180}" ;;
    slip-between-the-beats) echo "${SECONDS_SLIP_BETWEEN_THE_BEATS:-175}" ;;
    it-aint-what-it-is) echo "${SECONDS_IT_AINT_WHAT_IT_IS:-180}" ;;
    *) echo 180 ;;
  esac
}

SONGS="keep-it-up needle-drop-healer slip-between-the-beats it-aint-what-it-is"

for slug in $SONGS; do
  LYR="assets/keep-it-up/audio/lyrics/${slug}.txt"
  TAG="assets/keep-it-up/audio/tags/${slug}.txt"
  OUT="assets/keep-it-up/audio/${slug}.mp3"
  if [ ! -f "$LYR" ] || [ ! -f "$TAG" ]; then
    echo "MISSING $slug — no lyrics or tags"; continue
  fi
  SECS="$(seconds_for "$slug")"
  if [ "$GO" = "0" ]; then
    echo ""
    echo "== $slug (${SECS}s) =="
    npm run --silent heartmula:generate -- \
      --lyrics "$LYR" --tags "$(cat "$TAG")" \
      --seconds "$SECS" --out "$OUT" --dry-run 2>&1 | tail -4
  else
    echo ""
    echo "== generating $slug (${SECS}s) =="
    npm run --silent heartmula:generate -- \
      --lyrics "$LYR" --tags "$(cat "$TAG")" \
      --seconds "$SECS" --out "$OUT" 2>&1 | tail -8
    if [ -f "$OUT" ]; then
      GOT="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT" 2>/dev/null)"
      printf '   -> %s  %.1fs (asked for %ss)\n' "$OUT" "${GOT:-0}" "$SECS"
    else
      echo "   -> NO FILE"
    fi
  fi
done
