'use strict';
// lib/xml-guard.js
//
// Cheap MusicXML well-formedness check, shared by every tool that
// hands a score to an external renderer.
//
// Why this exists: MuseScore 4.7.5 does not fail on truncated or
// invalid MusicXML — it HANGS. Measured: a 4-part score missing its
// closing </score-partwise> was still running after 150s, while the
// same score renders in 0.58s when well-formed. Without a guard the
// cost of one bad input is the full render timeout, per attempt.
//
// A tag-depth scan catches the failures that actually occur
// (truncation, unbalanced/typo'd tags) without pulling in an XML
// parser. Comments, CDATA, processing instructions and the DOCTYPE are
// stripped first so their angle brackets don't count toward depth.
//
// Pure Node, no deps.

const fs = require('node:fs');

/**
 * @param {string} p path to a (possibly plain-text) XML file
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function musicXmlIsWellFormed(p) {
    let s;
    try { s = fs.readFileSync(p, 'utf8'); }
    catch { return { ok: false, reason: 'unreadable' }; }

    // An empty file is malformed, not "depth 0".
    if (s.trim().length === 0) return { ok: false, reason: 'file is empty' };

    const stripped = s
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
        .replace(/<\?[\s\S]*?\?>/g, '')
        .replace(/<!DOCTYPE[^>]*>/gi, '');

    // Track a stack of open element names, not just a depth counter:
    // a counter accepts crossed nesting like `<a><b></a></b>`, which is
    // not well-formed XML and can hang mscore just as truncation does.
    const stack = [];
    let sawElement = false;
    // Match an opening tag, a closing tag, or a self-closing tag.
    // Attribute values may contain '>' so they are matched explicitly.
    const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    let m;
    while ((m = re.exec(stripped)) !== null) {
        const closing = m[1] === '/';
        const name = m[2];
        const selfClosing = m[4] === '/';
        sawElement = true;
        if (selfClosing) continue;
        if (closing) {
            const open = stack.pop();
            if (open === undefined) {
                return { ok: false, reason: `unbalanced </${name}> — nothing left open` };
            }
            if (open !== name) {
                return { ok: false, reason: `mismatched </${name}>, expected </${open}>` };
            }
        } else {
            stack.push(name);
        }
    }
    if (!sawElement) return { ok: false, reason: 'no XML elements found' };
    if (stack.length > 0) {
        return { ok: false, reason: `unclosed <${stack[stack.length - 1]}> at EOF (depth ${stack.length}) — file is truncated` };
    }
    return { ok: true };
}

module.exports = { musicXmlIsWellFormed };
