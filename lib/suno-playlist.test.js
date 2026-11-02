#!/usr/bin/env node
'use strict';
// lib/suno-playlist.test.js — the playlist module's pure half, plus its
// wire contract against a FAKE client. No browser, no account.
//
// The contract this pins:
//   - the routes are the ones the LIVE production SPA uses
//   - the bodies are the ones the live API answered 200 to
//   - a read-back reports MEMBERSHIP, not "the add call said OK"
//   - a malformed body is a failure, not an empty playlist
//
//   node lib/suno-playlist.test.js

const {
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
} = require('./suno-playlist.js');

let passed = 0;
let failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; console.log(`  ✓ ${label}`); }
    else {
        failed++; failures.push({ label, actual: a, expected: e });
        console.log(`  ✗ ${label}`);
        console.log(`    expected: ${e}`);
        console.log(`    got:      ${a}`);
    }
}
function assertTrue(label, cond) {
    if (cond) { passed++; console.log(`  ✓ ${label}`); }
    else {
        failed++; failures.push({ label, actual: 'false', expected: 'true' });
        console.log(`  ✗ ${label}`);
    }
}

/**
 * A fake SunoClient: records the calls, answers from a route table.
 */
function fakeClient(routes = {}) {
    const calls = [];
    return {
        calls,
        async api(pathname, opts = {}) {
            const method = opts.method || 'GET';
            calls.push({ pathname, method, body: opts.body });
            const key = `${method} ${pathname}`;
            if (Object.prototype.hasOwnProperty.call(routes, key)) {
                const r = routes[key];
                return typeof r === 'function' ? r(opts) : r;
            }
            for (const [k, r] of Object.entries(routes)) {
                if (k.includes('*') && pathname.includes(k.replace('*', ''))) {
                    return typeof r === 'function' ? r(opts) : r;
                }
            }
            return { status: 404, body: '{"detail":"Not found."}' };
        },
    };
}

