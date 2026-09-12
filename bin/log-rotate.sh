#!/bin/bash
# log-rotate.sh — daily log rotation for the chart-watcher (and other) logs.
#
# Mirrors the behavior of newsyslog / logrotate for the small set of
# logs we actually produce. Keeps 7 daily rotations, gzipped. Old
# uncompressed logs older than 7 days are deleted.
#
# Logs rotated:
#   logs/chart-watcher.log
#   logs/chart-watcher.out.log   (launchd stdout)
#   logs/chart-watcher.err.log   (launchd stderr)
#   logs/server.log              (the existing static file server)
#   logs/server.err.log
#   logs/boot-*.log              (boot agents, dated in the filename)
#
# Naming: <name>.log → <name>.log.1 → <name>.log.1.gz (after the run).
# The current file is .1 after the run; the most recent rotation is
# always .1.gz; older ones count up.
#
# Schedule: daily at 03:00 via com.kaidjuric.digital-twin.log-rotate
# LaunchAgent (StartCalendarInterval).
#
# Manual use:
#   bin/log-rotate.sh           # rotate everything in logs/
#   bin/log-rotate.sh <file>...  # rotate just the named files

set -u

REPO="$HOME/digital-twin"
LOGDIR="$REPO/logs"
KEEP=7

mkdir -p "$LOGDIR"

rotate_one() {
    local f="$1"
    if [ ! -f "$f" ]; then return 0; fi
    local name="${f%.log}"

    # Bump old rotations up: .N.gz → .(N+1).gz
    # Loop from highest down to .2 so we don't overwrite in the wrong order.
    local i=$KEEP
    while [ $i -ge 2 ]; do
        local prev=$((i - 1))
        if [ -f "${name}.log.${prev}.gz" ]; then
            mv "${name}.log.${prev}.gz" "${name}.log.${i}.gz"
        fi
        i=$prev
    done

    # Current file → .1 (the most recent rotation, freshly uncompressed).
    if [ -s "$f" ]; then
        mv "$f" "${name}.log.1"
        gzip -9 "${name}.log.1"
    fi

    # Delete anything beyond the KEEP window.
    local purge=$((KEEP + 1))
    while [ $purge -le 60 ]; do
        if [ -f "${name}.log.${purge}.gz" ]; then
            rm -f "${name}.log.${purge}.gz"
        fi
        purge=$((purge + 1))
    done
}

if [ $# -gt 0 ]; then
    for arg in "$@"; do
        rotate_one "$arg"
    done
else
    # Default: rotate every *.log file in the logs dir.
    for f in "$LOGDIR"/*.log; do
        [ -e "$f" ] || continue
        rotate_one "$f"
    done
fi

echo "[log-rotate] done at $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOGDIR/log-rotate.log"