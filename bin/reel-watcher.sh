#!/bin/bash
# reel-watcher.sh — LaunchAgent wrapper for lib/reel-watcher.js
#
# Sprint 0.17. Mirrors bin/songs-watcher.sh / bin/chart-watcher.sh
# exactly: absolute paths, no `cd`, multi-candidate Node resolution,
# homebrew / hermes first. Drop-in sibling.
#
# Pair with com.kaidjuric.digital-twin.reel-watcher.plist.

set -e

REPO="$HOME/digital-twin"

NODE_BIN=""
for candidate in \
  "$HOME/.hermes/node/bin/node" \
  "$HOME/.nvm/versions/node/v22.22.3/bin/node" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node; do
  if [ -x "$candidate" ]; then
    NODE_BIN="$candidate"
    break
  fi
done
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "FATAL: no node binary found on PATH" >&2
  exit 1
fi

mkdir -p "$REPO/reel-inbox" "$REPO/reel-inbox/processed" "$REPO/logs"

export NODE_NO_WARNINGS=1
# ffmpeg/ffprobe must be on PATH for the watcher to find them.
# launchd strips PATH; we restore it here so `which ffmpeg` succeeds.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
exec "$NODE_BIN" "$REPO/lib/reel-watcher.js" "$@"