#!/bin/bash
# SWR Agent Hub - Scalable multi-agent system
# Usage: ./agent-hub.sh {start|stop|status|add|remove|list}

HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$HUB_DIR/agents"
PID_DIR="$HUB_DIR/pids"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

log() { echo -e "${GREEN}[HUB]${NC} $1"; }

mkdir -p "$PID_DIR" "$AGENT_DIR"

# List all agents
list_agents() {
    echo -e "${CYAN}═══ Registered Agents ═══${NC}"
    echo ""
    
    # Control agents
    echo -e "${BLUE}Control Layer (always running):${NC}"
    for agent in hub ops twin check; do
        if [ -f "$PID_DIR/$agent.pid" ]; then
            pid=$(cat "$PID_DIR/$agent.pid")
            if kill -0 "$pid" 2>/dev/null; then
                echo -e "  ${GREEN}●${NC} $agent (PID $pid)"
            else
                echo -e "  ${RED}●${NC} $agent (dead)"
            fi
        else
            echo -e "  ${YELLOW}○${NC} $agent (not running)"
        fi
    done
    
    echo ""
    echo -e "${MAGENTA}Persona Layer (digital beings):${NC}"
    
    # Load personas
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
}

# Add custom agent
add_agent() {
    local name=$1
    if [ -z "$name" ]; then
        echo "Usage: $0 add <agent-name>"
        return
    fi
    
    mkdir -p "$AGENT_DIR/custom"
    cat > "$AGENT_DIR/custom/${name}.js" << EOF
#!/usr/bin/env node
// Custom Agent: $name

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.join(__dirname, '../..');

function log(msg) {
    console.log(\`[\${new Date().toISOString()}] [$name] \${msg}\`);
}

const LOG_FILE = path.join(AGENT_ROOT, 'agents/custom/${name}.log');

function main() {
    log('Starting $name...');
    
    // Your agent logic here
    setInterval(() => {
        // Check command.txt for tasks
    }, 1000);
}

main();
EOF
    
    log "Created custom agent: $name"
    echo "Edit: $AGENT_DIR/custom/${name}.js"
}

# Start/stop
start_agents() {
    log "Starting SWR Agent Hub..."
    
    # Kill existing
    for f in "$PID_DIR"/*.pid; do
        [ -f "$f" ] && kill $(cat "$f") 2>/dev/null
    done
    sleep 1
    
    # Core
    node "$HUB_DIR/hub-coordinator.js" > "$PID_DIR/hub.log" 2>&1 &
    echo $! > "$PID_DIR/hub.pid"
    
    node "$AGENT_DIR/ops/swr-ops.js" > "$PID_DIR/ops.log" 2>&1 &
    echo $! > "$PID_DIR/ops.pid"
    
    node "$AGENT_DIR/twin/swr-twin.js" > "$PID_DIR/twin.log" 2>&1 &
    echo $! > "$PID_DIR/twin.pid"
    
    node "$AGENT_DIR/check/swr-check.js" > "$PID_DIR/check.log" 2>&1 &
    echo $! > "$PID_DIR/check.pid"
    
    # Start persona engine
    node "$HUB_DIR/../personas/persona-engine.js" --daemon > "$PID_DIR/personas.log" 2>&1 &
    echo $! > "$PID_DIR/personas.pid"
    
    sleep 2
    list_agents
}

stop_agents() {
    log "Stopping all agents..."
    for f in "$PID_DIR"/*.pid; do
        [ -f "$f" ] && kill $(cat "$f") 2>/dev/null
    done
    rm -f "$PID_DIR"/*.pid
    log "All stopped."
}

case "${1:-list}" in
    start) start_agents ;;
    stop) stop_agents ;;
    list|status) list_agents ;;
    add) add_agent "$2" ;;
    restart) stop_agents; sleep 1; start_agents ;;
    *)
        echo "Usage: $0 {start|stop|list|add|restart}"
        ;;
esac
