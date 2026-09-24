#!/bin/bash
# auto-update.sh — digital-twin self-update on launch.
#
# Detects new commits on origin/main, fast-forwards the repo if any,
# and reloads the watcher LaunchAgents when their code changed so the
# running processes pick up the new files WITHOUT a login cycle.
#
# Wire-in: bin/boot.sh calls this instead of a blind `git pull`. Also
# runnable by hand:
#   bin/auto-update.sh          # check + pull + reload watchers
#   bin/auto-update.sh --once   # same (explicit; idempotent)
#
# Exit codes:
#   0  up to date, or updated cleanly
#   1  repo dirty (refused to overwrite local changes)
#   2  git not available / not a repo
#   3  fetch failed (offline / auth) — logged, boot continues anyway

set -u

REPO="$HOME/digital-twin"
LOGDIR="$REPO/logs"
LOG="$LOGDIR/auto-update.log"
BRANCH="${TWIN_UPDATE_BRANCH:-main}"

mkdir -p "$LOGDIR"

# Write log via Python (works under the Hermes dotfile guard, same
# pattern as bin/boot.sh's append_log).
append_log() {
    python3 -c "
import sys
with open('$LOG', 'a') as f:
    f.write(sys.stdin.read())
"
}

if ! command -v git >/dev/null 2>&1; then
    append_log <<EOF
[$(date '+%Y-%m-%d %H:%M:%S')] FATAL: git not on PATH
EOF
    exit 2
fi

cd "$REPO" 2>/dev/null || {
    echo "FATAL: cannot cd to $REPO" >&2
    exit 2
}

if [ ! -d .git ]; then
    append_log <<EOF
[$(date '+%Y-%m-%d %H:%M:%S')] FATAL: $REPO is not a git checkout
EOF
    exit 2
fi

append_log <<EOF
[$(date '+%Y-%m-%d %H:%M:%S')] auto-update start (branch=$BRANCH)
EOF

# --- 1. fetch -------------------------------------------------------------
if ! git fetch origin "$BRANCH" 2>/dev/null; then
    append_log <<EOF
[$(date '+%Y-%m-%d %H:%M:%S')] fetch failed — offline or auth? continuing at current HEAD
EOF
    exit 3
fi

# --- 2. detect new commits ------------------------------------------------
BEHIND=$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo "0")
if [ "${BEHIND:-0}" -eq 0 ]; then
    append_log <<EOF
[$(date '+%Y-%m-%d %H:%M:%S')] up to date (HEAD = origin/$BRANCH)
EOF
    exit 0
fi

# --- 3. dirty-tree guard --------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
    append_log <<EOF
[$(date '+%Y-%m-%d %H:%M:%S')] REFUSED: uncommitted local changes ($(git status --porcelain | wc -l | tr -d ' ') file(s)). Commit or stash first.
EOF
    exit 1
fi

# --- 4. pull + show what changed -------------------------------------------
# Snapshot which watcher files exist BEFORE the pull so we can decide
# whether a reload is needed after it.
HAD_CHART=false;  HAD_SONGS=false;  HAD_MJ=false;  HAD_REEL=false;  HAD_SERVE=false
[ -f "$REPO/lib/chart-watcher.js" ]  && HAD_CHART=true
[ -f "$REPO/lib/songs-watcher.js" ]  && HAD_SONGS=true
[ -f "$REPO/lib/mj-watcher.js" ]     && HAD_MJ=true
[ -f "$REPO/lib/reel-watcher.js" ]   && HAD_REEL=true
[ -f "$REPO/lib/serve.js" ]          && HAD_SERVE=true

CHANGED=$(git rev-list "HEAD..origin/$BRANCH")
COUNT=$(echo "$CHANGED" | grep -c . || true)

echo "-- pulling $COUNT new commit(s) on origin/$BRANCH --"
if ! git pull --ff-only origin "$BRANCH" 2>&1; then
    append_log <<EOF
[$(date '+%Y-%m-%d %H:%M:%S')] pull failed (not fast-forward?). Manual intervention required.
EOF
    exit 1
fi

# Log the new commit subjects (one line each, newest last).
LOG_MSG="[$(date '+%Y-%m-%d %H:%M:%S')] updated:"
while read -r C; do
    [ -n "$C" ] || continue
    LOG_MSG="$LOG_MSG
[$(date '+%Y-%m-%d %H:%M:%S')]   $(git log -1 --format='%h %s' "$C")"
done <<< "$CHANGED"
append_log <<EOF
$LOG_MSG
EOF

# --- 5. reload watchers whose code may have changed ------------------------
# Only kickstart agents that (a) exist as a plist AND (b) were already
# loaded. kickstart -k picks up the new JS from disk without login.
reload_if_loaded() {
    local label="$1"
    if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
        launchctl kickstart -k "gui/$(id -u)/$label" 2>/dev/null \
            && append_log <<EOF
[$(date '+%Y-%m-%d %H:%M:%S')] reloaded $label
EOF
    fi
}

if $HAD_CHART && [ -f "$REPO/lib/chart-watcher.js" ]; then
    reload_if_loaded "com.kaidjuric.digital-twin.chart-watcher"
fi
if $HAD_SONGS && [ -f "$REPO/lib/songs-watcher.js" ]; then
    reload_if_loaded "com.kaidjuric.digital-twin.songs-watcher"
fi
if $HAD_MJ && [ -f "$REPO/lib/mj-watcher.js" ]; then
    reload_if_loaded "com.kaidjuric.digital-twin.mj-watcher"
fi
if $HAD_REEL && [ -f "$REPO/lib/reel-watcher.js" ]; then
    reload_if_loaded "com.kaidjuric.digital-twin.reel-watcher"
fi
# The static server is Node (lib/serve.js) and reads its handlers from
# disk, so a pull that changes it needs a reload to take effect.
if $HAD_SERVE && [ -f "$REPO/lib/serve.js" ]; then
    reload_if_loaded "com.kaidjuric.digital-twin.server"
fi

append_log <<EOF
[$(date '+%Y-%m-%d %H:%M:%S')] auto-update done
EOF
exit 0