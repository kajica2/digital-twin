#!/bin/bash
# bin/ig-watcher.sh
#
# LaunchAgent wrapper for ig-watcher.js
# Resolves Node and the repo path, then execs the watcher.

set -e

# Resolve the repo path (follows symlinks)
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# Resolve Node - try Hermes first, then NVM, then Homebrew, then system
if [ -x "$HOME/.hermes/node/bin/node" ]; then
    NODE="$HOME/.hermes/node/bin/node"
elif [ -x "$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node/" 2>/dev/null | tail -1)/bin/node" ]; then
    NODE="$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node/" 2>/dev/null | tail -1)/bin/node"
elif command -v node &> /dev/null; then
    NODE="$(command -v node)"
else
    echo "Error: Node.js not found" >&2
    exit 1
fi

# Export PATH so ffmpeg/ffprobe resolve
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Execute the watcher
exec "$NODE" "$REPO/lib/ig-watcher.js" "$@"
