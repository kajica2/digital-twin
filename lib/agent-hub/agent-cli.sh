#!/bin/bash
# SWR Agent CLI — send a command to one of the three hub agents.
#
# Commands are queued in the hub ROOT, in the agent's own commands/
# directory (ops/commands/), because that is where the agents read them.
# The earlier version wrote to lib/agent-hub/agents/<agent>/command.txt,
# which no agent ever looked at — every CLI command was silently lost.
#
# One file per command: two commands sent in quick succession used to
# destroy each other (the CLI truncated a single command.txt in place).
#
# SWR_HUB_ROOT points the CLI at a second hub instance living elsewhere.
set -euo pipefail

HUB_ROOT="${SWR_HUB_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

send_cmd() {
    local agent=$1
    shift
    local cmd="$*"
    local dir="$HUB_ROOT/$agent/commands"
    mkdir -p "$dir"
    # Write to a temp name and rename into place, so the agent never
    # reads a half-written command. The name is timestamp-first so the
    # agent drains the queue in the order the commands were sent.
    local stamp
    stamp="$(node -e 'process.stdout.write(String(Date.now()).padStart(14,"0"))' 2>/dev/null || printf '%014d' "$(date +%s)")"
    local name="${stamp}-$$-${RANDOM}.msg"
    local tmp="$dir/.tmp-$name"
    printf '%s\n' "$cmd" > "$tmp"
    mv -f "$tmp" "$dir/$name"
    echo "→ $agent: $cmd"
}

case "${1:-}" in
    ops)
        shift
        send_cmd "ops" "$@"
        ;;
    twin)
        shift
        send_cmd "twin" "$@"
        ;;
    check)
        shift
        send_cmd "check" "$@"
        ;;
    status)
        echo "hub root: $HUB_ROOT"
        for agent in ops twin check; do
            pidfile="$HUB_ROOT/pids/$agent.pid"
            if [[ -f "$pidfile" ]]; then
                pid="$(cat "$pidfile")"
                if kill -0 "$pid" 2>/dev/null; then
                    echo "  $agent: running (pid $pid)"
                else
                    echo "  $agent: STOPPED (stale pid $pid)"
                fi
            else
                echo "  $agent: not started"
            fi
        done
        ;;
    *)
        cat <<'USAGE'
Usage: agent-cli.sh {ops|twin|check} <command>
       agent-cli.sh status

Examples:
  agent-cli.sh ops add Build new landing page
  agent-cli.sh ops done
  agent-cli.sh ops status
  agent-cli.sh twin decide dark theme, light theme | landing page
  agent-cli.sh twin voice
  agent-cli.sh check file pages/index.html
  agent-cli.sh check test
  agent-cli.sh check claim FLUX generation
USAGE
        exit 1
        ;;
esac
