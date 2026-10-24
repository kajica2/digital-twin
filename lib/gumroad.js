#!/usr/bin/env node
'use strict';
// lib/gumroad.js
//
// Turn the social engine's price plan (data/social/pricing.json) into real
// products on the user's Gumroad storefront.
//
// WHAT THIS IS
//
// Two layers, deliberately separated:
//
//   1. A PURE planner. `planFromPricingPlan()` turns the price plan plus the
//      per-item packages into a list of product specs (name, price, slug,
//      description, which local file is the cover, which local files are the
//      downloadable product files). It does no I/O and knows nothing about
//      HTTP. That is what the unit tests exercise.
//
//   2. A TRANSPORT. `GumroadClient` talks to Gumroad's own dashboard
//      endpoints with the seller's session cookie, creates/updates products,
//      uploads covers, uploads the downloadable files, and publishes when
//      asked.
//
// WHY THE DASHBOARD AND NOT THE PUBLIC API
//
// Gumroad's public API (api/v2) needs an OAuth application owned by the
// account. There is none on this machine, and minting one is an
// account-level artifact the user has to ask for. The dashboard endpoints
// work with the session cookie the user already has, so this module uses
// those.
//
// The transport is intentionally thin and explicit about what it calls:
//
//   GET    https://gumroad.com/products          -> session check + CSRF token
//   GET    https://gumroad.com/products/<id>/edit -> per-product upload props
//   POST   https://gumroad.com/links              -> create (303 -> Location)
//   POST   https://gumroad.com/links/<permalink>  -> update (top-level params)
//   POST   https://gumroad.com/links/<permalink>/publish
//   DELETE https://gumroad.com/links/<permalink>
//   POST   https://gumroad.com/links/<permalink>/thumbnails
//   POST   https://gumroad.com/rails/active_storage/direct_uploads
//   POST   https://gumroad.com/s3_utility/generate_multipart_signature
//   GET    https://gumroad.com/s3_utility/current_utc_time_string
//
// Two route facts that cost real time to find, both verified live:
//
//   * `POST /links` returns 303 with the new product's permalink ONLY in the
//     Location header. The body is empty.
//   * The update action is `POST /links/<permalink>` (top-level params, NOT
//     nested under `link[...]`), and `<permalink>` is the AUTO-GENERATED
//     `unique_permalink`, not the public `custom_permalink` slug. A product
//     created with the slug "the-whole-catalogue" is edited at
//     /links/<random-letters>.
//
// Usage:
//   node lib/gumroad.js check            # preflight: seller, currency, gates
//   node lib/gumroad.js plan             # what the plan asks for
//   node lib/gumroad.js verify           # read every product back, diff it
//   node lib/gumroad.js sync             # dry run: what WOULD be written
//   node lib/gumroad.js sync --apply     # actually create/update the products
//   node lib/gumroad.js sync --apply --via-duplicate   # create by duplicating
//   node lib/gumroad.js sync --apply --only neon-pulse-cover
//
// `sync --apply` switches to the duplicate route on its own when Gumroad
// refuses a create for the daily ceiling; `--via-duplicate` starts there.
//
// THE DAILY WINDOW
//
// Gumroad allows 10 NEW products per day. A plan larger than that cannot
// be applied in one run: the products past the tenth are refused with
// "Sorry, you can only create 10 products per day."
//
// The run is therefore RESUMABLE, not all-or-nothing. A product that
// exists is updated; one that does not is created. Run it again after the
// window resets and the next ten are created. Nothing is lost and nothing
// is duplicated.
//
// PAST THE WALL: DUPLICATE AN EXISTING PRODUCT
//
// Waiting 24 hours for every ten products is a poor trade when the plan is
// already half on the storefront. Gumroad's own dashboard has a Duplicate
// action, and it creates the copy through `ProductDuplicatorService`, which
// saves with `validate: false` — so the daily-creation-limit validation
// never runs. That route is the sanctioned way past the wall:
//
//   POST /product_duplicates            {link_id: <source permalink>}
//   GET  /product_duplicates/<source>   -> {status, duplicated_product}
//
// The copy inherits the SOURCE's price, description, thumbnail and — this
// is the trap — its product_file rows (same S3 URLs, new rows). A copy is
// only sellable once those inherited rows are dropped and this product's
// own bytes and cover are attached, which is what
// `syncProductViaDuplicate()` does:
//
//   1. read the copy's edit props (per-product editor_revision + the
//      inherited file ids),
//   2. one revision-gated save that renames/reprices/reslugs the copy AND
//      names the inherited files in `deletion_operations`, because the
//      editor contract reads an omitted file as "no statement", not
//      "delete",
//   3. upload this product's file(s) and cover, then attach them.
//
// A product that already exists is never touched by this path.
//
// The bundle is the same trick: duplicate a product, then convert the COPY
// into a bundle (PUT /bundles/<external id>/product) — no second Link, so
// no second creation check — and attach the members by external id. The
// duplicated twin itself survives.
//
// The bundle waits until every member is on the storefront: a bundle
// missing members sells a discount on a catalogue that is not there.
//
// Pure Node, no deps.

const fs = require('node:fs');
const { squareCover } = require('./gumroad-cover.js');
const path = require('node:path');
const crypto = require('node:crypto');

const { parseNetscape } = require('./x-cookies.js');

const REPO = path.resolve(__dirname, '..');

const GUMROAD_ORIGIN = 'https://gumroad.com';
const SELLER_HOST = 'https://kaidjuric.gumroad.com';

// Where the session cookie lives. Outside the repo, always.
const DEFAULT_COOKIE_FILE = path.join(process.env.HOME || '', '.gumroad-cookies.txt');

// The price plan the social engine writes.
const PRICING_FILE = path.join(REPO, 'data', 'social', 'pricing.json');
const PACKAGES_DIR = path.join(REPO, 'data', 'social');

// Media that must be a cover image (Gumroad's thumbnail endpoint rejects
// anything else).
const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const MIME_BY_EXT = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.txt': 'text/plain',
};

// Evaporate's default part size (10 MB). Multipart requires every part but
// the last to be at least 5 MB.
const PART_SIZE = 10 * 1024 * 1024;

function log(msg) { process.stdout.write(`[gumroad] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[gumroad] ${msg}\n`); }

// ---------------------------------------------------------------- pure layer

/**
 * Gumroad's slug rules (upstream: Link#custom_permalink validation).
 * Letters, digits, underscore and dash; max 255.
 */
function isValidCustomPermalink(slug) {
    return typeof slug === 'string' &&
        slug.length > 0 &&
        slug.length <= 255 &&
        /^[a-zA-Z0-9_-]+$/.test(slug);
}

/**
 * Is this token a filesystem path rather than prose?
 *
 * A URL is not a path: "https://example.com/a" must survive.
 */
function looksLikePath(token) {
    if (!token) return false;
    if (token.includes('://')) return false;
    if (token.startsWith('~/')) return true;
    if (token.startsWith('/') && token.length > 1) {
        // "/a" alone is a word in prose; "/a/b" or "/a.jpg" is a path.
        return token.slice(1).includes('/') || /\.[A-Za-z0-9]{2,4}$/.test(token);
    }
    return false;
}

/**
 * Strip absolute filesystem paths out of anything that will be published.
 *
 * The package files carry absolute paths (the twin runs on the author's
 * machine); a storefront description must never leak that.
 */
