#!/usr/bin/env node
'use strict';
// lib/suno-playlist.js — playlists on the user's Suno account.
//
// The mutator makes tracks; this puts them somewhere. Suno's playlist API
// is not in the public docs, so every route here was read out of the
// LIVE production SPA bundles (an authenticated fetch of suno.com's own
// immutable chunks) and then confirmed against the account:
//
//   POST /api/playlist/create/                        { name }
//   GET  /api/playlist/me                             the account's playlists
//   GET  /api/playlist/{playlist_id}                  one playlist + its clips
//   GET  /api/playlist/v2/{playlist_id}               one playlist (v2 shape)
//   POST /api/playlist/v2/{playlist_id}/tracks/add    { clip_ids: [...] }
//   POST /api/playlist/v2/{playlist_id}/tracks/remove { clip_ids: [...] }
//
// MEASURED 2026-11-02 (live): the add route answers
//   { "successes": [ "<clip id>", ... ], "failures": [] }
// and the v2 detail answers { metadata: { id, name, song_count, ... } }.
// The v1 detail answers { id, name, playlist_clips: [...], num_total_results }.
//
// The trailing slash matters on `/api/playlist/create/` — without it the
// route answers 404. The v2 detail route has NO trailing slash — with one
// it answers 404. Both were measured, not guessed.
//
//   node lib/suno-playlist.js list
//   node lib/suno-playlist.js find --name Guslar
//   node lib/suno-playlist.js create --name Guslar
//   node lib/suno-playlist.js add --playlist <id> --clip <id> [--clip <id>...]
//   node lib/suno-playlist.js show --playlist <id>

const path = require('node:path');

const API_BASE = 'https://studio-api-prod.suno.com';

const ROUTES = {
    create: () => '/api/playlist/create/',
    mine: () => '/api/playlist/me',
    detail: (id) => `/api/playlist/${id}`,
    detailV2: (id) => `/api/playlist/v2/${id}`,
    addTracks: (id) => `/api/playlist/v2/${id}/tracks/add`,
    removeTracks: (id) => `/api/playlist/v2/${id}/tracks/remove`,
};

/**
 * The clip ids a playlist holds.
 *
 * Suno answers with several shapes depending on the route, and a read-back
 * that misses the real one reports "the playlist is empty" while the
 * playlist is full. MEASURED 2026-11-02 (live):
 *
 *   v1 detail: { playlist_clips: [ { clip: { id, title, ... } } ] }
 *              — the id lives under a NESTED `clip`, not on the entry.
 *   v2 detail: { metadata: { id, name, song_count } } — no ids at all.
 *   some responses carry a bare `clip_ids` array.
 *
 * So an entry's id is looked for, in order, at: `id`, `clip.id`,
 * `clip_id`, `song_id`. Anything unrecognised contributes nothing rather
 * than throwing.
 *
 * @param {object} playlist
 * @returns {string[]}
 */
function clipIdsOf(playlist) {
    if (!playlist || typeof playlist !== 'object') return [];
    const out = [];
    const push = (v) => {
        if (typeof v === 'string' && v) { out.push(v); return; }
        if (!v || typeof v !== 'object') return;
        for (const key of ['id', 'clip_id', 'song_id']) {
            if (typeof v[key] === 'string' && v[key]) { out.push(v[key]); return; }
        }
        // v1 nests the whole clip object under `clip`.
        if (v.clip && typeof v.clip === 'object' && typeof v.clip.id === 'string' && v.clip.id) {
            out.push(v.clip.id);
        }
    };
    for (const key of ['playlist_clips', 'clips', 'tracks', 'items']) {
        const arr = playlist[key];
        if (Array.isArray(arr)) arr.forEach(push);
    }
    if (Array.isArray(playlist.clip_ids)) playlist.clip_ids.forEach(push);
    // De-duplicate, keep order.
    return [...new Set(out)];
}

