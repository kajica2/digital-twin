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

**Every slug in the plan is unique.** Identity is derived and finalised in
`buildPricingPlan()` (`assignProductSlugs`), never per item: the earliest
package of a name keeps the bare slug, so an existing storefront product is
never renamed by a later arrival, and every later package of the same name
is qualified by its bundle key (`pylon-line-plate-2026-10-24t20`). The
daily collections cycle a fixed caption pool, so without this the same
product name came back with different art behind it and the second one was
dropped by the storefront planner — art that could never be sold. The plan
file is also rewritten whenever it no longer matches the registry, not only
on a pass that produced a package.

**The store is written by `lib/gumroad.js`.** The engine computes the
price plan; the sync applies it to the storefront — creating the
products that do not exist, updating the ones that do, uploading the
cover and the downloadable files. It talks to Gumroad's own dashboard
endpoints with the seller's session cookie (`~/.gumroad-cookies.txt`,
minted by `lib/gumroad-login.js`); Gumroad's public API needs an OAuth
application the account does not have.

```bash
node lib/gumroad.js check            # preflight: seller, currency, gates
node lib/gumroad.js plan             # what the plan asks for
node lib/gumroad.js verify           # read every product back, diff it
node lib/gumroad.js sync             # dry run
node lib/gumroad.js sync --apply     # write it
```

**The daily window, and how the sync gets past it.** Gumroad allows
**10 new products per day**, and the limit is a rolling 24-hour count
that nobody can raise from the seller side. A create past it is refused
with *"Sorry, you can only create 10 products per day."* Rather than
spread one catalogue over a week, the sync **switches to Gumroad's own
Duplicate route**, which is a first-class dashboard action that saves the
copy with `validate: false` and so never runs the creation-limit
validation. The copy is then renamed, repriced, re-slugged, given its own
file uploads and cover, and — for the bundle — converted into the bundle
in place. `docs/GUMROAD.md` has the mechanics, the save contract and the
traps.

**Publishing is still the author's call.** The sync creates and updates
products; it does not publish them. Every package carries its own
`publish` flag, and the account's own gates (currently
`no_payout_method`) decide what can go live.

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
| `lib/gumroad.js` | applies the price plan to the storefront (create/update/duplicate, cover, files, verify) — see `docs/GUMROAD.md` |
| `lib/gumroad-login.js` | mints the seller session into `~/.gumroad-cookies.txt` |
| `lib/gumroad-cover.js` | centre-crops and squares a cover (Gumroad wants 600px+, square) |
| `lib/gumroad.test.js` | the unit suite (173 assertions) |
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
- The price plan is applied by `lib/gumroad.js`. Ten NEW products per day
  are allowed; past that the sync duplicates an existing product and
  rewrites the copy, so a whole catalogue lands in one run. The bundle
  waits for its members.
- The copy is template-driven. It is serviceable, not a campaign.
- A stale package (its source is gone) is pruned, with a log line.
