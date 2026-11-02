# The humanize layer — raw, unpolished, imperfect

The suffix that says what the track is **not**.

## Why it is separate from the style

A descriptor says what the music **is**. The humanize layer says what
it is **not**: not quantised, not mastered, not polished, not clean.

Suno's default sound **is** polished. That is the thing standing
between a style and the raw take it describes. A descriptor that says
"live to two-track, audible breathing, loose human timing" will still
come back smooth unless something says otherwise.

So it is a suffix: it composes **after** the descriptor.

## The vocabulary is measured, not invented

Reading the raw styles already in the account (the ones tagged "Raw &
Imperfect", "raw unplugged acoustic demo", and the like), the phrases
Suno has been shown to respond to on **this** account are concrete:

```
close-mic spit, lip buzz, unquantized timing drift
valve clicks, lip noise, tape saturation, human drift
live one-take room recording, slight timing imperfections
honest rough performance, unquantized timing drift
no autotune, no mastering, no compression, no quantized
```

Those are what the suffixes are built from, rather than adjectives like
"authentic" or "lo-fi", which say nothing about what to do.

## The four suffixes

### `raw` — the general one

```
raw unprocessed recording, rough and imperfect takes, unpolished and
unquantized, tape wobble and bleed, no gloss no polish, dry close-mic
room tone, honest mistakes left in
```

```
no autotune, no mastering, no compression, no quantized, no glossy production
```

### `unplugged` — the house's own vocabulary

```
raw unplugged acoustic demo, close-mic spit and lip buzz, valve clicks
and lip noise, unquantized timing drift, live one-take room recording,
human drift and honest rough performance
```

```
no autotune, no mastering, no compression, no reverb, no quantization
```

### `one-take` — the performance, not the production

```
live one-take room recording, single pass with no edits or second takes,
slight timing imperfections, natural drift, honest rough performance left in
```

```
no autotune, no mastering, no overdubs, no quantization
```

### `tape` — the house's most-used warmth

```
raw tape-saturated room, tape wobble and flutter, wow and flutter on
imperfect human takes, tape hiss and bleed, unquantized timing drift,
honest rough performance
```

```
no autotune, no digital precision, no mastering, no quantization
```

## Two fields, not one

The suffix composes into `tags`. The exclusions go in
`negative_tags`.

That is the house's own rule for Pro and Premier — move the exclusions
into *Exclude Styles* — and a **necessity**: MEASURED, the account's
"UNPLUGGED IMPERFECT TRUMPET" style is exactly **1000 characters**,
which is the tag limit. The exclusions cannot ride along in the same
field.

## The overflow rule — and why it is NOT "the descriptor wins"

The house rule everywhere else is that **the descriptor always wins**
when the two exceed the limit: a variant that loses its descriptor is
not a variant of the source song.

**The humanize layer is the exception**, and it has to be:

> MEASURED 2026-11-02: the KAI master style is 856 characters and the
> raw suffix is 176. Together they are 1034 — over the limit. With the
> descriptor winning, the style came out ending
> `"…dry close-mic roo"` — the raw layer cut mid-word and the thing
> that was asked for was gone.

A mutation is an *amendment* to a song, so the song wins. The
humanize layer **is** the instruction, so it wins.

So when the two overflow: **the suffix keeps its whole tail** (its
meaning lives at the end — "honest mistakes left in" is not optional)
and the descriptor gives way from the front — **cut at a clause
boundary**, so the style still reads as prose rather than starting
mid-word.

## Not applied twice

A style that already carries a layer does not get it again. The check
is the layer's **distinctive phrase** (`raw unprocessed recording`,
`live one-take room recording`, …), not the first comma-segment — with
a long descriptor neither segment contains the other, so a
first-segment comparison silently failed and the suffix was appended to
a style that already had it.

## Using it

```bash
# print a suffix
npm run suno:humanize -- raw
npm run suno:humanize -- unplugged

# humanize the KAI sound DNA in a workspace
npm run suno:kai -- --workspace <wid> --source <clipId> --humanize raw --apply
```

The `--humanize` flag works on the KAI runner. The mutator's `raw`
mutation is built from the same suffix, so the two cannot drift:

```bash
npm run suno:mutate -- --url https://suno.com/song/<uuid> --mutation raw --save-styles --apply
```

## Files

| file | what it is |
|---|---|
| `lib/suno-humanize.js` | the four suffixes, the composition, the overflow rule |
| `lib/suno-humanize.test.js` | 47 assertions |

## Tests

```bash
npm run test:suno-humanize
```

The tests pin that every suffix says raw, unpolished and imperfect; that
the vocabulary is concrete (it names the microphone, the timing drift,
the tape, and keeps the mistakes); the two-field split; the overflow
rule (the suffix keeps its whole tail, the descriptor gives way at a
clause boundary, and the KAI case ends "honest mistakes left in" rather
than "close-mic roo"); and that the layer is not applied twice.
