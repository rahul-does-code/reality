// Selection eval page (driven by scripts/eval-select.mjs): runs the app's real selection code on
// labeled photos and reports IoU against ground truth. Data is served under /evaldata/ by the
// driver (index.json + img/<id>.jpg + gt/<id>.png), never from the repo.
(globalThis as { __SEGMENTER_DELEGATE__?: string }).__SEGMENTER_DELEGATE__ = "CPU";
import { segmentAt } from "../src/vision/segmenter";
import { segmentClick } from "../src/vision/select";
import { samEncode, samSegment, type SamPoint } from "../src/vision/sam";
import { combine } from "../src/vision/lasso";
import { feather, type Point } from "../src/vision/mask";

type Item = { id: string; cls: string; w: number; h: number; cov: number; center: [number, number]; rand: [number, number] };
type Mask = Uint8Array | Float32Array;
type Out = { mask: Mask; ms: number; note?: string };

async function load(url: string): Promise<ImageData> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

function bandOf(gt: Uint8Array, w: number, h: number, band = 5): Uint8Array {
  const near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) if (gt[y * w + x] !== gt[y * w + x - 1]) near[y * w + x] = near[y * w + x - 1] = 1;
  for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) if (gt[y * w + x] !== gt[(y - 1) * w + x]) near[y * w + x] = near[(y - 1) * w + x] = 1;
  // Dilate by `band` with separable running maxima.
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -1e9;
    for (let x = 0; x < w; x++) { if (near[y * w + x]) last = x; if (x - last <= band) tmp[y * w + x] = 1; }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (near[y * w + x]) last = x; if (last - x <= band) tmp[y * w + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= band) out[y * w + x] = 1; }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= band) out[y * w + x] = 1; }
  }
  return out;
}

/** IoU over the frame, and over a +-5px band around the GT boundary (edge quality). */
function score(pred: Mask, gt: Uint8Array, band: Uint8Array) {
  let inter = 0, uni = 0, bi = 0, bu = 0;
  for (let i = 0; i < gt.length; i++) {
    const p = pred[i] > 0.5 ? 1 : 0, g = gt[i];
    if (p & g) inter++;
    if (p | g) uni++;
    if (band[i]) { if (p & g) bi++; if (p | g) bu++; }
  }
  return { iou: uni ? inter / uni : 0, biou: bu ? bi / bu : 0 };
}

/** Standard corrective click: the interior point (max distance to its border) of the larger error region. */
function nextClick(pred: Mask, gt: Uint8Array, w: number, h: number): SamPoint | null {
  const err = new Uint8Array(w * h);
  let fn = 0, fp = 0;
  for (let i = 0; i < gt.length; i++) {
    const p = pred[i] > 0.5 ? 1 : 0;
    if (gt[i] && !p) { err[i] = 1; fn++; } else if (!gt[i] && p) { err[i] = 2; fp++; }
  }
  const want = fn >= fp ? 1 : 2;
  if (!(want === 1 ? fn : fp)) return null;
  // Chamfer distance to the nearest pixel outside the chosen error class (two passes).
  const d = new Float32Array(w * h);
  const INF = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = err[i] === want ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) v = Math.min(v, d[i - w] + 1);
    if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + 1.414);
    if (x < w - 1 && y > 0) v = Math.min(v, d[i - w + 1] + 1.414);
    d[i] = x === 0 || y === 0 || x === w - 1 || y === h - 1 ? Math.min(v, 1) : v;
  }
  let best = -1, bi = -1;
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
    if (y < h - 1) v = Math.min(v, d[i + w] + 1);
    if (x < w - 1 && y < h - 1) v = Math.min(v, d[i + w + 1] + 1.414);
    if (x > 0 && y < h - 1) v = Math.min(v, d[i + w - 1] + 1.414);
    d[i] = v;
    if (v > best) { best = v; bi = i; }
  }
  return bi < 0 ? null : { x: bi % w, y: (bi / w) | 0, label: want === 1 ? 1 : 0 };
}