async function run() {
console.log('\n1. the routes — read out of the live production SPA');

assert('create keeps its trailing slash',
    ROUTES.create(), '/api/playlist/create/');
assert('mine', ROUTES.mine(), '/api/playlist/me');
assert('detail has NO trailing slash',
    ROUTES.detail('p1'), '/api/playlist/p1');
assert('detail v2 has no trailing slash',
    ROUTES.detailV2('p1'), '/api/playlist/v2/p1');
assert('add tracks',
    ROUTES.addTracks('p1'), '/api/playlist/v2/p1/tracks/add');
assert('remove tracks',
    ROUTES.removeTracks('p1'), '/api/playlist/v2/p1/tracks/remove');

console.log('\n2. the shapes Suno answers with');

// MEASURED 2026-11-02 (live): the v1 detail carries playlist_clips,
// the v2 detail carries metadata.song_count.
const v1 = {
    entity_type: 'playlist_schema',
    id: 'p1',
    name: 'Guslar',
    playlist_clips: [
        { id: 'clip-a', title: 'One' },
        { id: 'clip-b', title: 'Two' },
    ],
    num_total_results: 2,
};
const v2 = { metadata: { id: 'p1', name: 'Guslar', song_count: 2 } };

assert('clip ids from playlist_clips',
    clipIdsOf(v1), ['clip-a', 'clip-b']);
assert('clip ids from a bare clip_ids array',
    clipIdsOf({ clip_ids: ['x', 'y'] }), ['x', 'y']);
assert('bare strings are accepted too',
    clipIdsOf({ playlist_clips: ['x', 'y'] }), ['x', 'y']);
assert('duplicate ids collapse',
    clipIdsOf({ playlist_clips: [{ id: 'x' }, { id: 'x' }] }), ['x']);
assert('an unknown shape contributes nothing',
    clipIdsOf({ something_else: [{ id: 'x' }] }), []);
assert('a null playlist contributes nothing',
    clipIdsOf(null), []);

// MEASURED 2026-11-02 (live): the v1 detail nests the clip under
// `clip`, so the id is NOT on the entry. The old reader missed it and
// reported a full playlist as empty.
assert('ids from the nested v1 shape (clip.id)',
    clipIdsOf({ playlist_clips: [{ clip: { id: 'n1', title: 'One' } }] }), ['n1']);
assert('the nested shape de-duplicates too',
    clipIdsOf({ playlist_clips: [{ clip: { id: 'n1' } }, { clip: { id: 'n1' } }] }), ['n1']);
assert('ids from a clip_id field',
    clipIdsOf({ playlist_clips: [{ clip_id: 'c1' }] }), ['c1']);
assert('ids from a song_id field',
    clipIdsOf({ playlist_clips: [{ song_id: 's1' }] }), ['s1']);
assert('a nested clip with no id contributes nothing',
    clipIdsOf({ playlist_clips: [{ clip: { title: 'no id' } }] }), []);
assert('name from the v1 shape', nameOf(v1), 'Guslar');
assert('name from the v2 shape', nameOf(v2), 'Guslar');
assert('id from the v1 shape', idOf(v1), 'p1');
assert('id from the v2 shape', idOf(v2), 'p1');

console.log('\n3. findByName — case-insensitive, first match wins');

const list = [v1, { id: 'p2', name: 'Other' }];
assert('an exact name', findByName(list, 'Guslar').id, 'p1');
assert('a different case', findByName(list, 'guslar').id, 'p1');
assert('padded', findByName(list, '  GUSLAR ').id, 'p1');
assert('a name that is not there', findByName(list, 'Nope'), null);
assert('an empty name finds nothing', findByName(list, ''), null);

console.log('\n4. parseJson — an HTML body is not a playlist');

assert('a JSON object', parseJson('{"a":1}'), { a: 1 });
assert('an HTML body', parseJson('<!doctype html><html></html>'), null);
assert('an empty body', parseJson(''), null);
assert('a truncated body', parseJson('{"a":'), null);
assert('an object passes through', parseJson({ a: 1 }), { a: 1 });

console.log('\n5. the wire contract');

{
    const c = fakeClient({
        'GET /api/playlist/me': { status: 200, body: JSON.stringify({ playlists: [v1] }) },
    });
    const got = await listPlaylists(c);
    assert('listPlaylists returns the playlists', got.length, 1);
    assert('listPlaylists calls /api/playlist/me',
        c.calls[0].pathname, '/api/playlist/me');
}
{
    const c = fakeClient({ 'GET /api/playlist/me': { status: 200, body: '<html>oops</html>' } });
    let threw = null;
    try { await listPlaylists(c); } catch (e) { threw = e; }
    assertTrue('an unparseable list is an error, not an empty list', !!threw);
}
{
    const c = fakeClient({
        'POST /api/playlist/create/': { status: 200, body: JSON.stringify({ id: 'p9', name: 'New' }) },
    });
    const made = await createPlaylist(c, 'New');
    assert('createPlaylist posts the name', c.calls[0].body, { name: 'New' });
    assert('createPlaylist returns the created id', made.id, 'p9');
}
{
    const c = fakeClient({
        'POST /api/playlist/create/': { status: 200, body: JSON.stringify({ id: 'p9' }) },
    });
    let threw = null;
    try { await createPlaylist(c, '   '); } catch (e) { threw = e; }
    assertTrue('a nameless create is refused before the call', !!threw);
    assert('and no call was made', c.calls.length, 0);
}
{
    // MEASURED 2026-11-02 (live): this body is what the API answered.
    const c = fakeClient({
        'POST /api/playlist/v2/p1/tracks/add': {
            status: 200,
            body: JSON.stringify({ successes: ['clip-a'], failures: [] }),
        },
    });
    const r = await addTracks(c, 'p1', ['clip-a']);
    assert('the add body is clip_ids', c.calls[0].body, { clip_ids: ['clip-a'] });
    assert('the add reports its successes', r.successes, ['clip-a']);
    assert('the add reports no failures', r.failures, []);
}
{
    const c = fakeClient({
        'POST /api/playlist/v2/p1/tracks/remove': {
            status: 200,
            body: JSON.stringify({ successes: ['clip-a'], failures: [] }),
        },
    });
    const r = await removeTracks(c, 'p1', ['clip-a']);
    assert('the remove body is clip_ids', c.calls[0].body, { clip_ids: ['clip-a'] });
    assert('the remove reports its successes', r.successes, ['clip-a']);
}
{
    const c = fakeClient({
        'POST /api/playlist/v2/p1/tracks/add': { status: 500, body: 'boom' },
    });
    let threw = null;
    try { await addTracks(c, 'p1', ['clip-a']); } catch (e) { threw = e; }
    assertTrue('a failing add throws', !!threw);
}
{
    const c = fakeClient({
        'POST /api/playlist/v2/p1/tracks/add': { status: 200, body: '{"successes":[]}' },
    });
    let threw = null;
    try { await addTracks(c, 'p1', []); } catch (e) { threw = e; }
    assertTrue('adding nothing is refused before the call', !!threw);
    assert('and no call was made', c.calls.length, 0);
}

console.log('\n6. getPlaylist — membership, not the add call\'s word');

{
    const c = fakeClient({
        'GET /api/playlist/p1': { status: 200, body: JSON.stringify(v1) },
        'GET /api/playlist/v2/p1': { status: 200, body: JSON.stringify(v2) },
    });
    const p = await getPlaylist(c, 'p1');
    assert('the id', p.id, 'p1');
    assert('the name', p.name, 'Guslar');
    assert('the clips', p.clipIds, ['clip-a', 'clip-b']);
    assert('the song count', p.songCount, 2);
}
{
    // A playlist whose v2 detail is missing still reads from v1.
    const c = fakeClient({
        'GET /api/playlist/p1': { status: 200, body: JSON.stringify(v1) },
        'GET /api/playlist/v2/p1': { status: 404, body: 'nope' },
    });
    const p = await getPlaylist(c, 'p1');
    assert('the clips still read', p.clipIds, ['clip-a', 'clip-b']);
}
{
    const c = fakeClient({
        'GET /api/playlist/p1': { status: 404, body: '{"detail":"not found"}' },
        'GET /api/playlist/v2/p1': { status: 404, body: '{"detail":"not found"}' },
    });
    let threw = null;
    try { await getPlaylist(c, 'p1'); } catch (e) { threw = e; }
    assertTrue('a missing playlist throws', !!threw);
}

console.log('\n7. ensurePlaylist — find, or make');

{
    const c = fakeClient({
        'GET /api/playlist/me': { status: 200, body: JSON.stringify({ playlists: [v1] }) },
    });
    const r = await ensurePlaylist(c, 'Guslar');
    assert('an existing playlist is found', r.id, 'p1');
    assert('and not created', r.created, false);
    assert('and no create call was made', c.calls.length, 1);
}
{
    const c = fakeClient({
        'GET /api/playlist/me': { status: 200, body: JSON.stringify({ playlists: [] }) },
        'POST /api/playlist/create/': { status: 200, body: JSON.stringify({ id: 'p7', name: 'Guslar' }) },
    });
    const r = await ensurePlaylist(c, 'Guslar');
    assert('a missing playlist is created', r.id, 'p7');
    assert('and reported as created', r.created, true);
    assert('and the create went to the trailing-slash route',
        c.calls[1].pathname, '/api/playlist/create/');
}

console.log('\n8. findPlaylist');

{
    const c = fakeClient({
        'GET /api/playlist/me': { status: 200, body: JSON.stringify({ playlists: [v1, { id: 'p2', name: 'Other' }] }) },
    });
    const f = await findPlaylist(c, 'other');
    assert('a case-insensitive find', f.id, 'p2');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
    for (const f of failures) console.log(`FAILED: ${f.label}\n  expected ${f.expected}\n  got      ${f.actual}`);
    process.exit(1);
}
}

run().catch((e) => { console.error(e); process.exit(1); });
