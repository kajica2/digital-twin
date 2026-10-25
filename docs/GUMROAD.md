# Gumroad

`lib/gumroad.js` turns the social engine's price plan
(`data/social/pricing.json`) into real products on the storefront at
`https://kaidjuric.gumroad.com`. The engine computes; this module applies.

```
node lib/gumroad.js check                 # who am I, what is blocked
node lib/gumroad.js plan                  # what the plan asks for
node lib/gumroad.js verify                # read every product back, diff it
node lib/gumroad.js sync                  # dry run
node lib/gumroad.js sync --apply          # write it
node lib/gumroad.js sync --apply --via-duplicate
node lib/gumroad.js sync --apply --only <slug-or-package-id>
node lib/gumroad.js sync --apply --duplicate-source <permalink>
```

`npm run gumroad:check` / `gumroad:plan` / `gumroad:sync` wrap the first
three. `npm run test:gumroad` runs the suite.

## Why the dashboard endpoints and not the public API

Gumroad's public API (`api/v2`) needs an OAuth application owned by the
account. There is none on this machine, and minting one is an
account-level artifact the human has to ask for. The dashboard endpoints
work with the session cookie the account already has, so the module uses
those — the same requests the web editor makes, with the same
parameters.

Two route facts that cost real time:

- `POST /links` returns **303** with the new product's permalink only in
  the `Location` header, and the body is empty. A refused create redirects
  to `/products/new`, and the reason is in that page's flash.
- The update action is `POST /links/<permalink>` with **top-level**
  params (not nested under `link[...]`), and `<permalink>` is the
  auto-generated `unique_permalink`, not the public slug. A product whose
  public URL is `/l/neon-pulse-cover` is edited at `/links/flfke`.

## The session cookie

`~/.gumroad-cookies.txt` — Netscape format, `chmod 600`, outside the repo
(the `.gitignore` has a `*-cookies.txt` rule). Minted by
`lib/gumroad-login.js`. Gumroad rotates `_gumroad_app_session` on **every**
response, so the client keeps an absorbing jar (`CookieJar`); sending the
original cookie back throws away the session that carries the flash
message, which is how a refused create once arrived as a bare redirect
with no explanation.

The cookie is a live authenticated session. Treat it like a password: it
is not committed, and if it is ever pasted into a chat or a log, rotate it
by re-running the login flow.

When the jar expires, `check` says so (a redirect to the login page) and
`verify` fails loudly. Re-mint with `node lib/gumroad-login.js`.

## The daily ceiling

Gumroad allows **10 new products per day** for a non-`compliant?` seller
(100 for a compliant one). Upstream enforces it as
`validate :validate_daily_product_creation_limit, on: :create` over a
rolling 24-hour window of `user.links.where(created_at: 1.day.ago..)`.

Nobody can raise it: `user.daily_product_creation_limit` is staff-set JSON
on `User` with no seller-facing setter, and
`skip_daily_product_creation_limit?` skips only in development, for a
blank user, or for a team member. Do not try.

`sync` is resumable, not all-or-nothing: a product that exists is updated,
one that does not is created. When the ceiling refuses a create, the run
**switches to the duplicate route** (below) and keeps going.

## Past the ceiling: duplicate an existing product

The dashboard's Duplicate action is a first-class feature, and it runs
through `ProductDuplicatorService`, which saves the copy with
`validate: false` — so the creation-limit validation never fires. That is
the sanctioned way past the wall, and it is what `sync` uses:

```
POST /product_duplicates                 link_id=<source permalink>
GET  /product_duplicates/<source>        -> {status, duplicated_product}
```

The GET is polled. Three things make that poll less obvious than it looks:

- The controller only enqueues `DuplicateProductWorker`; the copy appears
  asynchronously. `product_duplicating` / `product_duplicated` /
  `product_duplication_failed` are the three statuses.
- The answer comes from a **Redis record keyed by the source product id**
  with a ten-minute TTL, so duplicating the same source again can answer
  with the *previous* copy first. A permalink this run has already
  accounted for is therefore not an answer — the poll keeps waiting
  (`duplicatePollVerdict`).
- `is_duplicating` is set on the source for the duration. A second
  request while it is set is refused with "Duplication in progress", which
  is retried rather than treated as a failure.

### What a copy inherits, and what has to be fixed

`ProductDuplicatorService#duplicate` copies, among other things:

| inherited | consequence |
|---|---|
| `name = "<source> (copy)"`, `price_cents` of the source | rename and reprice |
| `custom_permalink = nil` | the public URL is the random `unique_permalink` until a slug is set |
| the source's **thumbnail** (a new blob, same image) | upload the real cover |
| the source's **product_file rows** — a NEW row per file, pointing at the SAME S3 object | the copy serves the source's file until those rows are dropped |
| the source's prices (`duplicate_prices`) | the copy keeps the source's price until overwritten |
| the source's offer codes (`duplicate_offer_codes` **assigns** them, shared objects) | never duplicate a product that has offer codes |
| `draft = true`, `purchase_disabled_at = now` | the copy is a draft, like every product this repo creates |

