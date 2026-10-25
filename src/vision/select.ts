// SELECTION: a voice `select` + frame + point -> mask. Knows nothing about operations.
import type { NamedInstance, Select, SegmentNamedResponse } from "../commands/schema";
import { segmentAt, type SegResult } from "./segmenter";
import { applyRegion, coverage, dilate, erode, feather, refineRadius, type Point } from "./mask";
import { frameJpeg } from "./frameJpeg";

/** label: what is selected, for the stage, e.g. "taller bottle (named)". */
export type Selection = { mask: Uint8Array; alpha: Float32Array; note: string; label: string };

// One-entry cache so a voice "pointed" select reuses the mask from the click/pinch at that point.
let last: { frame: ImageData; x: number; y: number; job: Promise<SegResult> } | null = null;

/** segmentAt, memoized on (frame, point). Stage's click path calls this too. */
export function segmentPointed(frame: ImageData, p: Point): Promise<SegResult> {
  if (last && last.frame === frame && last.x === p.x && last.y === p.y) return last.job;
  const job = segmentAt(frame, p);
  last = { frame, x: p.x, y: p.y, job };
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

/** Keep only pixels inside the (pixel) box; a missing mask fills the whole box. */
function clipToBox(mask: Uint8Array | null, box: NamedInstance["box"], w: number, h: number) {
  const out = new Uint8Array(w * h);
  for (let y = Math.max(0, Math.floor(box.y0 * h)); y < Math.min(h, Math.ceil(box.y1 * h)); y++) {
    for (let x = Math.max(0, Math.floor(box.x0 * w)); x < Math.min(w, Math.ceil(box.x1 * w)); x++) {
      out[y * w + x] = mask ? mask[y * w + x] : 1;
    }
  }
  return out;
}

/**
 * Gemini finds `name` in the frame; the instance nearest the point becomes the mask. With only a box
 * (the default), the point segmenter runs inside it (at the point if it's in the box, else the box
 * center) and the result is clipped to the box.
 */
async function segmentNamed(frame: ImageData, name: string, p: Point | null): Promise<{ mask: Uint8Array; note: string } | { error: string }> {
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
  const of = found.instances.length > 1 ? ` (nearest of ${found.instances.length})` : "";
  const timing = cached ? "cached" : `gemini ${found.ms}ms`;
  const label = `"${inst.label || name}"${of} · ${timing}`;
  if (inst.polygons) {
    const mask = rasterize(inst.polygons, w, h);
    if (coverage(mask) > 0) return { mask, note: `${label} · gemini mask` };
  }
  const { box } = inst;
  const inBox = p && p.x >= box.x0 * w && p.x <= box.x1 * w && p.y >= box.y0 * h && p.y <= box.y1 * h;
  const seed = inBox ? p : { x: ((box.x0 + box.x1) / 2) * w, y: ((box.y0 + box.y1) / 2) * h };
  const res = await segmentPointed(frame, seed);
  const clipped = res.source === "model" ? clipToBox(res.mask, box, w, h) : null;
  const ok = clipped && coverage(clipped) > 0;
  const mask = ok ? clipped : clipToBox(null, box, w, h);
  return { mask, note: `${label} · ${ok ? `segmented in box at ${inBox ? "point" : "center"}` : "filled box"}` };
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
  let label = "pointed";

  if (select.refine && !select.region && previousMask) {
    mask = previousMask;
    label = select.source === "named" && select.name ? `${select.name} (named)` : "selection";
  } else if (select.source === "face_part") {
    return { error: `face parts aren't supported yet (${select.face_part ?? "face"})` };
  } else if (select.source === "named") {
    const name = select.name?.trim() || "that";
    const named = select.name ? await segmentNamed(frame, select.name, point) : { error: "no name given" };
    // No fallback to the point or the current selection: editing the wrong thing is worse than nothing.
    if (!("mask" in named)) {
      console.warn(`[select] named "${name}" failed: ${named.error}`);
      return { error: `Couldn't find '${name}' - try again or point at it.` };
    }
    mask = named.mask;
    notes.push(named.note);
    label = `${name} (named)`;
  } else if (point) {
    const res = await segmentPointed(frame, point);
    mask = res.mask;
    notes.push(res.source + (res.note ? ` (${res.note})` : ""));
  } else if (previousMask) {
    mask = previousMask;
    label = "selection"; // Stage keeps the current label
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
  return { mask, alpha: feather(mask, w, h, 3), note: notes.join(" · "), label };
}
