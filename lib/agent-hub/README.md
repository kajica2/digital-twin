# SWR Agent Hub

Single terminal, three persistent agents that coordinate and keep things moving.

## Quick Start

```bash
cd ~/Digital-Twin/lib/agent-hub

# Start the hub (opens tmux with 4 windows)
./agent-hub.sh start

# Attach to session
./agent-hub.sh attach

# Check status
./agent-hub.sh status

# Stop everything
./agent-hub.sh stop
```

## The Three Agents

### SWR-Ops (Orchestrator)
Window: `ops`
- Decomposes work into tasks
- Manages task queue
- Coordinates other agents

**Commands:**
```
add <task>     - Add new task
done           - Mark current task done  
block          - Move current to blocked
status         - Show task status
twin <msg>     - Send to Twin
check <msg>    - Send to Check
```

### SWR-Twin (Digital Twin)
Window: `twin`
- Embodies founder's voice/taste
- Makes creative decisions
- Confidence threshold: 0.85

**Commands:**
```
decide <opt1, opt2, opt3> | <context>  - Make decision
remember <key> | <value>               - Store in memory
recall <key>                            - Retrieve memory
voice                                   - Show voice rules
```

### SWR-Check (Verifier)
Window: `check`
- Read-only verification
- Validates claims
- Runs tests

**Commands:**
```
file <path>             - Verify file exists
diff <pattern>          - Check git diff
test                    - Run npm test
claim <statement>       - Verify in docs
status                  - Show history
```

## Workflow

1. **Ops** adds a task: `add Build new landing page`
2. **Twin** decides on creative direction: `decide dark theme, light theme | landing page`
3. **Check** verifies work: `file pages/landing.html`
4. **Ops** marks done: `done`

## Agent Communication

Agents communicate via inbox/outbox files:
- `agents/ops/inbox.txt` - messages for Ops
- `agents/twin/inbox.txt` - messages for Twin  
- `agents/check/inbox.txt` - messages for Check

The hub coordinator routes messages automatically.

## Integration with Obsidian

The agent hub can post to Obsidian:

```bash
cd ~/Digital-Twin/lib/obsidian-integration
node twin-agent.js post "Agent hub started" --tag "system"
```

## Keyboard Shortcuts (tmux)

```
Ctrl+b d     - Detach from session
Ctrl+b 0     - Go to Ops
Ctrl+b 1     - Go to Twin
Ctrl+b 2     - Go to Check
Ctrl+b 3     - Go to Hub Monitor
Ctrl+b n     - Next window
Ctrl+b p     - Previous window
```
