#!/usr/bin/env node
'use strict';
// lib/suno-web.js
//
// Suno **web** client — the authenticated studio API, driven through a
// headed Chrome over CDP.
//
// Why a browser and not plain HTTP:
//
//   * `api.suno.ai` answers **503** from this network and
//     `auth.suno.com/api/v1/auth/refresh` answers **404**. Both were
//     probed directly with the jar's own tokens.
//   * The API the app actually uses is
//     `https://studio-api-prod.suno.com/api/...`, and it demands
//     `Authorization: Bearer <access token>`.
//   * That access token is **refreshed by the SPA itself**, using the
//     `__client` refresh cookie. A hand-exported access token is
//     routinely expired; the browser's session is not.
//
// Two constraints, both learned the hard way:
//
//   1. **The browser must be HEADED.** suno.com loads Cloudflare
//      Turnstile and hCaptcha.
//   2. **The cookie jar is usually stale.** The SPA refreshes it
//      server-side. We never send the jar's token directly — we read
//      the token off the app's own request.
//
// Credentials live OUTSIDE the repo (~/.suno-cookies.txt), matching the
// ~/.midjourney-cookies.txt precedent.
//
// CLI:
//   node lib/suno-web.js styles                     # list saved styles
//   node lib/suno-web.js create --title T --tags S  # create one style
//   node lib/suno-web.js clip --id <clip_id>        # one clip's settings
//   node lib/suno-web.js billing                    # credits
//
// Exit: 0 ok · 1 fatal

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    parseCookieFile,
    toBrowserCookies,
} = require('./mj-cookies.js');

const {
    launchChrome,
    cdpConnect,
    CDPClient,
    killChrome,
} = require('./mj-submitter.js');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'suno-config.json'), 'utf8'));

// Every in-page API call gets a deadline. Kept below the CDP request
// timeout (DEFAULT_CDP_TIMEOUT_MS, 30s) so the abort surfaces as a
// named AbortError rather than a generic "the browser did not answer".
const DEFAULT_API_TIMEOUT_MS = 20000;

function log(msg) { process.stdout.write(`[suno-web] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[suno-web] ${msg}\n`); }

