// Stroke -> mask. A closed stroke is a lasso (polygon fill); an open stroke is a scribble prompt for
// the MediaPipe interactive segmenter. Both fall back to the polygon or a thin dilated stroke so a
// gesture always selects something. Pure mask math except segmentScribble.
import { initSegmenter, MAX_POINT_COVERAGE, type SegResult } from "./segmenter";
import { binarize, componentAt, coverage, dilate, type Point } from "./mask";

export type CombineMode = "replace" | "add" | "subtract";

/** End within this fraction of the stroke's bbox diagonal of the start = closed. */
const CLOSE_FRAC = 0.08;
/** Looser gap allowed when the stroke already encloses most of its bbox (a "C" that nearly meets). */
const LOOSE_CLOSE_FRAC = 0.3;
const MIN_FILL_FRAC = 0.35;
const MAX_SCRIBBLE_POINTS = 30;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function boundsOf(points: Point[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** Shoelace area of the polygon implied by the points (closing edge included). */
export function polygonArea(points: Point[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return Math.abs(a) / 2;
}

/**
 * True if the stroke is meant as a loop: the end comes back near the start (or near any of the
 * first 15% of points, for overshoots), or nearly meets while enclosing most of its bounding box.
 */
export function isClosed(points: Point[]): boolean {
  if (points.length < 4) return false;
  const b = boundsOf(points);
  const diag = Math.hypot(b.w, b.h);
  if (diag < 1) return false;
  const end = points[points.length - 1];
  const head = Math.max(1, Math.floor(points.length * 0.15));
  let gap = Infinity;
  for (let i = 0; i < head; i++) gap = Math.min(gap, Math.hypot(end.x - points[i].x, end.y - points[i].y));
  if (gap <= CLOSE_FRAC * diag) return true;
  return gap <= LOOSE_CLOSE_FRAC * diag && polygonArea(points) >= MIN_FILL_FRAC * b.w * b.h;
}

/** Scanline fill (nonzero winding, pixel centers) of the polygon; returns a w*h 0/1 mask. */
export function fillPolygon(points: Point[], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const n = points.length;
  if (n < 3) return out;
  const b = boundsOf(points);
  const yStart = clamp(Math.floor(b.y0), 0, h - 1);
  const yEnd = clamp(Math.ceil(b.y1), 0, h - 1);
  const xs: { x: number; dir: number }[] = [];
  for (let y = yStart; y <= yEnd; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = points[j];
      const c = points[i];
      if ((a.y <= cy && c.y > cy) || (c.y <= cy && a.y > cy)) {
        xs.push({ x: a.x + ((cy - a.y) / (c.y - a.y)) * (c.x - a.x), dir: c.y > a.y ? 1 : -1 });
      }
    }
    xs.sort((p, q) => p.x - q.x);
    let wind = 0;
    for (let k = 0; k < xs.length - 1; k++) {
      wind += xs[k].dir;
      if (!wind) continue;
      const x0 = clamp(Math.ceil(xs[k].x - 0.5), 0, w);
      const x1 = clamp(Math.ceil(xs[k + 1].x - 0.5), 0, w);
      out.fill(1, y * w + x0, y * w + x1);
    }
  }
  return out;
}

/** Resample by arc length to <= 30 evenly spaced points, normalized to 0..1 (segmenter input). */
export function strokeToScribble(points: Point[], w: number, h: number): { x: number; y: number }[] {
  const norm = (p: Point) => ({ x: clamp(p.x / w, 0, 1), y: clamp(p.y / h, 0, 1) });
  if (points.length <= 1) return points.map(norm);
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const total = cum[cum.length - 1];
  if (total === 0) return [norm(points[0])];
  const count = Math.min(MAX_SCRIBBLE_POINTS, points.length);
  const out: { x: number; y: number }[] = [];
  let seg = 1;
  for (let k = 0; k < count; k++) {
    const d = (k / (count - 1)) * total;
    while (seg < points.length - 1 && cum[seg] < d) seg++;
    const span = cum[seg] - cum[seg - 1];
    const t = span > 0 ? (d - cum[seg - 1]) / span : 0;
    const a = points[seg - 1];
    const c = points[seg];
    out.push(norm({ x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t }));
  }
  return out;
}

/** The stroke itself as a mask: the polyline dilated to ~1.2% of the short side (>= 4px). */
export function strokeMask(points: Point[], w: number, h: number, radius?: number): Uint8Array {
  const line = new Uint8Array(w * h);
  const set = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi >= 0 && yi >= 0 && xi < w && yi < h) line[yi * w + xi] = 1;
  };
  if (points.length) set(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const c = points[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(c.x - a.x, c.y - a.y)));
    for (let s = 1; s <= steps; s++) set(a.x + ((c.x - a.x) * s) / steps, a.y + ((c.y - a.y) * s) / steps);
  }
  const r = radius ?? Math.max(4, Math.round(Math.min(w, h) * 0.012));
  return dilate(line, w, h, r);
}

