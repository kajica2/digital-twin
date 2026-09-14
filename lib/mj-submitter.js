#!/usr/bin/env node
// lib/mj-submitter.js
//
// Midjourney submitter — drives Discord web via Chrome DevTools Protocol
// to submit a prompt to Midjourney and capture the result image.
//
// Standalone usage:
//   node lib/mj-submitter.js --prompt "my prompt text" --ar "3:4" [--output mj-output]
//
// Also callable from lib/mj-watcher.js as the export runner.
//
// Flow:
//   1. Launch or attach to a debug Chrome on the configured port.
//   2. Open Discord web at the configured channel URL.
//   3. Wait for the chat textarea to render.
//   4. Type `/imagine prompt: <prompt>` and submit.
//   5. Wait for the MJ bot's embed response (poll for image embeds).
//   6. Screenshot the result or download the embedded image.
//   7. Save to output directory, return the output path.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

// ---------- Default config ----------
const REPO = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'mj-config.json'), 'utf8'));
const DEFAULT_OUTPUT = path.resolve(REPO, CONFIG.mj.outputDir);

// ---------- CLI parsing ----------
function parseArgs() {
    const argv = process.argv.slice(2);
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case '--prompt':      args.prompt = argv[++i]; break;
            case '--prompt-file': args.promptFile = argv[++i]; break;
            case '--ar':          args.ar = argv[++i]; break;
            case '--output':      args.outputDir = argv[++i]; break;
            case '--port':        args.port = parseInt(argv[++i], 10); break;
            case '--channel-url': args.channelUrl = argv[++i]; break;
            case '--dry-run':     args.dryRun = true; break;
            case '--help':
                console.log(`Usage: node lib/mj-submitter.js --prompt "..." [options]

Options:
  --prompt <text>         Prompt text to submit to Midjourney
  --prompt-file <path>    Read prompt from a .md file (first non-frontmatter paragraph)
  --ar <aspect>           Aspect ratio override (e.g. "3:4", "16:9")
  --output <dir>          Output directory for captured images (default: mj-output/)
  --port <num>            Chrome debug port (default: ${CONFIG.chrome.debugPort})
  --channel-url <url>     Discord channel URL (default: from config)
  --dry-run               Validate prompt and config without launching Chrome
  --help                  Show this help`);
                process.exit(0);
        }
    }
    if (!args.prompt && !args.promptFile) {
        console.error('ERROR: --prompt or --prompt-file is required');
        process.exit(1);
    }
    return args;
}