function scrubPaths(text) {
    if (typeof text !== 'string') return '';
    const kept = [];
    for (const token of text.split(/\s+/)) {
        if (!token) continue;
        const core = token.replace(/^[([{]+/, '').replace(/[)\]}]+$/, '');
        if (looksLikePath(core)) continue;
        kept.push(token);
    }
    return kept.join(' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * The file extension without the dot, lowercased.
 */
function extOf(filePath) {
    const base = path.basename(String(filePath || ''));
    const i = base.lastIndexOf('.');
    return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

/**
 * Read one package (data/social/<id>/) and describe its media.
 * Missing packages are not fatal: the price plan is the contract, the
 * package is the artwork.
 */
function readPackage(packagesDir, id) {
    const dir = path.join(packagesDir, id);
    const postFile = path.join(dir, 'post.json');
    if (!fs.existsSync(postFile)) return null;
    let post;
    try {
        post = JSON.parse(fs.readFileSync(postFile, 'utf8'));
    } catch {
        return null;
    }
    const files = post.files || {};
    const images = Array.isArray(files.images) ? files.images : (files.image ? [files.image] : []);
    const video = files.video || null;
    const toRel = (p) => (typeof p === 'string' && p.startsWith(REPO + path.sep))
        ? path.relative(REPO, p)
        : p;
    return {
        id,
        kind: post.kind || null,
        title: post.title || null,
        description: post.description || '',
        images: images.map(toRel).filter(Boolean),
        video: toRel(video),
        publish: post.publish === true,
    };
}

/**
 * The poster frame the reel watcher wrote next to the video.
 *
 * Two of the packages on disk have no cover recorded in their post.json
 * even though the reel watcher wrote one next to the video, so the cover is
 * derived from the video's name rather than trusted to the manifest.
 */
function coverSiblingOf(videoRel) {
    if (!videoRel) return null;
    const dir = path.dirname(videoRel);
    const base = path.basename(videoRel).replace(/\.[A-Za-z0-9]+$/, '');
    for (const suffix of ['_cover.jpg', '_cover.png', '_cover.jpeg']) {
        const candidate = path.join(dir, base + suffix);
        if (fs.existsSync(path.resolve(REPO, candidate))) return candidate;
    }
    return null;
}

/**
 * Build the product specs from the price plan + the packages.
 *
 * @param {object} options
 * @param {object} options.pricing       parsed data/social/pricing.json
 * @param {string} options.packagesDir   where the per-item packages live
 * @param {boolean} [options.withBundle] include the catalogue bundle
 * @returns {{products: Array<object>, bundle: object|null, skipped: Array<object>}}
 */
function planFromPricingPlan(options) {
    const pricing = options.pricing;
    const packagesDir = options.packagesDir || PACKAGES_DIR;
    const withBundle = options.withBundle !== false;

    if (!pricing || !Array.isArray(pricing.items)) {
        throw new Error('price plan has no items array');
    }

    const products = [];
    const skipped = [];
    // One slug is one product: Gumroad rejects the second claim with
    // "Custom permalink is already used by another one of your products".
    // Two packages can collide when the copy is derived from the same
    // caption on two days, and then only the first can exist on the
    // storefront — so the later one is reported instead of silently
    // producing a product that cannot be created.
    const slugOwner = new Map();

    for (const item of pricing.items) {
        const slug = item.slug || item.id;
        if (!isValidCustomPermalink(slug)) {
            skipped.push({ id: item.id, reason: `invalid slug "${slug}"` });
            continue;
        }
        const amount = Number(item.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            skipped.push({ id: item.id, reason: `invalid price "${item.amount}"` });
            continue;
        }
        if (slugOwner.has(slug)) {
            skipped.push({ id: item.id, reason: `slug "${slug}" is already planned by ${slugOwner.get(slug)}` });
            continue;
        }
        const pkg = readPackage(packagesDir, item.id);

        // The product's downloadable files: every image variant for a cover
        // study, the single plate for an art plate, the video for a reel.
        const downloadFiles = [];
        if (pkg) {
            if (pkg.kind === 'reel' && pkg.video) {
                downloadFiles.push(pkg.video);
            } else {
                downloadFiles.push(...pkg.images);
            }
        }

        // The cover is the first image that exists; for a reel that is the
        // poster frame the reel watcher wrote next to the video.
        let cover = null;
        if (pkg) {
            const candidates = pkg.kind === 'reel'
                ? [pkg.images[0], coverSiblingOf(pkg.video)]
                : pkg.images;
            cover = candidates.find((p) => p && fs.existsSync(path.resolve(REPO, p))) || null;
        }

        const description = scrubPaths(pkg && pkg.description ? pkg.description : '');

        products.push({
            key: item.id,
            name: item.name || item.id,
            slug,
            priceCents: Math.round(amount * 100),
            currency: 'eur',
            nativeType: 'digital',
            description,
            rationale: item.rationale || '',
            cover,
            files: downloadFiles.filter((p) => fs.existsSync(path.resolve(REPO, p))),
            missingFiles: downloadFiles.filter((p) => !fs.existsSync(path.resolve(REPO, p))),
            publish: !!(pkg && pkg.publish),
        });
        slugOwner.set(slug, item.id);
    }

    let bundle = null;
    if (withBundle && pricing.bundle && pricing.bundle.slug) {
        const amount = Number(pricing.bundle.amount);
        if (isValidCustomPermalink(pricing.bundle.slug) && Number.isFinite(amount) && amount > 0) {
            bundle = {
                key: 'bundle',
                name: pricing.bundle.name || 'The whole catalogue',
                slug: pricing.bundle.slug,
                priceCents: Math.round(amount * 100),
                currency: 'eur',
                nativeType: 'bundle',
                discount: pricing.bundle.discount || 0,
                members: products.map((p) => p.key),
                description: `The whole catalogue — ${products.length} products, ${Math.round(pricing.bundle.discount * 100)}% off.`,
            };
        }
    }

    return { products, bundle, skipped };
}

/**
 * Read the price plan from disk and plan against it.
 */
function planFromDisk(options) {
    const opts = options || {};
    const pricingFile = opts.pricingFile || PRICING_FILE;
    const pricing = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
    return planFromPricingPlan({
        pricing,
        packagesDir: opts.packagesDir || PACKAGES_DIR,
        withBundle: opts.withBundle,
    });
}

// ------------------------------------------------------------ transport layer

/**
 * Read a Netscape cookie jar into a `Cookie:` header value.
 * Only gumroad.com cookies are used.
 */
function cookieHeaderFromFile(cookieFile) {
    const text = fs.readFileSync(cookieFile, 'utf8');
    const entries = parseNetscape(text).filter((e) => /gumroad\.com$/.test(e.domain || ''));
    const seen = new Map();
    for (const e of entries) seen.set(e.name, e.value);
    return [...seen.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
}

/**
 * A tiny in-memory cookie jar.
 *
 * Gumroad rotates `_gumroad_app_session` on every response. If the client
 * keeps sending the ORIGINAL cookie, the session it creates is thrown away
 * — and with it any flash message the server set. That is why a failed
 * product creation came back as a bare 302 to /products/new with no
 * explanation: the explanation was in the new session, which the client
 * never sent back.
 */
class CookieJar {
    constructor(header) {
        this.cookies = new Map();
        if (header) {
            for (const part of header.split(';')) {
                const eq = part.indexOf('=');
                if (eq === -1) continue;
                const name = part.slice(0, eq).trim();
                if (name) this.cookies.set(name, part.slice(eq + 1).trim());
            }
        }
    }

    /** The `Cookie:` header value for the next request. */
    header() {
        return [...this.cookies.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
    }

    /** Absorb the `set-cookie` headers of a response. */
    absorb(setCookieHeaders) {
        for (const raw of setCookieHeaders || []) {
            const first = raw.split(';')[0];
            const eq = first.indexOf('=');
            if (eq === -1) continue;
            const name = first.slice(0, eq).trim();
            const value = first.slice(eq + 1).trim();
            if (!name) continue;
            // An empty value with an expiry in the past is a deletion.
            if (value === '' || /expires=Thu, 01 Jan 1970/i.test(raw)) this.cookies.delete(name);
            else this.cookies.set(name, value);
        }
    }
}

/**
 * Pull the Inertia page props out of a dashboard HTML page.
 */
function propsFromHtml(html) {
    const m = html.match(/data-page="([^"]+)"/);
    if (!m) throw new Error('no Inertia page props in response');
    const decoded = m[1]
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
    return JSON.parse(decoded).props;
}

// The daily ceiling on NEW products, in Gumroad's own words.
const DAILY_LIMIT_RE = /only create (\d+) products? per day/i;

// The symbols the plan's currencies format with, for reading a currency off a
// formatted price (the edit page exposes no currency field).
const CURRENCY_SYMBOLS = { eur: '€', usd: '$', gbp: '£' };

// Said when the daily ceiling is reached and there is no product on the
// storefront safe to duplicate.
const NO_DUPLICATE_SOURCE =
    'Gumroad allows no more new products today and there is no plan product on the storefront to duplicate';

/**
 * Why a create was refused.
 *
 * A refused create answers 303 to /products/new with the reason in that
 * page's flash, not in the response to the create itself. The flash
 * lives in the session the redirect set, so it is read from the redirect
 * TARGET, not from the create response.
 *
 * The reason matters: "you can only create 10 products per day" is a
 * wall that clears tomorrow, while "that slug is taken" is a plan
 * error. Both used to arrive here as the same useless
 * "create did not return a product permalink".
 *
 * @returns {{message: string|null, limit: number|null}} the message, and
 *   the daily ceiling when that is what was hit.
 */
function parseRefusal(html) {
    let props = null;
    try { props = propsFromHtml(html); } catch { /* not an Inertia page */ }
    if (!props) return { message: null, limit: null };

    let message = null;
    const flash = props.flash;
    if (flash && typeof flash === 'string') message = flash;
    else if (flash && flash.message) message = String(flash.message);
    if (!message && props.errors) {
        const base = props.errors['link.base'];
        if (typeof base === 'string') message = base;
        else if (Array.isArray(base) && base.length) message = String(base[0]);
    }
    if (!message) return { message: null, limit: null };

    const m = message.match(DAILY_LIMIT_RE);
    return { message, limit: m ? Number(m[1]) : null };
}

/**
 * Encode a plain object as Rails form parameters.
 *
 * Three shapes, because the dashboard's save endpoint takes all three in one
 * request and Rails parses each differently:
 *
 *   scalar             -> key=value
 *   nested object      -> key[sub]=value          (one level per object)
 *   array of objects   -> key[0][sub]=value       (`files[]`)
 *   array of scalars   -> key[]=value             (`deletion_operations`)
 *
 * `key[0][sub]` and `key[][sub]` both reach Rails as the same array of
 * hashes, but `deleted_ids[files][]` has to be the bracket-array form: the
 * permitted filter declares it as an array of scalars, and an indexed key
 * would arrive as a hash of hashes instead.
 */
function encodeFormBody(fields) {
    const body = new URLSearchParams();
    const walk = (key, value) => {
        if (value === undefined || value === null) return;
        if (Array.isArray(value)) {
            if (!value.length) return;
            const objects = value.some((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
            if (objects) value.forEach((item, i) => walk(`${key}[${i}]`, item));
            else value.forEach((item) => { if (item !== undefined && item !== null) body.append(`${key}[]`, String(item)); });
            return;
        }
        if (typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) walk(`${key}[${k}]`, v);
            return;
        }
        body.set(key, String(value));
    };
    for (const [key, value] of Object.entries(fields || {})) walk(key, value);
    return body;
}

// The duplicator's own status strings (upstream ProductDuplicatorService).
const DUPLICATING = 'product_duplicating';
const DUPLICATED = 'product_duplicated';
const DUPLICATION_FAILED = 'product_duplication_failed';

/**
 * Read one `GET /product_duplicates/<source>` answer.
 *
 * The answer is a Redis record keyed by the SOURCE product with a ten-minute
 * TTL, so duplicating the same source again can answer with the PREVIOUS
 * copy first. A permalink that has already been seen is therefore not an
 * answer: it is the stale mapping, and the poll keeps waiting.
 *
 * @param {object} payload parsed JSON
 * @param {Set<string>} [seen] permalinks this run already accounted for
 * @returns {{state: 'done'|'pending'|'stale'|'failed', permalink?: string,
 *   externalId?: string|null, error?: string}}
 */
function duplicatePollVerdict(payload, seen) {
    if (!payload || typeof payload !== 'object') return { state: 'pending' };
    if (payload.status === DUPLICATION_FAILED) {
        return { state: 'failed', error: payload.error_message || 'duplication failed' };
    }
    if (payload.status !== DUPLICATED || payload.success !== true) return { state: 'pending' };
    const dup = payload.duplicated_product || {};
    const permalink = typeof dup.permalink === 'string' ? dup.permalink : null;
    if (!permalink) return { state: 'pending' };
    if (seen && seen.has && seen.has(permalink)) return { state: 'stale' };
    return { state: 'done', permalink, externalId: dup.id ? String(dup.id) : null };
}

/**
 * Can this product be used as the source of a duplicate?
 *
 * Two conditions, both learned the hard way from the upstream service:
 *
 *   * exactly one alive file — the copy inherits the source's file ROWS
 *     (same S3 URLs), and each one has to be dropped explicitly. One row is
 *     the whole job; five rows is five chances to drop the wrong thing.
 *   * no default offer code — `duplicate_offer_codes` does
 *     `copy.offer_codes = source.offer_codes`, i.e. it SHARES the source's
 *     offer codes with the copy instead of copying them.
 *
 * @param {object} info
 * @param {number} info.fileCount alive product files
 * @param {boolean} info.hasDefaultOfferCode
 */
function isSafeDuplicateSource(info) {
    if (!info) return false;
    return info.fileCount === 1 && info.hasDefaultOfferCode !== true;
}

/**
 * The Gumroad client.
 *
 * @param {object} options
 * @param {string} [options.cookieFile]  session cookie jar
 * @param {Function} [options.fetchImpl] injected fetch (tests)
 */
class GumroadClient {
    constructor(options) {
        const opts = options || {};
        this.cookieFile = opts.cookieFile || DEFAULT_COOKIE_FILE;
        this.fetchImpl = opts.fetchImpl || ((...args) => fetch(...args));
        this.cookie = null;
        this.jar = null;
        this.token = null;
        this._products = null;
    }

    /** Load the cookie jar (once). */
    auth() {
        if (!this.cookie) this.cookie = cookieHeaderFromFile(this.cookieFile);
        if (!this.jar) this.jar = new CookieJar(this.cookie);
        return this.jar.header();
    }

    /** Low-level request helper. */
    async request(url, options) {
        const opts = options || {};
        const headers = {
            Cookie: this.auth(),
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) digital-twin/1.0',
            ...(opts.headers || {}),
        };
        const res = await this.fetchImpl(url, {
            method: opts.method || 'GET',
            headers,
            body: opts.body,
            redirect: 'manual',
        });
        // Gumroad rotates the session cookie on every response; keep it.
        if (res.headers && typeof res.headers.getSetCookie === 'function') {
            this.jar.absorb(res.headers.getSetCookie());
        }
        const text = typeof res.text === 'function' ? await res.text() : '';
        return { status: res.status, headers: res.headers, text, location: res.headers && res.headers.get('location') };
    }

    /** CSRF token from the products page (cached). */
    async csrf() {
        if (this.token) return this.token;
        const res = await this.request(`${GUMROAD_ORIGIN}/products`);
        if (res.status !== 200) throw new Error(`GET /products returned ${res.status} — is the session valid?`);
        this.token = propsFromHtml(res.text).authenticity_token;
        return this.token;
    }

    /**
     * Preflight: who am I, and what is blocked?
     */
    async check() {
        const res = await this.request(`${GUMROAD_ORIGIN}/products`);
        if (res.status !== 200) {
            return { ok: false, status: res.status, reason: 'not signed in (or the account gate bounced us)' };
        }
        const props = propsFromHtml(res.text);
        const seller = props.current_seller || {};
        const loggedIn = props.logged_in_user || {};

        // The account's email state (confirmed vs pending) and its default
        // currency only appear on the settings page.
        let email = loggedIn.email || null;
        let hasUnconfirmedEmail = false;
        let currency = seller.currency_type || null;
        const settings = await this.request(`${GUMROAD_ORIGIN}/settings`);
        if (settings.status === 200) {
            try {
                const s = propsFromHtml(settings.text);
                const su = s.user || {};
                email = su.email || email;
                hasUnconfirmedEmail = su.has_unconfirmed_email === true;
                currency = su.currency_type || currency;
            } catch { /* the products page answer is good enough */ }
        }

        return {
            ok: true,
            sellerId: seller.id || null,
            sellerName: seller.name || null,
            subdomain: seller.subdomain || null,
            storefrontUrl: seller.subdomain ? `https://${seller.subdomain}` : null,
            currency,
            canPublish: seller.can_publish_products === true,
            publishBlockedReason: seller.publish_blocked_reason || null,
            email,
            hasUnconfirmedEmail,
            productCount: await this.listProducts().then((p) => p.length).catch(() => null),
        };
    }

    /**
     * Every product on the storefront.
     *
     * The dashboard's product table is a deferred Inertia prop: the HTML page
     * carries no rows. Asking for the partial component is the only way to
     * read the list without the browser.
     *
     * The table is PAGINATED — 50 rows a page — and the page size is not
     * visible from the outside, so every page is walked. Reading only the
     * first one made `findBySlug` blind past row 50, which is worse than a
     * miss: the sync would decide an existing product does not exist and
     * create a second one.
     */
    async listProducts() {
        // Cached for the run: the sync asks "does this slug exist?" once
        // per planned product, and the answer changes only when this
        // client creates or deletes something.
        if (this._products) return this._products;
        const all = [];
        const seen = new Set();
        // A hard stop so a broken `pages` count cannot loop forever.
        for (let page = 1; page <= 100; page++) {
            const res = await this.request(`${GUMROAD_ORIGIN}/products?products_page=${page}`, {
                headers: {
                    'X-Inertia': 'true',
                    'X-Inertia-Partial-Component': 'Products/Index',
                    'X-Inertia-Partial-Data': 'products_data',
                    'X-Requested-With': 'XMLHttpRequest',
                },
            });
            if (res.status !== 200) throw new Error(`product list returned ${res.status}`);
            const body = JSON.parse(res.text);
            const data = body.props && body.props.products_data;
            if (!data || !Array.isArray(data.products)) throw new Error('product list payload has no products');
            for (const product of data.products) {
                const key = product.permalink || String(product.id);
                if (seen.has(key)) continue;
                seen.add(key);
                all.push(product);
            }
            const pages = Number((data.pagination || {}).pages);
            if (!Number.isFinite(pages) || page >= pages || !data.products.length) break;
        }
        this._products = all;
        return this._products;
    }

    /**
     * The public slug of a product, from its storefront URL.
     */
    static publicSlug(product) {
        const url = product.url || '';
        const m = url.match(/\/l\/([^/?#]+)/);
        return m ? m[1] : (product.permalink || null);
    }

    /** Find an existing product by its public slug. */
    async findBySlug(slug) {
        const products = await this.listProducts();
        return products.find((p) => GumroadClient.publicSlug(p) === slug) || null;
    }

    /**
     * Per-product props (aws key, s3 endpoint, seller id).
     *
     * A bundle's edit page lives at a different URL, and the product route
     * redirects there, so the redirect is followed.
     */
    async editProps(permalink) {
        let res = await this.request(`${GUMROAD_ORIGIN}/products/${permalink}/edit`);
        if (res.status === 302 || res.status === 301) {
            const location = res.location;
            if (!location) throw new Error(`GET /products/${permalink}/edit redirected without a location`);
            res = await this.request(location);
        }
        if (res.status !== 200) throw new Error(`GET /products/${permalink}/edit returned ${res.status}`);
        return propsFromHtml(res.text);
    }

    /**
     * The product's external id (the opaque `id` the edit page carries).
     * Bundle membership is addressed by external id, not by permalink.
     */
    async externalId(permalink) {
        const props = await this.editProps(permalink);
        return props.id || null;
    }

    /**
     * Put products inside a bundle.
     *
     * The bundle's members are addressed by external id and the parameter
     * has to be an ARRAY (`products[][product_id]`). A hash-shaped
     * parameter (`products[0][product_id]`) reaches the controller and
     * then explodes inside the service with a 500.
     */
    async attachBundleMembers(bundlePermalink, memberExternalIds) {
        if (!memberExternalIds.length) return { status: 200, attached: 0 };
        const bundleProps = await this.editProps(bundlePermalink);
        const bundleExternalId = bundleProps.id;
        if (!bundleExternalId) throw new Error(`bundle ${bundlePermalink} has no external id`);
        const token = await this.csrf();
        const body = new URLSearchParams({ authenticity_token: token });
        memberExternalIds.forEach((id, i) => {
            body.append('products[][product_id]', id);
            body.append('products[][quantity]', '1');
            body.append('products[][position]', String(i));
        });
        const res = await this.request(`${GUMROAD_ORIGIN}/bundles/${bundleExternalId}/content`, {
            method: 'PATCH',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRF-Token': token,
                Referer: `${GUMROAD_ORIGIN}/bundles/${bundleExternalId}/content/edit`,
            },
            body: body.toString(),
        });
        if (res.status !== 303 && res.status !== 302 && res.status !== 200) {
            throw new Error(`bundle content update returned ${res.status}: ${res.text.slice(0, 200)}`);
        }
        return { status: res.status, attached: memberExternalIds.length };
    }

    /**
     * The reason a create was refused.
     *
     * The flash is in the session the refusal's redirect set, so this
     * reads the redirect target with the same (rotated) cookie jar.
     */
    async readRefusal(location) {
        const res = await this.request(location);
        return parseRefusal(res.text);
    }

    /**
     * Create a product. Returns {permalink, url, location}.
     *
     * The create route nests its params under `link[...]` and answers 303
     * with the new permalink in the Location header only.
     *
     * A REFUSED create answers 303 to /products/new instead, and the
     * reason is in that page's flash. The thrown error carries it, and
     * `dailyCreateLimit` is set when the wall is Gumroad's daily
     * product-creation ceiling.
     */
    async createProduct(spec) {
        const token = await this.csrf();
        const body = new URLSearchParams();
        body.set('authenticity_token', token);
        body.set('link[name]', spec.name);
        body.set('link[price_cents]', String(spec.priceCents));
        body.set('link[price_currency_type]', spec.currency || 'eur');
        body.set('link[native_type]', spec.nativeType || 'digital');
        body.set('link[custom_permalink]', spec.slug);
        const res = await this.request(`${GUMROAD_ORIGIN}/links`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRF-Token': token,
                Referer: `${GUMROAD_ORIGIN}/products`,
            },
            body: body.toString(),
        });
        const location = res.location || '';
        if (res.status !== 303 && res.status !== 302) {
            throw new Error(`create returned ${res.status}: ${res.text.slice(0, 300)}`);
        }
        const m = location.match(/\/products\/([^/?#]+)\/edit/);
        if (!m) {
            // Refused. Read WHY, from the page the refusal redirected to.
            const refusal = await this.readRefusal(location || `${GUMROAD_ORIGIN}/products/new`);
            const err = new Error(refusal.message
                ? `create refused: ${refusal.message}`
                : `create did not return a product permalink (Location: ${location})`);
            err.dailyCreateLimit = refusal.limit;
            err.location = location;
            throw err;
        }
        const permalink = m[1];
        this._products = null; // the storefront changed
        return { permalink, location, url: `${SELLER_HOST}/l/${spec.slug}` };
    }

    /**
     * Update a product. Params are TOP-LEVEL (not nested under `link[...]`).
     *
     * `editor_revision` + `deletion_operations` are the destructive half of
     * the editor's save contract: an omitted collection is "no statement",
     * so removing an inherited file row requires naming it in
     * `deletion_operations[deleted_ids][files][]` together with a revision
     * token read from that same product's edit page.
     */
    async updateProduct(permalink, fields) {
        const token = await this.csrf();
        const body = encodeFormBody({ authenticity_token: token, ...fields });
        const res = await this.request(`${GUMROAD_ORIGIN}/links/${permalink}`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRF-Token': token,
                Referer: `${GUMROAD_ORIGIN}/products/${permalink}/edit`,
            },
            body: body.toString(),
        });
        if (res.status !== 200) {
            throw new Error(`update returned ${res.status}: ${res.text.slice(0, 300)}`);
        }
        return res;
    }

    /**
     * Duplicate an existing product. Returns the copy's permalink.
     *
     * The controller enqueues `DuplicateProductWorker` and answers
     * `{success:true}` immediately; the copy appears asynchronously, so the
     * same route is then polled. The copy is a DRAFT with a new
     * `unique_permalink`, no `custom_permalink`, the source's price and
     * name ("<source> (copy)"), and the source's file rows.
     *
     * @param {string} sourcePermalink the source's unique_permalink
     * @param {object} [options]
     * @param {Set<string>} [options.seen] permalinks already accounted for
     * @param {number} [options.pollIntervalMs]
     * @param {number} [options.timeoutMs]
     */
    async duplicateProduct(sourcePermalink, options) {
        const opts = options || {};
        const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : 2000;
        const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 180000;
        const deadline = Date.now() + timeoutMs;

        const post = async () => {
            const token = await this.csrf();
            const body = encodeFormBody({ authenticity_token: token, link_id: sourcePermalink });
            const res = await this.request(`${GUMROAD_ORIGIN}/product_duplicates`, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-CSRF-Token': token,
                    'X-Requested-With': 'XMLHttpRequest',
                    Referer: `${GUMROAD_ORIGIN}/products`,
                },
                body: body.toString(),
            });
            if (res.status !== 200) {
                throw new Error(`duplicate of ${sourcePermalink} returned ${res.status}: ${res.text.slice(0, 200)}`);
            }
            let json = {};
            try { json = JSON.parse(res.text); } catch { /* non-JSON body */ }
            if (json.success !== true) {
                const message = json.error_message || json.error || `duplicate of ${sourcePermalink} was refused`;
                const busy = /duplication in progress/i.test(String(message));
                const err = new Error(String(message));
                err.duplicationBusy = busy;
                throw err;
            }
        };

        let started = false;
        while (Date.now() < deadline) {
            if (!started) {
                try {
                    await post();
                    started = true;
                } catch (e) {
                    if (!e.duplicationBusy) throw e;
                    await new Promise((r) => setTimeout(r, pollIntervalMs));
                    continue;
                }
            }
            const res = await this.request(`${GUMROAD_ORIGIN}/product_duplicates/${sourcePermalink}`, {
                headers: {
                    Accept: 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    Referer: `${GUMROAD_ORIGIN}/products`,
                },
            });
            let payload = null;
            if (res.status === 200) {
                try { payload = JSON.parse(res.text); } catch { payload = null; }
            }
            const verdict = duplicatePollVerdict(payload, opts.seen);
            if (verdict.state === 'done') {
                this._products = null; // the storefront changed
                return verdict;
            }
            if (verdict.state === 'failed') {
                throw new Error(`duplicate of ${sourcePermalink} failed: ${verdict.error}`);
            }
            await new Promise((r) => setTimeout(r, pollIntervalMs));
        }
        throw new Error(`duplicate of ${sourcePermalink} timed out after ${timeoutMs}ms`);
    }

    /**
     * Convert an existing product into a bundle and set its copy.
     *
     * The bundle route takes the product's EXTERNAL id and is the only route
     * that understands bundle pricing (it kinds the currency before the
     * amount internally). It sets `is_bundle` + `native_type` on the same
     * Link row, so no product is created here.
     */
    async updateBundleProduct(bundleExternalId, fields) {
        const token = await this.csrf();
        const body = encodeFormBody({ authenticity_token: token, ...fields });
        const res = await this.request(
            `${GUMROAD_ORIGIN}/bundles/${encodeURIComponent(bundleExternalId)}/product`,
            {
                method: 'PUT',
                headers: {
                    Accept: 'text/html',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-CSRF-Token': token,
                    Referer: `${GUMROAD_ORIGIN}/bundles/${encodeURIComponent(bundleExternalId)}/product/edit`,
                },
                body: body.toString(),
            }
        );
        if (res.status !== 303 && res.status !== 302) {
            throw new Error(`bundle product update returned ${res.status}: ${res.text.slice(0, 300)}`);
        }
        return { status: res.status, location: res.location };
    }


    /** Publish a product. Returns {success, error}. */
    async publish(permalink) {
        const token = await this.csrf();
        const body = new URLSearchParams({ authenticity_token: token });
        const res = await this.request(`${GUMROAD_ORIGIN}/links/${permalink}/publish`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRF-Token': token,
                Referer: `${GUMROAD_ORIGIN}/products/${permalink}/edit`,
            },
            body: body.toString(),
        });
        let json = {};
        try { json = JSON.parse(res.text); } catch { /* non-JSON error page */ }
        return { status: res.status, success: json.success === true, error: json.error_message || json.error || null };
    }

    /** Delete a product (soft delete upstream). */
    async destroy(permalink) {
        const token = await this.csrf();
        const body = new URLSearchParams({ authenticity_token: token });
        const res = await this.request(`${GUMROAD_ORIGIN}/links/${permalink}`, {
            method: 'DELETE',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRF-Token': token,
                Referer: `${GUMROAD_ORIGIN}/products`,
            },
            body: body.toString(),
        });
        let json = {};
        try { json = JSON.parse(res.text); } catch { /* non-JSON error page */ }
        this._products = null; // the storefront changed
        return { status: res.status, success: json.success === true };
    }

    // ---- covers (ActiveStorage direct upload) ----

    /**
     * Upload a cover image and attach it as the product's thumbnail.
     *
     * Gumroad's thumbnail validator wants a SQUARE image of at least 600px,
     * so the cover is prepared first (see lib/gumroad-cover.js).
     *
     * @returns {string|null} the public thumbnail URL
     */
    async uploadCover(permalink, filePath) {
        const prepared = squareCover(filePath);
        if (!prepared) throw new Error(`no square cover could be prepared from ${filePath}`);
        const data = fs.readFileSync(prepared.path);
        const token = await this.csrf();
        const blob = await this.createBlob(path.basename(prepared.path), data, MIME_BY_EXT[path.extname(prepared.path).toLowerCase()] || 'application/octet-stream');
        const body = new URLSearchParams({ authenticity_token: token });
        body.set('thumbnail[signed_blob_id]', blob.signed_id);
        const res = await this.request(`${GUMROAD_ORIGIN}/links/${permalink}/thumbnails`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRF-Token': token,
                Referer: `${GUMROAD_ORIGIN}/products/${permalink}/edit`,
            },
            body: body.toString(),
        });
        if (res.status !== 200) throw new Error(`thumbnail attach returned ${res.status}: ${res.text.slice(0, 200)}`);
        const json = JSON.parse(res.text);
        if (json.success === false) throw new Error(`thumbnail rejected: ${json.error || 'unknown error'}`);
        return json.thumbnail ? json.thumbnail.url : null;
    }

    /** Create an ActiveStorage blob and push the bytes to the presigned URL. */
    async createBlob(filename, data, contentType) {
        const token = await this.csrf();
        const checksum = crypto.createHash('md5').update(data).digest('base64');
        const res = await this.request(`${GUMROAD_ORIGIN}/rails/active_storage/direct_uploads`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
                Referer: `${GUMROAD_ORIGIN}/products`,
            },
            body: JSON.stringify({
                blob: { filename, byte_size: data.length, checksum, content_type: contentType },
            }),
        });
        if (res.status !== 200) throw new Error(`direct upload returned ${res.status}: ${res.text.slice(0, 200)}`);
        const json = JSON.parse(res.text);
        const up = json.direct_upload;
        const headers = { ...up.headers, 'Content-Length': String(data.length) };
        const put = await this.fetchImpl(up.url, { method: 'PUT', headers, body: data });
        if (put.status !== 200) throw new Error(`blob PUT returned ${put.status}`);
        return json;
    }

    // ---- product files (S3 multipart, Evaporate-compatible) ----

    /** Gumroad's server-side signer: base64(HMAC-SHA1(secret, to_sign)). */
    async sign(toSign) {
        const res = await this.request(
            `${GUMROAD_ORIGIN}/s3_utility/generate_multipart_signature?to_sign=${encodeURIComponent(toSign)}`
        );
        if (res.status !== 200) throw new Error(`signer returned ${res.status}`);
        return res.text.trim();
    }

    /** The server's clock, in the HTTP-date format S3 signatures use. */
    async serverDate() {
        const res = await this.request(`${GUMROAD_ORIGIN}/s3_utility/current_utc_time_string`);
        if (res.status !== 200) throw new Error(`server time returned ${res.status}`);
        return res.text.trim();
    }

    /**
     * The exact string Evaporate signs. Getting this wrong fails at S3 with
     * an opaque 403, so it lives in one tested function.
     */
    static stringToSign(method, mimeType, xAmzHeaders, requestPath, step) {
        const keys = Object.keys(xAmzHeaders).sort();
        const headerLines = keys.map((k) => `${k}:${xAmzHeaders[k]}\n`).join('');
        const contentType = step === 'complete' ? mimeType : `${mimeType}; charset=UTF-8`;
        return `${method}\n\n${contentType || ''}\n\n${headerLines}${requestPath}`;
    }

    /**
     * Upload a file to Gumroad's S3 bucket and return its public URL.
     *
     * The upload is the dashboard's own Evaporate flow: initiate a multipart
     * upload, PUT the parts, complete it. Signing is AWS Signature V2 (the
     * `Authorization: AWS <key>:<sig>` header), computed server-side by
     * Gumroad's signer endpoint.
     */
    async uploadProductFile(permalink, filePath) {
        const props = await this.editProps(permalink);
        const awsKey = props.aws_key;
        const s3Url = props.s3_url;
        const sellerId = props.current_seller_external_id;
        if (!awsKey || !s3Url || !sellerId) {
            throw new Error(`edit page for ${permalink} is missing the upload props (aws_key/s3_url/seller id)`);
        }
        const bucket = s3Url.split('/').pop();
        const endpoint = s3Url.slice(0, s3Url.lastIndexOf('/'));

        const abs = path.resolve(REPO, filePath);
        const data = fs.readFileSync(abs);
        const filename = path.basename(abs);
        const mimeType = MIME_BY_EXT[path.extname(filename).toLowerCase()] || 'application/octet-stream';
        const guid = crypto.randomUUID().replace(/-/g, '');
        const key = `attachments/${sellerId}/${guid}/original/${filename}`;
        const keyPath = `/${bucket}/${key}`;

        const date = await this.serverDate();
        const authHeaders = { 'x-amz-date': date };

        // 1. initiate
        const initiatePath = `${keyPath}?uploads`;
        const initiateSig = await this.sign(
            GumroadClient.stringToSign('POST', mimeType, { ...authHeaders, 'x-amz-acl': 'private' }, initiatePath, 'initiate')
        );
        const initiate = await this.fetchImpl(endpoint + initiatePath, {
            method: 'POST',
            headers: {
                Authorization: `AWS ${awsKey}:${initiateSig}`,
                'Content-Type': `${mimeType}; charset=UTF-8`,
                'x-amz-acl': 'private',
                'x-amz-date': date,
            },
            body: '',
        });
        if (initiate.status !== 200) throw new Error(`multipart initiate returned ${initiate.status}`);
        const initiateText = await initiate.text();
        const uploadId = (initiateText.match(/<UploadId>(.+)<\/UploadId>/) || [])[1];
        if (!uploadId) throw new Error(`multipart initiate returned no UploadId: ${initiateText.slice(0, 200)}`);

        // 2. parts
        const parts = [];
        const partCount = Math.max(1, Math.ceil(data.length / PART_SIZE));
        for (let n = 1; n <= partCount; n++) {
            const chunk = data.slice((n - 1) * PART_SIZE, n * PART_SIZE);
            const partPath = `${keyPath}?partNumber=${n}&uploadId=${uploadId}`;
            const sig = await this.sign(
                GumroadClient.stringToSign('PUT', mimeType, authHeaders, partPath, `upload #${n}`)
            );
            const put = await this.fetchImpl(endpoint + partPath, {
                method: 'PUT',
                headers: {
                    Authorization: `AWS ${awsKey}:${sig}`,
                    'Content-Type': `${mimeType}; charset=UTF-8`,
                    'x-amz-date': date,
                    'Content-Length': String(chunk.length),
                },
                body: chunk,
            });
            if (put.status !== 200) throw new Error(`part ${n} upload returned ${put.status}`);
            const etag = put.headers.get('etag');
            if (!etag) throw new Error(`part ${n} upload returned no ETag`);
            parts.push({ partNumber: n, etag });
        }

        // 3. complete
        const xml = '<CompleteMultipartUpload>' +
            parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('') +
            '</CompleteMultipartUpload>';
        const completePath = `${keyPath}?uploadId=${uploadId}`;
        const completeSig = await this.sign(
            GumroadClient.stringToSign('POST', 'application/xml; charset=UTF-8', authHeaders, completePath, 'complete')
        );
        const complete = await this.fetchImpl(endpoint + completePath, {
            method: 'POST',
            headers: {
                Authorization: `AWS ${awsKey}:${completeSig}`,
                'Content-Type': 'application/xml; charset=UTF-8',
                'x-amz-date': date,
                'Content-Length': String(Buffer.byteLength(xml)),
            },
            body: xml,
        });
        if (complete.status !== 200) {
            const t = await complete.text();
            throw new Error(`multipart complete returned ${complete.status}: ${t.slice(0, 300)}`);
        }
        return `${s3Url}/${key}`;
    }

    /**
     * Attach already-uploaded product files to a product.
     * `files` is a list of {url, display_name, extension, size, position}.
     */
    async attachFiles(permalink, files) {
        if (!files.length) return;
        await this.updateProduct(permalink, { files });
    }
}