/**
 * The name of a playlist, whichever shape it arrives in.
 *
 * @param {object} playlist
 * @returns {string}
 */
function nameOf(playlist) {
    if (!playlist || typeof playlist !== 'object') return '';
    if (typeof playlist.name === 'string') return playlist.name;
    if (playlist.metadata && typeof playlist.metadata.name === 'string') return playlist.metadata.name;
    return '';
}

/**
 * The id of a playlist, whichever shape it arrives in.
 *
 * @param {object} playlist
 * @returns {string}
 */
function idOf(playlist) {
    if (!playlist || typeof playlist !== 'object') return '';
    if (typeof playlist.id === 'string') return playlist.id;
    if (playlist.metadata && typeof playlist.metadata.id === 'string') return playlist.metadata.id;
    return '';
}

/**
 * Find a playlist by name, case-insensitively.
 *
 * @param {Array<object>} playlists
 * @param {string} name
 * @returns {object|null}
 */
function findByName(playlists, name) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return null;
    const list = Array.isArray(playlists) ? playlists : [];
    return list.find((p) => nameOf(p).trim().toLowerCase() === want) || null;
}

// ---------------------------------------------------------------------
// The API calls
// ---------------------------------------------------------------------

/**
 * Parse an API response body, tolerating the HTML that a catch-all can
 * answer with.
 *
 * @param {string} body
 * @returns {object|null}
 */
function parseJson(body) {
    if (body === null || body === undefined) return null;
    if (typeof body === 'object') return body;
    const text = String(body).trim();
    if (!text || text[0] !== '{' && text[0] !== '[') return null;
    try { return JSON.parse(text); } catch { return null; }
}

/**
 * Every playlist the account owns.
 *
 * @param {object} client a SunoClient
 * @returns {Promise<object[]>}
 */
async function listPlaylists(client) {
    const r = await client.api(ROUTES.mine());
    if (r.status < 200 || r.status >= 300) {
        throw new Error(`${r.status} listing playlists: ${String(r.body).slice(0, 200)}`);
    }
    const j = parseJson(r.body);
    if (!j) throw new Error(`unexpected playlist list body: ${String(r.body).slice(0, 200)}`);
    return Array.isArray(j.playlists) ? j.playlists : [];
}

/**
 * Find a playlist by name; null when the account has none by that name.
 *
 * @param {object} client
 * @param {string} name
 * @returns {Promise<object|null>}
 */
async function findPlaylist(client, name) {
    const list = await listPlaylists(client);
    return findByName(list, name);
}

/**
 * Create a playlist.
 *
 * @param {object} client
 * @param {string} name
 * @returns {Promise<object>} the created playlist
 */
async function createPlaylist(client, name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('a playlist needs a name');
    const r = await client.api(ROUTES.create(), { method: 'POST', body: { name: clean } });
    if (r.status < 200 || r.status >= 300) {
        throw new Error(`${r.status} creating playlist "${clean}": ${String(r.body).slice(0, 200)}`);
    }
    const j = parseJson(r.body);
    if (!j) throw new Error(`unexpected create body: ${String(r.body).slice(0, 200)}`);
    return j;
}

/**
 * Read one playlist, with its clips.
 *
 * The v1 detail carries the clip list; the v2 detail carries the
 * metadata. Both are read so a caller gets the name AND the membership.
 *
 * @param {object} client
 * @param {string} playlistId
 * @returns {Promise<object>}
 */