So each duplicated product gets:

1. **one revision-gated save** that renames it, reprices it, gives it its
   public slug, and names the inherited file rows in
   `deletion_operations` (see the save contract below);
2. **its own upload** for every downloadable file (a fresh S3 key, so
   nothing is shared with the source);
3. **its own cover** — `POST /links/<permalink>/thumbnails` replaces the
   inherited thumbnail blob.

A deletion that silently does not apply is the failure mode that ships a
copy serving the source's file, so `adoptDuplicate` reads the product back
and refuses to continue if a row survived.

### Which product may be the source

`resolveDuplicateSource` only considers storefront products whose **public
slug is one of the plan's slugs** — i.e. products this module created. The
account's own products (`krlzd`) are never candidates, and
`isSafeDuplicateSource` additionally requires:

- **exactly one alive file** — one inherited row to drop, not five;
- **no default offer code** — `duplicate_offer_codes` shares the source's
  offer codes with the copy instead of copying them.

### The save contract: omission is not deletion

The product editor's save route is gated by
`Feature.active?(:product_editor_save_contract, product.user)`, which is
**on** for this account (probed live: a save that omits `files` leaves them
attached). Under the contract:

- an omitted or empty collection means **"this request isn't about
  files"** — never "delete them";
- a removal must name the row by its `external_id` in
  `deletion_operations[deleted_ids][files][]`;
- a removal must also echo a fresh `editor_revision`, which is a digest
  over the product's alive files / rich content / variants / integrations
  (not its name, price or `updated_at`, so ordinary edits do not
  invalidate it). It is **per product**, so it is read from that product's
  edit page immediately before the destructive save;
- a stale token raises `StaleDeletionConflict` → HTTP 409
  (`error_code: "stale_deletion_conflict"`), and nothing is written.

`encodeFormBody` builds all three shapes the route reads — scalars, nested
objects, arrays of objects (`files[0][url]`) and bracket arrays of scalars
(`deletion_operations[deleted_ids][files][]`). The last one has to be the
bracket-array form: the permitted filter declares it as an array of
scalars, and an indexed key would arrive as a hash instead.

An empty description is dropped server-side unless it is flagged as a
deliberate clear (`description_changed=1`), and then the **inherited**
description survives — which is why a plan entry with no copy still sends
the flag.

## One slug is one product