/**
 * Turn one plan product into the file descriptors Gumroad wants.
 */
function fileDescriptors(files) {
    return files.map((f, i) => {
        const d = {
            url: f.url,
            display_name: f.displayName,
            extension: f.extension,
            size: f.size,
            position: i,
        };
        if (f.id) d.id = f.id;
        return d;
    });
}

/**
 * Rename/reprice/reslug a freshly duplicated product, and drop the file rows
 * it inherited from its source.
 *
 * A duplicate's own `product_file` rows are a DIFFERENT set of rows pointing
 * at the SAME S3 objects as the source's. Leaving them attached means the
 * copy serves the source's file — not a cosmetic problem, a wrong download.
 *
 * Dropping them needs both halves of the editor's save contract, because an
 * omitted collection is "no statement", not "delete":
 *
 *   * `deletion_operations[deleted_ids][files][]` names each inherited row by
 *     its external id, and
 *   * `editor_revision` proves the caller saw the product's current file set.
 *     It is per-product, so it is read from THIS copy immediately before the
 *     save.
 *
 * @returns {Promise<{props: object, inheritedFiles: number, deletedFiles: number}>}
 */
async function adoptDuplicate(client, permalink, fields) {
    const props = await client.editProps(permalink);
    const productProps = props.product || {};
    const inherited = Array.isArray(productProps.files) ? productProps.files : [];
    const revision = productProps.editor_revision || null;

    const payload = {};
    for (const [k, v] of Object.entries(fields || {})) {
        if (v !== undefined && v !== null) payload[k] = v;
    }
    // A blank description is dropped server-side unless it is flagged as a
    // deliberate clear, and then the INHERITED description survives.
    if (payload.description === '' && !payload.description_changed) payload.description_changed = '1';

    if (!inherited.length) {
        await client.updateProduct(permalink, payload);
        return { props, inheritedFiles: 0, deletedFiles: 0 };
    }
    if (!revision) {
        throw new Error(`${permalink}: edit props carry no editor_revision, so the inherited file row(s) cannot be dropped`);
    }
    payload.editor_revision = revision;
    payload.deletion_operations = { deleted_ids: { files: inherited.map((f) => f.id) } };
    await client.updateProduct(permalink, payload);

    // A deletion that silently did not apply is the failure mode that ships a
    // copy serving the source's file, so it is read back rather than assumed.
    const after = await client.editProps(permalink);
    const left = (after.product && Array.isArray(after.product.files)) ? after.product.files : [];
    if (left.length) {
        throw new Error(`${permalink}: ${left.length} inherited file row(s) survived the deletion save`);
    }
    return { props, inheritedFiles: inherited.length, deletedFiles: inherited.length };
}

