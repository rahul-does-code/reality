// AI masks for pointed selections: MediaPipe at the point (instant) in parallel with /api/aimask
// (vision names the object at a red ring + SAM 3.1 segments it), then sanity checks.
// Chain: SAM instance overlapping the vision box -> MediaPipe at points inside the vision box ->
// the vision box as a rounded rectangle -> the plain MediaPipe mask -> the circle.
import type { AiBox, AiSamInstance, AimaskRequest, AimaskResponse } from "../../server/routes/aimask";
import { maskForBox, segmentPointed } from "./select";
import { boxIoU, coverage, fallbackMask, type Point } from "./mask";
import { frameJpeg } from "./frameJpeg";

export type AiMaskSource = "sam" | "box+mediapipe" | "bbox" | "mediapipe" | "fallback";
export type AiMaskResult = { mask: Uint8Array; source: AiMaskSource; name: string | null; ms: number; note: string };
export type AiMaskMode = "always" | "off";

let mode: AiMaskMode = "always";
/** "off": pointed selections use MediaPipe only, as before. */
export function setAiMask(m: AiMaskMode): void {
  mode = m;
}
export const getAiMask = (): AiMaskMode => mode;

/** How long a command waits for the AI mask before using the MediaPipe one. */
export const AI_MASK_WAIT_MS = 8_000;
export const MIN_AI_COVERAGE = 0.003;
export const MAX_AI_COVERAGE = 0.45;
const MIN_BOX_IOU = 0.4;
const MARKED_SIDE = 512; // same sizing as the command frame
const SAM_SIDE = 1024; // SAM masks need detail; it returns pixel coords in this image's size

type Listener = (frame: ImageData, p: Point, r: AiMaskResult) => void;
const listeners = new Set<Listener>();
/** Called whenever an AI mask finishes (also after a command stopped waiting). Returns unsubscribe. */
export function onAiMask(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Point is inside `mask` (or within `snap` px of it). */
export function containsPoint(mask: Uint8Array, w: number, h: number, p: Point, snap = 0): boolean {
  const cx = Math.round(p.x);
  const cy = Math.round(p.y);
  for (let y = Math.max(0, cy - snap); y <= Math.min(h - 1, cy + snap); y++)
    for (let x = Math.max(0, cx - snap); x <= Math.min(w - 1, cx + snap); x++) if (mask[y * w + x]) return true;
  return false;
}

/** Contains the point and covers 0.3%..45% of the frame (80% when the command is about the inverse). */
export function sane(mask: Uint8Array, w: number, h: number, p: Point, allowLarge = false): boolean {
  const c = coverage(mask);
  return c >= MIN_AI_COVERAGE && c <= (allowLarge ? 0.8 : MAX_AI_COVERAGE) && containsPoint(mask, w, h, p, 2);
}

/** A SAM raster (covering its box, possibly downscaled) -> binary mask at frame size. */
export function samToMask(inst: AiSamInstance, w: number, h: number): Uint8Array {
  const bin = atob(inst.bits);
  const out = new Uint8Array(w * h);
  const x0 = Math.max(0, Math.floor(inst.box.x0 * w));
  const x1 = Math.min(w, Math.ceil(inst.box.x1 * w));
  const y0 = Math.max(0, Math.floor(inst.box.y0 * h));
  const y1 = Math.min(h, Math.ceil(inst.box.y1 * h));
  const sx = inst.rw / Math.max(1, x1 - x0);
  const sy = inst.rh / Math.max(1, y1 - y0);
  for (let y = y0; y < y1; y++) {
    const ry = Math.min(inst.rh - 1, Math.floor((y - y0 + 0.5) * sy));
    for (let x = x0; x < x1; x++) {
      const i = ry * inst.rw + Math.min(inst.rw - 1, Math.floor((x - x0 + 0.5) * sx));
      if (bin.charCodeAt(i >> 3) & (1 << (i & 7))) out[y * w + x] = 1;
    }
  }
  return out;
}

/** Rounded rectangle filling the box (radius 12% of the short side): fine for windows and signs. */
export function bboxMask(box: AiBox, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const x0 = box.x0 * w;
  const x1 = box.x1 * w;
  const y0 = box.y0 * h;
  const y1 = box.y1 * h;
  const r = 0.12 * Math.min(x1 - x0, y1 - y0);
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++)
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) {
      const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
      const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
      if (dx * dx + dy * dy <= r * r) out[y * w + x] = 1;
    }
  return out;
}

