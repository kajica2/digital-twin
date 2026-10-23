#!/usr/bin/env node
'use strict';
// lib/gumroad.test.js
//
// Tests for the Gumroad wiring.
//
// Two halves:
//
//   * The PURE planner — what would be created, from the price plan and the
//     packages. No network, no filesystem beyond reading the packages.
//
//   * The TRANSPORT — driven with a MOCKED fetch. These tests never write to
//     a real storefront. They pin the route shapes that were expensive to
//     find: the 303 Location, the top-level update params, the
//     `POST /links/<permalink>` path, the multipart string-to-sign.
//
//   node lib/gumroad.test.js

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const gr = require('./gumroad.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else {
        failed++;
        failures.push({ label, actual: a, expected: e });
        process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
    }
}
function assertTrue(label, cond) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: 'false', expected: 'true' });
           process.stderr.write(`  ✗ ${label}\n`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gumroad-test-'));
process.stderr.write(`\n[gumroad.test]\n\n`);

// ---------------------------------------------------------------- 1. slugs
process.stderr.write(`1. custom permalink rules\n`);
assert('letters and dashes are legal', gr.isValidCustomPermalink('the-whole-catalogue'), true);
assert('digits are legal', gr.isValidCustomPermalink('system-error-01'), true);
assert('underscore is legal', gr.isValidCustomPermalink('a_b'), true);
assert('spaces are not', gr.isValidCustomPermalink('a b'), false);
assert('a slash is not', gr.isValidCustomPermalink('a/b'), false);
assert('an empty slug is not', gr.isValidCustomPermalink(''), false);
assert('a non-string is not', gr.isValidCustomPermalink(null), false);
assert('over 255 chars is not', gr.isValidCustomPermalink('a'.repeat(256)), false);

// ------------------------------------------------------------ 2. scrubbing
process.stderr.write(`2. absolute paths never reach a description\n`);
assert('a home path is stripped', gr.scrubPaths('saved in /Users/kai/Documents/x.jpg'), 'saved in');
assert('a tilde path is stripped', gr.scrubPaths('at ~/Documents/y.png'), 'at');
assert('an absolute path mid-sentence is stripped',
    gr.scrubPaths('rendered /Users/kai/a/b.png today'), 'rendered today');
assert('plain text is untouched', gr.scrubPaths('a reel of glass and light'), 'a reel of glass and light');
assert('a non-string is empty', gr.scrubPaths(undefined), '');

// -------------------------------------------------------------- 3. planner
process.stderr.write(`3. planner turns the price plan into product specs\n`);
const pkgDir = path.join(TMP, 'packages');
fs.mkdirSync(path.join(pkgDir, 'plate-one'), { recursive: true });
fs.mkdirSync(path.join(pkgDir, 'reel-one'), { recursive: true });
fs.mkdirSync(path.join(pkgDir, 'cover-one'), { recursive: true });
fs.writeFileSync(path.join(pkgDir, 'plate-one', 'post.json'), JSON.stringify({
    kind: 'plate',
    title: 'plate one',
    description: 'A plate rendered locally /Users/kai/Documents/digital_twin/out.png',
    files: { images: [path.join(pkgDir, 'plate-one', 'missing.jpg')] },
}));
fs.writeFileSync(path.join(pkgDir, 'reel-one', 'post.json'), JSON.stringify({
    kind: 'reel',
    title: 'reel one',
    description: 'A reel',
    files: { image: '/nowhere/cover.jpg', video: '/nowhere/reel.mp4' },
}));
fs.writeFileSync(path.join(pkgDir, 'cover-one', 'post.json'), JSON.stringify({
    kind: 'cover',
    title: 'cover one',
    description: 'A cover study',
    files: { images: [] },
}));

const PLAN = {
    currency: 'EUR',
    count: 2,
    total: 15,
    bundle: { name: 'The whole catalogue', slug: 'the-whole-catalogue', amount: 12, discount: 0.2 },
    items: [
        { id: 'plate-one', name: 'Plate One — art plate', slug: 'plate-one', amount: 9, currency: 'EUR', rationale: 'r' },
        { id: 'reel-one', name: 'Reel One — reel', slug: 'reel-one', amount: 6, currency: 'EUR', rationale: 'r' },
        { id: 'cover-one', name: 'Cover One — cover study', slug: 'cover one', amount: 19, currency: 'EUR', rationale: 'r' },
    ],
};

const plan = gr.planFromPricingPlan({ pricing: PLAN, packagesDir: pkgDir });
assert('two products survived the slug check', plan.products.length, 2);
assert('the invalid slug is skipped', plan.skipped.map((s) => s.id), ['cover-one']);
assert('price becomes cents', plan.products[0].priceCents, 900);
assert('currency is gumroad-shaped', plan.products[0].currency, 'eur');
assert('native type is digital', plan.products[0].nativeType, 'digital');
assert('the slug is carried', plan.products[0].slug, 'plate-one');
assert('a missing package still yields a product', plan.products[1].name, 'Reel One — reel');
assert('the bundle is planned', plan.bundle.slug, 'the-whole-catalogue');
assert('the bundle price is 1200c', plan.bundle.priceCents, 1200);
assert('the bundle is native_type bundle', plan.bundle.nativeType, 'bundle');
assert('the bundle lists its members', plan.bundle.members, ['plate-one', 'reel-one']);
assert('the bundle can be left out', gr.planFromPricingPlan({ pricing: PLAN, packagesDir: pkgDir, withBundle: false }).bundle, null);
assert('a price plan without items throws', (() => {
    try { gr.planFromPricingPlan({ pricing: {}, packagesDir: pkgDir }); return 'no throw'; }
    catch { return 'threw'; }
})(), 'threw');

// A description with an absolute path is scrubbed before it can ship.
fs.writeFileSync(path.join(pkgDir, 'plate-one', 'post.json'), JSON.stringify({
    kind: 'plate',
    description: 'A plate rendered locally /Users/kai/Documents/digital_twin/out.png',
    files: { images: [] },
}));
const plan2 = gr.planFromPricingPlan({ pricing: PLAN, packagesDir: pkgDir });
assertTrue('the planned description carries no absolute path',
    !plan2.products[0].description.includes('/Users/'));

// --------------------------------------------------------- 4. cookie header
process.stderr.write(`4. the cookie jar parser keeps HTTP-only rows\n`);
const jarFile = path.join(TMP, 'jar.txt');
fs.writeFileSync(jarFile, [
    '# Netscape HTTP Cookie File',
    '',
    '#HttpOnly_.gumroad.com\tTRUE\t/\tTRUE\t1797998923\t_gumroad_app_session\tFAKE-SESSION',
    '.gumroad.com\tTRUE\t/\tTRUE\t1797998923\tXSRF-TOKEN\tFAKE-XSRF',
    '.other.com\tTRUE\t/\tTRUE\t1797998923\tsomeone_else\tNOPE',
    '',
].join('\n'));
const header = gr.cookieHeaderFromFile(jarFile);
assertTrue('the HTTP-only session cookie is present', header.includes('_gumroad_app_session=FAKE-SESSION'));
assertTrue('a foreign domain is not', !header.includes('someone_else'));
assertTrue('the XSRF cookie is present', header.includes('XSRF-TOKEN=FAKE-XSRF'));

// ------------------------------------------------------------ 5. Inertia
process.stderr.write(`5. Inertia page props\n`);
const page = '<html><body><div data-page="{&quot;props&quot;:{&quot;authenticity_token&quot;:&quot;TOK&quot;,&quot;current_seller&quot;:{&quot;id&quot;:&quot;5952229292192&quot;}}}"></div></body></html>';
const props = gr.propsFromHtml(page);
assert('the token is read', props.authenticity_token, 'TOK');
assert('the seller id is read', props.current_seller.id, '5952229292192');
assertTrue('a page without props throws', (() => {
    try { gr.propsFromHtml('<html></html>'); return false; } catch { return true; }
})());

// ------------------------------------------------- 6. string-to-sign (Evaporate)
process.stderr.write(`6. the multipart signature string\n`);
assert('initiate carries the acl and the charset',
    gr.GumroadClient.stringToSign('POST', 'image/jpeg', { 'x-amz-date': 'D', 'x-amz-acl': 'private' }, '/b/k?uploads', 'initiate'),
    'POST\n\nimage/jpeg; charset=UTF-8\n\nx-amz-acl:private\nx-amz-date:D\n/b/k?uploads');
assert('a part carries only the date',
    gr.GumroadClient.stringToSign('PUT', 'image/jpeg', { 'x-amz-date': 'D' }, '/b/k?partNumber=1&uploadId=U', 'upload #1'),
    'PUT\n\nimage/jpeg; charset=UTF-8\n\nx-amz-date:D\n/b/k?partNumber=1&uploadId=U');
assert('complete uses the xml content type verbatim',
    gr.GumroadClient.stringToSign('POST', 'application/xml; charset=UTF-8', { 'x-amz-date': 'D' }, '/b/k?uploadId=U', 'complete'),
    'POST\n\napplication/xml; charset=UTF-8\n\nx-amz-date:D\n/b/k?uploadId=U');
assert('the x-amz headers are sorted, not insertion-ordered',
    gr.GumroadClient.stringToSign('POST', 'm', { 'x-amz-date': 'D', 'x-amz-acl': 'private' }, '/p', 'initiate'),
    'POST\n\nm; charset=UTF-8\n\nx-amz-acl:private\nx-amz-date:D\n/p');

async function transportTests() {
    // ------------------------------------------------------- 7. transport (mocked)
    process.stderr.write(`7. the transport calls the routes that exist\n`);

    const JAR = path.join(TMP, 'jar.txt');
    const calls = [];

    function mockResponse(status, body, headers) {
        return {
            status,
            headers: {
                get: (k) => (headers && headers[k.toLowerCase()] !== undefined ? headers[k.toLowerCase()] : null),
                getSetCookie: () => (headers && headers['set-cookie'] ? [headers['set-cookie']] : []),
            },
            text: async () => (body || ''),
        };
    }

    function makeClient(handler) {
        const fetchImpl = async (url, opts) => {
            calls.push({ url, method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || {}, body: opts && opts.body });
            return handler(url, opts);
        };
        return new gr.GumroadClient({ cookieFile: JAR, fetchImpl });
    }

    const PROPS_PAGE = (props) => `<div data-page="${JSON.stringify({ props }).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"></div>`;
    const INERTIA_PRODUCTS = JSON.stringify({
        props: {
            products_data: {
                products: [
                    { id: 4402311, permalink: 'krlzd', url: 'https://kaidjuric.gumroad.com/l/krlzd', name: 'set od svg backgrounds' },
                    { id: 14980031, permalink: 'gsxlv', url: 'https://kaidjuric.gumroad.com/l/scratch-route-test', name: 'Scratch' },
                ],
            },
        },
    });

    // 7a. create: the permalink comes from the 303 Location, not the body.
    {
        calls.length = 0;
        const client = makeClient((url, opts) => {
            if (opts.method === 'POST' && url.endsWith('/links')) {
                return mockResponse(303, '', { location: 'https://gumroad.com/products/abc123/edit' });
            }
            return mockResponse(200, PROPS_PAGE({ authenticity_token: 'TOK' }));
        });
        const created = await client.createProduct({ name: 'X', priceCents: 900, currency: 'eur', nativeType: 'digital', slug: 'x-slug' });
        assert('the new permalink is parsed from the Location header', created.permalink, 'abc123');
        assert('the public url uses the slug', created.url, 'https://kaidjuric.gumroad.com/l/x-slug');
        const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/links'));
        assertTrue('the create body is form-encoded', create.headers['Content-Type'] === 'application/x-www-form-urlencoded');
        assertTrue('the create body nests under link[]', create.body.includes('link%5Bname%5D=X') || create.body.includes('link[name]=X'));
        assertTrue('the create body carries the CSRF token', create.body.includes('authenticity_token=TOK'));
        assertTrue('the create body carries the price', create.body.includes('900'));
    }

    // 7b. update: POST /links/<permalink> with TOP-LEVEL params.
    {
        calls.length = 0;
        const client = makeClient((url, opts) => {
            if (opts.method === 'POST' && /\/links\/abc123$/.test(url)) return mockResponse(200, '{}');
            return mockResponse(200, PROPS_PAGE({ authenticity_token: 'TOK' }));
        });
        await client.updateProduct('abc123', { name: 'New name', price_cents: 725, files: [{ url: 'u', display_name: 'f.jpg', extension: 'jpg', size: 10, position: 0 }] });
        const upd = calls.find((c) => c.method === 'POST' && c.url === 'https://gumroad.com/links/abc123');
        assertTrue('the update route is POST /links/<permalink>', !!upd);
        assertTrue('the update params are top-level, not nested under link[]', upd.body.includes('name=New+name'));
        assertTrue('the update body carries the price', upd.body.includes('price_cents=725'));
        assertTrue('the update body carries the file array', upd.body.includes('files%5B0%5D%5Burl%5D=u') || upd.body.includes('files[0][url]=u'));
    }

    // 7c. destroy uses DELETE on the permalink.
    {
        calls.length = 0;
        const client = makeClient((url, opts) => {
            if (opts.method === 'DELETE') return mockResponse(200, '{"success":true}');
            return mockResponse(200, PROPS_PAGE({ authenticity_token: 'TOK' }));
        });
        const res = await client.destroy('abc123');
        assert('destroy reports success', res.success, true);
        assert('destroy hits DELETE /links/<permalink>', calls.find((c) => c.method === 'DELETE').url, 'https://gumroad.com/links/abc123');
    }

    // 7d. publish reports the upstream error instead of throwing.
    {
        calls.length = 0;
        const client = makeClient((url, opts) => {
            if (opts.method === 'POST' && url.includes('/publish')) {
                return mockResponse(200, '{"success":false,"error_message":"we need you to have an email"}');
            }
            return mockResponse(200, PROPS_PAGE({ authenticity_token: 'TOK' }));
        });
        const res = await client.publish('abc123');
        assert('publish failure is reported', res.success, false);
        assert('the upstream message is kept', res.error, 'we need you to have an email');
    }

    // 7e. the product list needs the deferred-props partial reload.
    {
        calls.length = 0;
        const client = makeClient((url, opts) => {
            if (opts.headers['X-Inertia-Partial-Component']) return mockResponse(200, INERTIA_PRODUCTS);
            return mockResponse(200, PROPS_PAGE({ authenticity_token: 'TOK' }));
        });
        const list = await client.listProducts();
        assert('both products are listed', list.length, 2);
        assert('the public slug is read from the url', gr.GumroadClient.publicSlug(list[1]), 'scratch-route-test');
        const req = calls.find((c) => c.headers['X-Inertia-Partial-Component']);
        assert('the partial component is requested', req.headers['X-Inertia-Partial-Component'], 'Products/Index');
        assert('the partial data is requested', req.headers['X-Inertia-Partial-Data'], 'products_data');
    }

    // 7f. check() reports the gates.
    {
        calls.length = 0;
        const client = makeClient((url, opts) => {
            if (opts.headers['X-Inertia-Partial-Component']) return mockResponse(200, INERTIA_PRODUCTS);
            return mockResponse(200, PROPS_PAGE({
                authenticity_token: 'TOK',
                current_seller: { id: '5952229292192', name: 'Kai Djuric', subdomain: 'kaidjuric.gumroad.com', can_publish_products: false, publish_blocked_reason: 'no_payout_method' },
                user: { email: 'kai.djuric+store@gmail.com', has_unconfirmed_email: true },
            }));
        });
        const info = await client.check();
        assert('the seller id is reported', info.sellerId, '5952229292192');
        assert('the storefront is reported', info.storefrontUrl, 'https://kaidjuric.gumroad.com');
        assert('the publish block is reported', info.publishBlockedReason, 'no_payout_method');
        assert('the unconfirmed email is visible', info.hasUnconfirmedEmail, true);
        assert('the product count is read', info.productCount, 2);
    }

    // 7g. a signed-out session is reported, not thrown.
    {
        const client = makeClient(() => mockResponse(302, '', { location: 'https://gumroad.com/settings' }));
        const info = await client.check();
        assert('a bounced session is not ok', info.ok, false);
        assertTrue('the reason names the status', info.status === 302);
    }

    // 7h. the S3 upload path is exercised end to end against a mock S3.
    {
        calls.length = 0;
        const putBodies = [];
        const client = makeClient((url, opts) => {
            if (url.includes('current_utc_time_string')) return mockResponse(200, 'Fri, 23 Oct 2026 12:00:00 GMT');
            if (url.includes('generate_multipart_signature')) return mockResponse(200, 'SIGNATURE');
            if (url.startsWith('https://s3.amazonaws.com/gumroad/attachments/') && (opts.method === 'POST')) {
                if ((opts.body || '').includes('CompleteMultipartUpload')) {
                    return mockResponse(200, '<CompleteMultipartUploadResult><Location>https://s3.amazonaws.com/gumroad/x</Location></CompleteMultipartUploadResult>');
                }
                return mockResponse(200, '<InitiateMultipartUploadResult><UploadId>UPLOAD-ID</UploadId></InitiateMultipartUploadResult>');
            }
            if (url.startsWith('https://s3.amazonaws.com/gumroad/attachments/') && opts.method === 'PUT') {
                putBodies.push(opts.body);
                return mockResponse(200, '', { etag: '"abc123"' });
            }
            if (url.endsWith('/edit')) {
                return mockResponse(200, PROPS_PAGE({
                    authenticity_token: 'TOK',
                    aws_key: 'AKIAEXAMPLE',
                    s3_url: 'https://s3.amazonaws.com/gumroad',
                    current_seller_external_id: '5952229292192',
                }));
            }
            return mockResponse(200, PROPS_PAGE({ authenticity_token: 'TOK' }));
        });

        const mediaFile = path.join(TMP, 'plate.jpg');
        fs.writeFileSync(mediaFile, Buffer.alloc(1234, 7));
        const url = await client.uploadProductFile('abc123', mediaFile);
        assertTrue('the product file url points at gumroad\'s bucket',
            url.startsWith('https://s3.amazonaws.com/gumroad/attachments/5952229292192/'));
        assertTrue('the key carries the seller id', url.includes('/attachments/5952229292192/'));
        assertTrue('the key carries the filename', url.endsWith('/original/plate.jpg'));
        assert('the bytes were uploaded once', putBodies.length, 1);
        assert('the bytes are intact', putBodies[0].length, 1234);
        const initiate = calls.find((c) => c.url.includes('?uploads'));
        assertTrue('the initiate call sets the acl header', initiate.headers['x-amz-acl'] === 'private');
        assertTrue('the initiate call is signed with the aws key', initiate.headers.Authorization === 'AWS AKIAEXAMPLE:SIGNATURE');
        const part = calls.find((c) => c.url.includes('partNumber=1'));
        assertTrue('the part carries an explicit content length', part.headers['Content-Length'] === '1234');
    }

    // ------------------------------------------------------- 8. idempotency
    process.stderr.write(`8. a re-run updates instead of duplicating\n`);
    {
        calls.length = 0;
        const client = makeClient((url, opts) => {
            if (opts.headers['X-Inertia-Partial-Component']) return mockResponse(200, INERTIA_PRODUCTS);
            if (opts.method === 'POST' && url.endsWith('/links')) return mockResponse(303, '', { location: 'https://gumroad.com/products/newone/edit' });
            return mockResponse(200, PROPS_PAGE({ authenticity_token: 'TOK' }));
        });
        const existing = await client.findBySlug('scratch-route-test');
        assert('an existing product is found by its public slug', existing.permalink, 'gsxlv');
        const missing = await client.findBySlug('never-made');
        assert('an unknown slug finds nothing', missing, null);
    }

    // ------------------------------------------------------- 9. bundles
    process.stderr.write(`9. bundles: members are attached by external id\n`);
    {
        calls.length = 0;
        const client = makeClient((url, opts) => {
            // A bundle's product route redirects to /bundles/<external id>/product/edit.
            if (url === 'https://gumroad.com/products/bundle1/edit') {
                return mockResponse(302, '', { location: 'https://gumroad.com/bundles/EXTID==/product/edit' });
            }
            if (url === 'https://gumroad.com/bundles/EXTID==/product/edit') {
                return mockResponse(200, PROPS_PAGE({ authenticity_token: 'TOK', id: 'EXTID==', is_bundle: true }));
            }
            if (opts.method === 'PATCH' && url.includes('/content')) {
                return mockResponse(303, '', { location: 'https://gumroad.com/bundles/EXTID==/content/edit' });
            }
            return mockResponse(200, PROPS_PAGE({ authenticity_token: 'TOK' }));
        });

        const props = await client.editProps('bundle1');
        assert('the redirect to the bundle page is followed', props.id, 'EXTID==');

        const res = await client.attachBundleMembers('bundle1', ['PRODA==', 'PRODB==']);
        assert('both members are attached', res.attached, 2);
        const patch = calls.find((c) => c.method === 'PATCH');
        assert('the content route is the bundle external id', patch.url, 'https://gumroad.com/bundles/EXTID==/content');
        assertTrue('the member parameter is an array', patch.body.includes('products%5B%5D%5Bproduct_id%5D=PRODA%3D%3D') || patch.body.includes('products[][product_id]=PRODA=='));
        assertTrue('the first member is at position zero', patch.body.includes('position%5D=0') || patch.body.includes('position]=0'));
        assertTrue('the second member is at position one', patch.body.includes('position%5D=1') || patch.body.includes('position]=1'));
        assertTrue('the body carries the CSRF token', patch.body.includes('authenticity_token=TOK'));
    }

    // ------------------------------------------------------ 10. refusals
    process.stderr.write(`10. a refused create says WHY it was refused\n`);
    {
        // 10a. the reason is read from the page the refusal redirected to.
        calls.length = 0;
        const client = makeClient((url, opts) => {
            if (opts.method === 'POST' && url.endsWith('/links')) {
                // A refused create answers 303 to /products/new.
                return mockResponse(303, '', { location: 'https://gumroad.com/products/new' });
            }
            if (url === 'https://gumroad.com/products/new') {
                return mockResponse(200, PROPS_PAGE({
                    flash: { message: 'Sorry, you can only create 10 products per day.', status: 'danger' },
                    errors: { 'link.base': 'Sorry, you can only create 10 products per day.' },
                }));
            }
            return mockResponse(200, PROPS_PAGE({ authenticity_token: 'TOK' }));
        });

        let thrown = null;
        try {
            await client.createProduct({ name: 'X', priceCents: 900, currency: 'eur', nativeType: 'digital', slug: 'x-slug' });
        } catch (e) { thrown = e; }
        assertTrue('a refused create throws', !!thrown);
        assertTrue('the error carries the server\'s own reason',
            thrown && thrown.message.includes('you can only create 10 products per day'));
        assert('the daily ceiling is recognised', thrown && thrown.dailyCreateLimit, 10);
        assertTrue('the refusal page was read', calls.some((c) => c.url === 'https://gumroad.com/products/new'));
    }

    // 10b. a refusal with no flash is still reported, not swallowed.
    {
        const client = makeClient((url, opts) => {
            if (opts.method === 'POST' && url.endsWith('/links')) {
                return mockResponse(303, '', { location: 'https://gumroad.com/products/new' });
            }
            if (url === 'https://gumroad.com/products/new') {
                return mockResponse(200, '<html><body>no props here</body></html>');
            }
            return mockResponse(200, PROPS_PAGE({ authenticity_token: 'TOK' }));
        });
        let thrown = null;
        try {
            await client.createProduct({ name: 'X', priceCents: 900, currency: 'eur', nativeType: 'digital', slug: 'x-slug' });
        } catch (e) { thrown = e; }
        assertTrue('a silent refusal still throws', !!thrown);
        assertTrue('the fallback message names the Location',
            thrown && thrown.message.includes('Location: https://gumroad.com/products/new'));
        assert('a silent refusal is not a daily limit', thrown && thrown.dailyCreateLimit, null);
    }

    // 10c. the refusal parser is pure: the flash, the errors, the limit.
    {
        const flashPage = PROPS_PAGE({ flash: { message: 'Sorry, you can only create 10 products per day.' } });
        assert('the flash message is read', gr.parseRefusal(flashPage).message, 'Sorry, you can only create 10 products per day.');
        assert('the daily limit is read', gr.parseRefusal(flashPage).limit, 10);

        const errorsPage = PROPS_PAGE({ errors: { 'link.base': 'That slug is already taken.' } });
        assert('the base error is read', gr.parseRefusal(errorsPage).message, 'That slug is already taken.');
        assert('a non-limit refusal has no limit', gr.parseRefusal(errorsPage).limit, null);

        assert('a page with no props has no message', gr.parseRefusal('<html></html>').message, null);
    }

    // 10d. the daily wall stops the run instead of walking into it again.
    {
        const plan = {
            products: [
                { key: 'p1', slug: 'p1', name: 'P1', priceCents: 900, currency: 'eur', nativeType: 'digital', description: '', files: [], cover: null, publish: false },
                { key: 'p2', slug: 'p2', name: 'P2', priceCents: 900, currency: 'eur', nativeType: 'digital', description: '', files: [], cover: null, publish: false },
                { key: 'p3', slug: 'p3', name: 'P3', priceCents: 900, currency: 'eur', nativeType: 'digital', description: '', files: [], cover: null, publish: false },
            ],
            bundle: { key: 'bundle', slug: 'the-whole-catalogue', name: 'Bundle', priceCents: 1200, currency: 'eur', nativeType: 'bundle', members: ['p1', 'p2', 'p3'], description: 'all' },
            skipped: [],
        };
        let creates = 0;
        const fake = {
            findBySlug: async () => null,
            createProduct: async () => {
                creates++;
                const e = new Error('create refused: Sorry, you can only create 10 products per day.');
                e.dailyCreateLimit = 10;
                throw e;
            },
            editProps: async () => ({}),
            updateProduct: async () => ({}),
            externalId: async () => 'ID',
            attachBundleMembers: async () => ({ status: 200, attached: 0 }),
        };
        const out = await gr.sync({ client: fake, apply: true, plan });
        assert('the first create is attempted', creates, 1);
        assert('the refused one and the ones after it are all deferred, not retried',
            out.results.filter((r) => r.action === 'deferred').length, 3);
        assertTrue('no product is reported as an error',
            out.results.every((r) => r.action !== 'error'));
        assert('the daily limit is reported', out.dailyLimit, 10);
        assert('the bundle waits for its members', out.bundle.action, 'deferred');
        assertTrue('the bundle says what is missing', out.bundle.errors[0].includes('not on the storefront yet'));
    }

    // 10e. a bundle with every member in place is created.
    {
        const plan = {
            products: [
                { key: 'p1', slug: 'p1', name: 'P1', priceCents: 900, currency: 'eur', nativeType: 'digital', description: '', files: [], cover: null, publish: false },
            ],
            bundle: { key: 'bundle', slug: 'the-whole-catalogue', name: 'Bundle', priceCents: 1200, currency: 'eur', nativeType: 'bundle', members: ['p1'], description: 'all' },
            skipped: [],
        };
        let bundled = 0;
        const fake = {
            findBySlug: async () => ({ permalink: 'x1', url: 'u' }),
            createProduct: async () => ({ permalink: 'x1', url: 'u', location: 'l' }),
            editProps: async () => ({}),
            updateProduct: async () => ({}),
            externalId: async () => 'ID',
            attachBundleMembers: async () => { bundled++; return { status: 200, attached: 1 }; },
        };
        const out = await gr.sync({ client: fake, apply: true, plan });
        assert('a complete bundle is synced', out.bundle.action, 'update');
        assert('its members are attached', bundled, 1);
    }

    // --------------------------------------------------------- 11. file descriptors
    process.stderr.write(`11. file descriptors match gumroad's shape\n`);
    {
        const descs = gr.fileDescriptors([
            { url: 'https://s3.amazonaws.com/gumroad/attachments/x/original/a.jpg', displayName: 'a.jpg', extension: 'jpg', size: 10 },
        ]);
        assert('the descriptor keys are exactly what the update route wants',
            Object.keys(descs[0]).sort(), ['display_name', 'extension', 'position', 'size', 'url']);
        assert('position starts at zero', descs[0].position, 0);

        const withId = gr.fileDescriptors([
            { id: 'IkoXpPxIx4Y7noLWi0Misg==', url: 'u', displayName: 'a.jpg', extension: 'jpg', size: 10 },
        ]);
        assert('a reused file carries its id back so gumroad edits it in place',
            withId[0].id, 'IkoXpPxIx4Y7noLWi0Misg==');
    }


}

transportTests().then(() => {
// cleanup
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

process.stderr.write(`\n[gumroad.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
    process.exit(failed === 0 ? 0 : 1);

});
