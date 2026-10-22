# The social engine

`lib/social-engine.js` is the twin's social worker: one asset in, one
priced, tagged, written and staged post out.

It is a **worker**, not a chatbot and not a model call. It polls, it
finds what changed, it packages it, and it stops. The copy is written
from the asset's own fields, the tags from the asset's own words plus
the configured pools, the price from the configured table. The same
input always produces the same output — a diff between two runs means
the inputs changed and nothing else.

```
assets/marketplace/covers/          ┐
assets/marketplace/system-error/    │
assets/marketplace/daily/<date>/    ├─► discovery ─► package ─► stage ─► (gated) post
reel-inbox/processed/               │                  │
social-inbox/<item>/                ┘                  └─ data/social/<id>/
                                                            post.json
                                                            POST.md      ← what the poster reads
                                                            price.json
                                                        data/social/pricing.json  ← the store's price plan
```

## Running it

```bash
npm run social:once     # one pass, then exit
npm run social:worker   # the worker: poll forever
npm run social:dry      # compute and print, write nothing
npm run test:social     # the unit suite
```

The worker also runs as a launchd service:

```bash
launchctl print gui/$UID/com.kaidjuric.digital-twin.social-worker
pgrep -fl social-engine.js
tail -f logs/social-worker.out.log
```

The LaunchAgent points at `~/Library/LaunchAgents/social-worker-launcher.sh`
rather than at `bin/`: launchd on Sequoia cannot `execve()` anything
under `$HOME`, so the shim resolves Node and the real repo path and
execs the worker itself. Same pattern as the other four watchers.

## What it does with an asset

**Tags**, in three tiers, each capped:

| tier | where it comes from | cap |
|---|---|---|
| primary | the asset's own words (title, family, kind) | 7 |
| secondary | the kind's words + the configured pool | 10 |
| niche | the asset's long-tail words (prompt / alt) | 15 |

A tier is never padded with invented reach: if the asset is thin, the
tier is thin, and the package says so in `warnings`. A multi-word
family (`neon-pulse`) contributes both its words and the squashed form
(`#neonpulse`) — a hashtag is one word.

**Copy** for Instagram, TikTok, Twitter, Facebook and YouTube. The
templates and the hashtag alphabet live in `lib/social-shared.js` — the
social engine does not reimplement them, it feeds that module a
persona-shaped object. One implementation of "what a caption is".

**Price**, from `lib/social-config.json`:

```
amount = base + lettering + variant × (variants − 1)     clamped to [floor, ceiling]
```

A cover study is 12 EUR, +3 when the type was set in layout rather
than painted in, +1 per extra seed variant. A reel is 6. The whole
catalogue is sold as a bundle at 20 % off.

**POST.md** — the file `lib/ig-poster.js` reads. The contract is the
persona pack's: a `# ` title, a `## Caption` section, a `## Next`
section (the poster stops there) and a `## Hashtags` section. The
engine rewrites the "Next" block to say what actually happens to the
package instead of "upload this by hand".

## The store

`data/social/pricing.json` is the price plan: every product, its name,
its slug, its price and the rationale behind it, plus the catalogue
total and the bundle.

**Gumroad has no API wired into this repo.** The plan is therefore
*applied by hand* — it is a document, not a mutation. The same is true
of the catalogue in `pages/marketplace.html`: the engine computes the
prices, a human sets them on the store.

## Publishing is gated

Two switches, both off by default:

```json
"posting": {
  "enabled": true,
  "poster": "lib/ig-poster.js",
  "autoPublish": false,
  "dryRunPoster": false
}
```

- `posting.autoPublish: false` — nothing is published unless the item
  itself says so (`publish: true` in the item's `item.json`).
- `posting.dryRunPoster: true` — the poster is invoked with
  `--dry-run`: the whole path is exercised, nothing reaches Instagram.

A package without a video is staged, never posted. The poster is the
only thing in the repo that publishes to a real account, and that is
irreversible, so the gate stays.

## Dropping something in

`social-inbox/<name>/` with an optional `item.json`:

```json
{
  "title": "Demo Frame",
  "kind": "plate",
  "description": "A frame pulled off the System Error series.",
  "variantCount": 1,
  "publish": false
}
```

The worker picks it up within one poll interval, writes
`data/social/demo-frame/`, links the media (symlinks, never copies) and
adds it to the price plan.

## The files

| file | what it is |
|---|---|
| `lib/social-engine.js` | the worker and every pure function in it |
| `lib/social-shared.js` | the shared rules: one tag alphabet, one tier contract, one POST.md shape |
| `lib/social-config.json` | the config: sources, tag pools, caps, price table, posting gate |
| `lib/social-engine.test.js` | the unit suite (121 assertions) |
| `lib/social-shared.test.js` | the rules suite (36 assertions) |
| `data/social/` | the generated packages and the price plan (gitignored) |
| `social-inbox/` | the drop zone (gitignored, `.gitkeep` kept) |
| `logs/social-worker.out.log` | the service log |

## The limits

- The catalogue and the reels are discovered; anything else has to be
  dropped into `social-inbox/`. The catalogue is the covers, the System
  Error plates and the daily bundle the daily run publishes; the reels
  are the reel-watcher's output, in the flat layout it writes
  (`<base>.mp4`, `<base>_cover.jpg`, `<base>_POST.md` in one
  directory).
- The price plan is a plan. Nothing writes to Gumroad.
- The copy is template-driven. It is serviceable, not a campaign.
- A stale package (its source is gone) is pruned, with a log line.
