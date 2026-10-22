#!/usr/bin/env node
'use strict';

/**
 * lib/ig-poster.test.js — contract tests for the Instagram poster's
 * browser helpers.
 *
 * The reel path was dead code until it was repaired: it looked for a
 * create control Instagram no longer renders, uploaded through
 * `input.files` (read-only in current Chrome), never clicked through
 * the crop screen, and searched for the publish button across the whole
 * page — where the feed's own "Share" buttons live.
 *
 * These tests pin the repaired behaviour against a fake CDP client.
 * The helpers take the client as an argument precisely so they can be
 * driven without a browser.
 */

const assert = require('node:assert');
const path = require('node:path');

const {
    uploadMedia,
    clickNextThroughCrop,
    clickShare,
    setCaption,
    clickCreateTab,
} = require('./ig-poster.js');

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            throw new Error('use checkAsync for promise-returning tests');
        }
        passed++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failed++;
        console.log(`  FAIL ${name}\n       ${e.message}`);
    }
}

async function checkAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failed++;
        console.log(`  FAIL ${name}\n       ${e.message}`);
    }
}

/**
 * A fake CDP client.
 *
 * `js()` is driven by a responder: each expression is matched against
 * the registered patterns and the first match decides the answer.
 * `send()` records every call so a test can assert on the protocol.
 */
function fakeCdp(responder) {
    const calls = [];
    const respond = typeof responder === 'function'
        ? responder
        : () => ({});
    return {
        calls,
        jsCalls: [],
        async js(expression, awaitPromise) {
            this.jsCalls.push({ expression, awaitPromise });
            const answer = respond(expression, this);
            return answer === undefined ? {} : answer;
        },
        async send(method, params) {
            calls.push({ method, params });
            if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
            if (method === 'DOM.querySelector') return { nodeId: 42 };
            return {};
        },
        async screenshot() { return 'ZmFrZS1zY3JlZW5zaG90'; },
    };
}

