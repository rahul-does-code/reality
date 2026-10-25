// SELECTION: a voice `select` + frame + point -> mask. Knows nothing about operations.
import type { NamedInstance, Select, SelectSource, SegmentNamedResponse } from "../commands/schema";
import { segmentAt, type SegResult } from "./segmenter";
import { applyRegion, bbox, boxIoU, coverage, dilate, erode, feather, invert, refineRadius, type Point } from "./mask";
import { frameJpeg } from "./frameJpeg";
import { faceMask, FACE_PARTS as MESH_PARTS, type FacePart as MeshPart } from "./face";
import { aiSegmentWithin, getAiMask } from "./aiMask";
import { isClothing, segmentClothing } from "./clothing";

/**
 * mask: what edits apply to. subject: the same before any inversion, so "the background" is always
 * the inverse of the subject (saying it twice doesn't flip back). label: what is selected, e.g.
 * "taller bottle (named)"; "pointed" for a plain point selection (the marker shows it). usedPoint:
 * the mask was segmented at the stored point, so the marker still describes it.
 */
export type Selection = {
  mask: Uint8Array;
  subject: Uint8Array;
  alpha: Float32Array;
  note: string;
  label: string;
  source: SelectSource | "selection";
  usedPoint: boolean;
};

/** The selection a command starts from (Stage's current one, or the mask the last edit used). */
export type CurrentSelection = { mask: Uint8Array; subject: Uint8Array; label: string; pointed?: boolean } | null;

// One-entry cache so a voice "pointed" select reuses the mask from the click/pinch at that point.
let last: { frame: ImageData; x: number; y: number; allowLarge: boolean; job: Promise<SegResult> } | null = null;

/** segmentAt, memoized on (frame, point). Stage's click path calls this too. */
export function segmentPointed(frame: ImageData, p: Point, allowLarge = false): Promise<SegResult> {
  if (last && last.frame === frame && last.x === p.x && last.y === p.y && last.allowLarge === allowLarge) return last.job;
  const job = segmentAt(frame, p, allowLarge);
  last = { frame, x: p.x, y: p.y, allowLarge, job };
  return job;
}

// Named lookups cached per (frame, name). Every instance is kept, so a new point re-picks for free.
const namedCache = new WeakMap<ImageData, Map<string, Promise<{ instances: NamedInstance[]; ms: number }>>>();

function findNamed(frame: ImageData, name: string): { job: Promise<{ instances: NamedInstance[]; ms: number }>; cached: boolean } {
  let byName = namedCache.get(frame);
  if (!byName) namedCache.set(frame, (byName = new Map()));
  const key = name.trim().toLowerCase();
  const hit = byName.get(key);
  if (hit) return { job: hit, cached: true };
  const job = fetch("/api/segment-named", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frame: frameJpeg(frame), name }),
  }).then(async (res) => {
    let body: SegmentNamedResponse;
    try {
      body = (await res.json()) as SegmentNamedResponse;
    } catch {
      throw new Error(`proxy ${res.status}: is the server running?`);
    }
    if ("error" in body) throw new Error(body.error);
    return body;
  });
  byName.set(key, job);
  job.catch(() => byName.delete(key)); // don't cache failures
  return { job, cached: false };
}

/** Instance whose box is nearest the point (0 if inside; tightest box wins ties). No point: the first. */
function nearest(instances: NamedInstance[], p: Point | null): NamedInstance {
  if (!p) return instances[0];
  const score = ({ box }: NamedInstance) => {
    const dx = Math.max(box.x0 - p.x, 0, p.x - box.x1);
    const dy = Math.max(box.y0 - p.y, 0, p.y - box.y1);
    return [Math.hypot(dx, dy), (box.x1 - box.x0) * (box.y1 - box.y0)];
  };
  return instances.reduce((best, i) => {
    const [d, a] = score(i);
    const [bd, ba] = score(best);
    return d < bd || (d === bd && a < ba) ? i : best;
  });
}

/** Normalized polygons -> binary mask at frame size (union). */
function rasterize(polygons: [number, number][][], w: number, h: number): Uint8Array {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  for (const polygon of polygons) {
    ctx.beginPath();
    polygon.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
    ctx.closePath();
    ctx.fill();
  }
  const px = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 3] > 127 ? 1 : 0;
  return out;
}

