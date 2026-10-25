import { InteractiveSegmenterLegacy } from "@mediapipe/tasks-vision";
import { binarize, componentAt, coverage, fallbackMask, type Point } from "./mask";
import { loadLocalModel, visionFileset } from "./assets";

// Model is local if downloaded by `node scripts/setup.mjs`, else fetched from Google.
const LOCAL_MODEL = "/models/magic_touch.tflite";
const REMOTE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite";

export type SegResult = {
  mask: Uint8Array;
  source: "model" | "fallback";
  ms: number;
  note?: string;
  /** Share of the frame the mask covers, 0..1. */
  coverage: number;
  /** The point itself is in the mask (false: snapped to a blob within 14px, or the circle fallback missed it). */
  inside: boolean;
};

/** A pointed object covering more of the frame than this is a wrong mask (e.g. the background). */
export const MAX_POINT_COVERAGE = 0.45;
const MIN_POINT_COVERAGE = 0.002;

let segmenterPromise: Promise<InteractiveSegmenterLegacy> | null = null;

async function create(delegate: "GPU" | "CPU") {
  const fileset = await visionFileset();
  const buf = await loadLocalModel(LOCAL_MODEL);
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
 * Only a blob that contains the point (or snaps to it within 14px) is accepted, and one covering
 * more than MAX_POINT_COVERAGE is rejected unless `allowLarge` (the command is about the background).
 * Never throws: on any failure or implausible mask, returns a circle fallback.
 */
export async function segmentAt(frame: ImageData, p: Point, allowLarge = false): Promise<SegResult> {
  const t0 = performance.now();
  const { width: w, height: h } = frame;
  const maxCoverage = allowLarge ? 0.8 : MAX_POINT_COVERAGE;
  const fallback = (note: string): SegResult => {
    const mask = fallbackMask(w, h, p);
    return { mask, source: "fallback", ms: performance.now() - t0, note, coverage: coverage(mask), inside: true };
  };

  try {
    const seg = await initSegmenter();
    let picked: Uint8Array | null = null;
    let note = "no usable mask";

    seg.segment(frame, { keypoint: { x: p.x / w, y: p.y / h } }, (res) => {
      for (const m of res.confidenceMasks ?? []) {
        // Copy inside the callback: the buffer is only valid until it returns.
        const conf = m.getAsFloat32Array().slice();
        const bin = binarize(conf, m.width, m.height, w, h);
        const blob = componentAt(bin, w, h, p);
        if (!blob) {
          note = "no mask blob at the point";
          continue;
        }
        const cov = coverage(blob);
        if (cov >= MIN_POINT_COVERAGE && cov <= maxCoverage) {
          picked = blob;
          return;
        }
        note = `mask coverage ${(cov * 100).toFixed(1)}% out of range`;
      }
    });

    if (!picked) return fallback(note);
    const mask: Uint8Array = picked;
    const inside = !!mask[Math.min(h - 1, Math.max(0, Math.round(p.y))) * w + Math.min(w - 1, Math.max(0, Math.round(p.x)))];
    return { mask, source: "model", ms: performance.now() - t0, coverage: coverage(mask), inside };
  } catch (e) {
    return fallback(e instanceof Error ? e.message : String(e));
  }
}
