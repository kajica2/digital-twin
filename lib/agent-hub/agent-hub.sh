#!/bin/bash
# SWR Agent Hub — start / stop / status the three agents.
#
# Usage: ./agent-hub.sh {start|stop|status|list|restart|add <name>|logs <agent>}
#
# The three agents are SWR-Ops (orchestrator), SWR-Twin (voice) and
# SWR-Check (verifier). They talk through per-agent inboxes — one file
# per message — and the coordinator only watches.
#
# The agents are launched in their own session (setsid where it exists,
# python3's os.setsid() on macOS, nohup as a last resort) so they
# survive the shell that started them. A plain `node … &` dies with the
# session, which is how the previous launch looked "running" for exactly
# as long as the terminal was open.
#
# SWR_HUB_ROOT points a whole hub instance at a different directory, so a
# second harness can run beside this one without touching its pids, logs,
# inboxes, task board or memory.
set -uo pipefail

HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB_ROOT="${SWR_HUB_ROOT:-$HUB_DIR}"
AGENT_DIR="$HUB_DIR/agents"
PID_DIR="$HUB_ROOT/pids"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

log() { echo -e "${GREEN}[HUB]${NC} $1"; }

mkdir -p "$PID_DIR" "$HUB_ROOT/ops" "$HUB_ROOT/twin" "$HUB_ROOT/check" \
         "$HUB_ROOT/tasks" "$HUB_ROOT/memory"

# The agents, in the order they are started.
AGENTS=("ops:ops/swr-ops.js" "twin:twin/swr-twin.js" "check:check/swr-check.js")

pid_of() {
    local name=$1
    local file="$PID_DIR/$name.pid"
    [ -f "$file" ] || return 1
    cat "$file"
}

alive() {
    local pid=$1
    kill -0 "$pid" 2>/dev/null
}

# List all agents
list_agents() {
    echo -e "${CYAN}═══ Registered Agents ═══${NC}"
    echo ""

    echo -e "${BLUE}Control Layer (always running):${NC}"
    for agent in hub ops twin check; do
        if pid=$(pid_of "$agent"); then
            if alive "$pid"; then
                echo -e "  ${GREEN}●${NC} $agent (PID $pid)"
            else
                echo -e "  ${RED}●${NC} $agent (dead — stale pid file)"
            fi
        else
            echo -e "  ${YELLOW}○${NC} $agent (not running)"
        fi
    done

    echo ""
    echo -e "${MAGENTA}Persona Layer (digital beings):${NC}"

    if [ -f "$HUB_DIR/../personas/registry.json" ]; then
        node -e "
            const fs = require('fs');
            const reg = JSON.parse(fs.readFileSync('$HUB_DIR/../personas/registry.json', 'utf8'));
            reg.personas.forEach(p => {
                console.log('  ' + p.id + ' - ' + p.name + ' (' + p.type + ')');
            });
        "
    fi

    echo ""
    echo -e "${YELLOW}Custom Agents:${NC}"
    if [ -d "$AGENT_DIR/custom" ]; then
        ls -1 "$AGENT_DIR/custom" 2>/dev/null | sed 's/\.js$//' | while read agent; do
            echo "  $agent"
        done
    fi

    echo ""
    echo -e "${CYAN}hub root: $HUB_ROOT${NC}"
}