// Box -> mask results, per (frame, name, instance), so repeating a named command is instant.
const boxMaskCache = new WeakMap<ImageData, Map<string, Promise<{ mask: Uint8Array; iou: number; sample: number } | null>>>();

const SAMPLE_NAMES = ["center", "left", "right", "top", "bottom"];

/**
 * Segment at the box center and four points 25% of the box away from it, and keep the mask whose
 * bounding box best matches Gemini's box (IoU). null if the segmenter produced nothing usable.
 */
export function maskForBox(frame: ImageData, key: string, box: NamedInstance["box"]) {
  let byKey = boxMaskCache.get(frame);
  if (!byKey) boxMaskCache.set(frame, (byKey = new Map()));
  const hit = byKey.get(key);
  if (hit) return hit;
  const { width: w, height: h } = frame;
  const px = { x: box.x0 * w, y: box.y0 * h, w: (box.x1 - box.x0) * w, h: (box.y1 - box.y0) * h };
  const cx = px.x + px.w / 2;
  const cy = px.y + px.h / 2;
  const samples: Point[] = [
    { x: cx, y: cy },
    { x: cx - px.w * 0.25, y: cy },
    { x: cx + px.w * 0.25, y: cy },
    { x: cx, y: cy - px.h * 0.25 },
    { x: cx, y: cy + px.h * 0.25 },
  ];
  const job = (async () => {
    let best: { mask: Uint8Array; iou: number; sample: number } | null = null;
    for (const [i, pt] of samples.entries()) {
      const res = await segmentAt(frame, pt);
      if (res.source !== "model") continue; // the circle fallback says nothing about the object
      const b = bbox(res.mask, w, h);
      const iou = b ? boxIoU(b, px) : 0;
      if (!best || iou > best.iou) best = { mask: res.mask, iou, sample: i };
    }
    return best;
  })();
  byKey.set(key, job);
  return job;
}

const MAX_BOX_AREA = 0.7; // a "found" box covering most of the frame is a guess, not a find
const MIN_IOU = 0.4;

/**
 * Gemini finds `name` in the frame; the instance nearest the point (if any) is used. The stored
 * point is only used to choose an instance, never as the segmentation prompt.
 */
