#!/bin/bash
# mj-watcher.sh — LaunchAgent wrapper for lib/mj-watcher.js
#
# Midjourney prompt watcher. Mirrors bin/chart-watcher.sh and
# bin/songs-watcher.sh exactly: absolute paths, no `cd`,
# multi-candidate Node resolution. Drop-in sibling.
#
# Pair with com.kaidjuric.digital-twin.mj-watcher.plist.

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

mkdir -p "$REPO/prompts-inbox" "$REPO/prompts-inbox/processed" "$REPO/mj-output" "$REPO/logs"

export NODE_NO_WARNINGS=1
exec "$NODE_BIN" "$REPO/lib/mj-watcher.js" "$@"