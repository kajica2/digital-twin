#!/bin/bash
# chart-watcher.sh — LaunchAgent wrapper for lib/chart-watcher.js
#
# Sprint 0.8. Mirrors the macos-launchd-automation skill's `start.sh`
# template: absolute paths, no `cd`, multi-candidate Node resolution.
# The plain `cd "$REPO"` form fails under a GUI LaunchAgent because
# the launchd chdir happens before the shell starts and can hit TCC
# restrictions on macOS — so we skip the cd entirely.
#
# Pair with com.kaidjuric.digital-twin.chart-watcher.plist:
#   * No WorkingDirectory key (skill warning)
#   * EnvironmentVariables.PATH pointing at ~/.hermes/node/bin first
#   * KeepAlive=true so the watcher restarts after a crash

set -e

REPO="$HOME/digital-twin"

# Multi-candidate Node resolution. Hermes Node first (sandboxed
# installs live there), then NVM, then Homebrew, then system.
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

mkdir -p "$REPO/chart-inbox" "$REPO/chart-inbox/processed" "$REPO/logs"

export NODE_NO_WARNINGS=1
exec "$NODE_BIN" "$REPO/lib/chart-watcher.js" --notify-on-success "$@"