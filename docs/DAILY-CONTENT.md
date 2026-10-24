# Daily Content — the marketplace's daily run

> One collection a day, rendered on Midjourney, published as marketplace
> plates. The run is the twin producing something new every night
> instead of waiting to be asked.

## What it does

`lib/daily-content.js` runs once a day (launchd, 00:20 local) and:

1. **picks a collection** from `lib/daily-collections.json` — deterministic
   by day-of-year, so the same date always carries the same collection and
   the cycle wraps;
2. **writes its prompts** as a Midjourney pack (one top-level bullet per
   plate, each ending in `--ar 16:9`) into `daily-content/<date>/`;
3. **submits them** through `lib/mj-web.js` — the same web submitter the
   watcher uses, so the prompt composition and the acceptance evidence
   are identical to every other Midjourney job in the repo;
4. **downloads** the accepted job's grid cell through a real browser (the
   CDN answers curl and headless clients with 403) and converts it to the
   marketplace's JPG;
5. **publishes** the bundle to `assets/marketplace/daily/<date>/` and
   updates `assets/marketplace/daily/index.json`;
6. **commits and pushes** it, which is what puts it on the site;
7. **hands the plates to the reel pipeline** — each plate becomes a
   1080×1920 vertical video plus a tagged audio track, and both land in
   `reel-inbox/`, where the running reel-watcher picks them up and
   writes the POST sheet.

The page (`pages/marketplace.html`, the *Daily Frames* section) reads
`index.json` and renders whatever the catalogue holds. A clone that has
never run the pipeline shows the section's empty state — the page states
that plainly rather than erroring.

## Why it is built this way

**The copy comes from the library, never from the run.** Each plate's
caption, alt text and prompt live in `lib/daily-collections.json`, so the
page cannot drift from the art and the e2e can tie every caption to the
manifest it came from. Nothing is generated, so nothing has to be
reviewed twice.

**The prompts are subject-first.** The subject leads, then the camera, the
light and the texture, then `no text`. This is the rule the Midjourney
acceptance matcher needs: a prompt that starts with the same forty
characters as its siblings collapses into one excerpt, and the matcher
then credits the wrong job (see `docs/MJ-CONTACT-SHEET.md`).

**The account's style codes are typed in, not stored in the library.**
`lib/mj-profile.local.json` (gitignored) holds the profile and moodboard
codes; the pipeline appends them to the submitted prompt. The library is
tracked, and those codes are the account's own identifiers. Without them
the render carries the profile alone — which is what makes a daily plate
look different from the rest of the Midjourney work in this repo.

**The run owns its browser.** Port 9445 and its own profile directory,
not the shared 9444 session the watcher and any hand-driven session use.
A calendar job that types into a shared composer is a collision waiting
for a night.

**It refuses to publish over somebody else's work.** Before committing,
the run reads `git status --porcelain` and refuses to proceed if anything
outside `assets/marketplace/daily/` has changed. A daily job that
swallows a colleague's uncommitted work is worse than a daily job that
does nothing.

**It never re-renders a day it already published.** The bundle's
`plates.json` is the record; without `--force` a second run on the same
date stops with one line. That is how a daily run quietly burns a quota.

## Running it

```bash
npm run daily:content           # today's collection: render, publish, push
npm run daily:content:dry       # the plan only — no browser, no generations
node lib/daily-content.js --collection last-ferry --no-publish
node lib/daily-content.js --date 2026-10-22 --force
```

| flag | meaning |
|---|---|
| `--date YYYY-MM-DD` | the day to render (default: today) |
| `--collection <id>` | pick a collection instead of the day's |
| `--count N` | how many plates of the collection (default: 3) |
| `--slot N` | which cell of the 4-up to publish (default: 0) |
| `--port N` | the browser's debug port (default: 9445) |
| `--profile <dir>` | the browser's profile directory (default: `/tmp/mj-daily-profile`) |
| `--profile-codes "a b c"` | override the account's style codes |
| `--dry-run` | print the plan and stop |
| `--no-publish` | render, but write nothing (a trial) |
| `--no-git` | write the bundle and the catalogue, but do not commit |
| `--force` | re-render a day that is already published |

