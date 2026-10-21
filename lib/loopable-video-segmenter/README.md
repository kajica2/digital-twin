# Loopable Video Segmenter (audio-aware) — local port

Port of the author's `kajica2/loopable-video-segmenter` Gradio app into the
digital-twin as a uv-managed local package: the same segmentation logic
(`core.py`, no gradio), a gradio UI (`ui.py` -> `127.0.0.1:7861`), and a
headless CLI (`lvs-segment segment`).

- **Setup:** `npm run lvs:setup` (`uv sync --project lib/loopable-video-segmenter`)
- **Self-check:** `npm run lvs:check`
- **UI:** `npm run lvs:ui`
- **CLI:** `npm run lvs:segment -- video.mp4 --segments 4`
- **ffmpeg** must be on PATH (MoviePy uses it for encode/decode): `brew install ffmpeg`

MIT — see the LICENSE in the source repo (`github.com/kajica2/loopable-video-segmenter`).