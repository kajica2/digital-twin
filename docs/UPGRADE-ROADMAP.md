# Digital Twin upgrade roadmap

Research and repository baseline: 10 November 2026. This is a product comparison and a staged implementation plan for Kai Djuric’s local-first creative workspace. Effort ranges are estimates for one developer, not delivery commitments.

## Product direction

Make the existing toolkit easier to return to: capture a thought, find the relevant context, choose a tool, finish the work. Keep the music catalogue and media pipelines as the differentiator. Preserve the vanilla HTML/JS stack, shared house/studio skins, and Today / Songs / Twin navigation.

The repository already has substantial processing and orchestration modules. The working shell had a smaller set of capabilities: an agenda, searchable song catalogues, tool links, and sample runtime counters. The best first investment is a useful daily interface around that work, followed by observed runtime state. Building another processing pipeline would add less value at this stage.

## Comparable products and decisions

These are adjacent products with relevant interaction patterns, rather than claims that Digital Twin offers their full feature sets. Sources below are the vendors’ own documentation, checked for this upgrade. No pricing assumptions are used.

| Product | Documented pattern | Decision for Digital Twin |
| --- | --- | --- |
| [Mem Workspace](https://get.mem.ai/product/workspace) | Searchable notes, editable collections, related context, MCP access | Start with explicit saved memories and reliable retrieval. Add grounded related context after there is useful personal data. |
| [mymind Spaces](https://mymind.com/how-to-get-the-most-out-of-spaces) | Saved searches become collections that update as matching items arrive | Ship saved keyword/tag searches. They need no model, account, or background service. |
| [Raycast Search Bar](https://manual.raycast.com/search-bar) and [Quicklinks](https://manual.raycast.com/quicklinks) | One keyboard entry point for tools and saved resources, with import/export | Ship a keyboard command palette over tools, agenda tasks, and memory, plus memory portability. |
| [Reclaim quick start](https://help.reclaim.ai/en/articles/14846468-how-to-get-started-with-reclaim) | Focus planning, priority-aware tasks, and calendar changes previewed before application | Follow with a local task planner and reviewable suggestions. Calendar integration requires a separate opt-in and credentials. |

## Phase 1 — implemented in this change

| Capability | User outcome | Acceptance evidence |
| --- | --- | --- |
| Quick capture in Today | Save a note, reference, or decision with inline #tags | Save → inspect stored record → reload → find the same note |
| Memory in Twin | Search words and tags, pin, edit, delete, undo the last deletion | Accent-insensitive word matching; edits retain IDs; literal HTML stays text |
| Saved searches | Revisit a theme or project without arranging folders | A later matching note appears in the saved query |
| Command palette | Find a tool, agenda task, or saved memory from any panel | Search button and Cmd/Ctrl K; arrows, Enter, Escape; native modal focus management |
| Memory backup | Move or keep a copy of notes and saved searches | Download JSON → delete → import → restore; repeated imports do not duplicate |
| Observable overview | See real memory and unfinished-task counts | Counters derived from local records and agenda state; sample routines explicitly labelled |
| Complete offline shell | Reopen and capture with the network unavailable after one successful visit | Cache both skins and shared scripts/styles; network-first navigation; scope-specific cache retirement |
| Existing root entry point | `/twin-os/` and `/pages/twin-os/` share the same experience | Same storage keys and browser smoke coverage |

Memory has its own versioned record (`dt-memory-v1`). Existing agenda keys and catalogue formats remain intact. Backup covers memory and saved searches, not agenda data, generated catalogues, or media. The new features make no model calls and upload no user data. Search is deterministic keyword matching, not semantic or AI retrieval.

## Phase 2 — connect observed work, then improve planning

Priority: next. Estimated effort: 3–5 developer days after choosing the local runtime source.

1. **Read-only runtime snapshot.** Adapt existing watcher/hub status into a versioned, redacted snapshot (`generatedAt`, source, state, last result, failure detail). Inspect current status producers before adding a new endpoint. Missing or stale input must show unavailable/stale, never a fabricated counter. Keep credentials and absolute paths out of public artifacts.
2. **Task planning.** Extend the existing agenda with priority, a day, an estimate, and an optional song/project reference. Migrate old records without losing completion. Allow sample agenda entries to be removed. Distinguish a recurring routine from a dated task.
3. **Useful daily readout.** Surface unfinished work and recent completed outputs from those records. Every suggestion should say which task or observation produced it. Offer a proposed focus block for review; do not move calendars automatically.

Acceptance: old agenda records migrate; reload and backup preserve new fields; missing/stale runtime snapshots have distinct states; a failed job links to a concrete recovery instruction; focus suggestions point to real inputs.

## Phase 3 — connect creative context

Priority: after Phase 2. Estimated effort: 4–7 developer days, depending on catalogue size and linking rules.

- Add stable references between memory, songs, render manifests, and projects. Resolve references through existing catalogues rather than embedding local filesystem paths in public pages.
- Expand the palette to catalogue records using a shared search adapter; retain the Songs panel’s richer filters. The first release’s palette searches tools, tasks, and memory only.
- Add context suggestions using shared tags and project IDs, with the reason shown beside each suggestion. Measure usefulness before adding embeddings.
- Offer a combined workspace backup with schema migration and a restore preview. Add IndexedDB if measured storage volume or concurrent writes warrant it; the current small memory record uses localStorage with visible quota failures.

Acceptance: links resolve after reindexing; removed catalogue items produce a clear unavailable state; suggestions cite real records; imports have a reviewable summary and preserve existing user work.

## Phase 4 — optional assistance and external connections

Priority: only after the capture/recall loop proves useful. Estimated effort: scope after provider and access choices.

- Evaluate a local model or an explicitly enabled provider for grounded question answering. Answers must cite saved records, identify insufficient evidence, and keep a retrieval-only fallback.
- Expose a narrow, read-only local MCP surface for approved memory/catalogue queries. Authentication and scope come before write tools.
- Add calendar connections only when requested, with previewable changes and explicit application. Make account disconnect and data export part of that feature.
- Attach any proposed automation to a visible input, output, run history, and recovery action. Reuse the existing orchestrator and watcher implementations.

## How to decide the next investment

Use the workspace personally for a week, then review:

- Can a captured decision be found again within 10 seconds?
- Which saved queries and tool shortcuts get used repeatedly?
- Are task suggestions based on enough real activity to be useful?
- Can the latest memory backup be restored into a clean browser with the expected note count?
- Does the shell remain usable offline, in both skins, and at a phone viewport?

Collect these through a short manual review first. Any telemetry would need an explicit product decision; none is added here.