Gumroad's public permalink is unique per seller, and it refuses a second
claim outright (*"Custom permalink is already used by another one of your
products"*). Slug uniqueness is therefore enforced **upstream, in the plan**
(`lib/social-engine.js` → `assignProductSlugs`), not here:

- The **earliest package keeps the bare slug**, so a product that already
  exists on the storefront is never renamed by a later arrival.
- Every later package with the same name is qualified by its own bundle
  key — `pylon-line-plate-2026-10-24t20`, named
  `Pylon · line — art plate (24 Oct 2026 20:00)`.

The reason it has to be that way: the daily collections cycle a fixed
caption pool, so two days that draw the same subject produce the same
product name for **different art**. Before this rule the planner skipped
the second one — 12 of 45 daily plates were unsellable, each a real render
that could never be bought.

`planFromPricingPlan` still refuses a duplicate slug and reports it as
`skipped`. That guard is now a **canary**: a plan produced by this repo can
never contain one, so a skip means the plan file is stale or hand-edited.
An empty skip list is part of a clean run.


## The bundle

The bundle is a copy converted in place:

```
PUT   /bundles/<external id>/product      name, description, custom_permalink,
                                          price_cents, price_currency_type
PATCH /bundles/<external id>/content      products[][product_id]=<external id> …
```

- Converting is `is_bundle = true` + `native_type = bundle` on the **same
  Link row**, so it costs no creation slot and the duplicated product
  itself survives. `Link.can_be_bundle` includes any non-membership,
  non-call product without variants.
- The bundle route is the only one that kinds the **currency before the
  amount** (it assigns `price_currency_type`, then the carried
  `price_cents`, and skips both in the bulk assign), so both are always
  sent together.
- The copy's inherited file row is dropped first: a bundle carries its
  members' files, and the bundle route does not accept files at all.
- Members are addressed by **external id** (the opaque `props.id` on the
  edit page, not the permalink), and the parameter must be an **array** —
  the hash form (`products[0][product_id]`) reaches the controller and
  then 500s inside `Bundle::UpdateProductsService`.
- The sync only touches the bundle when every member is on the
  storefront. A bundle missing members sells a discount on a catalogue
  that is not there.

## Publishing — drafts are invisible

Writing a product is not showing it. The public storefront
(`https://kaidjuric.gumroad.com`) renders **published** products only, so a
catalogue of correct drafts shows the seller's name and nothing else — the
state the store was in until 2026-10-25, with 82 products on the account
and an empty shop page.

Three things had to line up, and only two of them are code:

1. **The publish step existed and was never called.** `GumroadClient.publish()`
   was dead code: `sync` created and updated, and `publish: true` on a plan
   product changed nothing. `sync` now publishes what the plan marks, and
   `node lib/gumroad.js publish` publishes on demand:

   ```bash
   node lib/gumroad.js publish                 # what would be published
   node lib/gumroad.js publish --apply --all    # the whole catalogue
   node lib/gumroad.js publish --apply --only pylon-line-plate
   ```

   `--all` and `--only` are the operator naming what to publish, so they win
   over the plan's per-product `publish` flag; without either, only a marked
   product is touched.

2. **The account refuses to publish until a payout method is set.** `check`
   reports `publishing blocked (no_payout_method)`, and both entry points say
   so instead of attempting and failing: `publishTargets()` returns the
   products, the block reason, and how many are waiting — nothing is
   attempted against a blocked account. Set the payout method at
   `https://gumroad.com/settings/payments`, then run the command above.

3. **The plan has to mark the product.** Every package is written with
   `publish: false` (`posting.autoPublish` is off for the same reason), so
   publishing is a deliberate edit, not a side effect of a nightly sync.

## Covers and files

- A cover is a **thumbnail**, not a product file: `POST /links/<permalink>/thumbnails`
  with an ActiveStorage direct-upload blob. The validator wants a **square**
  image of at least **600 px** and at most **5 MB**
  (`jpeg`/`png`/`gif`/`webp`), and reports failure in the **200 body**
  (`{success:false,error}`), not in the status. `lib/gumroad-cover.js`
  centre-crops to the largest square and scales to 800×800 with ffmpeg.
- A downloadable file is uploaded to Gumroad's S3 bucket through the
  dashboard's own Evaporate flow (multipart, AWS Signature V2 computed by
  Gumroad's `s3_utility` signer) and then attached by URL. `size` and the
  display name go with it; `extension` is stripped server-side.
- Attached rows must be shaped for the wire: `display_name`, not
  `displayName`. The save route ignores an unknown key silently, and the
  row then falls back to the S3 basename with no extension — the buyer
  sees an extension-less file.

## Verification

`verify` reads each product back and compares it with the plan:

| checked | how |
|---|---|
| name | the edit page's `product.name` |
| price | `product.price_cents`, exactly |
| currency | the edit page exposes none, so the dashboard row's formatted price must carry the plan's symbol (`€`) |
| public slug | `product.custom_permalink` |
| files | each plan file present exactly once, by served name and byte size, with no strays — a stray row is an inherited file that was never dropped |
| cover | a thumbnail exists |
| bundle | price, public slug, `is_bundle`, member count, cover |

It exits non-zero on any mismatch, so it is usable as a gate.

## Rules this module keeps

- **Products that exist are never recreated.** `sync` looks the slug up
  first; `--via-duplicate` only applies to products that are missing.
- **Never duplicate the account's own products.** Source candidates come
  only from plan slugs.
- **Drafts only.** `POST /links` creates drafts and so does the duplicate
  route. Publishing stays the author's decision, and the account's own
  gates (currently `no_payout_method`) decide what can go live.
- **Nothing personal in a description.** `scrubPaths` strips absolute
  filesystem paths before a package description reaches the storefront.

## Files

| file | job |
|---|---|
| `lib/gumroad.js` | planner, transport, sync, duplicate route, verifier |
| `lib/gumroad-cover.js` | square-cover preparation (ffmpeg) |
| `lib/gumroad-login.js` | mints the session cookie jar |
| `lib/gumroad.test.js` | 189 assertions, mocked fetch, no network |
| `docs/SOCIAL-ENGINE.md` | the engine that computes the price plan |

## Open

- The bundle's thumbnail is the source product's cover (the plan has no
  bundle artwork). A dedicated cover is a follow-up.
- The duplicate route caps nothing, but it is a rate-limited platform
  feature in spirit: a run of 60+ duplicates is done serially, and
  `ThrottleInterval`-style backoff is not implemented.
- `verify` compares the formatted price's symbol, not the exact money
  format, and derives the currency from the seller's display currency
  rather than a product field (the edit page has none).
- Products are drafts until published, and publishing needs a payout method
  on the account first. The step is wired (`sync` publishes what the plan
  marks; `publish --apply --all` does the catalogue) and reports the block
  rather than failing silently.
- ~~The daily pipeline can still emit two packages with the same caption
  (and therefore the same slug); the planner skips the second one.~~
  **Resolved 2026-10-25:** the plan disambiguates a repeated name by its
  bundle key (see *One slug is one product*), so the plan always covers the
  whole registry and the skip list is empty on every real run.
- A reel's product slug still comes from its **title**, which lives in the
  POST sheet the reel-watcher writes, while its id comes from the file
  basename. Two of the 92 products on the plan disagree between a fresh
  pass and the registry for this reason (`frost-window-kettle-steam`,
  `frost-window-pane-fern`). The registry keeps the first-computed slug, so
  nothing drifts on a normal run; a rebuilt registry would rename them, and
  the old title-derived slugs of ~30 other reels would be recreated rather
  than updated. Fixing it means a storefront migration, not a code change.
