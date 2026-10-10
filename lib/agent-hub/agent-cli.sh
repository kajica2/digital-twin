#!/bin/bash
# SWR Agent CLI - Send commands to agents

CMD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/lib/agent-hub/agents"

send_cmd() {
    local agent=$1
    local cmd=$2
    echo "$cmd" > "$CMD_DIR/$agent/command.txt"
    echo "→ $agent: $cmd"
}

case "$1" in
    ops)
        shift
        send_cmd "ops" "$*"
        ;;
    twin)
        shift
        send_cmd "twin" "$*"
        ;;
    check)
        shift
        send_cmd "check" "$*"
        ;;
    *)
        echo "Usage: $0 {ops|twin|check} <command>"
        echo ""
        echo "Examples:"
        echo "  $0 ops add Build new landing page"
        echo "  $0 ops done"
        echo "  $0 ops status"
        echo "  $0 twin decide dark theme, light theme | landing page"
        echo "  $0 twin voice"
        echo "  $0 check file pages/index.html"
        echo "  $0 check test"
        echo "  $0 check claim FLUX generation"
        ;;
esac
