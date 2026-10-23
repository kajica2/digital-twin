#!/bin/bash
# bin/gumroad-sync.sh — LaunchAgent wrapper for lib/gumroad.js
#
# Mirrors bin/daily-content.sh and the watcher launchers: absolute
# paths, no `cd`, multi-candidate Node resolution. The launcher lives in
# ~/Library/LaunchAgents/ rather than in the repo, because launchd on
# Sequoia cannot execve a path under $HOME from its own spawn context
# (see the TCC note in AGENTS.md, sprint 0.25/0.26) — bash can, so the
# shim resolves the Node binary and execs it.
#
# Pair with com.kaidjuric.digital-twin.gumroad-sync.plist.
#
# WHY THIS IS DAILY AND NOT ONCE
#
# Gumroad allows 10 NEW products per day, so a catalogue larger than
# that cannot be applied in one run — the rest are refused with "Sorry,
# you can only create 10 products per day." The sync is resumable: a
# product that exists is updated, one that does not is created. Running
# it once a day creates ten more each day until the catalogue is whole.
#
# The same reason it must be a CALENDAR job and not a watch: the window
# is measured by Gumroad's day, not by the file system's.

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

mkdir -p "$REPO/logs"

# The session cookie is the only credential this needs, and it lives
# outside the repo (~/.gumroad-cookies.txt). Without it the run refuses
# to touch the storefront — it exits with a line saying so, rather than
# half-applying the plan.
exec "$NODE_BIN" "$REPO/lib/gumroad.js" sync --apply