## The schedule

`~/Library/LaunchAgents/com.kaidjuric.digital-twin.daily-content.plist`
fires it at **00:20 local**, on purpose: Midjourney's fast hours are
00:00–03:00, so the day's plates render in about a minute instead of
queueing in relax mode. The launcher (`daily-content-launcher.sh`)
lives in `~/Library/LaunchAgents/` because launchd on Sequoia cannot
`execve` a path under `$HOME` from its own spawn context — bash can, so
the shim resolves Node and execs it (the same fix the watcher fleet
uses).

```bash
launchctl print gui/$UID/com.kaidjuric.digital-twin.daily-content
launchctl kickstart -k gui/$UID/com.kaidjuric.digital-twin.daily-content
```

## What the run publishes

```
assets/marketplace/daily/index.json          the catalogue the page reads
assets/marketplace/daily/<date>/frame-01.jpg  the plates
assets/marketplace/daily/<date>/frame-02.jpg
assets/marketplace/daily/<date>/frame-03.jpg
assets/marketplace/daily/<date>/plates.json   provenance: prompt, task id, dimensions
assets/marketplace/daily/<date>/collection.json
```

`plates.json` is the evidence file: it ties each image to the prompt it
was made from, the Midjourney task id, and the dimensions it was
published at. The e2e spec reads the catalogue and fails if a caption,
an alt text or a declared dimension disagrees with it.

## The reel hand-off

A plate on a page is not distribution. After the day's bundle is
published, `lib/daily-reels.js` builds a vertical reel for each plate
and drops it into `reel-inbox/`:

```
reel-inbox/relay-pylon-line.mp4   1080×1920, H.264 + AAC, 6 s
reel-inbox/relay-pylon-line.mp3   silent, ID3: title / artist / album / genre
```

The reel-watcher (a launchd service) picks the pair up, transcodes it
and writes the cover and the POST sheet, whose caption comes from the
audio's ID3 title — which is the plate's own caption. The social engine
then packages the reel as a product, staged and **not** posted.

The source is built **vertical on purpose**: the watcher letterboxes
rather than crops, so a 16:9 source would sit in a black band. Instead
the still is centred over a blurred, darkened extension of itself and
drifts slowly right.

The reels cost **no Midjourney quota** — they are built from plates that
were already published. They are also **not tracked**: `reel-inbox/` is
working state, so the reels live on the machine that made them.

```bash
npm run daily:reels                     # queue the newest published day
node lib/daily-reels.js --date 2026-10-22 --dry-run
node lib/daily-reels.js --date 2026-10-22 --force   # re-queue, re-transcode
```

A reel the watcher has already produced is **left alone** — re-queuing
it would re-transcode the same video for nothing. `--force` overrides.
That also means the daily run is safe to re-run: an already-published
day skips the render (no quota) and the hand-off finds its reels
already processed.

## The hourly burst

`lib/marketplace-hourly.js` runs the same pipeline on an **hourly
cadence**: eleven slots, one collection each, published under the
hour's own key.

```bash
npm run marketplace:hourly:plan    # print the plan — spends nothing
npm run marketplace:hourly:init    # write the plan to the state file
npm run marketplace:hourly         # run THIS hour's slot (the launchd tick)
npm run marketplace:hourly:burst   # stay up and run each slot when its hour arrives
node lib/marketplace-hourly.js --slot 2026-10-24T13   # run one named slot
```

### The key is the hour

A bundle directory is named by its **key**, not by its date. The daily
run's key is the date (`2026-10-24`); an hourly slot's key is the hour
(`2026-10-24T13`). The key is the directory name, the catalogue
entry's `key`, and the catalogue's dedupe key:

```
assets/marketplace/daily/2026-10-24T13/frame-01.jpg
assets/marketplace/daily/2026-10-24T13/plates.json
```