/**
 * Create one planned product by duplicating an existing one, then make the
 * copy into THAT product: its own name, price, slug, bytes and cover.
 *
 * The duplicate route is how the run gets past Gumroad's daily creation
 * ceiling, since the copy is saved with `validate: false` upstream.
 *
 * @param {GumroadClient} client
 * @param {object} product the plan entry
 * @param {object} options
 * @param {string} options.source permalink of the product to duplicate
 * @param {Set<string>} [options.seen] permalinks already accounted for
 */
async function syncProductViaDuplicate(client, product, options) {
    const opts = options || {};
    const result = {
        key: product.key,
        slug: product.slug,
        name: product.name,
        priceCents: product.priceCents,
        action: 'duplicate',
        permalink: null,
        url: null,
        cover: null,
        files: [],
        deletedFiles: 0,
        errors: [],
    };

    const dup = await client.duplicateProduct(opts.source, {
        seen: opts.seen,
        pollIntervalMs: opts.pollIntervalMs,
        timeoutMs: opts.timeoutMs,
    });
    if (opts.seen && typeof opts.seen.add === 'function') opts.seen.add(dup.permalink);
    result.permalink = dup.permalink;

    const adopted = await adoptDuplicate(client, dup.permalink, {
        name: product.name,
        description: product.description,
        // The currency lands before the amount: the copy inherits the
        // source's price rows, and price_cents files under whichever
        // currency the product reads at that instant.
        price_currency_type: product.currency,
        price_cents: product.priceCents,
        custom_permalink: product.slug,
    });
    result.deletedFiles = adopted.deletedFiles;

    // The copy is independent of the source now, so its own bytes go on.
    const descriptors = [];
    for (const rel of product.files) {
        const abs = path.resolve(REPO, rel);
        const displayName = path.basename(abs);
        try {
            const url = await client.uploadProductFile(dup.permalink, rel);
            descriptors.push({ url, displayName, extension: extOf(abs), size: fs.statSync(abs).size });
            result.files.push(rel);
        } catch (e) {
            result.errors.push(`file ${rel}: ${e.message}`);
        }
    }
    if (descriptors.length) {
        try {
            // `attachFiles` posts the descriptors as-is, so they go through the
            // same shaping the create path uses. Handing it `displayName`
            // instead of `display_name` is silently ignored by the save route:
            // the row keeps no display name and the buyer sees an extension-less
            // file, which is exactly the bug this shaper prevents.
            await client.attachFiles(dup.permalink, fileDescriptors(descriptors));
        } catch (e) {
            result.errors.push(`attach files: ${e.message}`);
        }
    }

    if (product.cover) {
        try {
            result.cover = await client.uploadCover(dup.permalink, product.cover);
        } catch (e) {
            result.errors.push(`cover ${product.cover}: ${e.message}`);
        }
    }

    result.url = `${SELLER_HOST}/l/${product.slug}`;
    return result;
}

