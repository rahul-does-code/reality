import { FilesetResolver, InteractiveSegmenterLegacy } from "@mediapipe/tasks-vision";
import { binarize, componentAt, coverage, fallbackMask, invert, type Point } from "./mask";

// WASM is copied to public/ by `node scripts/setup.mjs`. Model is local if downloaded, else fetched from Google.
const WASM_PATH = "/mediapipe-wasm";
const LOCAL_MODEL = "/models/magic_touch.tflite";
const REMOTE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite";

export type SegResult = { mask: Uint8Array; source: "model" | "fallback"; ms: number; note?: string };

let segmenterPromise: Promise<InteractiveSegmenterLegacy> | null = null;

async function loadLocalModel(): Promise<Uint8Array | null> {
  try {
    const r = await fetch(LOCAL_MODEL);
    const type = r.headers.get("content-type") ?? "";
    // Vite serves index.html for missing files, so reject HTML responses.
    if (r.ok && !type.includes("text/html")) return new Uint8Array(await r.arrayBuffer());
  } catch {
    /* fall through to remote */
  }
  return null;
}

async function create(delegate: "GPU" | "CPU") {
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  const buf = await loadLocalModel();
  return InteractiveSegmenterLegacy.createFromOptions(fileset, {
    baseOptions: buf
      ? { modelAssetBuffer: buf, delegate }
      : { modelAssetPath: REMOTE_MODEL, delegate },
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
}

/** Call on mount so the first click is fast. Safe to call repeatedly. */
export function initSegmenter(): Promise<InteractiveSegmenterLegacy> {
  if (!segmenterPromise) {
    segmenterPromise = create("GPU").catch(() => create("CPU"));
    segmenterPromise.catch(() => {
      segmenterPromise = null; // allow retry on next call
    });
  }
  return segmenterPromise;
}

/**
 * Segment the object under point `p` (frame pixel coords).
 * Never throws: on any failure or implausible mask, returns a circle fallback.
 */
export async function segmentAt(frame: ImageData, p: Point): Promise<SegResult> {
  const t0 = performance.now();
  const { width: w, height: h } = frame;
  const fallback = (note: string): SegResult => ({
    mask: fallbackMask(w, h, p),
    source: "fallback",
    ms: performance.now() - t0,
    note,
  });

  try {
    const seg = await initSegmenter();
    let picked: Uint8Array | null = null;
    let note = "no usable mask";

    seg.segment(frame, { keypoint: { x: p.x / w, y: p.y / h } }, (res) => {
      for (const m of res.confidenceMasks ?? []) {
        // Copy inside the callback: the buffer is only valid until it returns.
        const conf = m.getAsFloat32Array().slice();
        const bin = binarize(conf, m.width, m.height, w, h);
        // Try as-is, then inverted (in case the channel is background confidence).
        for (const cand of [bin, invert(bin)]) {
          const blob = componentAt(cand, w, h, p);
          if (!blob) continue;
          const cov = coverage(blob);
          if (cov >= 0.002 && cov <= 0.8) {
            picked = blob;
            return;
          }
          note = `mask coverage ${(cov * 100).toFixed(1)}% out of range`;
        }
      }
    });

    if (!picked) return fallback(note);
    return { mask: picked, source: "model", ms: performance.now() - t0 };
  } catch (e) {
    return fallback(e instanceof Error ? e.message : String(e));
  }
}
