// Live recolor: recolors the pointed object on the MOVING video (no freeze).
// Two loops share one mask:
// - render: every animation frame, draw the video and recolor inside the current alpha, touching
//   only the mask's bounding box (capped work size, alpha upsampled bilinearly, GPU blend).
// - segmentation: every 300-1000ms (3x the measured segmentation time), segment a ~640px
//   downscale of the live frame; one in flight at a time; successive masks are blended (EMA).
// While the pointer holds still the seed follows the object (interior point of the last mask),
// so the color tracks a moving object; moving the pointer re-aims.
import { initSegmenter, segmentAt } from "../vision/segmenter";
import { bbox, boxIoU, feather, type Box, type Point } from "../vision/mask";
import { recolor } from "./recolor";

const SEG_WIDTH = 640;
const MIN_INTERVAL_MS = 300;
const MAX_INTERVAL_MS = 1000;
const EMA_NEW = 0.6; // weight of the newest mask in the blend
const REPLACE_IOU = 0.3; // box IoU below this = the object moved a lot: replace, don't blend
const MAX_AREA_JUMP = 4; // a following seed whose mask grows/shrinks more than this lost the object
const FADE_MS = 2000;
const MAX_WORK_PX = 160_000; // recolor work budget per frame (~400x400)
const REAIM_FRAC = 0.04; // pointer moved > 4% of the frame width since the last seed = re-aim

export type LiveStats = { fps: number; segMs: number; hasMask: boolean; renderMs: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Bounding box of alpha > thr, or null. */
function alphaBox(a: Float32Array, w: number, h: number, thr = 0.02): Box | null {
  const m = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) m[i] = a[i] > thr ? 1 : 0;
  return bbox(m, w, h);
}

/** A pixel inside the mask near its centroid (the centroid itself may be outside a C shape). */
function interiorPoint(mask: Uint8Array, w: number, b: Box): Point {
  let sx = 0, sy = 0, n = 0;
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      if (mask[y * w + x]) { sx += x; sy += y; n++; }
    }
  }
  const cx = Math.round(sx / n);
  const cy = Math.round(sy / n);
  if (mask[cy * w + cx]) return { x: cx, y: cy };
  let best = { x: cx, y: cy };
  let bestD = Infinity;
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD && mask[y * w + x]) { bestD = d; best = { x, y }; }
    }
  }
  return best;
}

export class LiveRecolor {
  stats: LiveStats = { fps: 0, segMs: 0, hasMask: false, renderMs: 0 };

  private video: HTMLVideoElement | null = null;
  private getPoint: () => Point | null = () => null;
  private color = "#ff4f8b";
  private out: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private running = false;
  private raf = 0;
  private timer = 0;
  private inFlight = false;
  private run = 0; // bumped by start/stop so a stale in-flight segmentation is dropped

  private segCanvas = document.createElement("canvas");
  private segCtx = this.segCanvas.getContext("2d", { willReadFrequently: true })!;
  private sw = 0; // segmentation resolution
  private sh = 0;
  private alpha: Float32Array | null = null; // blended feathered alpha at seg resolution
  private drawBox: Box | null = null; // alpha > 0 region, seg resolution
  private lastBox: Box | null = null; // last model mask's box, for the "moved a lot" test
  private lastArea = 0;
  private gain = 1; // fade multiplier
  private lostAt: number | null = null;
  private trackPt: Point | null = null; // follow seed (seg res)
  private aimPt: Point | null = null; // pointer position when the user last aimed (seg res)
  private segAvg = 0;
  private work = document.createElement("canvas");
  private workCtx = this.work.getContext("2d", { willReadFrequently: true })!;
  private regionAlpha = new Float32Array(0);
  private regionHard = new Float32Array(0);
  private frames = 0;
  private fpsT0 = 0;
  private renderAvg = 0;

  start(video: HTMLVideoElement, getPoint: () => Point | null, color: string, outCanvas: HTMLCanvasElement): void {
    this.stop();
    this.video = video;
    this.getPoint = getPoint;
    this.color = color;
    this.out = outCanvas;
    this.ctx = outCanvas.getContext("2d")!; // GPU-backed: the video blit stays cheap
    this.running = true;
    this.fpsT0 = performance.now();
    void initSegmenter();
    this.raf = requestAnimationFrame(this.render);
    this.scheduleSeg(0);
  }

  setColor(c: string): void {
    this.color = c;
  }

