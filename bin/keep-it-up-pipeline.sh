#!/usr/bin/env bash
# The rest of the KEEP IT UP pipeline, unattended.
#
#   bash bin/keep-it-up-pipeline.sh
#
# Three stages, in order, because the machine has 24 GB and the render
# and the generator both want most of it:
#
#   1. wait for the music generator to finish (it is already running)
#   2. render the remaining FLUX frames (the model loads once, and
#      --skip-existing resumes from what is on disk)
#   3. assemble the film
#
# Each stage checks the one before it, and the script stops on the
# first failure rather than carrying on with a broken input.
set -uo pipefail
REPO="/Users/kaidejuricmasscmbook/Documents/digital_twin"
cd "$REPO" || exit 1

log() { printf '\n=== %s ===\n' "$1"; }

# ---------------------------------------------------------------------------
log "1/3 waiting for the music generator"

# The generator's wrapper PID, if it is still running. Wait for it.
GEN_PID="${1:-}"
if [ -n "$GEN_PID" ] && kill -0 "$GEN_PID" 2>/dev/null; then
  while kill -0 "$GEN_PID" 2>/dev/null; do sleep 20; done
fi

SONGS=4
HAVE=$(ls assets/keep-it-up/audio/*.mp3 2>/dev/null | wc -l | tr -d ' ')
echo "songs on disk: $HAVE / $SONGS"
if [ "$HAVE" -lt "$SONGS" ]; then
  echo "the generator did not finish all four songs — the render is not the"
  echo "next problem, so stop here and look at the songs first."
  exit 1
fi

for f in assets/keep-it-up/audio/*.mp3; do
  printf '   %-58s %s\n' "$(basename "$f")" \
    "$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f")s"
done

# ---------------------------------------------------------------------------
log "2/3 rendering the frames"

DONE=$(ls assets/flux2/keep-it-up/frames/*.png 2>/dev/null | wc -l | tr -d ' ')
echo "frames already on disk: $DONE / 100"
echo "the model loads once and the batch takes about 150 s a frame"

lib/flux2-renderer/.venv/bin/python lib/flux2-renderer/render-many.py \
  --manifest assets/flux2/keep-it-up/manifest.json \
  --out-dir assets/flux2/keep-it-up/frames \
  --width 832 --height 464 --steps 20 --seed-base 8100 --skip-existing
RC=$?
NOW=$(ls assets/flux2/keep-it-up/frames/*.png 2>/dev/null | wc -l | tr -d ' ')
echo "frames after the render: $NOW / 100 (exit $RC)"
if [ "$NOW" -lt 100 ]; then
  echo "the render did not finish — the assembly would be a film with holes."
  exit 1
fi

# ---------------------------------------------------------------------------
log "3/3 assembling the film"

node bin/keep-it-up-video.mjs \
  --frames assets/flux2/keep-it-up/frames \
  --audio assets/keep-it-up/audio \
  --out assets/keep-it-up/keep-it-up.mp4
RC=$?

if [ "$RC" -ne 0 ]; then
  echo "the assembly failed (exit $RC)"
  exit 1
fi

log "done"
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,duration \
  -of default=nw=1 assets/keep-it-up/keep-it-up.mp4
ls -la assets/keep-it-up/keep-it-up.mp4
