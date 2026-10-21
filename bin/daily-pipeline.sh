#!/bin/bash
# bin/daily-pipeline.sh — LaunchAgent wrapper for lib/daily-pipeline.js
#
# Mirrors bin/mj-watcher.sh exactly: absolute paths, no `cd`,
# multi-candidate Node resolution. Drop-in sibling for the daily
# mood-journey pipeline that fires once a day on calendar schedule.
#
# Pair with com.kaidjuric.digital-twin.daily-pipeline.plist.

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

mkdir -p "$REPO/daily" "$REPO/prompts-inbox" "$REPO/logs"

exec "$NODE_BIN" "$REPO/lib/daily-pipeline.js" "$@"