/**
 * Pick a product to duplicate.
 *
 * Never one of the user's own products: the candidates are the storefront
 * products whose PUBLIC slug is one of the plan's slugs (i.e. the ones this
 * module created), and only those that are safe to duplicate — one file, no
 * default offer code (see `isSafeDuplicateSource`).
 *
 * @returns {Promise<{permalink: string, slug: string, externalId: string|null}|null>}
 */
async function resolveDuplicateSource(client, plan) {
    const planSlugs = new Set(plan.products.map((p) => p.slug));
    for (const listed of await client.listProducts()) {
        const slug = GumroadClient.publicSlug(listed);
        if (!slug || !planSlugs.has(slug) || !listed.permalink) continue;
        let props;
        try {
            props = await client.editProps(listed.permalink);
        } catch {
            continue;
        }
        const p = props.product || {};
        const files = Array.isArray(p.files) ? p.files : [];
        if (!isSafeDuplicateSource({ fileCount: files.length, hasDefaultOfferCode: !!p.default_offer_code })) continue;
        return { permalink: listed.permalink, slug, externalId: props.id || null };
    }
    return null;
}

/**
 * Create the catalogue bundle by duplicating a product and CONVERTING the
 * copy — no second Link row, so no second creation check, and the
 * duplicated product itself survives.
 *
 * The copy's inherited file row is dropped first: a bundle carries its
 * members' files, and the bundle route does not accept files at all.
 */