const toPx = (b: AiBox, w: number, h: number) => ({ x: b.x0 * w, y: b.y0 * h, w: (b.x1 - b.x0) * w, h: (b.y1 - b.y0) * h });
const boxContains = (b: AiBox, p: Point, w: number, h: number) => p.x >= b.x0 * w && p.x <= b.x1 * w && p.y >= b.y0 * h && p.y <= b.y1 * h;

/** The vision box (or the first alternative) that contains the point; the vision box if none does. */
export function targetBox(r: Extract<AimaskResponse, { vision: unknown }>, p: Point, w: number, h: number) {
  const v = r.vision!;
  return [v, ...v.alternatives].find((c) => boxContains(c.bbox, p, w, h)) ?? v;
}

/**
 * SAM instance to use: among the masks that contain the point and pass the coverage check, the one
 * whose box overlaps the target box most (the box+point prompt wins ties). With no vision box, the
 * point-only instance if it passes.
 */
export function pickSam(
  instances: AiSamInstance[],
  target: AiBox | null,
  p: Point,
  w: number,
  h: number,
  allowLarge = false,
): { inst: AiSamInstance; mask: Uint8Array; iou: number } | null {
  let best: { inst: AiSamInstance; mask: Uint8Array; iou: number } | null = null;
  for (const inst of instances) {
    if (!target && inst.role !== "point") continue;
    const mask = samToMask(inst, w, h);
    if (!sane(mask, w, h, p, allowLarge)) continue;
    const iou = target ? boxIoU(toPx(inst.box, w, h), toPx(target, w, h)) : 1;
    if (!best || iou > best.iou + 1e-6 || (Math.abs(iou - best.iou) <= 1e-6 && inst.role === "vision")) best = { inst, mask, iou };
  }
  return best;
}

/** The frame at 512px with a red ring (and a dot) at p, for the vision model. */
export function markedJpeg(frame: ImageData, p: Point): string {
  const full = document.createElement("canvas");
  full.width = frame.width;
  full.height = frame.height;
  full.getContext("2d")!.putImageData(frame, 0, 0);
  const s = Math.min(1, MARKED_SIDE / Math.max(frame.width, frame.height));
  const c = document.createElement("canvas");
  c.width = Math.round(frame.width * s);
  c.height = Math.round(frame.height * s);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(full, 0, 0, c.width, c.height);
  const r = Math.max(10, Math.round(Math.min(c.width, c.height) * 0.035));
  ctx.strokeStyle = "#ff0000";
  ctx.lineWidth = Math.max(3, r / 4);
  ctx.beginPath();
  ctx.arc(p.x * s, p.y * s, r, 0, Math.PI * 2);
  ctx.stroke();
  return c.toDataURL("image/jpeg", 0.85).split(",")[1];
}