(async () => {
    console.log('ig-poster');

    // ---------------------------------------------------------------- upload
    await checkAsync('uploadMedia sets the files natively, through the DOM domain', async () => {
        const cdp = fakeCdp();
        await uploadMedia(cdp, '/tmp/reel.mp4', 'video/mp4');

        const setFiles = cdp.calls.find(c => c.method === 'DOM.setFileInputFiles');
        assert.ok(setFiles, 'DOM.setFileInputFiles was never sent');
        assert.deepStrictEqual(setFiles.params.files, ['/tmp/reel.mp4'],
            'the wrong file was handed to the input');
        assert.strictEqual(setFiles.params.nodeId, 42, 'the file input node was not resolved');

        const dom = cdp.calls.find(c => c.method === 'DOM.querySelector');
        assert.ok(dom, 'the file input was never queried');
        assert.strictEqual(dom.params.selector, 'input[type="file"]');
    });

    await checkAsync('uploadMedia asks for a video accept type', async () => {
        const cdp = fakeCdp();
        await uploadMedia(cdp, '/tmp/reel.mp4', 'video/mp4');
        const js = cdp.jsCalls.map(c => c.expression).join('\n');
        assert.ok(js.includes('"video/mp4"'),
            'the accept type was not passed to the page');
        assert.ok(js.includes('input[type="file"]'),
            'the page did not look for a file input');
    });

    await checkAsync('uploadMedia refuses to run without a file input', async () => {
        const cdp = fakeCdp();
        cdp.send = async (method) => {
            if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
            if (method === 'DOM.querySelector') return { nodeId: 0 };
            return {};
        };
        await assert.rejects(
            () => uploadMedia(cdp, '/tmp/reel.mp4', 'video/mp4'),
            /no file input/,
            'a missing file input was not reported');
    });

    // ----------------------------------------------------------------- crop
    await checkAsync('clickNextThroughCrop stops when there is no next', async () => {
        let calls = 0;
        const cdp = fakeCdp((expr) => {
            if (expr.includes("=== 'next'")) {
                calls++;
                return calls <= 2 ? { clicked: true } : { clicked: false, labels: ['back', 'share'] };
            }
            return {};
        });
        const clicked = await clickNextThroughCrop(cdp, 4, 1);
        assert.strictEqual(clicked, 2, 'the crop walk did not stop at the last screen');
        assert.strictEqual(calls, 3, 'it kept looking for "next" after the last screen');
    });

    await checkAsync('clickNextThroughCrop never exceeds its step budget', async () => {
        let calls = 0;
        const cdp = fakeCdp((expr) => {
            if (expr.includes("=== 'next'")) { calls++; return { clicked: true }; }
            return {};
        });
        const clicked = await clickNextThroughCrop(cdp, 3, 1);
        assert.strictEqual(clicked, 3);
        assert.strictEqual(calls, 3, 'it clicked more often than the budget allowed');
    });

    await checkAsync('clickNextThroughCrop scopes its search to the dialog', async () => {
        const cdp = fakeCdp(() => ({ clicked: false }));
        await clickNextThroughCrop(cdp, 1, 1);
        const expr = cdp.jsCalls[0].expression;
        assert.ok(expr.includes('[role="dialog"]'),
            'the "next" search was not scoped to the create dialog');
    });

    // ---------------------------------------------------------------- share
    await checkAsync('clickShare searches inside the dialog, never the page', async () => {
        const cdp = fakeCdp((expr) => {
            if (expr.includes('const btns')) {
                return { clicked: true, which: 'share', scoped: true };
            }
            if (expr.includes('const dtext')) {
                // The confirmation poll: a published post.
                return { url: 'https://www.instagram.com/kaidjuric/reel/ABC123/', dialog: 'Shared reel', alert: '' };
            }
            return {};
        });
        const res = await clickShare(cdp);
        assert.strictEqual(res.clicked, true);
        assert.strictEqual(res.confirmation.ok, true, 'the publish was not confirmed');
        assert.strictEqual(res.confirmation.url, 'https://www.instagram.com/kaidjuric/reel/ABC123/');
        const expr = cdp.jsCalls.map(c => c.expression).join('\n');
        assert.ok(expr.includes('[role="dialog"]'),
            'the publish button search was not scoped to the dialog');
    });

    await checkAsync('clickShare fails loudly, with a screenshot, when nothing matches', async () => {
        const cdp = fakeCdp((expr) => {
            if (expr.includes('const btns')) {
                return { clicked: false, scoped: true, buttons: ['next', 'cancel'] };
            }
            return {};
        });
        await assert.rejects(
            () => clickShare(cdp),
            /could not find the share button/,
            'a missing publish button was not reported');
    });

    // --------------------------------------------------------------- caption
    await checkAsync('setCaption types into the field with CDP Input.insertText', async () => {
        const cdp = fakeCdp((expr) => {
            if (expr.includes('field.focus()')) {
                return { found: true, focused: true };
            }
            if (expr.includes('landed.slice(0, 100)')) {
                return { landed: 'seemingly so', counter: '13/2,200' };
            }
            return {};
        });
        const res = await setCaption(cdp, 'seemingly so');
        assert.strictEqual(res.set, true, 'the caption was not accepted');
        assert.strictEqual(res.method, 'cdp', 'the caption did not go in through CDP');
        const insert = cdp.calls.find(c => c.method === 'Input.insertText');
        assert.ok(insert, 'Input.insertText was never sent');
        assert.deepStrictEqual(insert.params, { text: 'seemingly so' });
    });

    await checkAsync('setCaption reports when there is no caption field', async () => {
        const cdp = fakeCdp(() => ({ found: false }));
        const res = await setCaption(cdp, 'seemingly so');
        assert.strictEqual(res.set, false);
        assert.match(res.reason, /no caption field/);
        assert.ok(!cdp.calls.some(c => c.method === 'Input.insertText'),
            'it typed into a field that was not there');
    });

    await checkAsync('setCaption falls back only when the CDP insertion lands nothing', async () => {
        // The read-back after Input.insertText reports an empty field:
        // the fallback must then run.
        const cdp = fakeCdp((expr) => {
            if (expr.includes('execCommand')) return { set: false, ok: false, landed: '' };
            if (expr.includes('field.focus()')) return { found: true, focused: true };
            if (expr.includes('landed.slice(0, 100)')) return { landed: '', counter: '0/2,200' };
            return {};
        });
        const res = await setCaption(cdp, 'seemingly so');
        assert.strictEqual(res.set, false, 'an empty caption was reported as set');
        assert.ok(!res.method, 'the fallback did not run');
        const fallback = cdp.jsCalls.filter(c => c.expression.includes('execCommand'));
        assert.strictEqual(fallback.length, 1, 'the in-page fallback did not run');
    });

    await checkAsync('setCaption embeds the caption safely', async () => {
        // A caption with a quote and a newline must not be able to
        // break out of the JavaScript string it is embedded in.
        const nasty = '"; alert(1); //';
        const cdp = fakeCdp((expr) => {
            if (expr.includes('execCommand')) return { set: true, ok: true, landed: nasty };
            if (expr.includes('field.focus()')) return { found: true, focused: true };
            if (expr.includes('landed.slice(0, 100)')) return { landed: '', counter: '0/2,200' };
            return {};
        });
        await setCaption(cdp, nasty);
        const fallbackExpr = cdp.jsCalls.filter(c => c.expression.includes('execCommand'))
            .map(c => c.expression).join('\n');
        assert.ok(fallbackExpr, 'the fallback expression was never built');
        assert.ok(fallbackExpr.includes(JSON.stringify(nasty)),
            'the caption was not embedded with JSON.stringify');
        // The raw text must never appear unescaped in the expression.
        assert.ok(!fallbackExpr.includes(`'${nasty}'`),
            'the caption was embedded as a raw string literal');
    });

    await checkAsync('setCaption blurs the field so Instagram commits the caption', async () => {
        // Instagram's caption editor commits its value on blur, and
        // the publish reads the committed value. Without the blur the
        // post goes up with the PREVIOUS caption — the empty one —
        // while the editor's counter still reads the new text.
        const cdp = fakeCdp((expr) => {
            if (expr.includes('field.blur()')) return true;
            if (expr.includes('field.focus()')) return { found: true, focused: true };
            if (expr.includes('landed.slice(0, 100)')) return { landed: 'seemingly so', counter: '13/2,200' };
            return {};
        });
        const res = await setCaption(cdp, 'seemingly so');
        assert.strictEqual(res.set, true);
        const blurIdx = cdp.jsCalls.findIndex(c => c.expression.includes('field.blur()'));
        assert.ok(blurIdx >= 0, 'the caption field was never blurred');

        // The blur must come AFTER the text was inserted.
        const insertIdx = cdp.calls.findIndex(c => c.method === 'Input.insertText');
        assert.ok(insertIdx >= 0, 'Input.insertText was never sent');
        const insertExprIdx = cdp.jsCalls.findIndex(c => c.expression.includes('landed.slice(0, 100)'));
        assert.ok(blurIdx > insertExprIdx, 'the field was blurred before the text was inserted');
    });

    await checkAsync('setCaption blurs the field on the fallback path too', async () => {
        const cdp = fakeCdp((expr) => {
            if (expr.includes('field.blur()')) return true;
            if (expr.includes('execCommand')) return { set: true, ok: true, landed: 'seemingly so' };
            if (expr.includes('field.focus()')) return { found: true, focused: true };
            if (expr.includes('landed.slice(0, 100)')) return { landed: '', counter: '0/2,200' };
            return {};
        });
        await setCaption(cdp, 'seemingly so');
        assert.ok(cdp.jsCalls.some(c => c.expression.includes('field.blur()')),
            'the fallback path skipped the blur');
    });

    // ----------------------------------------------------------- create tab
    await checkAsync('clickCreateTab looks in the create panel first', async () => {
        const cdp = fakeCdp((expr) => {
            if (expr.includes('const wanted')) return { clicked: true };
            return {};
        });
        const res = await clickCreateTab(cdp, 'Post');
        assert.strictEqual(res, true, 'the create tab was not clicked');
        const expr = cdp.jsCalls.map(c => c.expression).join('\n');
        assert.ok(expr.includes('[role="dialog"]'),
            'the create panel was not searched');
        // The panel is searched FIRST, and the unscoped page search is
        // only the fallback: the left nav carries a "Reels" entry of
        // its own, and finding that one walks away from the composer.
        assert.ok(expr.includes('(panel && pick(panel)) || pick(document)'),
            'the create panel is not searched before the page');
    });

    // -------------------------------------------------------------- summary
    console.log(`\n  ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
