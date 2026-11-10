// Complete local memory story; runs on a repo-root host or E2E_URL deployment.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const art = join(root, 'e2e/artifacts/twin-workspace');
await rm(art, { recursive: true, force: true });
await mkdir(art, { recursive: true });
const base = process.env.E2E_URL || 'http://127.0.0.1:5188';
let server;
if (!process.env.E2E_URL) {
  server = spawn(process.execPath, ['lib/serve.js', '--port', '5188', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base)).ok) break; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const browser = await puppeteer.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
const watchdog = setTimeout(() => { console.error('Workspace test exceeded 90 seconds'); browser.close(); }, 90000);
const errors = [];
const page = await browser.newPage();
page.on('pageerror', error => errors.push(error.message));
const click = selector => page.click(selector);
const value = async (selector, text) => {
  await page.$eval(selector, (node, text) => { node.value = text; node.dispatchEvent(new Event('input', { bubbles: true })); }, text);
};
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('dt-memory-v1')));
const capture = async text => {
  await click('[data-capture-open]'); await value('[data-memory-text]', text); await click('[data-memory-save]');
};
const status = () => page.$eval('[data-memory-status]', node => node.textContent);
try {
  await page.setViewport({ width: 1280, height: 900 });
  assert.equal((await page.goto(base + '/pages/twin-os/', { waitUntil: 'networkidle0' })).status(), 200);
  await page.waitForFunction(() => customElements.get('twin-memory'));
  assert.equal(await page.$eval('[data-memory-total]', node => node.textContent), '0');
  assert.ok((await page.$eval('.patterns', node => node.previousElementSibling.textContent)).includes('examples'));

  await capture('Željko: use the muted trumpet take. #Jazz #release');
  await capture('<img src=x onerror="window.injected=true"> #reference');
  assert.equal((await stored()).notes.length, 2);
  assert.match(await status(), /saved on this browser/);
  await click('[data-panel="twin"].rail-item');
  assert.equal(await page.$('.memory-text img'), null, 'note HTML must remain text');
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await value('[data-memory-search]', 'zeljko jazz');
  assert.equal(await page.$$eval('.memory-card', nodes => nodes.length), 1);
  await click('[data-memory-save-search]');
  await capture('Željko: keep the second solo. #jazz');
  await click('[data-panel="twin"].rail-item');
  assert.equal(await page.$$eval('.memory-card', nodes => nodes.length), 2, 'saved search includes new matches');
  await click('.memory-card .memory-actions button:first-child'); // pin the first search result
  assert.equal((await stored()).notes.filter(note => note.pinned).length, 1);
  await page.reload({ waitUntil: 'networkidle0' });
  await click('[data-panel="twin"].rail-item');
  assert.equal((await stored()).spaces.length, 1);
  assert.equal(await page.$eval('.memory-card', node => node.dataset.pinned), 'true');
  await click('.memory-card .memory-actions button:nth-child(2)');
  await value('[data-memory-text]', 'Revised solo decision. #jazz');
  await click('[data-memory-save]');
  assert.ok((await stored()).notes.some(note => note.text === 'Revised solo decision. #jazz'));
  assert.equal((await stored()).notes.length, 3, 'editing preserves identity');
  console.log('PASS capture, literal text rendering, accent search, saved searches, pin, edit and reload');

  await click('[data-command-open]');
  await value('[data-command-search]', 'revised solo');
  assert.equal(await page.$$eval('.command-result', nodes => nodes.length), 1);
  await page.focus('[data-command-search]'); await page.keyboard.press('Enter');
  assert.equal(await page.$eval('section[data-panel="twin"]', node => node.hidden), false);
  await click('[data-command-open]'); await value('[data-command-search]', 'mp4 maker');
  await page.focus('[data-command-search]'); await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'command-result');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('[data-command-dialog]', node => node.open), false);
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  assert.equal(await page.$eval('[data-command-dialog]', node => node.open), true);
  await page.keyboard.press('Escape');
  await click('[data-command-open]'); await value('[data-command-search]', 'how-to guide');
  await page.focus('[data-command-search]');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.keyboard.press('Enter')]);
  assert.ok(new URL(page.url()).pathname.endsWith('/pages/how-to.html'), 'tool command opens the correct page');
  await page.goto(base + '/pages/twin-os/', { waitUntil: 'networkidle0' });
  console.log('PASS palette recall, tool lookup, keyboard navigation, Escape and Ctrl K');

  await click('[data-panel="twin"].rail-item');
  await value('[data-memory-search]', '');
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: art });
  await click('[data-memory-export]');
  let backupPath;
  for (let i = 0; i < 50; i++) {
    const name = (await readdir(art)).find(name => /^twin-memory-\d.*\.json$/.test(name));
    if (name) { backupPath = join(art, name); break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(backupPath, 'actual backup download completes');
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.equal(backup.app, 'digital-twin-memory'); assert.equal(backup.notes.length, 3);
  await click('.memory-card .memory-actions button:nth-child(3)');
  assert.equal((await stored()).notes.length, 2);
  await click('[data-memory-undo]'); assert.equal((await stored()).notes.length, 3);
  await click('.memory-card .memory-actions button:nth-child(3)');
  const fileInput = await page.$('[data-memory-import]');
  await fileInput.uploadFile(backupPath);
  await page.waitForFunction(() => document.querySelector('[data-memory-status]').textContent.includes('Backup imported'));
  assert.equal((await stored()).notes.length, 3);
  await fileInput.uploadFile(backupPath);
  await page.waitForFunction(() => document.querySelector('[data-memory-status]').textContent.includes('0 new memories'));
  assert.equal((await stored()).notes.length, 3);
  const invalid = join(art, 'invalid-backup.json');
  await writeFile(invalid, JSON.stringify({ ...backup, notes: [backup.notes[0], null] }));
  await fileInput.uploadFile(invalid);
  await page.waitForFunction(() => document.querySelector('[data-memory-status]').textContent.includes('not imported'));
  assert.equal((await stored()).notes.length, 3);
  console.log('PASS downloaded backup, delete, undo, merge restore, idempotent reimport and malformed import');

  // A second tab writes using the same origin; the first tab must preserve that work.
  const other = await browser.newPage();
  await other.goto(base + '/twin-os/', { waitUntil: 'networkidle0' });
  await other.type('[data-memory-text]', 'Second tab memory #jazz'); await other.click('[data-memory-save]');
  await page.bringToFront();
  await page.waitForFunction(() => document.querySelector('[data-memory-total]').textContent === '4', { polling: 100, timeout: 5000 });
  await capture('First tab continued'); assert.equal((await stored()).notes.length, 5);
  await other.close();

  await page.evaluate(async () => { await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker did not activate')), 8000))]); });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  let offlineCount = 5;
  for (const skin of ['house', 'studio']) {
    await page.goto(base + '/pages/twin-os/?skin=' + skin, { waitUntil: 'networkidle0' });
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => customElements.get('twin-memory'));
    assert.equal(await page.$eval('[data-memory-total]', node => node.textContent), String(offlineCount));
    assert.notEqual(await page.$eval('body', node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    await capture('Offline ' + skin + ' capture'); offlineCount++;
    assert.match(await status(), /saved on this browser/);
    await page.setOfflineMode(false);
  }
  console.log('PASS shared root entry point, tab refresh, offline shell, both skins and offline capture');

  for (const theme of ['light', 'dark']) {
    await click(`theme-toggle [data-value="${theme}"]`); await click('[data-panel="twin"].rail-item');
    await page.screenshot({ path: join(art, 'memory-' + theme + '.png'), fullPage: true });
  }
  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile has no horizontal overflow');
  await page.screenshot({ path: join(art, 'memory-mobile.png'), fullPage: true });

  const context = await browser.createBrowserContext(); const denied = await context.newPage();
  await denied.evaluateOnNewDocument(() => { Storage.prototype.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); }; });
  await denied.goto(base + '/pages/twin-os/', { waitUntil: 'networkidle0' });
  await denied.type('[data-memory-text]', 'Keep this unsaved draft'); await denied.click('[data-memory-save]');
  assert.match(await denied.$eval('[data-memory-status]', n => n.textContent), /not saved/);
  assert.equal(await denied.$eval('[data-memory-text]', n => n.value), 'Keep this unsaved draft');
  await context.close();
  const corruptContext = await browser.createBrowserContext(); const corrupt = await corruptContext.newPage();
  await corrupt.evaluateOnNewDocument(() => localStorage.setItem('dt-memory-v1', '{broken'));
  await corrupt.goto(base + '/pages/twin-os/', { waitUntil: 'networkidle0' });
  assert.match(await corrupt.$eval('[data-memory-status]', n => n.textContent), /left untouched/);
  assert.equal(await corrupt.evaluate(() => localStorage.getItem('dt-memory-v1')), '{broken');
  await corruptContext.close();
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('PASS themes, mobile, quota failures retain drafts, corrupt storage is preserved and no browser exceptions');
} finally {
  clearTimeout(watchdog); await browser.close(); if (server) server.kill();
}
