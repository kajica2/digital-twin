# Refael MP4 Maker

**Refael** turns an MP3 into a 1920×1080 MP4 with an auto-generated
typographic cover — fully offline, in the browser, no upload. Single
track, custom image, or batch a folder. It is the third local tool in
the Twin OS Songs panel (after MuScriptor and the CLIP Interrogator).

## Origin

- Hugging Face Space: `kaidjuric/refael-mp4-maker` (static SDK, MIT)
  — https://huggingface.co/spaces/kaidjuric/refael-mp4-maker
- Part of the **Sainted Word Records** portfolio. The canonical source
  lives on the author's other machine at
  `~/Documents/autodashboard/refael-mp4-maker` (single
  `index.html`), auto-deployed to the Space via the
  `hf-clean-redploy.py` queue. The repo copy is the ported artifact:
  `pages/refael-mp4-maker.html` — the Space's `index.html` plus one
  hygiene line: a data-URI favicon (the page's own "R" monogram, so
  browsers stop auto-requesting `/favicon.ico` → 404 → console
  error). Everything else is byte-identical.

## What it does

- **Three render engines** behind one "Render mode" radio group:
  - `⚡ Fast (offline)` — WebCodecs (`VideoEncoder` + `AudioEncoder`),
    sub-second for short tracks, your CPU.
  - `🛡 FFmpeg.wasm` — full ffmpeg compiled to WASM; lazy-loads from
    unpkg.com **on first use** (see offline caveat below).
  - `🐢 Real-time` — MediaRecorder; renders in wall-clock time.
- **Auto covers** — deterministic from track name + artist. Mood
  keyword detection (dark / light / fire / love / ocean / earth, in
  English + Serbian/Cyrillic) picks a palette; "Auto (match mood)"
  styles cascade through cover style, title layout, and font pair.
  Same name = same cover, every time.
- **One HTML file** — Fraunces/Inter design, dark-only, fonts
  embedded as data URIs. Works from `file://` with no server, no
  install, no network.
- **PWA** — blob-URL manifest + inline service worker; installable
  when served over HTTP(S).
- **Built-in selftest** — open with `?selftest=1` to run an
  end-to-end fast-path render (3s sine → MP4) with a visible log
  overlay. This is the manual smoke lever for the render pipeline.

## Offline caveat

The footer's "0 network calls" claim is true for the **default
path**: page load, cover rendering, and the Fast engine make zero
requests. The **FFmpeg.wasm** engine is the exception — it
lazy-loads `@ffmpeg/ffmpeg@0.12.10` + core from unpkg.com on first
use of that mode (then the browser caches them). `?selftest=1`'s
`fetch('/__selftest_upload__')` probe only fires in selftest mode
and is a no-op outside it.

## How to run

```bash
python3 -m http.server 5173 --directory pages
# open http://127.0.0.1:5173/refael-mp4-maker.html
```

or simply open `pages/refael-mp4-maker.html` directly from disk
(`file://`) — everything works with no server.

## E2E

`e2e/refael.spec.mjs` is a Puppeteer contract spec, Python-free,
same URL convention as `clip-interrogator.spec.mjs`:

```bash
cd e2e
PORT=5180 node refael.spec.mjs       # requires: python3 -m http.server 5180 --directory pages
```

Asserts: title + hero, offline badge, 3-tab tablist with the first
active, 3 engine radios with Fast checked, engine pill + hint, render
buttons disabled until input, 1920×1080 canvases, output-info row,
"0 network calls" footer claim, ffmpeg one-liner `<details>`, the
random-name generator actually fills the title input, internal links
don't 404 on the page, the Twin OS `data-tool-refael` card, and 0
console errors / failed requests on both pages (dark screenshot in
`e2e/artifacts/`).

The selftest render (`?selftest=1`) is deliberately NOT in the spec —
WebCodecs in headless Chrome is flaky across versions; it stays a
manual smoke lever (`node refael.spec.mjs` covers the static
contract; open `?selftest=1` in a real browser to exercise the
render path).

## Attribution

MIT-licensed. Ported from the author's own `kaidjuric/refael-mp4-maker`
Space (private source: Sainted Word Records portfolio).