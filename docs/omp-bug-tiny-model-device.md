# `local/qwen3-1.7b: default providers.tinyModelDevice=cpu-onnx is broken on Apple silicon; download CLI ignores config.yml`

## Summary

OMP ships `providers.tinyModelDevice` defaulted to `cpu-onnx`. On Apple silicon the ONNX runtime cannot execute Qwen3's RotaryEmbedding cache updates, so every request against `local/qwen3-1.7b` fails. Compounding this, `omp tiny-models download` reads only the `PI_TINY_DEVICE` env var and ignores `~/.omp/agent/config.yml:providers.tinyModelDevice`, so a user who correctly configures the device still cannot pull the model without first discovering the env var.

## Environment

- macOS 25.6.0 (Tahoe), arm64 Apple M4 Pro, 25.7 GB RAM
- `omp` v18.8.6 (`~/.local/bin/omp`), bun 1.4.2, node v26.3.0
- OMP config: `modelRoles.tiny: local/qwen3-1.7b` (default)
- Default `~/.omp/agent/config.yml` ships with `providers.tinyModelDevice: cpu-onnx`
- No other local model runners active: `/usr/local/bin/ollama` is a dangling symlink; LM Studio present but empty; ports 11434/1234/8080 closed

## Defect 1: default device broken on Apple silicon

**Repro:**

1. On a fresh install (or after `omp config set modelRoles.tiny local/qwen3-1.7b`), run any OMP session that triggers judgment or title generation.
2. Observe in `~/.omp/logs/*.log`:
   - `judgment candidate failed, candidate: local/qwen3-1.7b, error: judgment: local model qwen3-1.7b returned no output`
   - `title-generator: local tiny model produced no title; skipping (no online fallback)`

**Expected:** The default device on Apple silicon should be a working runtime (e.g. `mlx`). At minimum, OMP should auto-select a working device for the platform.

**Actual:** Default is `cpu-onnx` everywhere. onnxruntime-node cannot run Qwen3's RotaryEmbedding cache; the request always fails.

**Workaround:** `omp config set providers.tinyModelDevice mlx`. Persists in `~/.omp/agent/config.yml` as `providers.tinyModelDevice: mlx`. After applying, the same OMP session produced 0 of the above errors (previously 138+ across a single debug session).

## Defect 2: download CLI ignores config.yml

**Repro:**

1. Apply the workaround above: `omp config set providers.tinyModelDevice mlx`.
2. Run `omp tiny-models download qwen3-1.7b` without setting any env var.
3. Observe the download fails to find the runtime, even though `~/.omp/agent/config.yml` is correctly configured.

**Expected:** The download CLI should consult the same config the rest of OMP uses. If a runtime mismatch is detected, it should print a clear error pointing at the right knob.

**Actual:** The CLI reads only `PI_TINY_DEVICE` from the environment. A user with a correctly configured install cannot pull the model without first discovering the env var (by reading the binary, or by trial and error).

**Workaround:** `PI_TINY_DEVICE=mlx omp tiny-models download qwen3-1.7b` pulled 944 MB in 26.6 s on a 35 MB/s link. Once the model is on disk, OMP uses it correctly (provided defect 1 is also worked around).

## Suggested fix direction

1. Auto-select the runtime on Apple silicon: if `process.platform === 'darwin' && process.arch === 'arm64'`, default `providers.tinyModelDevice` to `mlx` (or surface the choice at install time).
2. Make `omp tiny-models download` consult `~/.omp/agent/config.yml:providers.tinyModelDevice` first; fall back to `PI_TINY_DEVICE`; if neither is set, print a clear error.
3. Optionally: validate at install time that the selected runtime can actually materialize the configured model — fail loud, not silent.

## Notes

- Verified end-to-end on the workaround stack: MLX worker loads `mlx-community/Qwen3-1.7B-4bit` in 0.5–0.7 s; generation probes return non-empty text.
- The 138 → 0 error count is from a single OMP debug session (`omp-report-2026-10-09T05-23-50-828Z.tar.gz`).
- Two related low-severity findings observed but not blocking: a stale `~/.omp/run/tiny/qwen3-1.7b-onnx.sock` lockfile survives the device switch, and `title.generator: fork` (online) is the default even when a local model is available.