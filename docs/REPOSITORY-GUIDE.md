# Repository guide

Digital Twin is Kai Djuric's local-first creative workspace: a place to organise music, prepare media, and coordinate repeatable work.

## Choose a starting point

| Your task | Start here |
| --- | --- |
| Understand the public product | [Landing page](../pages/landing.html) |
| Open the working shell | [Twin OS](../pages/twin-os/index.html) |
| Learn the operator workflow | [How-to guide](../pages/how-to.html) |
| Understand the shared visual language | [Design contract](../DESIGN.md) |
| Change or review this repository | [Agent and contributor context](../AGENTS.md) |
| Understand the social worker | [Social engine](SOCIAL-ENGINE.md) |
| Understand media conversion | [Media toolchain](MEDIA-TOOLCHAIN.md) |

## Where work belongs

| Location | Responsibility |
| --- | --- |
| `pages/` | Browser-facing tools and their entry points |
| `lib/` | Shared logic, processing tools, and worker implementations |
| `agents/` | Agent definitions and orchestration entry points |
| `assets/` | Shared visual assets, skins, and authored creative inputs |
| `data/` | Catalogues and tool outputs; check ignore rules before tracking |
| `docs/` | Operator references, architecture decisions, and workflow explanations |
| `e2e/` | Browser checks and their local artifacts |

Use the existing implementation for a workflow before introducing a sibling one. A new page should link to its operator documentation, and that documentation should identify the implementation it describes. Check the existing ignore rules for generated media and machine-specific state.

Before moving a module, trace its imports, command-line callers, page references, scheduled jobs, and tests. Move one dependency group at a time and verify those callers together.

## Product personality

**Calm, specific, musically literate.** The workspace should make the next useful action clear.

- Describe the task in the user's language: index songs, prepare a clip, review a render.
- Report observed state and the next action. Example: “No songs indexed. Choose a source folder, then rebuild the catalogue.”
- Explain what an agent actually does. Name its input, output, and limits.
- Keep notifications for decisions, failures, and completed work that matter.
- Use musical imagery in introductions; use concrete instructions in controls and errors.
- Keep planned capabilities separate from available workflows.

The shared identity is **Kai Djuric — musician, inventor, creative technologist**. Digital Twin expresses the organising side of that practice. Its existing skin contract remains the visual reference.

## Working agreement

Read the repository's agent instructions before implementation. Use its current package scripts and browser checks rather than copying historical test counts. Record verification with the command, outcome, and any environment limitation.