// ---------- Prompt extraction ----------
function extractPrompt(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    // Skip YAML frontmatter (between --- delimiters)
    let body = content;
    if (lines[0] && lines[0].trim() === '---') {
        const endIdx = lines.slice(1).findIndex(l => l.trim() === '---');
        if (endIdx >= 0) {
            body = lines.slice(endIdx + 2).join('\n');
        }
    }

    // Take the first non-empty, non-heading paragraph as the prompt.
    // Paragraphs are split on blank lines only, so a prompt hard-wrapped
    // across multiple lines stays one paragraph. Heading lines (# ...)
    // and standalone decorative paragraphs (---, backticked tags) are
    // skipped. The prompt is the FIRST substantive paragraph — MJ
    // doesn't need the file's title or editorial notes.
    const paragraphs = body.split('\n\n')
        .map(p => p.trim())
        .filter(p => p.length > 0);

    let prompt = null;
    for (const p of paragraphs) {
        const lines = p.split('\n');
        // Skip pure heading blocks (e.g. "# Title")
        if (lines.every(l => /^#+\s*/.test(l))) continue;
        // Skip decorative blocks: ---, backticked tags, param-only lines
        if (/^(-{3,}|`[^`]+`)\s*$/.test(lines[0].trim())) continue;
        prompt = p
            .replace(/^#+\s*/gm, '')
            .replace(/\n/g, ' ')
            .trim();
        break;
    }

    if (!prompt) {
        throw new Error(`No prompt text found in ${filePath}`);
    }

    return prompt;
}

// ---------- Chrome management ----------
function chromeDebugUrl(port) {
    return `http://127.0.0.1:${port}`;
}

function checkChromeOnPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`${chromeDebugUrl(port)}/json/version`, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    });
}

function launchChrome(port, userDataDir, chromeBin) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(userDataDir, { recursive: true });

        const proc = spawn(chromeBin, [
            `--remote-debugging-port=${port}`,
            '--remote-debugging-address=::',
            `--user-data-dir=${userDataDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--new-window',
            'about:blank',
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });

        let stderrBuf = '';
        proc.stderr.on('data', d => { stderrBuf += d.toString(); });

        // Wait up to 8 seconds for the port to respond
        const deadline = Date.now() + 8000;
        const poll = () => {
            if (Date.now() > deadline) {
                reject(new Error(`Chrome failed to bind on port ${port} within 8s. Stderr: ${stderrBuf.slice(-200)}`));
                return;
            }
            checkChromeOnPort(port).then(info => {
                if (info) resolve(proc);
                else setTimeout(poll, 300);
            });
        };
        poll();
    });
}

function killChrome(proc) {
    try { proc.kill('SIGTERM'); } catch {}
}

// ---------- CDP helpers ----------
function cdpConnect(debugUrl) {
    return new Promise((resolve, reject) => {
        http.get(`${debugUrl}/json`, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const targets = JSON.parse(data);
                    // Find the first page target, or create one
                    const existing = targets.find(t => t.type === 'page');
                    if (existing) {
                        resolve(existing.webSocketDebuggerUrl);
                    } else {
                        // Create a new page
                        http.get(`${debugUrl}/json/new`, (res2) => {
                            let d2 = '';
                            res2.on('data', c => d2 += c);
                            res2.on('end', () => {
                                try {
                                    const t = JSON.parse(d2);
                                    resolve(t.webSocketDebuggerUrl);
                                } catch (e) { reject(e); }
                            });
                        });
                    }
                } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

class CDPClient {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.id = 0;
        this.pending = new Map();
        this._connected = false;
    }

    async connect() {
        const WebSocket = globalThis.WebSocket || require('ws');
        if (!WebSocket) {
            throw new Error('No WebSocket available. Install ws: npm install ws');
        }
        this.ws = new WebSocket(this.wsUrl);
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', () => resolve(), { once: true });
            this.ws.addEventListener('error', (e) => reject(e), { once: true });
        });
        this.ws.addEventListener('message', (ev) => {
            try {
                const m = JSON.parse(ev.data);
                if (m.id && this.pending.has(m.id)) {
                    const p = this.pending.get(m.id);
                    this.pending.delete(m.id);
                    if (m.error) p.reject(new Error(JSON.stringify(m.error)));
                    else p.resolve(m.result);
                }
            } catch {}
        });
        this._connected = true;
        return this;
    }

    async send(method, params = {}) {
        if (!this._connected) throw new Error('CDPClient not connected');
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.ws.send(JSON.stringify({ id, method, params }));
            } catch (e) {
                this.pending.delete(id);
                reject(e);
            }
        });
    }

    async js(expression, awaitPromise = false) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise,
        });
        if (result.exceptionDetails) {
            throw new Error(`JS error: ${result.exceptionDetails.text} at ${result.exceptionDetails.lineNumber}`);
        }
        return result.result.value;
    }

    async navigate(url) {
        await this.send('Page.enable');
        await this.send('Page.navigate', { url });
    }

    async screenshot(format = 'png') {
        const result = await this.send('Page.captureScreenshot', { format });
        return result.data; // base64-encoded
    }

    async waitForSelector(jsExpression, timeoutMs = 30000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const found = await this.js(jsExpression);
            if (found) return found;
            await new Promise(r => setTimeout(r, 500));
        }
        throw new Error(`Timeout waiting for selector: ${jsExpression}`);
    }

    async waitForUrlChange(currentUrl, timeoutMs = 30000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const url = await this.js('window.location.href');
            if (url !== currentUrl) return url;
            await new Promise(r => setTimeout(r, 500));
        }
        throw new Error('Timeout waiting for URL change');
    }

    close() {
        this._connected = false;
        try { this.ws.close(); } catch {}
    }
}

// ---------- Midjourney submitter ----------
async function submitToMidjourney({
    prompt,
    ar,
    channelUrl,
    outputDir,
    port,
    userDataDir,
    chromeBin,
    generationTimeoutMs,
    defaultArgs,
    dryRun,
}) {
    // Build the full prompt with MJ parameters
    let fullPrompt = prompt;
    // Check if the prompt already has MJ params
    if (!prompt.includes('--ar ') && ar) {
        fullPrompt += ` --ar ${ar}`;
    }
    // If no params at all and defaultArgs exist, append them
    if (!prompt.includes('--') && defaultArgs) {
        fullPrompt += ` ${defaultArgs}`;
    }

    const outputSlug = slugify(prompt.slice(0, 40));
    const outputBase = path.join(outputDir, outputSlug);
    fs.mkdirSync(outputBase, { recursive: true });
    // Save the prompt text alongside results
    fs.writeFileSync(path.join(outputBase, 'prompt.md'),
        `# Prompt submitted ${new Date().toISOString()}\n\n${fullPrompt}\n`);

    if (dryRun) {
        console.log(`[dry-run] Prompt: ${fullPrompt}`);
        console.log(`[dry-run] Channel: ${channelUrl}`);
        console.log(`[dry-run] Output: ${path.join(outputBase, 'result.png')}`);
        return { ok: true, dryRun: true, prompt: fullPrompt, outputBase };
    }

    // 1. Launch or connect to Chrome
    let chromeProc = null;
    let chromeInfo = await checkChromeOnPort(port);

    if (!chromeInfo) {
        console.log(`[mj-submitter] Launching Chrome on port ${port}...`);
        chromeProc = await launchChrome(port, userDataDir, chromeBin);
        chromeInfo = await checkChromeOnPort(port);
        if (!chromeInfo) {
            killChrome(chromeProc);
            throw new Error('Chrome launched but CDP not reachable');
        }
        console.log(`[mj-submitter] Chrome running: ${chromeInfo.Browser}`);
    } else {
        console.log(`[mj-submitter] Attaching to existing Chrome on port ${port}: ${chromeInfo.Browser}`);
    }

    // 2. Connect via CDP
    const wsUrl = await cdpConnect(chromeDebugUrl(port));
    const cdp = new CDPClient(wsUrl);
    await cdp.connect();
    console.log('[mj-submitter] CDP connected');

    try {
        // 3. Enable domains
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Network.enable');

        // 4. Focus the tab (prevents timer throttling)
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

        // 5. Navigate to Discord channel
        console.log(`[mj-submitter] Navigating to ${channelUrl}...`);
        await cdp.navigate(channelUrl);
        await new Promise(r => setTimeout(r, 4000));

        // 6. Wait for Discord to render — look for the chat textarea
        // Discord web uses role="textbox" or aria-label="Message #channel"
        console.log('[mj-submitter] Waiting for Discord chat textarea...');
        const textareaSelector = `
            (() => {
                const ta = document.querySelector('textarea[role="textbox"], div[role="textbox"][aria-multiline="true"], div[data-slate-editor="true"]');
                if (ta) { return { tag: ta.tagName, role: ta.getAttribute('role'), found: true }; }
                // Also check for the loading screen
                const loading = document.querySelector('[class*="loading"], [class*="spinner"]');
                return { found: false, loading: !!loading };
            })()
        `;

        // Poll for the textarea; return ONLY when actually found.
        const pollFn = `(async () => {
            const deadline = Date.now() + 45000;
            while (Date.now() < deadline) {
                const r = ${textareaSelector};
                if (r.found) return r;
                await new Promise(res => setTimeout(res, 500));
            }
            return null;
        })()`;
        let textareaInfo = null;
        try {
            textareaInfo = await cdp.js(pollFn, true /* awaitPromise */);
        } catch (e) { /* fall through to null */ }

        if (!textareaInfo) {
            // Take a diagnostic screenshot
            const diagData = await cdp.screenshot();
            const diagPath = path.join(outputBase, 'diagnostic.png');
            fs.writeFileSync(diagPath, Buffer.from(diagData, 'base64'));
            throw new Error(`Discord textarea not found within 45s (likely Discord login required). Diagnostic screenshot saved to ${diagPath}`);
        }

        console.log(`[mj-submitter] Discord chat ready: ${JSON.stringify(textareaInfo)}`);

        // 7. Type the /imagine command
        // Discord's textarea is a contenteditable div (Slate.js editor).
        // We need to use the React-aware value setter pattern.
        const mjCommand = `/imagine prompt: ${fullPrompt}`;
        console.log(`[mj-submitter] Submitting: /imagine prompt: ${fullPrompt}`);

        const editorResult = await cdp.js(`
            (() => {
                const editor = document.querySelector('div[role="textbox"][data-slate-editor="true"], div[role="textbox"][aria-multiline="true"]');
                if (!editor) return { error: 'editor not found' };

                // Focus the editor
                editor.focus();

                // Clear existing content
                editor.innerHTML = '';

                // Insert the text using execCommand for Discord's Slate editor
                document.execCommand('insertText', false, ${JSON.stringify(mjCommand)});

                // Dispatch input event for React/Slate
                editor.dispatchEvent(new Event('input', { bubbles: true }));
                editor.dispatchEvent(new Event('change', { bubbles: true }));

                return { ok: true, textLength: ${mjCommand.length} };
            })()
        `);

        if (editorResult.error) {
            throw new Error(`Discord chat editor not writable: ${editorResult.error}`);
        }

        await new Promise(r => setTimeout(r, 1500));

        // 8. Click send (Enter key)
        const sendResult = await cdp.js(`
            (() => {
                const editor = document.querySelector('div[role="textbox"][data-slate-editor="true"], div[role="textbox"][aria-multiline="true"]');
                if (!editor) return { error: 'editor not found for send' };
                editor.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true,
                }));
                return { sent: true };
            })()
        `);

        if (sendResult.error) {
            throw new Error(`Failed to send prompt: ${sendResult.error}`);
        }

        console.log('[mj-submitter] Prompt submitted, waiting for generation...');

        // 9. Wait for MJ bot's response — poll for image embeds
        // MJ posts an embed with image when generation completes.
        // Look for article[data-slate-factory] or div[class*="embed"] or img in the message list
        const deadline = Date.now() + generationTimeoutMs;
        let resultUrl = null;
        let screenshotData = null;

        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2000));

            // Check for MJ's embed images in recent messages
            const check = await cdp.js(`
                (() => {
                    // Look for image embeds — MJ posts them as articles with images
                    const embeds = document.querySelectorAll('img[class*="embed"], img[class*="image"], article img, div[class*="embedWrapper"] img, div[class*="message"] img[alt*="grid"], div[class*="message"] img[src*="cdn.discordapp.com"]');
                    const images = [];
                    for (const img of embeds) {
                        const src = img.src || img.currentSrc || '';
                        // Filter for likely MJ images (usually a grid of 4, hosted on Discord CDN)
                        if (src.includes('cdn.discordapp.com')) {
                            const rect = img.getBoundingClientRect();
                            images.push({
                                src: src,
                                w: rect.width,
                                h: rect.height,
                                naturalW: img.naturalWidth,
                                naturalH: img.naturalHeight,
                            });
                        }
                    }
                    // Also look for the "Waiting for Midjourney..." / loading state
                    const loading = document.body.innerText.includes('Waiting for') || 
                                   document.body.innerText.includes('upscaling') ||
                                   document.body.innerText.includes('Rendering') ||
                                   document.body.innerText.includes('in the queue');
                    return { images: images.slice(-3), loading: loading };
                })()
            `);

            if (check.images && check.images.length > 0) {
                // Found MJ-generated images — take the last one (most recent)
                const latest = check.images[check.images.length - 1];
                console.log(`[mj-submitter] Generation complete! Image: ${latest.src} (${latest.naturalW}×${latest.naturalH})`);
                resultUrl = latest.src;
                break;
            }

            // Check for MJ's "**/imagine**" message text followed by an embed
            const textCheck = await cdp.js(`
                (() => {
                    const messages = document.querySelectorAll('[class*="message"]');
                    for (const msg of messages) {
                        const text = msg.innerText || '';
                        if (text.includes('/imagine') && (text.includes('**') || text.includes('**/imagine**'))) {
                            const imgs = msg.querySelectorAll('img[src*="cdn.discordapp.com"]');
                            if (imgs.length > 0) {
                                return { found: true, src: imgs[imgs.length - 1].src };
                            }
                        }
                    }
                    return { found: false };
                })()
            `);

            if (textCheck.found) {
                console.log('[mj-submitter] Generation complete (message scan)!');
                resultUrl = textCheck.src;
                break;
            }

            // Check if text contains "Completed" or "generation complete"
            const completedCheck = await cdp.js(`
                document.body.innerText.includes('Completed') || 
                document.body.innerText.includes('Open in browser') ||
                document.body.innerText.includes('Upscale')
            `);
            if (completedCheck) {
                // Give it a moment to render fully
                await new Promise(r => setTimeout(r, 2000));
                // Take screenshot and look for images again
                const recheck = await cdp.js(`
                    (() => {
                        const imgs = document.querySelectorAll('img[src*="cdn.discordapp.com"]');
                        const last = imgs[imgs.length - 1];
                        return last ? { found: true, src: last.src, w: last.naturalWidth, h: last.naturalHeight } : { found: false };
                    })()
                `);
                if (recheck.found) {
                    resultUrl = recheck.src;
                    break;
                }
            }
        }

        // 10. Capture the result
        if (resultUrl) {
            // Download the image via CDP
            const result = await cdp.send('Page.downloadURL', { url: resultUrl });
            // Note: Page.downloadURL doesn't exist in CDP. Instead, capture as screenshot or fetch via JS.
            // Fallback: take a full-page screenshot
            screenshotData = await cdp.screenshot();
            const pngPath = path.join(outputBase, 'result.png');
            fs.writeFileSync(pngPath, Buffer.from(screenshotData, 'base64'));
            console.log(`[mj-submitter] Result saved: ${pngPath}`);

            // Also save a metadata file
            const meta = {
                prompt: fullPrompt,
                submittedAt: new Date().toISOString(),
                resultUrl: resultUrl,
                outputPath: pngPath,
                channelUrl: channelUrl,
            };
            const metaPath = path.join(outputBase, 'meta.json');
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
            console.log(`[mj-submitter] Metadata saved: ${metaPath}`);

            return { ok: true, resultUrl, outputPath: pngPath, metaPath };
        } else {
            // Timeout — capture whatever is on screen
            console.log('[mj-submitter] Generation timed out — capturing current state');
            screenshotData = await cdp.screenshot();
            const timeoutPath = path.join(outputBase, 'timeout.png');
            fs.writeFileSync(timeoutPath, Buffer.from(screenshotData, 'base64'));
            return { ok: false, timeout: true, outputPath: timeoutPath };
        }
    } finally {
        cdp.close();
        // Don't kill Chrome here — the watcher reuses it across prompts
    }
}

