"""Gradio UI for the Loopable Video Segmenter (port of the author's app.py).

Mirrors the upstream Blocks exactly (plain 5.x-safe APIs). Launches on
127.0.0.1:7861 — deliberately NOT 7860, which the CLIP Interrogator owns.
"""

from __future__ import annotations

import gradio as gr

from .core import create_loopable_segments


def build_gradio_app():
    with gr.Blocks(title="Loopable Video Segmenter with librosa") as demo:
        gr.Markdown(
            "# MP4 → Loopable Segments (Audio-Aware)\n"
            "Upload a long MP4, choose how many segments, and download a ZIP of loopable clips.\n"
            "Segments are aligned with musical beats detected by **librosa** (falls back to equal time if no audio/beats)."
        )
        with gr.Row():
            video = gr.Video(label="Upload MP4")
            with gr.Column():
                num = gr.Slider(1, 20, value=4, step=1, label="Number of segments")
                loopable = gr.Checkbox(
                    value=True,
                    label="Make each segment loopable (forward + reverse)",
                )
                btn = gr.Button("Create segments")
        out_zip = gr.File(label="Download ZIP")
        status = gr.Textbox(label="Status")

        btn.click(
            fn=create_loopable_segments,
            inputs=[video, num, loopable],
            outputs=[out_zip, status],
            api_name="create-segments",
        )
    return demo


if __name__ == "__main__":
    build_gradio_app().launch(server_name="127.0.0.1", server_port=7861, show_api=False)