/** Union of the connected blobs under any of the points (componentAt for each, deduplicated). */
function componentsAt(mask: Uint8Array, w: number, h: number, pts: Point[]): Uint8Array | null {
  let out: Uint8Array | null = null;
  for (const p of pts) {
    const i = clamp(Math.round(p.y), 0, h - 1) * w + clamp(Math.round(p.x), 0, w - 1);
    if (out && out[i]) continue;
    const blob = componentAt(mask, w, h, p);
    if (!blob) continue;
    if (!out) out = blob;
    else for (let k = 0; k < out.length; k++) out[k] |= blob[k];
  }
  return out;
}

/** Fallback for a stroke: its polygon if it encloses real area, else the thin dilated stroke. */
function strokeFallback(points: Point[], w: number, h: number): Uint8Array {
  const b = boundsOf(points);
  if (points.length >= 3 && polygonArea(points) >= MIN_FILL_FRAC * b.w * b.h && b.w > 8 && b.h > 8) {
    const poly = fillPolygon(points, w, h);
    if (coverage(poly) > 0) return poly;
  }
  return strokeMask(points, w, h);
}

/**
 * Segment the object(s) under a scribble (frame px points) with the interactive segmenter.
 * Same post-processing as segmentAt (binarize, keep blobs under the scribble, reject implausible
 * coverage) and never an inverted mask. Never throws: falls back to strokeFallback.
 */
export async function segmentScribble(frame: ImageData, points: Point[]): Promise<SegResult> {
  const t0 = performance.now();
  const { width: w, height: h } = frame;
  const result = (mask: Uint8Array, source: SegResult["source"], note?: string): SegResult => ({
    mask,
    source,
    ms: performance.now() - t0,
    note,
    coverage: coverage(mask),
    inside: true, // the mask comes from the stroke itself, not from a single point
  });
  const fallback = (note: string): SegResult => result(strokeFallback(points, w, h), "fallback", note);
  if (!points.length) return fallback("empty stroke");

  try {
    const seg = await initSegmenter();
    const scribble = strokeToScribble(points, w, h);
    const probes = scribble.map((q) => ({ x: q.x * w, y: q.y * h }));
    let picked: Uint8Array | null = null;
    let note = "no usable mask";

    seg.segment(frame, { scribble }, (res) => {
      for (const m of res.confidenceMasks ?? []) {
        // Copy inside the callback: the buffer is only valid until it returns.
        const conf = m.getAsFloat32Array().slice();
        const bin = binarize(conf, m.width, m.height, w, h);
        const blob = componentsAt(bin, w, h, probes);
        if (!blob) continue;
        const cov = coverage(blob);
        if (cov >= 0.002 && cov <= MAX_POINT_COVERAGE) {
          picked = blob;
          return;
        }
        note = `mask coverage ${(cov * 100).toFixed(1)}% out of range`;
      }
    });

    if (!picked) return fallback(note);
    return result(picked, "model");
  } catch (e) {
    return fallback(e instanceof Error ? e.message : String(e));
  }
}

export type StrokeSelection = Omit<SegResult, "source"> & {
  kind: "lasso" | "scribble";
  /** "lasso" = exact polygon fill, "model" = scribble segmentation, "fallback" = see note. */
  source: SegResult["source"] | "lasso";
};

/** One entry point for a finished stroke: closed = lasso polygon, open = scribble segmentation. */
export async function selectStroke(frame: ImageData, points: Point[]): Promise<StrokeSelection> {
  const { width: w, height: h } = frame;
  if (isClosed(points)) {
    const t0 = performance.now();
    const poly = fillPolygon(points, w, h);
    const done = (mask: Uint8Array, source: StrokeSelection["source"], note?: string): StrokeSelection => ({
      kind: "lasso",
      mask,
      source,
      ms: performance.now() - t0,
      note,
      coverage: coverage(mask),
      inside: true,
    });
    if (coverage(poly) > 0) return done(poly, "lasso");
    return done(strokeMask(points, w, h), "fallback", "degenerate lasso");
  }
  return { kind: "scribble", ...(await segmentScribble(frame, points)) };
}

/** replace: B. add: A or B. subtract: A and not B. A null A counts as empty. */
export function combine(maskA: Uint8Array | null, maskB: Uint8Array, mode: CombineMode): Uint8Array {
  if (mode === "replace") return maskB.slice();
  if (!maskA) return mode === "add" ? maskB.slice() : new Uint8Array(maskB.length);
  const out = new Uint8Array(maskB.length);
  if (mode === "add") for (let i = 0; i < out.length; i++) out[i] = maskA[i] | maskB[i];
  else for (let i = 0; i < out.length; i++) out[i] = maskA[i] & (maskB[i] ^ 1);
  return out;
}
