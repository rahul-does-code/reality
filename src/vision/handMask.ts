// Keep the pointing hand out of a selection: when the pointer source is "finger", the segmenter
// often grabs the finger along with the object. Mask the hand's (dilated) convex hull out, then
// tidy the cut: fill small holes away from the hand and drop small slivers left beside it.
import { fillPolygon } from "./lasso";
import { dilate, type Point } from "./mask";

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Andrew's monotone chain; returns hull points in order (no repeat of the first). */
export function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Convex hull of the 21 hand landmarks (frame px), dilated by `dilatePx` to cover finger width. */
export function handHullMask(landmarks21Px: Point[], w: number, h: number, dilatePx = 12): Uint8Array {
  const hull = convexHull(landmarks21Px);
  const filled = fillPolygon(hull, w, h);
  return dilatePx > 0 ? dilate(filled, w, h, dilatePx) : filled;
}

/** Label 4-connected components where `on(i)` holds; calls visit(pixels, touchesBorder). */
function forComponents(w: number, h: number, on: (i: number) => boolean, visit: (px: Int32Array, n: number, border: boolean) => void) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const comp = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || !on(s)) continue;
    let sp = 0;
    let n = 0;
    let border = false;
    stack[sp++] = s;
    seen[s] = 1;
    while (sp) {
      const i = stack[--sp];
      comp[n++] = i;
      const x = i % w;
      const y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x > 0 && !seen[i - 1] && on(i - 1)) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < w - 1 && !seen[i + 1] && on(i + 1)) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0 && !seen[i - w] && on(i - w)) { seen[i - w] = 1; stack[sp++] = i - w; }
      if (y < h - 1 && !seen[i + w] && on(i + w)) { seen[i + w] = 1; stack[sp++] = i + w; }
    }
    visit(comp, n, border);
  }
}

/**
 * mask minus the hand hull. Then: holes smaller than `smallPx` that don't touch the hull are filled
 * (segmentation pinholes), and islands smaller than `smallPx` are dropped (finger-edge slivers)
 * unless they are the largest island, so a small object is never erased entirely.
 * Holes left by the hand itself stay open. Default smallPx = 0.15% of the frame (min 64).
 */
export function removeHand(mask: Uint8Array, hullMask: Uint8Array, w: number, h: number, smallPx?: number): Uint8Array {
  const small = smallPx ?? Math.max(64, Math.round(w * h * 0.0015));
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] & (hullMask[i] ^ 1);

  forComponents(w, h, (i) => !out[i], (px, n, border) => {
    if (border || n >= small) return;
    for (let k = 0; k < n; k++) if (hullMask[px[k]]) return;
    for (let k = 0; k < n; k++) out[px[k]] = 1;
  });
  const islands: Int32Array[] = [];
  forComponents(w, h, (i) => out[i] === 1, (px, n) => islands.push(px.slice(0, n)));
  const largest = islands.reduce((m, c) => Math.max(m, c.length), 0);
  for (const c of islands) {
    if (c.length >= small || c.length === largest) continue;
    for (let k = 0; k < c.length; k++) out[c[k]] = 0;
  }
  return out;
}