async function requestAimask(frame: ImageData, p: Point): Promise<Extract<AimaskResponse, { vision: unknown }>> {
  const s = Math.min(1, SAM_SIDE / Math.max(frame.width, frame.height));
  const body: AimaskRequest = {
    marked: markedJpeg(frame, p),
    frame: frameJpeg(frame, SAM_SIDE, 0.9),
    width: Math.round(frame.width * s), // frameJpeg's size
    height: Math.round(frame.height * s),
    point: { x: Math.min(1, Math.max(0, p.x / frame.width)), y: Math.min(1, Math.max(0, p.y / frame.height)) },
  };
  const res = await fetch("/api/aimask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let json: AimaskResponse;
  try {
    json = (await res.json()) as AimaskResponse;
  } catch {
    throw new Error(`proxy ${res.status}: is the server running?`);
  }
  if ("error" in json) throw new Error(json.error);
  return json;
}

/** Cheap frame fingerprint: dimensions + ~4k sampled bytes (FNV-1a). */
function frameHash(f: ImageData): string {
  let x = 0x811c9dc5;
  const step = Math.max(1, Math.floor(f.data.length / 4096));
  for (let i = 0; i < f.data.length; i += step) x = Math.imul(x ^ f.data[i], 0x01000193);
  return `${f.width}x${f.height}:${(x >>> 0).toString(36)}`;
}
const cache = new Map<string, Promise<AiMaskResult>>();
const CACHE_MAX = 32;
const BUCKET = 0.02; // points within 2% of the frame share a result

/**
 * The AI mask at p (frame pixels) on the ORIGINAL frozen frame. Never throws; cached per
 * (frame hash, point bucket, allowLarge).
 */
export function aiSegmentAt(frame: ImageData, p: Point, allowLarge = false): Promise<AiMaskResult> {
  const { width: w, height: h } = frame;
  const key = `${frameHash(frame)}|${Math.round(p.x / w / BUCKET)},${Math.round(p.y / h / BUCKET)}|${allowLarge}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const job = run(frame, p, allowLarge);
  cache.set(key, job);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  job.then((r) => listeners.forEach((fn) => fn(frame, p, r)));
  return job;
}

async function run(frame: ImageData, p: Point, allowLarge: boolean): Promise<AiMaskResult> {
  const t0 = performance.now();
  const { width: w, height: h } = frame;
  const mpJob = segmentPointed(frame, p, allowLarge);
  const aiJob = requestAimask(frame, p).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  const [mp, ai] = await Promise.all([mpJob, aiJob]);
  const notes: string[] = [];
  const done = (mask: Uint8Array, source: AiMaskSource, name: string | null): AiMaskResult => ({
    mask,
    source,
    name,
    ms: Math.round(performance.now() - t0),
    note: notes.join(" · "),
  });
  // Last resorts: MediaPipe at the point if it passes, else the circle.
  const fallback = (): AiMaskResult => {
    if (mp.source === "model" && sane(mp.mask, w, h, p, allowLarge)) return done(mp.mask, "mediapipe", null);
    notes.push(mp.note ?? "mediapipe mask failed checks");
    return done(mp.source === "fallback" ? mp.mask : fallbackMask(w, h, p), "fallback", null);
  };

  if (ai instanceof Error) {
    notes.push(`aimask: ${ai.message}`);
    return fallback();
  }
  notes.push(`vision ${ai.visionProvider ?? "failed"} ${ai.visionMs}ms`, `sam ${ai.samMs}ms`);
  if (ai.visionError) notes.push(`vision: ${ai.visionError}`);
  if (ai.samError) notes.push(`sam: ${ai.samError}`);
  const target = ai.vision ? targetBox(ai, p, w, h) : null;

  // 2. SAM: the instance overlapping the target box most (point-only SAM when vision failed).
  if (ai.sam?.length) {
    const pick = pickSam(ai.sam, target?.bbox ?? null, p, w, h, allowLarge);
    if (pick) {
      notes.push(`${pick.inst.role} prompt, box IoU ${pick.iou.toFixed(2)}`);
      return done(pick.mask, "sam", target?.name ?? null);
    }
    notes.push("no SAM mask passed checks");
  }
  if (!target) return fallback();

  // 3. MediaPipe at points inside the box, best IoU with it; else the box itself.
  const best = await maskForBox(frame, `aimask|${target.bbox.x0},${target.bbox.y0},${target.bbox.x1},${target.bbox.y1}`, target.bbox);
  if (best && best.iou >= MIN_BOX_IOU && sane(best.mask, w, h, p, allowLarge)) {
    notes.push(`box IoU ${best.iou.toFixed(2)}`);
    return done(best.mask, "box+mediapipe", target.name);
  }
  const rect = bboxMask(target.bbox, w, h);
  if (sane(rect, w, h, p, allowLarge)) {
    notes.push(`box IoU ${best ? best.iou.toFixed(2) : "none"} < ${MIN_BOX_IOU}`);
    return done(rect, "bbox", target.name);
  }
  notes.push("vision box failed checks");
  return fallback();
}

/** aiSegmentAt, or null if it takes longer than `ms` (it keeps running and fires onAiMask). */
export function aiSegmentWithin(frame: ImageData, p: Point, allowLarge = false, ms = AI_MASK_WAIT_MS): Promise<AiMaskResult | null> {
  return Promise.race([aiSegmentAt(frame, p, allowLarge), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}
