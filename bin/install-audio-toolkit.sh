#!/usr/bin/env bash
# bin/install-audio-toolkit.sh — install the Python Audio Processing
# Toolkit (MIT, https://github.com/Matin-python/Python-Audio-Processing-Toolkit).
#
#   bash bin/install-audio-toolkit.sh
#
# It is a REFERENCE, not a dependency of the twin: the toolkit's own
# scripts record from a microphone and open matplotlib windows, and the
# twin already has a better visualiser in lib/story/ (seven per-band
# lines, driven by scipy's Butterworth filters and drawn into the
# video through ffmpeg). What the toolkit is good for is the plain
# reading of the DSP: waveform, spectrogram, FFT, and the live
# amplitude/magnitude analysers.
#
# So it lands LOCAL and GITIGNORED — the clone is another project's
# code with its own .git, and the twin's rule is that vendored trees
# and their paths do not travel in the public repo. The CHECK is
# tracked: tools/check-audio-toolkit.py proves the install works.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$REPO/lib/python-audio-toolkit"
URL="https://github.com/Matin-python/Python-Audio-Processing-Toolkit.git"

if [ -d "$DIR/.git" ]; then
  echo "already cloned: $DIR"
else
  echo "cloning $URL"
  rm -rf "$DIR"
  git clone --depth 1 "$URL" "$DIR"
fi

cd "$DIR"
echo "creating the venv"
uv venv --python 3.12 .venv
echo "installing the requirements"
uv pip install --python .venv/bin/python -r requirements.txt

echo
echo "checking the install"
"$REPO/tools/check-audio-toolkit.py"
echo
echo "the toolkit's own scripts (they need a microphone):"
echo "  $DIR/processing/voice_processing.py"
echo "  $DIR/recording/fixed_time_recorder.py"
echo "  $DIR/recording/voice_activity_recorder.py"
echo "  $DIR/realtime/"