async function syncBundleViaDuplicate(client, bundle, options) {
    const opts = options || {};
    const dup = await client.duplicateProduct(opts.source, {
        seen: opts.seen,
        pollIntervalMs: opts.pollIntervalMs,
        timeoutMs: opts.timeoutMs,
    });
    if (opts.seen && typeof opts.seen.add === 'function') opts.seen.add(dup.permalink);

    const adopted = await adoptDuplicate(client, dup.permalink, {
        name: bundle.name,
        description: bundle.description,
    });
    const externalId = adopted.props.id || null;
    if (!externalId) throw new Error(`bundle copy ${dup.permalink} has no external id`);

    await client.updateBundleProduct(externalId, {
        name: bundle.name,
        description: bundle.description,
        custom_permalink: bundle.slug,
        // The bundle controller kinds the currency before the amount itself,
        // so both are always sent together.
        price_currency_type: bundle.currency,
        price_cents: bundle.priceCents,
    });

    return { permalink: dup.permalink, externalId, deletedFiles: adopted.deletedFiles, url: `${SELLER_HOST}/l/${bundle.slug}` };
}

/**
 * What the buyer sees as a file's name.
 *
 * Gumroad keeps `display_name` without the extension and the extension in its
 * own column (`extension: "JPG"`), so the two have to be joined back together
 * before either can be compared with a filename on disk.
 */
