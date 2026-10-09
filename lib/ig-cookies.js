#!/usr/bin/env node
'use strict';
// lib/ig-cookies.js
//
// Instagram cookie handling. Parses Netscape-format cookie files
// exported from a logged-in Instagram session.
//
// Key insight from mj-cookies.js: `__Host-` cookies must NOT carry
// a Domain attribute when passed to Chromium, or they are silently
// dropped and the site shows "Log in" with no error.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_COOKIE_PATH = () => {
    const home = process.env.HOME || '';
    return path.join(home, 'Downloads', 'd1925cb8-c34b-4805-aaa9-56eda9fc7f10.txt');
};

/**
 * Parse a Netscape-format cookie file.
 * @param {string} filePath
 * @returns {Array<{domain, flag, path, secure, expiration, name, value}>}
 */
function parseCookieFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const cookies = [];
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        
        const parts = trimmed.split('\t');
        if (parts.length < 7) continue;
        
        // Netscape format: domain, flag, path, secure, expiration, name, value
        cookies.push({
            domain: parts[0],
            flag: parts[1] === 'TRUE',
            path: parts[2],
            secure: parts[3] === 'TRUE',
            expiration: parseInt(parts[4], 10),
            name: parts[5],
            value: parts[6],
        });
    }
    
    return cookies;
}

/**
 * Convert cookies to Chrome's format, handling the __Host- prefix correctly.
 * @param {Array} cookies - Parsed cookies
 * @returns {Array} Chrome-format cookies
 */
function toBrowserCookies(cookies) {
    return cookies.map(c => {
        // __Host- cookies must NOT have a Domain attribute
        if (c.name.startsWith('__Host-')) {
            return {
                url: 'https://www.instagram.com',
                name: c.name,
                value: c.value,
                path: '/',
                secure: true,
                // No domain field
            };
        }
        
        // Regular cookies: use the domain as-is
        return {
            url: (c.secure ? 'https://' : 'http://') + c.domain,
            name: c.name,
            value: c.value,
            path: c.path,
            secure: c.secure,
            domain: c.domain, // Include for regular cookies
        };
    });
}

/**
 * Describe cookies for debugging (without exposing values).
 * @param {Array} cookies
 * @returns {string}
 */
function describe(cookies) {
    const names = cookies.map(c => c.name).join(', ');
    return `${cookies.length} cookies: ${names}`;
}

/**
 * Validate that cookies contain required Instagram session cookies.
 * @param {Array} cookies
 * @returns {{valid: boolean, missing: string[]}}
 */
function validate(cookies) {
    const names = new Set(cookies.map(c => c.name));
    const required = ['sessionid', 'csrftoken', 'ds_user_id'];
    const missing = required.filter(r => !names.has(r));
    return { valid: missing.length === 0, missing };
}

module.exports = {
    parseCookieFile,
    toBrowserCookies,
    describe,
    validate,
    defaultCookiePath: DEFAULT_COOKIE_PATH,
};