async function getPlaylist(client, playlistId) {
    const v1 = await client.api(ROUTES.detail(playlistId));
    // A 404 body can still be valid JSON ({"detail":"not found"}), so the
    // STATUS decides whether the v1 shape is there — not the parse.
    const j1 = (v1.status >= 200 && v1.status < 300) ? parseJson(v1.body) : null;
    let v2 = null;
    try {
        const r2 = await client.api(ROUTES.detailV2(playlistId));
        if (r2.status >= 200 && r2.status < 300) v2 = parseJson(r2.body);
    } catch { /* the v2 shape is a bonus, not a requirement */ }
    if (!j1 && !v2) {
        throw new Error(`playlist not found: ${playlistId} (${v1.status}) ${String(v1.body).slice(0, 160)}`);
    }
    return {
        id: idOf(j1) || idOf(v2) || playlistId,
        name: nameOf(j1) || nameOf(v2),
        clipIds: clipIdsOf(j1).length ? clipIdsOf(j1) : clipIdsOf(v2),
        songCount: (v2 && v2.metadata && Number(v2.metadata.song_count)) ||
            (j1 && Number(j1.num_total_results)) || null,
        raw: j1,
        rawV2: v2,
    };
}

/**
 * Add clips to a playlist.
 *
 * @param {object} client
 * @param {string} playlistId
 * @param {string[]} clipIds
 * @returns {Promise<{successes: string[], failures: string[], raw: object}>}
 */
async function addTracks(client, playlistId, clipIds) {
    const ids = (Array.isArray(clipIds) ? clipIds : [clipIds]).filter(Boolean);
    if (!ids.length) throw new Error('no clips to add');
    const r = await client.api(ROUTES.addTracks(playlistId), {
        method: 'POST',
        body: { clip_ids: ids },
    });
    if (r.status < 200 || r.status >= 300) {
        throw new Error(`${r.status} adding to playlist ${playlistId}: ${String(r.body).slice(0, 200)}`);
    }
    const j = parseJson(r.body) || {};
    return {
        successes: Array.isArray(j.successes) ? j.successes : [],
        failures: Array.isArray(j.failures) ? j.failures : [],
        raw: j,
    };
}

/**
 * Remove clips from a playlist.
 *
 * @param {object} client
 * @param {string} playlistId
 * @param {string[]} clipIds
 * @returns {Promise<{successes: string[], failures: string[], raw: object}>}
 */
async function removeTracks(client, playlistId, clipIds) {
    const ids = (Array.isArray(clipIds) ? clipIds : [clipIds]).filter(Boolean);
    if (!ids.length) throw new Error('no clips to remove');
    const r = await client.api(ROUTES.removeTracks(playlistId), {
        method: 'POST',
        body: { clip_ids: ids },
    });
    if (r.status < 200 || r.status >= 300) {
        throw new Error(`${r.status} removing from playlist ${playlistId}: ${String(r.body).slice(0, 200)}`);
    }
    const j = parseJson(r.body) || {};
    return {
        successes: Array.isArray(j.successes) ? j.successes : [],
        failures: Array.isArray(j.failures) ? j.failures : [],
        raw: j,
    };
}

/**
 * Get a playlist by name, creating it when it does not exist.
 *
 * This is the "put the tracks in the Guslar playlist" operation, in one
 * call: the playlist is found, or made, and its id is returned.
 *
 * @param {object} client
 * @param {string} name
 * @returns {Promise<{id: string, name: string, created: boolean, playlist: object}>}
 */