async function segmentNamed(
  frame: ImageData,
  name: string,
  p: Point | null,
): Promise<{ mask: Uint8Array; note: string } | { error: string }> {
  const { width: w, height: h } = frame;
  const { job, cached } = findNamed(frame, name);
  let found: { instances: NamedInstance[]; ms: number };
  try {
    found = await job;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (!found.instances.length) return { error: "not in view" };
  const inst = nearest(found.instances, p ? { x: p.x / w, y: p.y / h } : null);
  const { box } = inst;
  const area = (box.x1 - box.x0) * (box.y1 - box.y0);
  if (area > MAX_BOX_AREA) return { error: `box covers ${Math.round(area * 100)}% of the frame` };
  const of = found.instances.length > 1 ? ` (nearest of ${found.instances.length})` : "";
  const timing = cached ? "cached" : `gemini ${found.ms}ms`;
  const label = `"${inst.label || name}"${of} · ${timing}`;
  if (inst.polygons) {
    const mask = rasterize(inst.polygons, w, h);
    if (coverage(mask) > 0) return { mask, note: `${label} · gemini mask` };
  }
  const key = `${name.trim().toLowerCase()}|${found.instances.indexOf(inst)}`;
  const best = await maskForBox(frame, key, box);
  if (!best || best.iou < MIN_IOU) return { error: `best mask/box IoU ${best ? best.iou.toFixed(2) : "none"} < ${MIN_IOU}` };
  return { mask: best.mask, note: `${label} · IoU ${best.iou.toFixed(2)} (${SAMPLE_NAMES[best.sample]} sample)` };
}

export const notFound = (name: string) => `Couldn't find '${name}' - try again or point at it.`;

/**
 * Resolve a `select` into a feathered alpha (plus the binary mask, for later refines).
 * `frame` must be the ORIGINAL frozen frame. `current` is the selection to build on: refines,
 * regions without a point, and "background" apply to it. refine "clear"/"only"/"add"/"subtract" are
 * handled by Stage; here they behave like no refine.
 */
export async function resolveSelection(
  select: Select,
  frame: ImageData,
  point: Point | null,
  current: CurrentSelection,
): Promise<Selection | { error: string }> {
  const { width: w, height: h } = frame;
  const notes: string[] = [];
  const sizeRefine = select.refine === "grow" || select.refine === "shrink" ? select.refine : null;
  let base: Uint8Array;
  let label: string;
  let source: Selection["source"] = select.source;
  let usedPoint = false;
  let inverted = select.invert;

  if (sizeRefine && !select.region && current) {
    base = current.mask;
    label = current.label;
    source = "selection";
    inverted = false; // grow/shrink what is selected now, inverted or not
  } else if (select.source === "face_part") {
    const part = select.face_part ?? "face";
    if (!MESH_PARTS.includes(part as MeshPart)) return { error: `"${part}" isn't a supported face part yet` };
    const m = await faceMask(frame, part as MeshPart, w, h); // largest face
    if (!m || coverage(m) === 0) return { error: "No face found" };
    base = m;
    label = `${part.replace("_", " ")} (face)`;
    notes.push("face landmarks");
  } else if (select.source === "background") {
    if (!current) return { error: "Point at the subject first, then say 'blur the background'" };
    base = current.subject;
    label = current.label === "pointed" ? "the pointed object" : current.label;
    inverted = true;
  } else if (select.source === "named") {
    const name = select.name?.trim() || "that";
    const clothing = !!select.name && isClothing(select.name);
    if (clothing && current?.pointed && !select.invert) {
      // "turn my shirt pink" while pointing at it: the pointed mask is the user's own choice.
      base = current.mask;
      label = current.label;
      source = "selection";
      notes.push(`pointed selection kept for "${name}" · mask ${(coverage(base) * 100).toFixed(1)}% of frame`);
    } else {
      const named = !select.name
        ? { error: "no name given" }
        : clothing
          ? await segmentClothing(frame, select.name, point)
          : await segmentNamed(frame, select.name, point);
      // No fallback to the point or the current selection: editing the wrong thing is worse than nothing.
      if (!("mask" in named)) {
        console.warn(`[select] named "${name}" failed: ${named.error}`);
        return { error: notFound(name) };
      }
      base = named.mask;
      notes.push(named.note);
      label = `${name} (named)`;
    }
  } else if (point) {
    // Only a command about the background/inverse may pick a mask covering most of the frame.
    // AI mask (vision + SAM, see aiMask.ts) if it arrives within AI_MASK_WAIT_MS, else the MediaPipe one.
    const ai = getAiMask() === "always" ? await aiSegmentWithin(frame, point, select.invert) : null;
    const res = ai ?? (await segmentPointed(frame, point, select.invert));
    base = res.mask;
    usedPoint = true;
    if (ai) label = ai.name ? `${ai.name} (${ai.source})` : ai.source === "fallback" ? "pointed (fallback)" : "pointed";
    else label = res.source === "fallback" ? "pointed (fallback)" : "pointed";
    notes.push(ai ? `ai ${ai.source} ${ai.ms}ms (${ai.note})` : res.source + (res.note ? ` (${res.note})` : "") + (getAiMask() === "always" ? " · ai mask timed out" : ""));
  } else if (current) {
    base = current.mask;
    label = current.label;
    source = "selection";
  } else {
    return { error: "point at (click) an object first" };
  }

  if (select.region) {
    const { side, fraction } = select.region;
    base = applyRegion(base, w, h, side, fraction);
    const part = `${side} ${Math.round(fraction * 100)}%`;
    notes.push(part);
    label = `${label}, ${part}`;
  }
  if (sizeRefine) {
    const r = refineRadius(base, w, h);
    const out = sizeRefine === "grow" ? dilate(base, w, h, r) : erode(base, w, h, r);
    if (coverage(out) > 0) {
      base = out;
      notes.push(`${sizeRefine} ${r}px`);
    } else notes.push("too small to shrink");
  }
  let mask = base;
  if (inverted) {
    mask = invert(base);
    usedPoint = false; // the marker sits on the excluded object
    label = select.source === "background" ? `background (except ${label})` : `everything except ${label}`;
    notes.push("inverted");
  }
  if (coverage(mask) === 0) return { error: "selection is empty" };
  return { mask, subject: base, alpha: feather(mask, w, h, 3), note: notes.join(" · "), label, source, usedPoint };
}
