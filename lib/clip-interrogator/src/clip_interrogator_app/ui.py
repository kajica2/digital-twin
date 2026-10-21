"""Gradio UI for the CLIP Interrogator port.

Modernized from the upstream HF space (pharma/CLIP-Interrogator):

- ``gr.Label(label=...)`` outputs (the removed ``num_top_classes`` / the
  not-a-gradio-5.x ``num_classes`` parameters are gone; a plain
  ``gr.Label`` renders the ``{label: score}`` dict with score-ordered
  bars).
- ``api_name`` lives on the ``.click()`` events, not on the Button
  constructors (``gr.Button(api_name=...)`` is not a gradio 5.x API).
- No ``run_on_click=True`` / ``cache_examples=True`` on ``gr.Examples``
  (both were removed upstream; examples just fill inputs).
- No ``ex.dataset.headers = [""]`` line.
- Share-to-community button, HF duplicate badge and Colab boilerplate dropped.
- All components are built inside a single Blocks-context builder and every
  handler receives its components as explicit parameters — no module-scope
  globals defined after a function that references them (fixes the latent
  bug in the upstream ``analyze_tab()``).
- ``api_name="image-to-prompt"`` / ``api_name="image-analysis"`` kept (on
  the click events) so the programmatic API matches upstream.
"""

from __future__ import annotations

import gradio as gr

from . import config
from .core import ModelManager, example_image, image_analysis, image_to_prompt


def build_gradio_app() -> gr.Blocks:
    """Construct the two-tab app. Nothing is loaded until a handler runs."""
    manager = ModelManager(shared_blip=True)  # BLIP shared across both CLIPs
    examples = [example_image("example01.jpg"), example_image("example02.jpg")]
    choices = config.display_names()

    def _prompt_handler(image, model_display, mode):
        model_id = config.DISPLAY_TO_ID.get(model_display)
        if model_id is None:
            raise gr.Error(f"unknown model {model_display!r}")
        return image_to_prompt(manager, image, model_id, mode)

    def _analyze_handler(image, model_display):
        model_id = config.DISPLAY_TO_ID.get(model_display)
        if model_id is None:
            raise gr.Error(f"unknown model {model_display!r}")
        ranks = image_analysis(manager, image, model_id, top=5)
        return (
            ranks["medium"],
            ranks["artist"],
            ranks["movement"],
            ranks["trending"],
            ranks["flavor"],
        )

    with gr.Blocks(title="CLIP Interrogator") as demo:
        gr.Markdown(
            "# CLIP Interrogator\n\n"
            "Want to figure out what a good prompt might be to create new "
            "images like an existing one? The CLIP Interrogator is here to "
            "get you answers."
        )

        with gr.Tab("Prompt"):
            with gr.Row():
                input_image = gr.Image(type="pil", label="Image")
                with gr.Column():
                    input_model = gr.Dropdown(
                        choices=choices, value=choices[0], label="CLIP Model"
                    )
                    input_mode = gr.Radio(
                        choices=list(config.MODES), value="best", label="Mode"
                    )
            submit_btn = gr.Button("Submit")
            output_text = gr.Textbox(label="Output", lines=6)
            submit_btn.click(
                _prompt_handler,
                inputs=[input_image, input_model, input_mode],
                outputs=[output_text],
                api_name="image-to-prompt",
            )
            gr.Examples(
                examples=[
                    [str(examples[0]), choices[0], "best"],
                    [str(examples[1]), choices[0], "best"],
                ],
                inputs=[input_image, input_model, input_mode],
            )

        with gr.Tab("Analyze"):
            with gr.Row():
                analyze_image = gr.Image(type="pil", label="Image")
                analyze_model = gr.Dropdown(
                    choices=choices, value=choices[0], label="CLIP Model"
                )
            with gr.Row():
                medium = gr.Label(label="Medium")
                artist = gr.Label(label="Artist")
                movement = gr.Label(label="Movement")
                trending = gr.Label(label="Trending")
                flavor = gr.Label(label="Flavor")
            analyze_btn = gr.Button("Analyze")
            analyze_btn.click(
                _analyze_handler,
                inputs=[analyze_image, analyze_model],
                outputs=[medium, artist, movement, trending, flavor],
                api_name="image-analysis",
            )
            gr.Examples(
                examples=[
                    [str(examples[0]), choices[0]],
                    [str(examples[1]), choices[0]],
                ],
                inputs=[analyze_image, analyze_model],
            )

    return demo


def main() -> None:
    build_gradio_app().queue(max_size=64).launch(
        server_name="127.0.0.1",
        server_port=7860,
        show_api=False,
    )


if __name__ == "__main__":
    main()