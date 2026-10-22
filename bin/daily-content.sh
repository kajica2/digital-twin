#!/bin/bash
# bin/daily-content.sh — LaunchAgent wrapper for lib/daily-content.js
#
# Mirrors bin/daily-pipeline.sh and the watcher launchers: absolute
# paths, no `cd`, multi-candidate Node resolution. The launcher lives in
# ~/Library/LaunchAgents/ rather than in the repo, because launchd on
# Sequoia cannot execve a path under $HOME from its own spawn context
# (see the TCC note in AGENTS.md, sprint 0.25/0.26) — bash can, so the
# shim resolves the Node binary and execs it.
#
# Pair with com.kaidjuric.digital-twin.daily-content.plist.

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

mkdir -p "$REPO/daily-content" "$REPO/assets/marketplace/daily" "$REPO/logs"

exec "$NODE_BIN" "$REPO/lib/daily-content.js" "$@"