A date-only layout would make the eleven slots overwrite each other.
The `T<HH>` suffix keeps the flat date-directory layout, so every
consumer — the reel hand-off, the social engine, the marketplace page,
the e2e spec — needed one regex widened and nothing else.

### The interval is a whole number of hours

`--interval-hours` (default 1) is an integer, and it has to be: the
bundle key is the hour, so two slots inside one hour would publish into
the same directory and the second would overwrite the first.

### The state file

`data/marketplace/hourly-burst.json` (gitignored) holds the plan and
what each slot did:

```
pending  → not yet run
running  → a process has it
done     → published
failed   → recorded, NOT retried
```

A failed slot is **not** retried automatically: a retry loop would
quietly spend a Midjourney quota on a failure that will not heal
itself. Re-run it by hand with `--slot <key>`.

A slot left `running` by a crash is taken over after 90 minutes — long
enough that a live render is never disturbed, short enough that a crash
does not cost the hour.

### The schedule

`~/Library/LaunchAgents/com.kaidjuric.digital-twin.marketplace-hourly.plist`
fires the tick at **minute 2 of every hour**. The slot belongs to the
hour it starts in, so a tick at `HH:02` picks `HH`'s slot, and a render
that overran the hour boundary cannot race the next tick. The tick is a
short `--once` invocation rather than a long-lived process: launchd
restarts it, a reboot does not lose the burst, and the state file owns
the progress.

The burst has its **own browser port (9448) and its own profile**
(`/tmp/mj-hourly-profile`), so it never collides with the daily agent
(9445) or the MJ watcher (9444). The session comes from the same cookie
jar.

```bash
launchctl print gui/$UID/com.kaidjuric.digital-twin.marketplace-hourly
launchctl kickstart -k gui/$UID/com.kaidjuric.digital-twin.marketplace-hourly
tail -f logs/marketplace-hourly.out.log
```

### The collection rotation

The burst walks the library from an offset of `dayOfYear + 1`, so the
hourly collections do not repeat the collection the daily run picked for
the same day, and no two slots in one burst share a collection.

## Cost

One collection a day is three Midjourney generations — one per plate.
Each generation is a 4-up, and the run publishes one cell of it. The
collection cycle is twelve days, so the same collection comes back every
twelve days with different renders.

An hourly burst of eleven slots costs **eleven collections — 33
generations**, the same three per collection the daily run spends.

## Tests

```bash
npm run test:daily-content      # the pure logic: selection, prompts, index, guard
npm run test:daily-reels        # the hand-off: names, the band, a real ffmpeg build
npm run test:marketplace-hourly # the burst: the schedule, the state, the slot command
cd e2e && PORT=5180 node marketplace.spec.mjs   # the page contract
```

The unit test covers the collection cycle, the pack format, the index
update and the publish guard (which paths a commit is allowed to touch).
The e2e spec covers the page: the catalogue resolves, the plates render,
and every caption matches the catalogue it came from.

## Limits

- **The cookie jar expires.** Midjourney's session comes from
  `~/.midjourney-cookies.txt`. When it goes stale the run fails loudly
  at the browser step — re-export the jar from a logged-in browser.
- **The download is browser-dependent.** The CDN answers curl and
  headless clients with 403, so the plates are fetched through a headed
  browser. A headless machine cannot run this pipeline.
- **One cell of the 4-up.** The run publishes slot 0 by default; the
  other three are discarded. `--slot` picks a different one, but the
  choice is not evaluated — see the sheet's own lesson that the audit of
  a render is a look, not a measurement.
- **No music.** The daily mood-journey pipeline (`lib/daily-pipeline.js`)
  writes the day's music brief; the content run does not touch it. The
  reel's audio track is silent by design — Instagram reels are posted
  silent and the music is added in the app.
- **Nothing is posted.** The reel reaches the social engine as a staged
  package. `posting.autoPublish` is off and every item is marked
  `publish: false`, so a reel never goes out without a deliberate
  decision.
