import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const url = process.argv[2] || 'http://127.0.0.1:5173/pages/vhs-gif-maker.html';
// The sample clip lives in the repo root when one is checked out there.
// It is resolved from the script's own location, never hardcoded: an
// absolute path in a tracked file is a path that is wrong everywhere
// except on the machine it was written on.
const clip = process.argv[3] || path.join(ROOT, 'test-input.mp4');
if (!fs.existsSync(clip)) {
  console.error(`no sample clip at ${clip}`);
  console.error('usage: node repro-vhs.mjs [pageUrl] [clipPath]');
  process.exit(2);
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', m => console.log('[console]', m.type(), m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'networkidle2' });

const input = await page.$('#fileInput');
await input.uploadFile(clip);

const state = await page.evaluate(() => {
  const v = document.getElementById('previewVideo');
  return { readyState: v.readyState, src: v.src.slice(0, 40), duration: v.duration, videoWidth: v.videoWidth };
});
console.log('after upload:', state);

await page.click('#generateBtn');
await new Promise(r => setTimeout(r, 12000));
const status = await page.$eval('#status', el => ({ text: el.textContent, cls: el.className }));
console.log('status:', status);
const gif = await page.$eval('#outputGif', el => el.src.slice(0, 30));
console.log('gif src:', gif);
await browser.close();
