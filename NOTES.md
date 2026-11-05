# Notes: post-HackTX improvement pass (Nov 2026)

Work done after the hackathon, on branch `claude/affectionate-albattani-qpqn99`. Decisions made
without asking (Rahul delegated autonomy for the night) are marked **Assumption**.

## How quality is measured now

- `npm run eval:select -- <set dir> [n]`: the app's real selection code on labeled photos (Open
  Images val, built by `scripts/eval-prep.py`) in headless Chromium. mIoU, boundary IoU (±5px around
  the true outline), failure rates, latency, plus a 2-corrective-click refinement protocol.
- `npx tsx scripts/eval-hand.mts <dir> [n]`: the app's HandLandmarker on photos of hands with
  sensor noise (detection rate, real fingertip noise), replayed through the pointer filter on
  synthetic pointing motions (jitter at rest, lag, error when you pinch).
- Unit tests: `npm run test:mask`, `test:select`, `test:chooser`.

Headless numbers use the CPU (no GPU), so absolute latencies are pessimistic; compare methods.

## Decisions

- **Assumption:** EfficientSAM-Ti (Apache-2.0) is the click segmenter, run in the browser, with
  MediaPipe as fallback. Larger SAMs (SAM 2, SAM ViT-B) were not downloadable from this machine.
- **Assumption:** a click waits up to 4s (`SAM_WAIT_MS`) for SAM before falling back to MediaPipe.
  The embedding starts on freeze, so on WebGPU the wait is usually a few hundred ms.
- **Assumption:** models are downloaded by `scripts/setup.mjs` (EfficientSAM GitHub repo) rather
  than committed.
- Not done: fine-tuning SAM's decoder. The training script worked, but exporting the fine-tuned
  decoder to ONNX needs the `onnx` Python package, and installing it was not permitted in this
  session. The trained mask chooser (pure JS weights) is shipped instead.
- Not changed without Rahul: `main`. Everything after the first merge lives on the branch.

## Results

### Selection (Open Images val, 400 objects, 155 classes; real app code in headless Chromium)

| | center click | off-center click | IoU < 0.5 (center) |
|---|---|---|---|
| Old app: MediaPipe magic_touch | 0.644 | 0.614 | 31% |
| EfficientSAM, its own pick of 3 candidates | 0.600 | 0.574 | 35% |
| **New app: EfficientSAM + trained chooser** | **0.716** | **0.692** | **20%** |

Corrective clicks (each at the center of the largest error region):

| | 1 click | +1 | +2 |
|---|---|---|---|
| Old: Shift/Alt-click OR/cut a MediaPipe blob | 0.644 | 0.386 | 0.538 |
| **New: Shift/Alt-click add SAM points** | 0.716 | **0.725** | **0.757** |

The old add/subtract made a selection *worse* on average after one correction.

Soft edges (120 objects, boundary IoU within ±5px of the true outline): the plain feather (radius 3)
beats the guided-filter `edgeAlpha` added in the first pass (SAM: 0.503 vs 0.482; MediaPipe:
0.526 vs 0.501), so `edgeAlpha` was removed. It only ever won on a synthetic test.

Latency: SAM's encoder runs once per frozen frame, started on freeze. Headless CPU-only WASM:
p50 2.6s (5.6s with other jobs competing); not measured with WebGPU (no GPU here). A click
therefore shows MediaPipe's mask at once and swaps in SAM's when it is ready ("refining mask...");
once the embedding exists a click decodes in ~90ms (p50, headless).

### Hand pointer (`scripts/eval-hand.mts`)

- HandLandmarker found a hand in 62% of 150 varied Open Images photos (25% in all 30 noisy
  frames). These are harder than a webcam close-up; detection thresholds were not changed.
- Raw fingertip noise ~5.4px (150px hand); the aim-ahead point ~6.9px.
- The old filter (minCutoff 5, beta 0.2) barely filtered: 5.8px jitter at rest. New: minCutoff 3,
  beta 0.02, plus a separate 0.6Hz filter on the aim direction: ~3.2px at rest and ~1.9px error
  when you pinch after a fast reach (was 3.2px). Cost: ~8px trailing during fast moves (was ~4px).
- **Assumption:** 0.6Hz for the direction (0.3Hz scored slightly better, but the replay never
  rotates the finger, and a slower filter would make the aim swing late when you do).
