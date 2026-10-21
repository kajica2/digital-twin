# Agent Session Reference

Reusable patterns from an OMP-assisted working session. Copy-paste into any repo.
Author identity for all git commits made in these sessions:
`Kajica Djuric <kai.djuric@gmail.com>`.

---

## 1. Git Workflow (the 3-step)

Never skip `stage`. Never bundle unrelated changes. Commit subject ≤ 72 chars,
Conventional Commit prefix (`docs:`, `feat:`, `chore:`, `fix:`).

| Step | Command |
|---|---|
| 1. stage | `git add <explicit paths>` |
| 2. commit | `git commit -m "<type>: <summary>"` |
| 3. push | `git push` |

Per-commit identity override (repo config may carry a different `user.name`):

```bash
git -c user.name="Kajica Djuric" -c user.email="kai.djuric@gmail.com" commit -m "docs: add X"
```

Full one-liner for a single-file change:

```bash
git add -A -- <path> \
&& git -c user.name="Kajica Djuric" -c user.email="kai.djuric@gmail.com" commit -m "<type>: <summary>" \
&& git push
```

Rules:
- `git add -A` only when the whole tree is the intended change set; otherwise list paths.
- `-- <path>` disambiguates revs vs. files. Always use it.
- Never `git commit --amend` on pushed commits; new commit instead.
- Never `git reset --hard` / `git checkout .` on a tree with uncommitted work.
- Commit message body only when the "why" is not obvious from the subject.

---

## 2. Auth Cleanup (checkpoint workflow)

Cleaning stale credentials from a local tool's store (OMP example). The rule is
**never mutate state that has no rollback**: snapshot → propose → mutate → verify.

### 4-step checkpoint protocol

| Step | Action | Output |
|---|---|---|
| 1. Discover | List the affected rows; read-only query | Candidate id list |
| 2. Propose | Present exact rows + ids to the user; get confirmation | Approved id list |
| 3. Execute | Backup file, then delete **scoped by id** | Backup path + rowcount |
| 4. Verify | Re-run the discovery query; expect 0 rows | Empty result set |

### SQLite mechanics

```bash
# 1. Discover (read-only)
sqlite3 "$DB" ".tables"
sqlite3 -header -column "$DB" "SELECT id, provider, created_at FROM creds;"

# 3a. Execute — backup FIRST, every time
cp "$DB" "$DB.bak-$(date +%Y%m%d-%H%M%S)"

# 3b. Scoped delete — WHERE id = ?, never a blanket DELETE
sqlite3 "$DB" "DELETE FROM creds WHERE id IN (12,15);"

# 4. Verify
sqlite3 "$DB" "SELECT count(*) FROM creds WHERE id IN (12,15);"   # expect 0
```

Hard rules:
- Backup before **every** write, not just risky ones. Timestamped, same directory.
- Scope by primary key. `DELETE FROM t` without `WHERE` is forbidden.
- `VACUUM` is optional and only after verification passes.
- Leave the `.bak` file in place; deleting it is a separate, explicit decision.
- Deleting credentials is a **credential-loss** action — report the id list, wait for the go.

---

## 3. OMP Config Fixes

Apple Silicon / MLX local inference.

| Symptom | Fix |
|---|---|
| OMP downloads/loads a tiny model on CPU, or skips MLX | `providers.tinyModelDevice: "mlx"` in the OMP config |
| Model download path picks the wrong backend | export `PI_TINY_DEVICE=mlx` before the download/run |

```json
{ "providers": { "tinyModelDevice": "mlx" } }
```

```bash
export PI_TINY_DEVICE=mlx
```

Notes:
- `tinyModelDevice` is the runtime selector; `PI_TINY_DEVICE` is the env-level
  equivalent used during fetch/quantization. Set both if one alone is ignored.
- Verify after change: model loads and reports the MLX backend, not CPU.

---

## 4. Bug Report Template

Format used for upstream OMP reports. Copy verbatim, replace `<…>`.

```markdown
## Summary
<one sentence: what is wrong, in the reporter's own words>

## Environment
- OMP version: <x.y.z>
- Platform: <macOS 15 / arm64>
- Model / provider: <id>
- Relevant config: <providers.tinyModelDevice, env vars>

## Defect
<root cause as understood — state it as a claim, not a guess>

## Repro
1. <step>
2. <step>
3. <step>

## Expected
<correct behaviour>

## Actual
<observed behaviour, incl. exact error text>

## Workaround
<what unblocks the reporter today>

## Suggested Fix
<proposed change, concrete enough to implement>
```

| Section | Rule |
|---|---|
| Summary | one line, no jargon |
| Environment | copy-pasteable facts only |
| Defect | root cause; "unclear" is an acceptable answer |
| Repro | minimal deterministic steps |
| Expected / Actual | must be directly comparable |
| Workaround | optional; omit if none |
| Suggested Fix | optional; omit rather than guess |

Store in the repo (`docs/`) **and** attach to the upstream issue. Git subject:
`docs: add <tool> upstream bug report for <symptom>`.

---

## 5. Vibe Mode Patterns

Routing and checkpointing under time pressure without losing correctness.

| Mode | Use when | Routing |
|---|---|---|
| **fast** | Fix is mechanical, well-understood, low blast radius | Single `fast` worker; no delegation. Verify inline. |
| **good** | Multi-file, design decisions, unknown blast radius | `good` worker(s) with explicit acceptance criteria; main agent verifies once after landing. |

Routing rules:
- Parallel `tasks[]` only for genuinely independent slices. Shared-contract edits
  get one integration owner; siblings coordinate via `write agent://<id>`.
- Never outsource the top-level plan. Delegating slice design is fine.
- Workers start blank — the brief must carry full context, intent, and paths.

### Checkpoint workflow for multi-step fixes

Use when a fix spans >1 subsystem or has a rollback:

```
Discover ──▶ Propose ──▶ Execute (one scoped step) ──▶ Verify ──▶ checkpoint
                ▲                                              │
                └──────────── next step, re-confirmed ────────┘
```

Per step:
1. **One** scoped change, independently revertable.
2. Record what was verified, not what was assumed.
3. Commit at each checkpoint — the git log is the audit trail for the multi-step fix.
4. Any step that needs a destructive/irreversible action re-enters at **Propose**.

Anti-patterns:
- One giant commit spanning all steps — no rollback point.
- Verifying twice ("running it again to be sure") — verify once, then hand off.
- Raising a checkpoint step to a worker without the acceptance criteria.

---

## Identity block

```bash
git config --global user.name  "Kajica Djuric"
git config --global user.email "kai.djuric@gmail.com"
```

Per-repo override wins if already set — use the `-c` flags in §1 instead.