// One MediaPipe call per (frame, click), shared by the variants that post-process it.
let mpCache: { frame: ImageData; x: number; y: number; job: ReturnType<typeof segmentAt> } | null = null;
const mp = (f: ImageData, p: Point) => {
  if (!mpCache || mpCache.frame !== f || mpCache.x !== p.x || mpCache.y !== p.y) mpCache = { frame: f, x: p.x, y: p.y, job: segmentAt(f, p) };
  return mpCache.job;
};
// One SAM+chooser decode per (frame, click), shared by the edge variants.
let samCache: { frame: ImageData; x: number; y: number; job: Promise<{ mask: Uint8Array; ms: number }> } | null = null;
const samC = (f: ImageData, p: Point) => {
  if (!samCache || samCache.frame !== f || samCache.x !== p.x || samCache.y !== p.y) {
    const t = performance.now();
    samCache = { frame: f, x: p.x, y: p.y, job: samSegment(f, [{ ...p, label: 1 }]).then((r) => ({ mask: r.masks[0], ms: performance.now() - t })) };
  }
  return samCache.job;
};
const timed = async (f: () => Promise<Mask>): Promise<Out> => {
  const t = performance.now();
  const mask = await f();
  return { mask, ms: performance.now() - t };
};

const single: Record<string, (f: ImageData, p: Point) => Promise<Out>> = {
  "mediapipe (old app mask)": async (f, p) => {
    const r = await mp(f, p);
    return { mask: r.mask, ms: r.ms, note: r.source === "fallback" ? "fallback" : undefined };
  },
  "mediapipe + feather (old alpha)": async (f, p) => {
    const r = await mp(f, p);
    return { mask: feather(r.mask, f.width, f.height, 3), ms: r.ms };
  },
  "sam, SAM's own pick": (f, p) => timed(async () => (await samSegment(f, [{ ...p, label: 1 }], { chooser: false })).masks[0]),
  "sam + trained chooser": async (f, p) => samC(f, p),
  "sam + chooser + feather r3": async (f, p) => {
    const r = await samC(f, p);
    return { mask: feather(r.mask, f.width, f.height, 3), ms: r.ms };
  },
  "app click (segmentClick) + feather": async (f, p) => {
    const r = await segmentClick(f, p);
    return { mask: feather(r.mask, f.width, f.height, 3), ms: r.ms, note: r.source === "fallback" ? "fallback" : r.engine };
  },
};

const log = document.getElementById("log")!;
(window as any).runEval = async (opts: { limit?: number; only?: string[]; refine?: number } = {}) => {
  const items: Item[] = await (await fetch("/evaldata/index.json")).json();
  const rows: Record<string, unknown>[] = [];
  const names = Object.keys(single).filter((m) => !opts.only || opts.only.some((o) => m.includes(o)));
  for (const [n, it] of items.slice(0, opts.limit ?? items.length).entries()) {
    const frame = await load(`/evaldata/img/${it.id}.jpg`);
    const g = await load(`/evaldata/gt/${it.id}.png`);
    const gt = new Uint8Array(it.w * it.h);
    for (let i = 0; i < gt.length; i++) gt[i] = g.data[i * 4] > 127 ? 1 : 0;
    const band = bandOf(gt, it.w, it.h);
    // Encoder time is per frame (it runs on freeze, before or while the user clicks).
    const te = performance.now();
    const encodeMs = await samEncode(frame).then(() => performance.now() - te).catch(() => -1);
    for (const click of ["center", "rand"] as const) {
      const [x, y] = it[click];
      for (const m of names) {
        const r = await single[m](frame, { x, y });
        rows.push({ id: it.id, cls: it.cls, click, method: m, ...score(r.mask, gt, band), ms: r.ms, encodeMs, note: r.note });
      }
    }
    // Refinement: up to `refine` extra corrective clicks from the center click. SAM gets all points
    // at once; MediaPipe does what the app did before (Shift-click adds a blob, Alt-click cuts one).
    if (opts.refine) {
      const p0 = { x: it.center[0], y: it.center[1], label: 1 as const };
      let pts: SamPoint[] = [p0];
      let sm: Mask = (await samSegment(frame, pts)).masks[0];
      let mm: Uint8Array = (await mp(frame, p0)).mask;
      for (let k = 1; k <= opts.refine; k++) {
        const ps = nextClick(sm, gt, it.w, it.h);
        if (ps) { pts = [...pts, ps]; sm = (await samSegment(frame, pts)).masks[0]; }
        const pm = nextClick(mm, gt, it.w, it.h);
        if (pm) mm = combine(mm, (await segmentAt(frame, pm)).mask, pm.label ? "add" : "subtract");
        rows.push({ id: it.id, cls: it.cls, click: `center+${k}`, method: "sam + corrective points", ...score(sm, gt, band), ms: 0 });
        rows.push({ id: it.id, cls: it.cls, click: `center+${k}`, method: "mediapipe + add/subtract (old)", ...score(mm, gt, band), ms: 0 });
      }
    }
    log.textContent = `${n + 1} / ${items.length}`;
  }
  return rows;
};
log.textContent = "ready";