# Add custom agent
add_agent() {
    local name=$1
    if [ -z "$name" ]; then
        echo "Usage: $0 add <agent-name>"
        return 1
    fi

    mkdir -p "$AGENT_DIR/custom"
    cat > "$AGENT_DIR/custom/${name}.js" << EOF
#!/usr/bin/env node
/**
 * Custom Agent: $name
 *
 * A starting point: the message protocol from ../../lib/hub-runtime.js,
 * the same one the three built-in agents speak.
 */

'use strict';

const hub = require('../../lib/hub-runtime.js');

const ROOT = hub.resolveRoot();

function log(msg) {
    const line = \`[\${new Date().toISOString()}] [$name] \${msg}\`;
    console.log(line);
}

function main() {
    log('Starting $name...');
    setInterval(() => {
        for (const msg of hub.takeMessages(ROOT, '$name')) {
            log(\`Message from \${msg.from.toUpperCase()}: \${msg.body}\`);
        }
    }, 500);
}

main();
EOF

    log "Created custom agent: $name"
    echo "Edit: $AGENT_DIR/custom/${name}.js"
}

# Detach a command from this shell's session.
#
# macOS has no `setsid` — it is a GNU coreutils tool. Every launch
# failed with "setsid: command not found" until this was fixed.
#
# The order of preference:
#   1. `setsid` when it exists (GNU/Linux).
#   2. python3's os.setsid() — a true new session, same semantics.
#   3. plain `nohup` + `disown`, which ignores SIGHUP.
#
# In every case the child is exec'd in place, so the pid we record is
# the pid of the process that actually runs.
#
# Usage: detach <logfile> <command> [args...]
# Prints the pid on stdout.
detach() {
    local logfile="$1"; shift
    if command -v setsid >/dev/null 2>&1; then
        setsid nohup "$@" >> "$logfile" 2>&1 < /dev/null &
    elif [ -x /usr/bin/python3 ]; then
        /usr/bin/python3 -c 'import os,sys
try:
    os.setsid()
except OSError:
    pass
os.execvp(sys.argv[1], sys.argv[1:])' "$@" >> "$logfile" 2>&1 < /dev/null &
    else
        nohup "$@" >> "$logfile" 2>&1 < /dev/null &
    fi
    echo $!
}

# Start/stop
start_agents() {
    log "Starting SWR Agent Hub (root: $HUB_ROOT)..."

    # Kill whatever the pid files point at, so a restart is clean.
    for f in "$PID_DIR"/*.pid; do
        [ -f "$f" ] || continue
        pid=$(cat "$f")
        kill "$pid" 2>/dev/null
    done
    sleep 1
    rm -f "$PID_DIR"/*.pid

    # The coordinator only watches.
    pid=$(detach "$PID_DIR/hub.log" node "$HUB_DIR/hub-coordinator.js")
    echo "$pid" > "$PID_DIR/hub.pid"

    for entry in "${AGENTS[@]}"; do
        name="${entry%%:*}"
        script="${entry##*:}"
        pid=$(detach "$PID_DIR/$name.log" node "$AGENT_DIR/$script")
        echo "$pid" > "$PID_DIR/$name.pid"
    done

    sleep 2
    list_agents
}

stop_agents() {
    log "Stopping all agents..."
    for f in "$PID_DIR"/*.pid; do
        [ -f "$f" ] || continue
        pid=$(cat "$f")
        kill "$pid" 2>/dev/null
    done
    sleep 1
    # Anything that ignored SIGTERM gets SIGKILL.
    for f in "$PID_DIR"/*.pid; do
        [ -f "$f" ] || continue
        pid=$(cat "$f")
        kill -9 "$pid" 2>/dev/null
    done
    rm -f "$PID_DIR"/*.pid
    log "All stopped."
}

tail_logs() {
    local name=$1
    if [ -z "$name" ]; then
        echo "Usage: $0 logs <agent>"
        return 1
    fi
    local file="$PID_DIR/$name.log"
    if [ ! -f "$file" ]; then
        echo "No log for $name at $file"
        return 1
    fi
    tail -n 40 "$file"
}

case "${1:-list}" in
    start) start_agents ;;
    stop) stop_agents ;;
    list|status) list_agents ;;
    add) add_agent "$2" ;;
    logs) tail_logs "$2" ;;
    restart) stop_agents; sleep 1; start_agents ;;
    *)
        echo "Usage: $0 {start|stop|list|status|restart|add <name>|logs <agent>}"
        ;;
esac
