// While the view is frozen, finds where the edited object has moved to in the live glasses video, so
// the glasses display can keep its overlay on the object when the wearer moves (the display's own gyro
// covers head turns between these fixes). Template matching on small grayscale copies: the object's
// box from the ORIGINAL frozen frame, searched by normalized cross-correlation near its last position.

export type Box = { x: number; y: number; w: number; h: number };
export type TrackFix = { dx: number; dy: number; score: number }; // frame px from the frozen position

const TEMPLATE_PX = 48; // template's long side after downscaling
const MIN_SCORE = 0.55;
const MAX_BOX_SHARE = 0.5; // larger than this (of the frame) is the scene, not an object to track

/** Bounding box (frame px) of what the display draws: pixels the edits changed, plus the selection. */
export function overlayBox(original: ImageData, current: ImageData, alpha: Float32Array | null): Box | null {
  const { width: w, height: h } = original;
  const a = original.data;
  const b = current.data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const j = i * 4;
      const changed =
        current !== original &&
        Math.max(Math.abs(a[j] - b[j]), Math.abs(a[j + 1] - b[j + 1]), Math.abs(a[j + 2] - b[j + 2])) > 10;
      if (!changed && !(alpha && alpha[i] > 0.5)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function grayScaled(src: CanvasImageSource, w: number, h: number, s: number) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const g = new Float32Array(c.width * c.height);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return { g, w: c.width, h: c.height };
}

export class ObjectTracker {
  private s: number;
  private tpl: Float32Array; // zero-mean template
  private tplNorm: number;
  private tx: number; // template position in the small frame
  private ty: number;
  private tw: number;
  private th: number;
  private px: number; // last found position (small px)
  private py: number;

  /** null when the box is too big (or too small) to track. */
  static create(original: ImageData, box: Box): ObjectTracker | null {
    const { width: w, height: h } = original;
    if (box.w * box.h > MAX_BOX_SHARE * w * h || box.w < 4 || box.h < 4) return null;
    const t = new ObjectTracker(original, box);
    return t.tplNorm > 1 ? t : null; // a flat patch can't be matched
  }

  private constructor(original: ImageData, box: Box) {
    this.s = Math.min(1, TEMPLATE_PX / Math.max(box.w, box.h));
    const c = document.createElement("canvas");
    c.width = original.width;
    c.height = original.height;
    c.getContext("2d")!.putImageData(original, 0, 0);
    const small = grayScaled(c, original.width, original.height, this.s);
    this.tx = Math.round(box.x * this.s);
    this.ty = Math.round(box.y * this.s);
    this.tw = Math.max(2, Math.min(small.w - this.tx, Math.round(box.w * this.s)));
    this.th = Math.max(2, Math.min(small.h - this.ty, Math.round(box.h * this.s)));
    this.px = this.tx;
    this.py = this.ty;
    const n = this.tw * this.th;
    this.tpl = new Float32Array(n);
    let mean = 0;
    for (let y = 0; y < this.th; y++)
      for (let x = 0; x < this.tw; x++) mean += this.tpl[y * this.tw + x] = small.g[(this.ty + y) * small.w + this.tx + x];
    mean /= n;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      this.tpl[i] -= mean;
      ss += this.tpl[i] * this.tpl[i];
    }
    this.tplNorm = Math.sqrt(ss);
  }

  /** Where the object is in `live` (same size as the frozen frame), or null if no confident match. */
  locate(live: CanvasImageSource, w: number, h: number): TrackFix | null {
    const f = grayScaled(live, w, h, this.s);
    const { tw, th, tpl } = this;
    const r = Math.max(6, Math.round(0.6 * Math.max(tw, th)));
    let best = -2, bx = this.px, by = this.py;
    const n = tw * th;
    for (let oy = this.py - r; oy <= this.py + r; oy++) {
      if (oy < 0 || oy + th > f.h) continue;
      for (let ox = this.px - r; ox <= this.px + r; ox++) {
        if (ox < 0 || ox + tw > f.w) continue;
        let sum = 0, sumSq = 0, cross = 0;
        for (let y = 0; y < th; y++) {
          const row = (oy + y) * f.w + ox;
          const trow = y * tw;
          for (let x = 0; x < tw; x++) {
            const v = f.g[row + x];
            sum += v;
            sumSq += v * v;
            cross += v * tpl[trow + x]; // tpl is zero-mean, so the window mean drops out of the cross term
          }
        }
        const varSum = sumSq - (sum * sum) / n;
        if (varSum <= 1e-3) continue;
        const score = cross / (Math.sqrt(varSum) * this.tplNorm);
        if (score > best) {
          best = score;
          bx = ox;
          by = oy;
        }
      }
    }
    if (best < MIN_SCORE) return null;
    this.px = bx;
    this.py = by;
    return { dx: (bx - this.tx) / this.s, dy: (by - this.ty) / this.s, score: best };
  }
}
