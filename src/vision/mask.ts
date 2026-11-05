export type Point = { x: number; y: number }; // pixel coords in frame space

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Fraction of pixels set in a binary mask. */
export function coverage(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n / mask.length;
}

/** Keep only the connected blob containing the point (snaps to nearest set pixel within snap px). */
export function componentAt(mask: Uint8Array, w: number, h: number, p: Point, snap = 14): Uint8Array | null {
  const px = clamp(Math.round(p.x), 0, w - 1);
  const py = clamp(Math.round(p.y), 0, h - 1);
  let start = py * w + px;

  if (!mask[start]) {
    let best = -1;
    let bestD = Infinity;
    for (let dy = -snap; dy <= snap; dy++) {
      for (let dx = -snap; dx <= snap; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD && mask[y * w + x]) {
          bestD = d;
          best = y * w + x;
        }
      }
    }
    if (best < 0) return null;
    start = best;
  }

  const out = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  stack[sp++] = start;
  out[start] = 1;
  while (sp) {
    const i = stack[--sp];
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0 && mask[i - 1] && !out[i - 1]) { out[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < w - 1 && mask[i + 1] && !out[i + 1]) { out[i + 1] = 1; stack[sp++] = i + 1; }
    if (y > 0 && mask[i - w] && !out[i - w]) { out[i - w] = 1; stack[sp++] = i - w; }
    if (y < h - 1 && mask[i + w] && !out[i + w]) { out[i + w] = 1; stack[sp++] = i + w; }
  }
  return out;
}

/** Threshold a float mask (any size) into a binary mask at frame size (nearest-neighbor resample). */
export function binarize(conf: Float32Array, mw: number, mh: number, w: number, h: number, thr = 0.5): Uint8Array {
  const out = new Uint8Array(w * h);
  if (mw === w && mh === h) {
    for (let i = 0; i < out.length; i++) out[i] = conf[i] > thr ? 1 : 0;
    return out;
  }
  for (let y = 0; y < h; y++) {
    const sy = Math.min(mh - 1, Math.floor((y / h) * mh));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(mw - 1, Math.floor((x / w) * mw));
      out[y * w + x] = conf[sy * mw + sx] > thr ? 1 : 0;
    }
  }
  return out;
}

export function invert(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 1;
  return out;
}

/** Last-resort mask so the demo never dead-ends: a filled circle around the point. */
export function fallbackMask(w: number, h: number, p: Point, r = 80): Uint8Array {
  const out = new Uint8Array(w * h);
  const r2 = r * r;
  const y0 = Math.max(0, Math.floor(p.y - r));
  const y1 = Math.min(h - 1, Math.ceil(p.y + r));
  const x0 = Math.max(0, Math.floor(p.x - r));
  const x1 = Math.min(w - 1, Math.ceil(p.x + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - p.x;
      const dy = y - p.y;
      if (dx * dx + dy * dy <= r2) out[y * w + x] = 1;
    }
  }
  return out;
}

export function bbox(mask: Uint8Array, w: number, h: number) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const k = 2 * r + 1;
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + clamp(i, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / k;
      sum += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)];
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += tmp[clamp(i, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / k;
      sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

/** Binary mask -> soft 0..1 alpha. Blur, then a slight gain so the edge grows ~1px and halos are covered. */
export function feather(mask: Uint8Array, w: number, h: number, radius = 3): Float32Array {
  const f = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) f[i] = mask[i];
  const blurred = boxBlur(boxBlur(f, w, h, radius), w, h, Math.max(1, radius - 1));
  for (let i = 0; i < blurred.length; i++) blurred[i] = Math.min(1, blurred[i] * 1.4);
  return blurred;
}

/**
 * Keep only one side of the mask's bounding box: e.g. side "top", fraction 0.5 = top half of the
 * object. "center" keeps the middle `fraction` of the box in both directions.
 */
export function applyRegion(
  mask: Uint8Array,
  w: number,
  h: number,
  side: "top" | "bottom" | "left" | "right" | "center",
  fraction: number,
): Uint8Array {
  const b = bbox(mask, w, h);
  if (!b) return mask;
  const f = clamp(fraction, 0, 1);
  let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h; // half-open box to keep
  if (side === "top") y1 = b.y + Math.round(b.h * f);
  else if (side === "bottom") y0 = y1 - Math.round(b.h * f);
  else if (side === "left") x1 = b.x + Math.round(b.w * f);
  else if (side === "right") x0 = x1 - Math.round(b.w * f);
  else {
    const mx = Math.round((b.w * (1 - f)) / 2);
    const my = Math.round((b.h * (1 - f)) / 2);
    x0 += mx; x1 -= mx; y0 += my; y1 -= my;
  }
  const out = new Uint8Array(mask.length);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) out[y * w + x] = mask[y * w + x];
  }
  return out;
}

/** Square-kernel morphology via the box blur: any set pixel within r (dilate) or all of them (erode). */
function morph(mask: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  const f = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) f[i] = mask[i];
  const avg = boxBlur(f, w, h, r);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = (grow ? avg[i] > 1e-3 : avg[i] > 1 - 1e-3) ? 1 : 0;
  return out;
}

export const dilate = (mask: Uint8Array, w: number, h: number, r: number) => morph(mask, w, h, r, true);
export const erode = (mask: Uint8Array, w: number, h: number, r: number) => morph(mask, w, h, r, false);

/** Grow/shrink step in px: 3-6, scaled with the object's size so small things don't vanish. */
export function refineRadius(mask: Uint8Array, w: number, h: number): number {
  const b = bbox(mask, w, h);
  if (!b) return 3;
  return clamp(Math.round(Math.min(b.w, b.h) * 0.03), 3, 6);
}

export type Box = { x: number; y: number; w: number; h: number };

/** Intersection over union of two pixel boxes (0 if either is empty). */
export function boxIoU(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}
