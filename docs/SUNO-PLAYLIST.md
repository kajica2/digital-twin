# Suno playlists — the routes, measured

`lib/suno-playlist.js` puts finished tracks somewhere. Suno does not
document its playlist API, so every route below was read out of the
live production SPA bundles and then confirmed against the account with
real requests.

```bash
node lib/suno-playlist.js list
node lib/suno-playlist.js find --name guslars
node lib/suno-playlist.js create --name guslars
node lib/suno-playlist.js show  --playlist a6f92f95-9889-42fb-bb93-08a00bbd15db
node lib/suno-playlist.js add   --playlist <id> --clip <id> [--clip <id>...]
node lib/suno-playlist.js remove --playlist <id> --clip <id> [...]
```

---

## The routes

Base: `https://studio-api-prod.suno.com` (`API_BASE` in the module).

|verb|route|body|
|---|---|---|
|create|`POST /api/playlist/create/`|`{ name }`|
|list mine|`GET /api/playlist/me`|—|
|detail (v1)|`GET /api/playlist/{id}`|—|
|detail (v2)|`GET /api/playlist/v2/{id}`|—|
|add tracks|`POST /api/playlist/v2/{id}/tracks/add`|`{ clip_ids: [...] }`|
|remove tracks|`POST /api/playlist/v2/{id}/tracks/remove`|`{ clip_ids: [...] }`|

**Trailing slashes are route-specific, and both cases were measured.**

- `/api/playlist/create/` **needs** the slash. Without it: `404`.
- `/api/playlist/v2/{id}` **must not** have one. With it: `404`.

Getting either backwards produces a 404 that looks exactly like a
missing playlist, so the module builds every route from one table
(`ROUTES`) rather than concatenating strings at the call sites.

---

## The response shapes

**`GET /api/playlist/me`**

```json
{ "num_total_results": 27, "playlists": [ … ] }
```

**`GET /api/playlist/{id}`** (v1) — the one with the clips:

```json
{
  "id": "a6f92f95-…",
  "name": "guslars",
  "entity_type": "playlist",
  "num_total_results": 3,
  "playlist_clips": [ { "id": "<clip id>", … }, … ]
}
```

**`GET /api/playlist/v2/{id}`** — the metadata shape:

```json
{ "metadata": { "id": "a6f92f95-…", "name": "guslars", "song_count": 3, … } }
```

**`POST …/tracks/add`**:

```json
{ "successes": [ "<clip id>" ], "failures": [] }
```

The add and remove verbs print `add: N ok, M failed`, then **re-read the
playlist** and print `now: N clip(s) in "<name>"`. The re-read is the
proof: the write route answers with what it *accepted*, which is not the
same thing as what the playlist now holds.

---

## Two APIs, one account

The web app on suno.com does **not** use the same base as the studio
API. Its own playlist route is:

```
GET https://suno.com/a/api/playlist/{id}/?page=1
```

The full set of `/a/api/*` endpoints the song page calls is in
`docs/SUNO-MUTATOR.md` (see *The web app's own API base*). `lib/suno-web.js`
targets `studio-api-prod.suno.com` and **cannot** reach `/a/api/*`; a
route probe against the studio base that returns `{}` proves nothing.

---

## Which playlist

The user's playlist id wins over any name match:

|name|id|
|---|---|
|`guslars`|`a6f92f95-9889-42fb-bb93-08a00bbd15db`|
|`Guslar`|`a28c50f2-fb3d-4044-ab4b-c347b33c9`|

Both exist on the account. `findByName` matches case-insensitively and
returns the first hit, so the **id** is what the commands take.

---

## Rate limits and credits

- The playlist routes are cheap: no credits are spent by adding a clip
  that already exists.
- Suno's API rate-limits hard on **clip reads**:
  `GET /api/clips/get_songs_by_ids` returned **429 `Too many requests`**
  after about six reads in one session. `GET /api/clip/{id}` (singular)
  does **not** 429 — prefer it.
- Space the calls out and reuse one browser session.

---

## Tests

```bash
npm run test:suno-playlist   # 54 assertions — no browser, no account, no credits
```

The pure half is covered: the route table (including the two trailing-slash
rules), the clip-id extraction across the three response shapes, the
name/id resolution, the add/remove request bodies, and the ensure
(lookup-or-create) behaviour.
