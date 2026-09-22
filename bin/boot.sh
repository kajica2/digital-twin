#!/bin/bash
# boot.sh — digital-twin boot core.
#
# Fires at user login via com.kaidjuric.digital-twin.boot LaunchAgent.
# Responsibilities (split on purpose — the server runs under its OWN
# LaunchAgent so launchd owns its lifecycle, not boot.sh):
#
#   1. auto-update: fetch origin, detect new commits, ff-only pull, and
#      reload watcher LaunchAgents whose code changed (bin/auto-update.sh)
#   2. ask launchd to ensure the server LaunchAgent is loaded + running
#   3. wait for the server health endpoint
#   4. open a visible Terminal showing the live server log
#   5. open the Twin OS PWA in the default browser
#   6. post a one-line status to an Apple Notes note ("twin OS" folder)
#
# AGENTS.md tone: silent unless something matters. No eager chatter.

set -u

REPO="$HOME/digital-twin"
LOGDIR="$REPO/logs"
LOG="$LOGDIR/boot-$(date +%Y%m%d).log"
PORT="${TWIN_PORT:-5173}"
TWINOS_PATH="/pages/twin-os/"

# Where Apple Notes will store the persistent status log. Create the
# folder if it doesn't exist so the AppleScript write never fails.
NOTES_FOLDER="twin OS"

mkdir -p "$LOGDIR"

append_log() {
    python3 -c "
import sys
with open('$LOG', 'a') as f:
    f.write(sys.stdin.read())
"
}

{
echo "[$(date '+%Y-%m-%d %H:%M:%S')] digital-twin boot start"

# --- 1. self-update: fetch, detect new commits, ff-only pull, reload
#        watchers whose code changed (bin/auto-update.sh) ----------------
cd "$REPO" || {
    echo "  FATAL: cannot cd to $REPO"
    exit 1
}
echo
echo "-- auto-update --"
AUTO_UPDATE_STATUS=0
"$REPO/bin/auto-update.sh" 2>&1 || AUTO_UPDATE_STATUS=$?
echo "  auto-update exit: $AUTO_UPDATE_STATUS (0=clean, 1=dirty/conflict, 3=offline — boot continues)"

# --- 2. ensure server LaunchAgent is loaded + running -----------------
echo
echo "-- server agent --"
SERVER_LABEL="com.kaidjuric.digital-twin.server"
SERVER_PLIST="$HOME/Library/LaunchAgents/$SERVER_LABEL.plist"

# bootstrap if not already loaded
if ! launchctl print "gui/$(id -u)/$SERVER_LABEL" >/dev/null 2>&1; then
    launchctl bootstrap "gui/$(id -u)" "$SERVER_PLIST" 2>>"$LOG"
fi

# kickstart if not currently running
STATE=$(launchctl print "gui/$(id -u)/$SERVER_LABEL" 2>/dev/null \
    | awk '/^[[:space:]]*state = /{print $3; exit}')
if [ "$STATE" != "running" ]; then
    launchctl kickstart -k "gui/$(id -u)/$SERVER_LABEL" 2>>"$LOG" || true
fi

# --- 3. wait for the server health endpoint ---------------------------
echo
echo "-- wait for server --"
UP=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do
    sleep 0.5
    if curl -fsS -o /dev/null --max-time 1 \
            "http://127.0.0.1:$PORT/" 2>/dev/null; then
        echo "  server up after ${i} half-seconds"
        UP=1
        break
    fi
done
if [ "$UP" -eq 0 ]; then
    echo "  WARN: server did not respond on 127.0.0.1:$PORT — continuing anyway"
fi

# --- 4. visible Terminal with the server log --------------------------
echo
echo "-- visible terminal --"
osascript "$REPO/bin/terminal-log.applescript" "$LOGDIR/server.log" \
    >>"$LOG" 2>&1 || echo "  WARN: terminal-log applescript failed"

# --- 5. open the Twin OS PWA in the default browser -------------------
echo
echo "-- open Twin OS --"
open "http://127.0.0.1:$PORT$TWINOS_PATH"

# --- 6. Apple Notes status note ---------------------------------------
echo
echo "-- apple notes status --"
# Find the Notes folder id (so we can target it by id — name-based
# targeting breaks if the user has multiple folders with the same name).
osascript "$REPO/bin/notes.applescript" \
    "$NOTES_FOLDER" "$(date '+%Y-%m-%d %H:%M:%S')" "$PORT" \
    >>"$LOG" 2>&1 || echo "  WARN: notes applescript failed"

echo
echo "[$(date '+%Y-%m-%d %H:%M:%S')] digital-twin boot end"
} >>"$LOG" 2>&1

exit 0