async function ensurePlaylist(client, name) {
    const existing = await findPlaylist(client, name);
    if (existing) {
        const id = idOf(existing);
        return { id, name: nameOf(existing) || name, created: false, playlist: existing };
    }
    const created = await createPlaylist(client, name);
    const id = idOf(created);
    if (!id) throw new Error(`playlist created but no id came back: ${JSON.stringify(created).slice(0, 200)}`);
    return { id, name: nameOf(created) || name, created: true, playlist: created };
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

const HELP = `Suno playlists — list, create, and fill them.

Usage:
  node lib/suno-playlist.js <verb> [options]

Verbs:
  list                     every playlist on the account
  find   --name <name>     the playlist with that name (if any)
  create --name <name>     create a playlist
  show   --playlist <id>   one playlist and its clips
  add    --playlist <id> --clip <id> [--clip <id>...]   add clips
  remove --playlist <id> --clip <id> [--clip <id>...]   remove clips

Options:
  --name <name>            the playlist name
  --playlist <id>          the playlist id
  --clip <id>              a clip id (repeatable)
  --port <n>               the CDP port
  --user-data-dir <path>   the Chrome profile dir (default from lib/suno-config.json)
  --cookies <path>         the cookie jar (default ~/.suno-cookies.txt)
  --help                   this text`;

async function main() {
    const argv = process.argv.slice(2);
    const log = (m) => process.stdout.write(`[suno-playlist] ${m}\n`);
    const has = (name) => argv.includes(`--${name}`);
    const flagAll = (name) => {
        const out = [];
        for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}` && argv[i + 1]) out.push(argv[i + 1]);
        return out;
    };
    const flag = (name, dflt) => { const v = flagAll(name); return v.length ? v[0] : dflt; };

    if (has('help') || has('h')) { process.stdout.write(`${HELP}\n`); return 0; }
    const verb = argv.find((a) => !a.startsWith('--') && !/^[0-9a-f-]{36}$/i.test(a));
    if (!verb) throw new Error('a verb is required\n\n' + HELP);

    const { SunoClient } = require('./suno-web.js');
    const client = await SunoClient.open({
        cookieFile: flag('cookies', undefined),
        port: Number(flag('port', 0)) || undefined,
        userDataDir: flag('user-data-dir', undefined),
    });
    try {
        if (verb === 'list') {
            const list = await listPlaylists(client);
            for (const p of list) {
                log(`${idOf(p)}  ${nameOf(p)}  ${p.num_total_results ?? p.metadata?.song_count ?? 0} track(s)`);
            }
            log(`${list.length} playlist(s)`);
            return 0;
        }
        if (verb === 'find') {
            const name = flag('name');
            if (!name) throw new Error('--name is required');
            const found = await findPlaylist(client, name);
            if (!found) { log(`no playlist named "${name}"`); return 1; }
            log(`${idOf(found)}  ${nameOf(found)}`);
            return 0;
        }
        if (verb === 'create') {
            const name = flag('name');
            if (!name) throw new Error('--name is required');
            const made = await createPlaylist(client, name);
            log(`created ${idOf(made)}  ${nameOf(made) || name}`);
            return 0;
        }
        if (verb === 'show') {
            const pid = flag('playlist');
            if (!pid) throw new Error('--playlist is required');
            const p = await getPlaylist(client, pid);
            log(`${p.id}  ${p.name}  ${p.clipIds.length} clip(s)`);
            for (const c of p.clipIds) log(`  ${c}`);
            return 0;
        }
        if (verb === 'add' || verb === 'remove') {
            const pid = flag('playlist');
            const clips = flagAll('clip');
            if (!pid) throw new Error('--playlist is required');
            if (!clips.length) throw new Error('--clip is required (repeatable)');
            const r = verb === 'add'
                ? await addTracks(client, pid, clips)
                : await removeTracks(client, pid, clips);
            log(`${verb}: ${r.successes.length} ok, ${r.failures.length} failed`);
            for (const f of r.failures) log(`  failed: ${typeof f === 'string' ? f : JSON.stringify(f)}`);
            const p = await getPlaylist(client, pid);
            log(`now: ${p.clipIds.length} clip(s) in "${p.name}"`);
            return r.failures.length ? 1 : 0;
        }
        throw new Error(`unknown verb: ${verb}\n\n${HELP}`);
    } finally {
        await client.close();
    }
}

module.exports = {
    API_BASE,
    ROUTES,
    clipIdsOf,
    nameOf,
    idOf,
    findByName,
    parseJson,
    listPlaylists,
    findPlaylist,
    createPlaylist,
    getPlaylist,
    addTracks,
    removeTracks,
    ensurePlaylist,
};

if (require.main === module) {
    main().then((code) => process.exit(code || 0)).catch((e) => {
        process.stderr.write(`[suno-playlist] fatal: ${e && e.message ? e.message : e}\n`);
        process.exit(1);
    });
}
