# Daily mood-journey pipeline

Once a day, on a launchd calendar schedule, the pipeline composes a
small creative brief from a deterministic 12-mood rotation and writes
three artifacts:

| Path | What |
|---|---|
| `daily/<YYYY-MM-DD>.json` | the day's structured record |
| `daily/<YYYY-MM-DD>-music.md` | a Suno-style brief for today's song |
| `prompts-inbox/<YYYY-MM-DD>-<mood>.md` | a Midjourney prompt pack; the existing `mj-watcher` LaunchAgent picks it up and submits |

The mood for a calendar day is fixed by `(dayOf-year - 1) % 12` against
the 12 moods below — same day, same mood, across runs:

```
still, dusk, dawn, drift, ember, neon,
hush,  vault, tide, gloss, ache,  bloom
```

Each mood carries a one-line seed (the lyric + the visual subject)
and a fixed pair of distinct visual subjects, so the MJ pack always
contains two non-duplicate prompts that the existing `mj-watcher`
will parse and submit through the web backend.

## Files

- `lib/daily-pipeline.js` — pure-Node logic, no dependencies.
- `lib/daily-pipeline.test.js` — 36 unit tests, pure stdlib.
- `bin/daily-pipeline.sh` — shell wrapper (mirrors `bin/mj-watcher.sh`).
- `~/Library/LaunchAgents/daily-pipeline-launcher.sh` — launchd shim,
  resolves Node + repo path (Sequoia TCC workaround).
- `~/Library/LaunchAgents/com.kaidjuric.digital-twin.daily-pipeline.plist`
  — `StartCalendarInterval` at 08:15 local, single fire, no
  `KeepAlive`, no `RunAtLoad`.

## Manual use

```bash
# ship today (writes the 3 files if not already shipped today)
./bin/daily-pipeline.sh --apply --yes

# preview what today would produce
./bin/daily-pipeline.sh                 # defaults to --dry-run

# generate for an arbitrary date or with an explicit mood
./bin/daily-pipeline.sh --apply --yes --date 2026-12-25
./bin/daily-pipeline.sh --apply --yes --mood ember

# overwrite today's files (skips the idempotency check)
./bin/daily-pipeline.sh --apply --yes --force
```

## Idempotency

If today's three artifacts already exist, the run is a **no-op** with
exit code 1 and a one-line error naming the file that blocked the write.
Use `--force` to overwrite. The launchd-fired run is `--apply --yes`
without `--force`, so a calendar jitter that fires twice produces only
one shipment per day.

## Schedule

The plist fires at **08:15 local** every day. To move the time, edit
the `<integer>` values for `Hour` / `Minute` and `launchctl kickstart
-k gui/$UID/com.kaidjuric.digital-twin.daily-pipeline`.

The plist is **installed but not bootstrapped** on this machine,
matching the convention in AGENTS.md ("irreversible service-state
change"). To activate:

```bash
launchctl bootstrap gui/$(id -u)/com.kaidjuric.digital-twin.daily-pipeline \
    ~/Library/LaunchAgents/com.kaidjuric.digital-twin.daily-pipeline.plist
launchctl kickstart -k gui/$(id -u)/com.kaidjuric.digital-twin.daily-pipeline
```

Verify:

```bash
launchctl print gui/$(id -u)/com.kaidjuric.digital-twin.daily-pipeline | grep -E "state|program|next run"
```

## Customizing the mood list

The 12 moods live in `lib/daily-pipeline.js` as `MOODS`, with paired
seeds in `MOOD_SEEDS` and visual pairs in `MOOD_VISUAL_PAIRS`. To add a
mood, append to all three arrays so the indices stay aligned:

```js
const MOODS  = [..., 'noir'];
const MOOD_SEEDS['noir'] = 'a hotel hallway at four in the morning.';
const MOOD_VISUAL_PAIRS['noir'] = ['a single lit door at the end of a corridor',
                                   'a glass left behind on a lobby counter'];
```

(Edit one file; the rest follows from the index.)

## What "mod journey" means here

A 12-mood rotation indexes one calendar day, one creative seed per day,
12 days for a full cycle. The repetition on the 13th day is the point:
the same mood returns with a different week-of-the-year context, and
the prompts travel with it. The mood is the journey; the day is the step.

## What this does NOT do

- **No Suno API submission.** Suno has no public API at the time of
  writing; the music brief is written as markdown so you can paste
  it into the Suno UI by hand.
- **No daily test run.** The unit suite is the only automated check;
  the calendar-scheduled run is the production proof.

## Auto-update behavior

`bin/auto-update.sh` reloads watch agents whose code changes. After
this commit the script also reloads the daily pipeline when
`lib/daily-pipeline.js` changes, so a pull that retunes a mood does
not require a manual restart.
