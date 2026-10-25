#!/bin/bash
# auto-update.sh — thin wrapper over `lib/boot.js --update-only`.
#
# The update logic lives in Node because launchd cannot run (or even
# read) a bash script under $HOME/Documents — see lib/boot.js's header.
# This wrapper stays because it is the documented manual entry point
# (README, AGENTS.md) and a shell alias is what people type.
#
#   bin/auto-update.sh          # fetch + fast-forward + reload agents
#   bin/auto-update.sh --once   # same (idempotent; kept for parity)
#
# Exit codes (from lib/boot.js):
#   0  up to date, or updated cleanly
#   1  fast-forward failed
#   (dirty / offline / not-a-repo are logged and exit 0 — boot continues)

set -u
REPO_TARGET="$(readlink -f "$HOME/digital-twin" 2>/dev/null || echo "$HOME/digital-twin")"

NODE_BIN="$(command -v node || true)"
for candidate in "$HOME/.hermes/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -n "$NODE_BIN" ] && break
    [ -x "$candidate" ] && NODE_BIN="$candidate"
done
if [ -z "$NODE_BIN" ]; then
    echo "FATAL: no node binary found" >&2
    exit 2
fi

exec "$NODE_BIN" "$REPO_TARGET/lib/boot.js" --update-only --no-open "$@"
