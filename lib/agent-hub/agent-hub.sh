#!/bin/bash
# SWR Agent Hub - Single terminal, three persistent agents
# Usage: ./agent-hub.sh [start|stop|status|attach]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_DIR="$SCRIPT_DIR/agents"
SESSION="swr-hub"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[HUB]${NC} $1"; }
warn() { echo -e "${YELLOW}[HUB]${NC} $1"; }
error() { echo -e "${RED}[HUB]${NC} $1"; }

# Ensure agents directory exists
mkdir -p "$AGENTS_DIR"/{ops,twin,check}

start_agents() {
    log "Starting SWR Agent Hub..."
    
    # Check if already running
    if tmux has-session -t "$SESSION" 2>/dev/null; then
        warn "Session already running. Run 'attach' to connect."
        return
    fi
    
    # Create new session with three windows
    tmux new-session -d -s "$SESSION" -n "ops"
    
    # SWR-Ops (Orchestrator) - Window 0
    tmux send-keys -t "$SESSION:0" "cd $AGENTS_DIR/ops && node swr-ops.js start" C-m
    tmux send-keys -t "$SESSION:0" "echo 'SWR-Ops ready'" C-m
    
    # Split for logs
    tmux split-window -t "$SESSION:0" -h
    tmux send-keys -t "$SESSION:0.right" "tail -f $AGENTS_DIR/ops/logs.txt" C-m
    
    # Window 1: SWR-Twin (Creative)
    tmux new-window -t "$SESSION" -n "twin"
    tmux send-keys -t "$SESSION:1" "cd $AGENTS_DIR/twin && node swr-twin.js start" C-m
    
    # Window 2: SWR-Check (Verifier)
    tmux new-window -t "$SESSION" -n "check"
    tmux send-keys -t "$SESSION:2" "cd $AGENTS_DIR/check && node swr-check.js start" C-m
    
    # Create hub window for coordination
    tmux new-window -t "$SESSION" -n "hub"
    tmux send-keys -t "$SESSION:3" "cd $SCRIPT_DIR && node hub-coordinator.js monitor" C-m
    
    sleep 1
    log "✓ All agents started!"
    log "  Use: ./agent-hub.sh attach"
}

stop_agents() {
    log "Stopping SWR Agent Hub..."
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    log "✓ Stopped."
}

status_agents() {
    if tmux has-session -t "$SESSION" 2>/dev/null; then
        log "Session active: $SESSION"
        echo ""
        echo -e "${BLUE}Windows:${NC}"
        tmux list-windows -t "$SESSION" 2>/dev/null || true
    else
        warn "No session running."
    fi
}

attach_session() {
    if tmux has-session -t "$SESSION" 2>/dev/null; then
        tmux attach-session -t "$SESSION"
    else
        error "No session to attach to. Run 'start' first."
    fi
}

case "${1:-start}" in
    start) start_agents ;;
    stop) stop_agents ;;
    status) status_agents ;;
    attach) attach_session ;;
    *) 
        echo "Usage: $0 {start|stop|status|attach}"
        exit 1
        ;;
esac