function expandHome(p) {
    if (!p) return p;
    return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class SunoClient {
    constructor({ cdp, chrome, cfg }) {
        this.cdp = cdp;
        this.chrome = chrome;
        this.cfg = cfg;
        this.token = null;
        this.browserToken = null;
        this.deviceId = null;
    }

    static async open(opts = {}) {
        const cfg = { ...CONFIG, ...(opts.config || {}) };
        const port = opts.port || cfg.port || 9455;
        const userDataDir = expandHome(opts.userDataDir || cfg.userDataDir);
        const chromeBin = opts.chromeBin || (cfg.paths && cfg.paths.webBrowserBin);
        const cookieFile = expandHome(opts.cookieFile || cfg.cookiesFile);
        const headless = opts.headless !== undefined ? !!opts.headless : !!cfg.headless;

        if (!fs.existsSync(cookieFile)) {
            throw new Error(
                `cookie file not found: ${cookieFile}\n` +
                `Export one from a browser logged into suno.com and keep it outside the repo.`
            );
        }
        if (!chromeBin || !fs.existsSync(chromeBin)) {
            throw new Error(`Chrome binary not found: ${chromeBin}`);
        }

        const chrome = await launchChrome(port, userDataDir, chromeBin, headless);
        const wsUrl = await cdpConnect(`http://127.0.0.1:${port}`);
        const cdp = await new CDPClient(wsUrl).connect();
        const client = new SunoClient({ cdp, chrome, cfg });
        await client._bootstrap(cookieFile);
        return client;
    }

    /**
     * Re-read the Bearer token from the page.
     *
     * MEASURED 2026-11-02: the token is captured ONCE at bootstrap, and
     * it EXPIRES mid-run — a long roll (six polls at five seconds each,
     * per clip) came back `GET /api/billing/info/ -> 401
     * {"detail": "Unauthorized."}` after the generation had already been
     * submitted.
     *
     * The SPA refreshes the session itself (the jar's `__client` is a
     * Firebase refresh token), so the fix is to ask the PAGE for a fresh
     * token rather than to re-mint one: navigate, let the app make a
     * request, and read the header off it.
     */
    async refreshToken() {
        const { cdp } = this;
        this.token = null;
        try {
            await cdp.send('Page.navigate', { url: 'https://suno.com/' });
        } catch { /* the page may already be there */ }
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            if (this.token) return this.token;
            await sleep(500);
        }
        return null;
    }

    async _bootstrap(cookieFile) {
        const { cdp } = this;

        // Hide the CDP automation flag from the page (Turnstile checks it).
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
            source: "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });",
        });

        await cdp.send('Network.enable');

        // The app attaches its own Authorization header. Rather than
        // decode a possibly-stale token out of the jar, read the header
        // off a request the SPA actually made.
        cdp.ws.addEventListener('message', ev => {
            try {
                const m = JSON.parse(ev.data);
                if (m.method !== 'Network.requestWillBeSent') return;
                const h = (m.params.request && m.params.request.headers) || {};
                const a = h.authorization || h.Authorization;
                if (!this.token && typeof a === 'string' && a.startsWith('Bearer ')) {
                    this.token = a.slice(7).trim();
                }
                if (!this.browserToken && h['browser-token']) this.browserToken = h['browser-token'];
                if (!this.deviceId && h['device-id']) this.deviceId = h['device-id'];
            } catch { /* a malformed frame is not fatal */ }
        });

        const cookies = toBrowserCookies(parseCookieFile(cookieFile), 'https://suno.com');
        let set = 0;
        for (const c of cookies) {
            const p = { name: c.name, value: c.value };
            if (c.url) {
                // `__Host-` cookies and anything the jar gave us as a URL.
                p.url = c.url;
            } else {
                p.domain = c.domain || '.suno.com';
                p.path = c.path || '/';
                p.secure = !!c.secure;
            }
            if (c.expires && c.expires > 0) p.expires = c.expires;
            try {
                await cdp.send('Network.setCookie', p);
                set += 1;
            } catch { /* one bad cookie must not sink the session */ }
        }
        log(`cookies: ${set}/${cookies.length} set`);

        await cdp.send('Page.enable');
        await cdp.send('Page.navigate', { url: 'https://suno.com/' });

        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
            if (this.token) break;
            await sleep(500);
        }
        if (!this.token) {
            throw new Error(
                'no Authorization header observed from suno.com within 45s — ' +
                'the cookie jar is probably expired or logged out'
            );
        }
        log('session authenticated');
    }

    /**
     * Call the studio API from inside the page, so the request carries
     * the same origin and cookies the SPA uses.
     */
    async api(pathname, { method = 'GET', body } = {}, { retryOn401 = true, timeoutMs = DEFAULT_API_TIMEOUT_MS } = {}) {
        const url = this.cfg.apiBase + pathname;
        const buildHeaders = () => {
            const headers = { authorization: `Bearer ${this.token}` };
            if (this.browserToken) headers['browser-token'] = this.browserToken;
            if (this.deviceId) headers['device-id'] = this.deviceId;
            if (body !== undefined) headers['content-type'] = 'application/json';
            return headers;
        };
        const buildExpr = () => {
            const headers = buildHeaders();
            // Every in-page fetch carries a deadline. A hung request used
            // to hang the whole run: the CDP evaluate never returned, so
            // the promise never settled and the session sat there until
            // it was killed by hand.
            return (
                `(async () => {` +
                ` const ctrl = new AbortController();` +
                ` const timer = setTimeout(() => ctrl.abort(), ${Number(timeoutMs)});` +
                ` try {` +
                `  const r = await fetch(${JSON.stringify(url)}, {` +
                `   method: ${JSON.stringify(method)},` +
                `   headers: ${JSON.stringify(headers)},` +
                (body !== undefined ? `   body: ${JSON.stringify(JSON.stringify(body))},` : '') +
                `   signal: ctrl.signal,` +
                `  });` +
                `  return { status: r.status, body: await r.text() };` +
                ` } catch (e) {` +
                `  const err = new Error('api ' + ${JSON.stringify(method)} + ' ' + ${JSON.stringify(pathname)} + ' aborted after ${Number(timeoutMs)}ms: ' + (e && e.message ? e.message : String(e)));` +
                `  err.name = 'AbortError';` +
                `  throw err;` +
                ` } finally { clearTimeout(timer); }` +
                `})()`
            );
        };

        let res;
        try {
            res = await this.cdp.js(buildExpr(), true);
        } catch (e) {
            // Keep the abort's NAME — a caller that catches AbortError
            // must still see AbortError after the wrap. Over CDP the
            // in-page exception arrives as text ("JS error: AbortError:
            // …"), so the message is the only signal left.
            const err = new Error(`api ${method} ${pathname} failed: ${e.message}`);
            if (e && e.name) err.name = e.name;
            else if (/aborted after \d+ms/.test(String(e && e.message))) err.name = 'AbortError';
            throw err;
        }

        // MEASURED 2026-11-02: the Bearer token EXPIRES mid-run. A roll
        // that polls six times per clip comes back 401 on the billing
        // call long after the generation was submitted — and the run
        // dies with a manifest that was never written.
        //
        // The SPA refreshes the session itself (the jar's `__client` is
        // a Firebase refresh token), so the fix is to ask the PAGE for a
        // fresh token and try again — once, so a real 401 does not
        // loop.
        if (res.status === 401 && retryOn401) {
            const fresh = await this.refreshToken();
            if (fresh) {
                try {
                    res = await this.cdp.js(buildExpr(), true);
                } catch (e) {
                    throw new Error(`api ${method} ${pathname} failed after a token refresh: ${e.message}`);
                }
            }
        }

        let json = null;
        try { json = JSON.parse(res.body); } catch { /* non-JSON error page */ }
        return { status: res.status, json, body: res.body };
    }

    async apiOk(pathname, opts) {
        const r = await this.api(pathname, opts);
        if (r.status < 200 || r.status >= 300) {
            throw new Error(`${opts && opts.method ? opts.method : 'GET'} ${pathname} -> ${r.status} ${String(r.body).slice(0, 200)}`);
        }
        return r.json;
    }

    /** Every saved style in the account. */
    async listStyles() {
        const j = await this.apiOk('/api/prompts/v2?per_page=100');
        return (j && j.styles) || [];
    }

    /**
     * Write one saved style. The server takes { tags, id, title } —
     * `id: null` means "new"; an existing id UPDATES that style.
     * Title <= 100, tags <= 1000.
     *
     * MEASURED 2026-11-01 (live): sending `id: null` CREATES every
     * time. A re-run used to leave a duplicate behind, every time.
     */
    async createStyle({ title, tags, id = null }) {
        const j = await this.apiOk('/api/prompts/v2', {
            method: 'POST',
            body: { tags, id: id || null, title },
        });
        return j;
    }

    /**
     * Delete one saved style. MEASURED 2026-11-01 (live): the endpoint
     * is `DELETE /api/prompts/v2/<id>` and answers 204.
     */
    async deleteStyle(id) {
        const r = await this.api(`/api/prompts/v2/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (r.status < 200 || r.status >= 300) {
            throw new Error(`DELETE /api/prompts/v2/${id} -> ${r.status} ${String(r.body).slice(0, 200)}`);
        }
        return true;
    }

    async getClip(id) {
        const j = await this.apiOk(`/api/clips/get_songs_by_ids?ids=${encodeURIComponent(id)}`);
        return (j && j.clips && j.clips[0]) || null;
    }

    async billing() {
        return this.apiOk('/api/billing/info/');
    }

    /**
     * Is a captcha required for a generation right now, and which
     * captcha version does the server expect?
     *
     * POST /api/c/check {ctype:"generation"} -> {required, captcha_version}
     */
    async captchaCheck() {
        const r = await this.api('/api/c/check', { method: 'POST', body: { ctype: 'generation' } });
        if (r.status < 200 || r.status >= 300) return { required: false, captcha_version: null };
        return { required: !!(r.json && r.json.required), captcha_version: (r.json && r.json.captcha_version) || null };
    }

    /**
     * Solve the generation captcha and return the token.
     *
     * The studio SPA runs a Cloudflare Turnstile widget before every
     * generation and sends the resulting token in the request body
     * (`token`) plus the captcha version (`token_provider`). The
     * endpoint answers 422 token_validation_failed without it once the
     * server decides a captcha is required.
     *
     * The widget is rendered by us in the live page (suno.com loads the
     * Turnstile script itself), and in a headed browser it solves
     * itself. Each token is single-use, so this is called per request.
     */
    async captchaToken({ siteKey, timeoutMs = 30000 } = {}) {
        const key = siteKey || this.cfg.captchaSiteKey;
        if (!key) throw new Error('no captcha site key configured');
        await this.cdp.send('Page.navigate', { url: this.cfg.createPage });
        // wait for the Turnstile script to exist
        for (let i = 0; i < 40; i++) {
            const ready = await this.cdp.js(
                `(!!window.turnstile && typeof window.turnstile.render === 'function')`
            );
            if (ready) break;
            await sleep(500);
        }
        const setup = await this.cdp.js(`(() => {
            try {
                if (!window.turnstile || typeof window.turnstile.render !== 'function') return 'no-render';
                if (!document.getElementById('suno-cap-host')) {
                    const div = document.createElement('div');
                    div.id = 'suno-cap-host';
                    div.style.cssText = 'position:fixed;left:8px;top:8px;width:300px;height:70px;z-index:99999;background:#fff';
                    document.body.appendChild(div);
                }
                window.__sunoTok = null; window.__sunoCapErr = null;
                window.turnstile.render(document.getElementById('suno-cap-host'), {
                    sitekey: ${JSON.stringify(key)},
                    action: 'generation',
                    callback: t => { window.__sunoTok = t; },
                    'error-callback': e => { window.__sunoCapErr = String(e); },
                    'expired-callback': () => { window.__sunoCapErr = 'expired'; }
                });
                return 'rendered';
            } catch (e) { return 'threw: ' + e.message; }
        })()`);
        if (setup !== 'rendered') throw new Error(`captcha widget not rendered (${setup})`);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await sleep(1000);
            const st = await this.cdp.js(
                `JSON.stringify({t: window.__sunoTok || null, e: window.__sunoCapErr || null})`
            );
            if (!st) continue;
            const parsed = JSON.parse(st);
            if (parsed.t) return parsed.t;
            if (parsed.e) throw new Error(`captcha failed: ${parsed.e}`);
        }
        throw new Error('captcha token timed out');
    }

    async close() {
        try { this.cdp.ws && this.cdp.ws.close(); } catch { /* already gone */ }
        if (this.chrome) killChrome(this.chrome);
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0] || 'styles';
    const flag = (name, dflt) => {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
    };

    const client = await SunoClient.open({
        cookieFile: flag('cookies', undefined),
        port: Number(flag('port', 0)) || undefined,
        // MEASURED 2026-11-02: the config's default profile
        // (/tmp/suno-web-profile) is held by an always-on instance, and
        // Chrome refuses to start on a locked profile — the run then
        // fails as "Chrome failed to bind on port N", which reads like a
        // broken browser. The flag makes a second run possible.
        userDataDir: flag('user-data-dir', undefined),
    });
    try {
        if (cmd === 'styles') {
            const styles = await client.listStyles();
            log(`${styles.length} saved styles`);
            for (const s of styles) {
                log(`  ${s.id} | ${JSON.stringify(s.title)} | ${(s.tags || '').length} chars`);
            }
        } else if (cmd === 'create') {
            const title = flag('title');
            const tags = flag('tags');
            if (!title || !tags) throw new Error('create needs --title and --tags');
            const r = await client.createStyle({ title, tags });
            log(`created ${JSON.stringify(r)}`);
        } else if (cmd === 'clip') {
            const id = flag('id');
            if (!id) throw new Error('clip needs --id');
            log(JSON.stringify(await client.getClip(id), null, 2));
        } else if (cmd === 'billing') {
            log(JSON.stringify(await client.billing(), null, 2));
        } else {
            throw new Error(`unknown command: ${cmd}`);
        }
    } finally {
        await client.close();
    }
}

if (require.main === module) {
    main().catch(e => { warn(`fatal: ${e.message}`); process.exit(1); });
}

module.exports = { SunoClient, CONFIG, expandHome };