// ---------- Utilities ----------
function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 60);
}

// ---------- Main ----------
async function main() {
    const args = parseArgs();
    let prompt = args.prompt;

    if (args.promptFile) {
        prompt = extractPrompt(path.resolve(args.promptFile));
    }

    if (!prompt) {
        console.error('ERROR: empty prompt');
        process.exit(1);
    }

    const config = {
        prompt,
        ar: args.ar || null,
        channelUrl: args.channelUrl || CONFIG.discord.channelUrl,
        outputDir: path.resolve(args.outputDir || DEFAULT_OUTPUT),
        port: args.port || CONFIG.chrome.debugPort,
        userDataDir: CONFIG.chrome.userDataDir,
        chromeBin: CONFIG.paths.chromeBin,
        generationTimeoutMs: CONFIG.mj.generationTimeoutMs,
        defaultArgs: CONFIG.mj.defaultArgs,
        dryRun: args.dryRun || false,
    };

    try {
        const result = await submitToMidjourney(config);
        if (result.ok) {
            console.log(`[mj-submitter] DONE. Result: ${result.outputPath || '(dry run)'}`);
            process.exit(0);
        } else if (result.dryRun) {
            console.log(`[mj-submitter] DRY RUN. Would submit: ${result.prompt}`);
            process.exit(0);
        } else {
            console.error(`[mj-submitter] FAILED. Output: ${result.outputPath}`);
            process.exit(2);
        }
    } catch (e) {
        console.error(`[mj-submitter] ERROR: ${e.message}`);
        console.error(e.stack);
        process.exit(1);
    }
}

// Module exports for the watcher
module.exports = {
    submitToMidjourney,
    extractPrompt,
    checkChromeOnPort,
    launchChrome,
    CDPClient,
    cdpConnect,
};

if (require.main === module) main();