  stop(): void {
    this.running = false;
    this.run++;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    this.alpha = this.drawBox = this.lastBox = this.trackPt = this.aimPt = null;
    this.lostAt = null;
    this.gain = 1;
    this.lastArea = 0;
    this.stats = { fps: 0, segMs: 0, hasMask: false, renderMs: 0 };
  }

  // ---- segmentation loop -------------------------------------------------------------------

  private scheduleSeg(delay: number) {
    this.timer = window.setTimeout(() => void this.segOnce(), delay);
  }

  private async segOnce() {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    const t0 = performance.now();
    try {
      await this.segmentStep();
    } catch (e) {
      console.warn("live segmentation failed", e);
      this.markLost();
    } finally {
      this.inFlight = false;
      if (this.running) {
        // Start-to-start interval of ~3x the seg time keeps segmentation under ~1/3 of the main thread.
        const interval = clamp(this.segAvg * 3, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
        this.scheduleSeg(Math.max(0, interval - (performance.now() - t0)));
      }
    }
  }

  private async segmentStep() {
    const v = this.video!;
    if (!v.videoWidth || v.readyState < 2) return;
    const p = this.getPoint();
    if (!p) return this.markLost();

    const s = Math.min(1, SEG_WIDTH / v.videoWidth);
    const sw = Math.round(v.videoWidth * s);
    const sh = Math.round(v.videoHeight * s);
    if (sw !== this.sw || sh !== this.sh) {
      this.sw = this.segCanvas.width = sw;
      this.sh = this.segCanvas.height = sh;
      this.alpha = this.drawBox = this.lastBox = this.trackPt = null;
    }
    this.segCtx.drawImage(v, 0, 0, sw, sh);
    const frame = this.segCtx.getImageData(0, 0, sw, sh);

    // Follow the object while the pointer holds still; moving the pointer re-aims.
    const user = { x: clamp(p.x * s, 0, sw - 1), y: clamp(p.y * s, 0, sh - 1) };
    const following =
      !!this.trackPt && !!this.aimPt && Math.hypot(user.x - this.aimPt.x, user.y - this.aimPt.y) < REAIM_FRAC * sw;
    if (!following) this.aimPt = user;
    const seed = following ? this.trackPt! : user;

    const run = this.run;
    const res = await segmentAt(frame, seed);
    if (!this.running || run !== this.run || sw !== this.sw) return;
    this.segAvg = this.segAvg ? this.segAvg * 0.7 + res.ms * 0.3 : res.ms;
    this.stats.segMs = Math.round(res.ms);

    // A fallback circle is no use live: treat it as a miss and let the last mask fade.
    const b = res.source === "model" ? bbox(res.mask, sw, sh) : null;
    if (!b) {
      this.trackPt = null; // retry from the pointer next time
      return this.markLost();
    }
    let area = 0;
    for (let i = 0; i < res.mask.length; i++) area += res.mask[i];
    if (following && this.lastArea && (area > this.lastArea * MAX_AREA_JUMP || area * MAX_AREA_JUMP < this.lastArea)) {
      this.trackPt = null; // the follow seed slid onto something else
      return this.markLost();
    }

    const next = feather(res.mask, sw, sh, 2);
    const a = this.alpha;
    if (a && this.lastBox && boxIoU(b, this.lastBox) >= REPLACE_IOU) {
      const keep = (1 - EMA_NEW) * this.gain;
      for (let i = 0; i < a.length; i++) {
        const v2 = a[i] * keep + next[i] * EMA_NEW;
        a[i] = v2 < 0.03 ? 0 : v2; // drop the ghost tail of old masks
      }
    } else {
      this.alpha = next; // first mask, or the object moved a lot: replace outright
    }
    this.gain = 1;
    this.lostAt = null;
    this.lastBox = b;
    this.lastArea = area;
    this.drawBox = alphaBox(this.alpha!, sw, sh);
    this.trackPt = interiorPoint(res.mask, sw, b);
  }

  private markLost() {
    if (this.alpha && this.lostAt === null) this.lostAt = performance.now();
  }

  // ---- render loop -------------------------------------------------------------------------

  private render = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.render);
    const v = this.video!;
    const out = this.out!;
    const ctx = this.ctx!;
    if (!v.videoWidth) return;
    const t0 = performance.now();
    if (out.width !== v.videoWidth || out.height !== v.videoHeight) {
      out.width = v.videoWidth;
      out.height = v.videoHeight;
    }
    ctx.drawImage(v, 0, 0);

