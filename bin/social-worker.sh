#!/bin/bash
# social-worker.sh — LaunchAgent wrapper for lib/social-engine.js
#
# Mirrors bin/songs-watcher.sh exactly: absolute paths, no `cd`,
# multi-candidate Node resolution. Drop-in sibling.
#
# Pair with com.kaidjuric.digital-twin.social-worker.plist.
#
# NOTE: launchd on Sequoia cannot execve() anything under $HOME, so the
# installed LaunchAgent points at ~/Library/LaunchAgents/social-worker-
# launcher.sh instead of this file. The shim resolves the same paths and
# execs the worker directly. This copy is the in-repo reference and the
# manual entry point.

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

mkdir -p "$REPO/data/social" "$REPO/logs" "$REPO/social-inbox"

export NODE_NO_WARNINGS=1
exec "$NODE_BIN" "$REPO/lib/social-engine.js" "$@"
