# Twin OS memory and search

Open `pages/twin-os/` through the existing local server:

```sh
node lib/serve.js --port 5173
```

## Capture and return

In **Today**, use **Keep a thought** to save a phrase, reference, or decision. Put `#tags` in the text to give it a topic. **Capture** in the top bar takes you back to this form from any panel.

In **Twin**, search the words you remember or a `#tag`. All search words must match, in any order; case and accents are ignored. **Save search** keeps the current query as a reusable collection. New matching memories appear automatically. Pin a memory to keep it above other results. Edit returns to the capture form; **Cancel edit** leaves the saved version unchanged. Delete offers **Undo delete** for the most recent deletion until the page is closed or reloaded.

Use **Search** or **Cmd/Ctrl K** to find an existing tool, agenda task, or memory. Arrow keys move through results, Enter opens one, and Escape closes the dialog. The palette does not search the audio catalogue yet; use the Songs panel for that.

## Back up memory

**Export memory** downloads a version 1 JSON backup of notes and saved searches. Keep it outside the browser. **Import memory** validates the complete file before writing anything and merges records by ID. Existing records win, including when an older backup contains an earlier version of a memory. Importing the same backup twice adds no duplicates.

Backups contain private note text in plain JSON. Agenda items, media, song catalogues, and theme preferences are outside this memory backup. Memory is stored per site and browser profile: localhost, GitHub Pages, and Vercel have separate storage. Export/import moves it between them. The two Twin OS paths on the same site share memory.

## Storage and recovery

The browser stores memory locally under `dt-memory-v1`; no server or model is involved. Limits are 1,000 notes, 5,000 characters per note, 20 saved searches, and a 2 MB import file. Browser storage limits can be lower. A failed write leaves the draft visible and reports that it was not saved. Export existing memory before making space.

If saved data is malformed, the workspace leaves it untouched and blocks memory writes. **Export memory** then downloads the original stored text as `twin-memory-recovery.json`. Keep this file for repair; it may not be a valid import until its format is repaired. Clearing this site's browser data resets the workspace, including agenda and preferences, so keep the recovery file and any other needed data first.

Other open tabs refresh memory after a storage change. Each operation rereads current storage before writing. localStorage does not provide transactions across simultaneous tab edits; coordinated multi-writer synchronization is a later phase.

## Offline use

Visit once online and allow the service worker to install. The shell, both skins, and memory scripts are cached locally. Reopening the shell and saving memories work offline; media tools and external links may need their own resources. Web fonts use their system fallbacks if unavailable. Online navigation refreshes the shell, and a cache version retires old assets without deleting unrelated application caches.

The overview counts saved memories and unfinished agenda tasks. The four starting tasks and three rhythms are labelled examples; no agent activity, spend, or learned behaviour is inferred from them.

## Implementation and checks

- `lib/twin-memory.js`: versioned record validation, tag extraction, matching, backup parsing, and merge rules; shared by browser and Node tests.
- `lib/twin-workspace.js`: `<twin-memory>`, capture controls, observed counters, and command dialog. Tool links resolve from the script URL, including on a project-site subpath.
- `assets/twin-workspace.css`: layout using the existing skin contract.
- `pages/twin-os/sw.js`: versioned shell assets and network-first catalogue fallback.
- `twin-os/`: root entry point, kept in sync with the canonical `pages/twin-os/` shell using one fewer parent directory in shared-asset paths.

```sh
npm run test:twin-memory
cd e2e && npm ci
# CHROME_PATH is optional when Puppeteer's installed browser is available.
CHROME_PATH=/path/to/chrome npm run e2e:twin-workspace --prefix ..
```

The browser spec starts a repo-root server by default. Set `E2E_URL` to a running host or deployment to verify that instance instead. It covers capture, edit, pin, literal text rendering, search, saved queries, keyboard navigation, actual download/import, invalid import, multiple tabs, both skins offline, mobile layout, and storage failures.

Product comparison and subsequent phases: [Upgrade roadmap](UPGRADE-ROADMAP.md).
