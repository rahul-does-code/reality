// SELECTION: a voice `select` + frame + point -> mask. Knows nothing about operations.
import type { Select } from "../commands/schema";
import { segmentAt, type SegResult } from "./segmenter";
import { applyRegion, coverage, dilate, erode, feather, refineRadius, type Point } from "./mask";

export type Selection = { mask: Uint8Array; alpha: Float32Array; note: string };

// One-entry cache so a voice "pointed" select reuses the mask from the click/pinch at that point.
let last: { frame: ImageData; x: number; y: number; job: Promise<SegResult> } | null = null;

/** segmentAt, memoized on (frame, point). Stage's click path calls this too. */
export function segmentPointed(frame: ImageData, p: Point): Promise<SegResult> {
  if (last && last.frame === frame && last.x === p.x && last.y === p.y) return last.job;
  const job = segmentAt(frame, p);
  last = { frame, x: p.x, y: p.y, job };
  return job;
}

/**
 * Resolve a `select` into a feathered alpha (plus the binary mask, for later refines).
 * `frame` must be the ORIGINAL frozen frame. `previousMask` is the current selection's binary
 * mask; a refine with no region applies to it, so "bigger" can be repeated.
 */
export async function resolveSelection(
  select: Select,
  frame: ImageData,
  point: Point | null,
  previousMask: Uint8Array | null,
): Promise<Selection | { error: string }> {
  const { width: w, height: h } = frame;
  const notes: string[] = [];
  let mask: Uint8Array;

  if (select.refine && !select.region && previousMask) {
    mask = previousMask;
  } else if (select.source === "face_part") {
    return { error: `face parts aren't supported yet (${select.face_part ?? "face"})` };
  } else if (select.source === "named") {
    // Text-prompted segmentation isn't built yet; the current selection stands in, as before.
    if (!previousMask) return { error: `can't find "${select.name}" by name yet: point at it first` };
    mask = previousMask;
    notes.push(`used selection for "${select.name}"`);
  } else if (point) {
    const res = await segmentPointed(frame, point);
    mask = res.mask;
    notes.push(res.source + (res.note ? ` (${res.note})` : ""));
  } else if (previousMask) {
    mask = previousMask;
  } else {
    return { error: "point at (click) an object first" };
  }

  if (select.region) {
    const { side, fraction } = select.region;
    mask = applyRegion(mask, w, h, side, fraction);
    notes.push(`${side} ${Math.round(fraction * 100)}%`);
  }
  if (select.refine) {
    const r = refineRadius(mask, w, h);
    const out = select.refine === "grow" ? dilate(mask, w, h, r) : erode(mask, w, h, r);
    if (coverage(out) > 0) {
      mask = out;
      notes.push(`${select.refine} ${r}px`);
    } else notes.push("too small to shrink");
  }
  if (coverage(mask) === 0) return { error: "selection is empty" };
  return { mask, alpha: feather(mask, w, h, 3), note: notes.join(" · ") };
}
