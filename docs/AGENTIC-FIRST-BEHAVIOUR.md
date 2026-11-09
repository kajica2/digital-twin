# Agentic first behaviour — seven classes

> The dominant mode an agent adopts on **first contact** with a prompt.
> Each class has a different default, a different first move, and a
> different failure mode.
>
> `docs/AGENT-PLAN.md` answers *which model* does the work.
> This doc answers *how to start* before any model is invoked.

Real agents usually **route**: classify the prompt first, then dispatch
to one of these. Strongest setups mix classes in a short chain, e.g.
Critic → Planner → Executor, or Investigator → Prototyper → Verifier on
the finished artifact.

---

## The seven classes

### 1. Verifier (Cautious Validator)

Trust nothing, verify everything.

- **First move:** "what's the source? is this true? what's the evidence?"
- **Acts only** on verified premises.
- **Best for:** research, fact-checking, security-sensitive work.
- **Failure mode:** paralysis; friction on simple asks.

### 2. Executor (Direct Doer)

Do exactly what's asked, period.

- **First move:** read the prompt, identify the action, do it.
- **No** clarification, no questions.
- **Best for:** clear, low-risk, reversible tasks.
- **Failure mode:** runs with bad premises; produces output the user
  didn't actually want.

### 3. Clarifier (Negotiator)

Understand before acting.

- **First move:** identify 1–3 high-impact ambiguities, ask before
  committing.
- **Best for:** open-ended briefs, high-stakes decisions, irreversible
  actions.
- **Failure mode:** over-asks; annoys with trivia.

### 4. Planner (Strategist)

Design before doing.

- **First move:** outline the approach, surface tradeoffs, get
  sign-off, then execute.
- **Best for:** multi-step work, system design, anything with long
  feedback loops.
- **Failure mode:** plans instead of acts.

### 5. Investigator (Researcher)

Gather before concluding.

- **First move:** read, search, collect context from authoritative
  sources. Then propose from evidence.
- **Best for:** novel questions, decisions requiring domain knowledge.
- **Failure mode:** context-cost too high; analysis paralysis.

### 6. Prototyper (Builder)

Build something small first, iterate.

- **First move:** scaffold a minimal working version, get feedback,
  refine.
- **Best for:** UI/UX, design exploration, hypothesis testing.
- **Failure mode:** ships a bad first version as the final.

### 7. Critic (Skeptic)

Question the brief itself.

- **First move:** "is this the right goal? what's missing? what could
  go wrong?"
- **Reframes or refuses** if the premise is flawed.
- **Best for:** ambiguous asks, requests that may be the wrong
  solution, prompt-injection defense.
- **Failure mode:** refuses too much; annoys with "but why?".

---

## Cheat-sheet

| Class | First move | Best for | Failure mode |
|---|---|---|---|
| Verifier | "Is this true?" | Research, security | Paralysis |
| Executor | "Do it." | Clear, reversible | Bad premises |
| Clarifier | "What do you mean?" | Open briefs, high-stakes | Over-asks |
| Planner | "What's the approach?" | Multi-step, long loops | Over-plans |
| Investigator | "What do I know?" | Novel questions | Analysis paralysis |
| Prototyper | "Build a v0." | UI, exploration | Ships bad v0 |
| Critic | "Is this the right ask?" | Ambiguous, suspicious | Refuses too much |

---

## How the twin uses this

Classify **once**, at first contact, then dispatch. Do not stay in the
first class for the whole job unless the job is one class.

House defaults that already constrain routing (see also
`docs/AGENT-PLAN.md` and `AGENTS.md`):

- **Prefer action over questions** for clear, reversible work → start
  as **Executor** (or **Prototyper** for UI), not Clarifier.
- **Irreversible / protected / credential / publish** work → **Critic**
  or **Clarifier** first, then Planner → Executor.
- **Security / secrets / deploy freshness** → **Verifier** on the
  artifact before claiming done.
- **Novel domain question with no repo precedent** → **Investigator**
  before Planner.
- **Multi-file system change with a long feedback loop** → **Planner**,
  then Executor; Verifier on the e2e result.

Example chains for this repo:

| Prompt shape | Chain |
|---|---|
| "fix the failing e2e" | Executor → Verifier |
| "add a new tool page" | Prototyper → Verifier |
| "merge to main" (protected) | Critic (can I?) → Clarifier only if a human action is required → Executor on the sync after merge |
| "why is this 3.5s not 2.0s?" | Investigator → Planner → Executor |
| "paste me a cookie jar" | Critic → Verifier → Executor (outside the repo) |

The failure modes are the stop conditions: if the chosen class is
spinning (paralysis, over-ask, over-plan, refuse-loop), reclassify and
switch.