    if (!this.getPoint()) this.markLost();
    if (this.lostAt !== null) {
      this.gain = Math.max(0, 1 - (t0 - this.lostAt) / FADE_MS);
      if (this.gain === 0) {
        this.alpha = this.drawBox = this.lastBox = this.trackPt = null;
        this.lostAt = null;
        this.gain = 1;
      }
    }
    if (this.alpha && this.drawBox) this.paint(ctx, out.width, out.height);

    const dt = performance.now() - t0;
    this.renderAvg = this.renderAvg * 0.9 + dt * 0.1;
    this.frames++;
    if (t0 - this.fpsT0 >= 500) {
      this.stats.fps = Math.round((this.frames * 1000) / (t0 - this.fpsT0));
      this.stats.renderMs = Math.round(this.renderAvg * 10) / 10;
      this.frames = 0;
      this.fpsT0 = t0;
    }
    this.stats.hasMask = !!this.alpha;
  };

  /**
   * Recolor only the mask's bounding box. The box is processed on a small work canvas (at most
   * MAX_WORK_PX pixels, so cost is bounded however big the object is) with the upsampled mask in
   * its alpha channel, then drawn over the full-res frame: the GPU does the alpha blend, and pixels
   * outside the mask (alpha 0) stay exactly the video's.
   */
  private paint(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const a = this.alpha!;
    const box = this.drawBox!;
    const { sw, sh } = this;
    const k = W / sw; // full px per seg px
    const x0 = clamp(Math.floor(box.x * k), 0, W - 1);
    const y0 = clamp(Math.floor(box.y * k), 0, H - 1);
    const x1 = clamp(Math.ceil((box.x + box.w) * k), x0 + 1, W);
    const y1 = clamp(Math.ceil((box.y + box.h) * k), y0 + 1, H);
    const rw = x1 - x0;
    const rh = y1 - y0;
    const q = Math.min(1, Math.sqrt(MAX_WORK_PX / (rw * rh)));
    const ww = Math.max(1, Math.round(rw * q));
    const wh = Math.max(1, Math.round(rh * q));
    if (this.work.width !== ww || this.work.height !== wh) {
      this.work.width = ww;
      this.work.height = wh;
    }
    const n = ww * wh;
    if (this.regionAlpha.length < n) {
      this.regionAlpha = new Float32Array(n);
      this.regionHard = new Float32Array(n);
    }
    // recolor walks alpha.length, so the views must be exact.
    const ra = this.regionAlpha.subarray(0, n);
    const hard = this.regionHard.subarray(0, n);
    const g = this.gain;
    const sx = rw / ww / k; // seg px per work px
    const sy = rh / wh / k;

    for (let y = 0; y < wh; y++) {
      const fy = clamp((y0 / k) + (y + 0.5) * sy - 0.5, 0, sh - 1);
      const iy = Math.min(Math.max(0, sh - 2), Math.floor(fy));
      const ty = fy - iy;
      const r0 = iy * sw;
      const r1 = r0 + (sh > 1 ? sw : 0);
      for (let x = 0; x < ww; x++) {
        const fx = clamp((x0 / k) + (x + 0.5) * sx - 0.5, 0, sw - 1);
        const ix = Math.min(Math.max(0, sw - 2), Math.floor(fx));
        const tx = fx - ix;
        const top = a[r0 + ix] + (a[r0 + ix + 1] - a[r0 + ix]) * tx;
        const bot = a[r1 + ix] + (a[r1 + ix + 1] - a[r1 + ix]) * tx;
        const v = (top + (bot - top) * ty) * g;
        ra[y * ww + x] = v;
        hard[y * ww + x] = v >= 0.01 ? 1 : 0;
      }
    }

    const wctx = this.workCtx;
    // Source is the output canvas (already holds this frame): ~5x cheaper than re-reading the video.
    wctx.drawImage(ctx.canvas, x0, y0, rw, rh, 0, 0, ww, wh);
    // Full-strength recolor (same math as the frozen path); the soft mask goes in alpha instead.
    const res = recolor(wctx.getImageData(0, 0, ww, wh), hard, this.color);
    const d = res.data;
    for (let i = 0; i < n; i++) d[i * 4 + 3] = ra[i] * 255;
    wctx.putImageData(res, 0, 0);
    ctx.drawImage(this.work, 0, 0, ww, wh, x0, y0, rw, rh);
  }
}