function productFileName(file) {
    const f = file || {};
    const base = String(f.file_name || f.display_name || f.name || '');
    const ext = String(f.extension || '').toLowerCase();
    if (!base) return '';
    if (!ext) return base;
    return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

/**
 * Compare a plan entry against what the storefront actually holds.
 *
 * Pure: `actual.files` is [{name, size}], `expected.files` the same shape,
 * so the caller does the stat() calls. Returns a list of human-readable
 * problems — empty means the product is what the plan asked for.
 */
function compareProduct(expected, actual) {
    if (!actual) return ['not on the storefront'];
    const problems = [];
    if ((actual.name || '') !== (expected.name || '')) {
        problems.push(`name ${JSON.stringify(actual.name || '')} != ${JSON.stringify(expected.name || '')}`);
    }
    if (Number(actual.priceCents) !== Number(expected.priceCents)) {
        problems.push(`price ${actual.priceCents} != ${expected.priceCents}`);
    }
    // The edit page does not expose the currency at all, so it is read off the
    // formatted price when the caller supplies one.
    const wantCurrency = String(expected.currency || '').toLowerCase();
    if (actual.currency) {
        if (String(actual.currency).toLowerCase() !== wantCurrency) {
            problems.push(`currency ${actual.currency} != ${expected.currency}`);
        }
    } else if (actual.priceFormatted && CURRENCY_SYMBOLS[wantCurrency]) {
        if (!actual.priceFormatted.includes(CURRENCY_SYMBOLS[wantCurrency])) {
            problems.push(`price ${JSON.stringify(actual.priceFormatted)} is not in ${expected.currency}`);
        }
    } else {
        problems.push('currency not reported');
    }
    if (expected.slug && (actual.slug || '') !== expected.slug) {
        problems.push(`public slug ${JSON.stringify(actual.slug || '')} != ${JSON.stringify(expected.slug)}`);
    }
    const want = (expected.files || []).map((f) => ({ name: f.name, size: f.size }));
    const got = (actual.files || []).map((f) => ({ name: productFileName(f), size: Number(f.size) }));
    for (const w of want) {
        const match = got.find((g) => g.name === w.name);
        if (!match) problems.push(`missing file ${w.name}`);
        else if (w.size !== undefined && match.size !== Number(w.size)) {
            problems.push(`file ${w.name} is ${match.size} bytes, expected ${w.size}`);
        }
    }
    for (const g of got) {
        if (!want.some((w) => w.name === g.name)) problems.push(`unexpected file ${g.name}`);
    }
    if (expected.cover && !actual.hasThumbnail) problems.push('no cover attached');
    return problems;
}

/**
 * Compare the bundle against the plan.
 *
 * The bundle's edit page is a different props shape: `bundle` (its own copy
 * and price) plus top-level `is_bundle` / `currency_type`, and the members as
 * `bundle.products`. Pure, like `compareProduct`.
 */
function compareBundle(expected, actual) {
    if (!actual) return ['not on the storefront'];
    const problems = [];
    if ((actual.name || '') !== (expected.name || '')) {
        problems.push(`name ${JSON.stringify(actual.name || '')} != ${JSON.stringify(expected.name || '')}`);
    }
    if (Number(actual.priceCents) !== Number(expected.priceCents)) {
        problems.push(`price ${actual.priceCents} != ${expected.priceCents}`);
    }
    if (expected.currency && actual.currency && String(actual.currency).toLowerCase() !== String(expected.currency).toLowerCase()) {
        problems.push(`currency ${actual.currency} != ${expected.currency}`);
    }
    if (expected.slug && (actual.slug || '') !== expected.slug) {
        problems.push(`public slug ${JSON.stringify(actual.slug || '')} != ${JSON.stringify(expected.slug)}`);
    }
    if (actual.isBundle !== true) problems.push('not converted to a bundle');
    if (Number(actual.members) !== Number(expected.members)) {
        problems.push(`${actual.members} member(s) != ${expected.members}`);
    }
    if (!actual.hasThumbnail) problems.push('no cover attached');
    return problems;
}

/**
 * Read one product back off the storefront and compare it to the plan.
 *
 * @returns {Promise<{slug: string, permalink: string|null, problems: string[]}>}
 */
async function verifyProduct(client, product) {
    const listed = await client.findBySlug(product.slug);
    if (!listed || !listed.permalink) return { slug: product.slug, permalink: null, problems: ['not on the storefront'] };
    const props = await client.editProps(listed.permalink);
    const p = props.product || {};
    const expectedFiles = product.files.map((rel) => ({
        name: path.basename(rel),
        size: fs.existsSync(path.resolve(REPO, rel)) ? fs.statSync(path.resolve(REPO, rel)).size : undefined,
    }));
    const actual = {
        name: p.name,
        priceCents: Number(p.price_cents),
        currency: p.currency_type || p.price_currency_type,
        priceFormatted: listed.price_formatted,
        slug: p.custom_permalink,
        files: (Array.isArray(p.files) ? p.files : []).map((f) => ({ ...f, size: f.file_size ?? f.size })),
        hasThumbnail: !!props.thumbnail,
    };
    return { slug: product.slug, permalink: listed.permalink, problems: compareProduct({ ...product, files: expectedFiles }, actual) };
}

/**
 * Read the bundle back off the storefront and compare it to the plan.
 */
async function verifyBundle(client, bundle) {
    const listed = await client.findBySlug(bundle.slug);
    if (!listed || !listed.permalink) return { slug: bundle.slug, permalink: null, problems: ['not on the storefront'] };
    const props = await client.editProps(listed.permalink);
    const b = props.bundle || {};
    const actual = {
        name: b.name,
        priceCents: Number(b.price_cents),
        currency: props.currency_type,
        slug: b.custom_permalink,
        isBundle: props.is_bundle === true,
        members: Array.isArray(b.products) ? b.products.length : 0,
        hasThumbnail: !!props.thumbnail,
    };
    return {
        slug: bundle.slug,
        permalink: listed.permalink,
        problems: compareBundle({ ...bundle, members: bundle.members.length }, actual),
    };
}

/**
 * The whole flow for one planned product: create or update, attach the
 * files, attach the cover.
 *
 * Re-running is safe: a file whose name and size already sit on the product
 * is reused instead of uploaded again, and the existing file ids are sent
 * back so Gumroad edits them in place rather than adding a second copy.
 *
 * @param {GumroadClient} client
 * @param {object} product the plan entry
 * @param {object} options
 * @param {boolean} [options.dryRun] plan only, touch nothing
 */
async function syncProduct(client, product, options) {
    const opts = options || {};
    const result = {
        key: product.key,
        slug: product.slug,
        name: product.name,
        priceCents: product.priceCents,
        action: null,
        permalink: null,
        url: null,
        cover: null,
        files: [],
        reused: [],
        errors: [],
    };

    const existing = await client.findBySlug(product.slug);
    if (existing) {
        result.action = 'update';
        result.permalink = existing.permalink;
        result.url = existing.url;
    } else {
        if (opts.dryRun) {
            result.action = 'create';
            result.url = `https://kaidjuric.gumroad.com/l/${product.slug}`;
            return result;
        }
        const created = await client.createProduct(product);
        result.action = 'create';
        result.permalink = created.permalink;
        result.url = created.url;
    }

    // What is already attached?
    //
    // THIS product's rows, never the seller-wide file library: the same file
    // name occurs on many products ("frame-01.jpg" on every daily plate), so
    // matching against the library would hand back another product's row —
    // and a shared file the product should not be selling.
    let existingFiles = [];
    let hasThumbnail = false;
    try {
        const edit = await client.editProps(result.permalink);
        existingFiles = (edit.product && Array.isArray(edit.product.files)) ? edit.product.files : [];
        hasThumbnail = !!edit.thumbnail;
    } catch (e) {
        result.errors.push(`read existing files: ${e.message}`);
    }
    const byName = new Map(existingFiles.map((f) => [productFileName(f), f]));

    // Upload the downloadable files first: the product file URLs must exist
    // before the product references them.
    const descriptors = [];
    for (const rel of product.files) {
        const abs = path.resolve(REPO, rel);
        const displayName = path.basename(abs);
        const size = fs.statSync(abs).size;
        const known = byName.get(displayName);
        if (known && Number(known.file_size ?? known.size) === size) {
            descriptors.push({
                id: known.id,
                url: known.url,
                displayName,
                extension: extOf(abs),
                size,
            });
            result.reused.push(displayName);
            continue;
        }
        if (opts.dryRun) { result.files.push(rel); continue; }
        try {
            const url = await client.uploadProductFile(result.permalink, rel);
            descriptors.push({ url, displayName, extension: extOf(abs), size });
            result.files.push(rel);
        } catch (e) {
            result.errors.push(`file ${rel}: ${e.message}`);
        }
    }

    if (opts.dryRun) return result;

    // The cover is a thumbnail, not a product file. Re-uploading one that is
    // already there buys nothing.
    if (product.cover && !hasThumbnail) {
        try {
            result.cover = await client.uploadCover(result.permalink, product.cover);
        } catch (e) {
            result.errors.push(`cover ${product.cover}: ${e.message}`);
        }
    }

    const fields = {
        name: product.name,
        description: product.description,
        price_cents: product.priceCents,
        price_currency_type: product.currency,
    };
    if (descriptors.length) fields.files = fileDescriptors(descriptors);

    try {
        await client.updateProduct(result.permalink, fields);
    } catch (e) {
        result.errors.push(`update: ${e.message}`);
    }

    return result;
}

/**
 * Sync the catalogue bundle: the bundle product itself, then the members.
 *
 * The bundle is a real Gumroad product with `is_bundle = true`. Its copy and
 * price are set through the BUNDLE route (the only one that kinds the
 * currency before the amount), and its members through a route that takes
 * external ids.
 *
 * When a bundle has to be created, it is created by duplicating a product
 * and converting the copy — that is the only way past the daily creation
 * ceiling, and it leaves the duplicated product itself intact.
 */
async function syncBundle(client, bundle, memberResults, options) {
    const opts = options || {};
    const result = {
        key: 'bundle',
        slug: bundle.slug,
        name: bundle.name,
        priceCents: bundle.priceCents,
        action: null,
        permalink: null,
        url: null,
        members: 0,
        errors: [],
    };

    let bundleExternalId = null;
    const existing = await client.findBySlug(bundle.slug);
    if (existing) {
        result.action = 'update';
        result.permalink = existing.permalink;
        result.url = existing.url;
    } else {
        if (opts.dryRun) {
            result.action = opts.viaDuplicate ? 'duplicate' : 'create';
            result.url = `${SELLER_HOST}/l/${bundle.slug}`;
            result.members = memberResults.length;
            return result;
        }
        let prov = null;
        if (opts.viaDuplicate) {
            const source = opts.resolveSource ? await opts.resolveSource() : null;
            if (!source) throw new Error(NO_DUPLICATE_SOURCE);
            prov = await syncBundleViaDuplicate(client, bundle, { ...opts, source: source.permalink });
        } else {
            try {
                const created = await client.createProduct(bundle);
                result.action = 'create';
                result.permalink = created.permalink;
                result.url = created.url;
            } catch (e) {
                // Past the daily ceiling the bundle becomes a converted copy
                // of an existing product instead — never a lost bundle.
                if (!e || !e.dailyCreateLimit || !opts.resolveSource) throw e;
                const source = await opts.resolveSource();
                if (!source) throw e;
                log(`bundle: daily ceiling reached — duplicating "${source.slug || source.permalink}" instead`);
                prov = await syncBundleViaDuplicate(client, bundle, { ...opts, source: source.permalink });
            }
        }
        if (prov) {
            result.action = 'duplicate';
            result.permalink = prov.permalink;
            result.url = prov.url;
            bundleExternalId = prov.externalId;
        }
    }

    if (opts.dryRun) {
        result.members = memberResults.length;
        return result;
    }

    // A product created through `POST /links` is already a bundle; a copy
    // becomes one here. Both then take their copy and price from the bundle
    // route.
    try {
        if (!bundleExternalId) {
            const props = await client.editProps(result.permalink);
            bundleExternalId = props.id || null;
        }
        if (!bundleExternalId) throw new Error('bundle has no external id');
        await client.updateBundleProduct(bundleExternalId, {
            name: bundle.name,
            description: bundle.description,
            custom_permalink: bundle.slug,
            price_currency_type: bundle.currency,
            price_cents: bundle.priceCents,
        });
    } catch (e) {
        result.errors.push(`update: ${e.message}`);
    }

    // Membership is addressed by external id.
    const memberIds = [];
    for (const m of memberResults) {
        if (!m || !m.permalink) continue;
        try {
            const id = await client.externalId(m.permalink);
            if (id) memberIds.push(id);
            else result.errors.push(`member ${m.key}: no external id`);
        } catch (e) {
            result.errors.push(`member ${m.key}: ${e.message}`);
        }
    }
    if (memberIds.length) {
        try {
            const att = await client.attachBundleMembers(result.permalink, memberIds);
            result.members = att.attached;
        } catch (e) {
            result.errors.push(`members: ${e.message}`);
        }
    }

    return result;
}

/**
 * Sync the whole plan.
 *
 * Products that exist are updated. Products that do not are created — and
 * when Gumroad's daily creation ceiling refuses the create, the rest of the
 * plan is created by DUPLICATING an existing plan product instead, which is
 * a first-class dashboard action that does not run the creation limit.
 *
 * @param {object} options
 * @param {boolean} [options.apply] actually write (default: dry run)
 * @param {string[]} [options.only] restrict to these plan keys
 * @param {boolean} [options.viaDuplicate] create by duplicate from the start
 * @param {string} [options.duplicateSource] explicit source permalink
 */
async function sync(options) {
    const opts = options || {};
    const client = opts.client || new GumroadClient({ cookieFile: opts.cookieFile });
    const plan = opts.plan || planFromDisk();
    const wanted = opts.only && opts.only.length ? opts.only : null;
    // `--only` names a plan entry by either its package id or its public
    // slug: the two differ (the package is `system-error-01`, the product is
    // `portrait-rgb-split-plate`).
    const isWanted = (entry) => !wanted || wanted.includes(entry.key) || wanted.includes(entry.slug);

    const dupOptions = {
        seen: new Set(opts.seenDuplicates || []),
        pollIntervalMs: opts.pollIntervalMs,
        timeoutMs: opts.timeoutMs,
    };

    const results = [];
    // Gumroad allows a limited number of NEW products per day. The wall is a
    // routing fact, not the end of the run: past it every create goes
    // through the duplicate route. The wall is still reported when no plan
    // product exists to duplicate yet, which is the only case where waiting
    // is the answer.
    let dailyLimit = null;
    let viaDuplicate = !!opts.viaDuplicate;
    let duplicateSource = opts.duplicateSource ? { permalink: opts.duplicateSource, slug: null } : null;
    let sourceResolved = !!duplicateSource;

    const ensureSource = async () => {
        if (!sourceResolved) {
            sourceResolved = true;
            duplicateSource = await resolveDuplicateSource(client, plan).catch(() => null);
        }
        return duplicateSource;
    };

    for (const product of plan.products) {
        if (!isWanted(product)) continue;
        if (dailyLimit && !viaDuplicate) {
            results.push({
                key: product.key,
                slug: product.slug,
                action: 'deferred',
                errors: [`not created: Gumroad allows ${dailyLimit} new products per day`],
            });
            continue;
        }
        try {
            const existing = await client.findBySlug(product.slug);
            if (!existing && viaDuplicate) {
                if (!opts.apply) {
                    results.push({
                        key: product.key,
                        slug: product.slug,
                        action: 'duplicate',
                        url: `${SELLER_HOST}/l/${product.slug}`,
                    });
                    continue;
                }
                const source = await ensureSource();
                if (!source) throw new Error(NO_DUPLICATE_SOURCE);
                results.push(await syncProductViaDuplicate(client, product, { ...dupOptions, source: source.permalink }));
                continue;
            }
            try {
                results.push(await syncProduct(client, product, { dryRun: !opts.apply }));
            } catch (e) {
                if (!e || !e.dailyCreateLimit) throw e;
                dailyLimit = e.dailyCreateLimit;
                const source = await ensureSource();
                if (!source) {
                    results.push({ key: product.key, slug: product.slug, action: 'deferred', errors: [e.message] });
                    continue;
                }
                log(`daily ceiling (${dailyLimit}) reached — creating the rest by duplicating "${source.slug || source.permalink}"`);
                viaDuplicate = true;
                results.push(await syncProductViaDuplicate(client, product, { ...dupOptions, source: source.permalink }));
            }
        } catch (e) {
            results.push({ key: product.key, slug: product.slug, action: 'error', errors: [e.message] });
        }
    }

    // The bundle IS the whole catalogue, so it is only touched when every
    // member is on the storefront. A bundle missing members is worse than
    // no bundle: it sells a discount on a catalogue that is not there.
    const members = plan.products.filter(isWanted);
    const missing = members.filter((p) => {
        const r = results.find((x) => x && x.key === p.key);
        return !r || !r.permalink;
    });

    let bundleResult = null;
    if (plan.bundle && (!wanted || wanted.includes('bundle') || wanted.includes(plan.bundle.key))) {
        if (missing.length) {
            bundleResult = {
                key: 'bundle',
                slug: plan.bundle.slug,
                action: 'deferred',
                errors: [`not created: ${missing.length} member product(s) are not on the storefront yet`],
            };
        } else {
            try {
                bundleResult = await syncBundle(client, plan.bundle, results, {
                    dryRun: !opts.apply,
                    viaDuplicate,
                    resolveSource: ensureSource,
                    ...dupOptions,
                });
            } catch (e) {
                bundleResult = { key: 'bundle', slug: plan.bundle.slug, action: 'error', errors: [e.message] };
            }
        }
    }

    return { plan, results, bundle: bundleResult, dailyLimit };
}

/**
 * Record the product id + URL back into the package's post.json, so the
 * social engine can reference what was actually created.
 */
function writeBackToPackages(results, packagesDir) {
    const dir = packagesDir || PACKAGES_DIR;
    for (const r of results) {
        if (!r || !r.key || !r.permalink) continue;
        const postFile = path.join(dir, r.key, 'post.json');
        if (!fs.existsSync(postFile)) continue;
        let post;
        try { post = JSON.parse(fs.readFileSync(postFile, 'utf8')); } catch { continue; }
        post.gumroad = {
            id: r.permalink,
            url: r.url,
            slug: r.slug,
            priceCents: r.priceCents,
            syncedAt: new Date().toISOString(),
        };
        fs.writeFileSync(postFile, JSON.stringify(post, null, 2) + '\n');
    }
}

module.exports = {
    // pure
    isValidCustomPermalink,
    scrubPaths,
    extOf,
    readPackage,
    planFromPricingPlan,
    planFromDisk,
    encodeFormBody,
    duplicatePollVerdict,
    isSafeDuplicateSource,
    productFileName,
    compareProduct,
    compareBundle,
    // transport
    GumroadClient,
    cookieHeaderFromFile,
    propsFromHtml,
    parseRefusal,
    // flow
    syncProduct,
    syncProductViaDuplicate,
    syncBundleViaDuplicate,
    adoptDuplicate,
    resolveDuplicateSource,
    verifyProduct,
    verifyBundle,
    sync,
    writeBackToPackages,
    fileDescriptors,
    // constants
    GUMROAD_ORIGIN,
    SELLER_HOST,
    DEFAULT_COOKIE_FILE,
    PRICING_FILE,
    PACKAGES_DIR,
    NO_DUPLICATE_SOURCE,
};

// ------------------------------------------------------------------- CLI

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
function hasFlag(name) { return ARGV.includes(name); }

async function main() {
    const cmd = ARGV[0] && !ARGV[0].startsWith('--') ? ARGV[0] : 'check';

    if (cmd === 'check') {
        const client = new GumroadClient({ cookieFile: argVal('--cookies', DEFAULT_COOKIE_FILE) });
        const info = await client.check();
        if (!info.ok) {
            warn(`not ready: ${info.reason} (HTTP ${info.status})`);
            return 2;
        }
        log(`seller      ${info.sellerName || '?'} (${info.sellerId})`);
        log(`storefront  ${info.storefrontUrl}`);
        log(`currency    ${info.currency}`);
        log(`email       ${info.email || '(none)'}${info.hasUnconfirmedEmail ? ' (+ unconfirmed)' : ''}`);
        log(`products    ${info.productCount}`);
        log(`publishing  ${info.canPublish ? 'allowed' : `blocked (${info.publishBlockedReason})`}`);
        return 0;
    }

    if (cmd === 'plan') {
        const plan = planFromDisk();
        const onStore = await new GumroadClient({ cookieFile: argVal('--cookies', DEFAULT_COOKIE_FILE) })
            .listProducts().then((l) => new Set(l.map((p) => GumroadClient.publicSlug(p))))
            .catch(() => null);
        if (onStore) {
            const missing = plan.products.filter((p) => !onStore.has(p.slug));
            log(`${plan.products.length - missing.length}/${plan.products.length} product(s) already on the storefront`);
            if (missing.length) log(`${missing.length} still to create (Gumroad allows 10 new products per day)`);
        }
        for (const p of plan.products) {
            log(`${p.slug.padEnd(34)} ${String(p.priceCents).padStart(6)}c  ${p.name}`);
            log(`${''.padEnd(34)} cover=${p.cover || '-'} files=${p.files.length}${p.missingFiles.length ? ` MISSING=${p.missingFiles.length}` : ''}`);
        }
        if (plan.bundle) {
            log(`${plan.bundle.slug.padEnd(34)} ${String(plan.bundle.priceCents).padStart(6)}c  ${plan.bundle.name} (bundle of ${plan.bundle.members.length})`);
        }
        if (plan.skipped.length) {
            for (const s of plan.skipped) warn(`skipped ${s.id}: ${s.reason}`);
        }
        return 0;
    }

    if (cmd === 'sync') {
        const apply = hasFlag('--apply');
        const only = argVal('--only', null);
        const onlyKeys = only ? only.split(',').map((s) => s.trim()) : null;
        const viaDuplicate = hasFlag('--via-duplicate');
        const duplicateSource = argVal('--duplicate-source', null);
        const client = new GumroadClient({ cookieFile: argVal('--cookies', DEFAULT_COOKIE_FILE) });

        if (!apply) {
            const plan = planFromDisk();
            log('DRY RUN — nothing will be written. Add --apply to write.');
            const existing = await client.listProducts().catch(() => []);
            const bySlug = new Map(existing.map((p) => [GumroadClient.publicSlug(p), p]));
            const missingWord = viaDuplicate ? 'duplicate' : 'create';
            for (const p of plan.products) {
                const hit = bySlug.get(p.slug);
                log(`${(hit ? 'update' : missingWord).padEnd(9)} ${p.slug.padEnd(34)} ${String(p.priceCents).padStart(6)}c  ${p.name}`);
                if (p.files.length) log(`${''.padEnd(34)} files: ${p.files.join(', ')}`);
                if (p.cover) log(`${''.padEnd(34)} cover: ${p.cover}`);
                if (p.missingFiles.length) warn(`${''.padEnd(34)} missing: ${p.missingFiles.join(', ')}`);
            }
            if (plan.bundle) {
                const hit = bySlug.get(plan.bundle.slug);
                log(`${(hit ? 'update' : missingWord).padEnd(9)} ${plan.bundle.slug.padEnd(34)} ${String(plan.bundle.priceCents).padStart(6)}c  ${plan.bundle.name} (bundle)`);
            }
            return 0;
        }

        const out = await sync({
            client,
            apply: true,
            only: onlyKeys,
            viaDuplicate,
            duplicateSource: duplicateSource || undefined,
        });
        let created = 0, updated = 0, duplicated = 0, deferred = 0, errored = 0;
        for (const r of out.results) {
            log(`${(r.action || '?').padEnd(9)} ${String(r.slug || r.key).padEnd(34)} ${r.url || ''}`);
            for (const e of r.errors || []) warn(`  ! ${r.key}: ${e}`);
            if (r.action === 'create') created++;
            else if (r.action === 'update') updated++;
            else if (r.action === 'duplicate') duplicated++;
            else if (r.action === 'deferred') deferred++;
            else if (r.action === 'error') errored++;
        }
        if (out.bundle) {
            log(`${(out.bundle.action || '?').padEnd(9)} ${String(out.bundle.slug).padEnd(34)} ${out.bundle.url || ''}`);
            for (const e of out.bundle.errors || []) warn(`  ! bundle: ${e}`);
        }
        writeBackToPackages(out.results);
        log(`${created} created · ${duplicated} duplicated · ${updated} updated · ${deferred} deferred · ${errored} errored`);
        if (out.plan && out.plan.skipped.length) {
            // A skipped package is a plan defect, not a quiet win: two
            // packages claimed the same slug, and only one can be a product.
            warn(`${out.plan.skipped.length} package(s) skipped — duplicate slugs in the price plan:`);
            for (const skip of out.plan.skipped) warn(`  - ${skip.id}: ${skip.reason}`);
        }
        if (out.dailyLimit) {
            // The wall clears on its own, and the duplicate route gets past
            // it in the meantime.
            warn(`Gumroad allows ${out.dailyLimit} new products per day.`);
            if (deferred) {
                warn(`${deferred} product(s) still waiting — re-run with --via-duplicate to create them by duplicating an existing one.`);
            }
        }
        return 0;
    }

    if (cmd === 'verify') {
        const plan = planFromDisk();
        const client = new GumroadClient({ cookieFile: argVal('--cookies', DEFAULT_COOKIE_FILE) });
        const only = argVal('--only', null);
        const onlyKeys = only ? only.split(',').map((s) => s.trim()) : null;
        let bad = 0;
        let checked = 0;
        for (const p of plan.products) {
            if (onlyKeys && !onlyKeys.includes(p.key) && !onlyKeys.includes(p.slug)) continue;
            checked++;
            let report;
            try {
                report = await verifyProduct(client, p);
            } catch (e) {
                report = { slug: p.slug, permalink: null, problems: [e.message] };
            }
            if (report.problems.length) {
                bad++;
                warn(`FAIL ${p.slug}${report.permalink ? ` (${report.permalink})` : ''}`);
                for (const problem of report.problems) warn(`  - ${problem}`);
            } else {
                log(`ok   ${p.slug.padEnd(34)} ${report.permalink}`);
            }
        }
        if (plan.bundle) {
            checked++;
            let report;
            try {
                report = await verifyBundle(client, plan.bundle);
            } catch (e) {
                report = { slug: plan.bundle.slug, permalink: null, problems: [e.message] };
            }
            if (report.problems.length) {
                bad++;
                warn(`FAIL ${plan.bundle.slug} (bundle)${report.permalink ? ` (${report.permalink})` : ''}`);
                for (const problem of report.problems) warn(`  - ${problem}`);
            } else {
                log(`ok   ${plan.bundle.slug.padEnd(34)} ${report.permalink} (bundle)`);
            }
        }
        log(`${checked - bad}/${checked} product(s) match the plan`);
        return bad ? 1 : 0;
    }

    warn(`Unknown command "${cmd}". Use: check | plan | verify | sync [--apply] [--via-duplicate] [--only <key,...>]`);
    return 1;
}

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((e) => {
        warn(e && e.message ? e.message : String(e));
        process.exit(1);
    });
}
