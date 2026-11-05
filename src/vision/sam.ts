// Main-thread side of the EfficientSAM worker (sam.worker.ts): one embedding per frozen frame,
// computed as soon as the frame freezes; clicks decode against it in tens of milliseconds.
// Points: label 1 = part of the object, 0 = not (Shift/Alt-click refinement).
import type { Point } from "./mask";

export type SamPoint = Point & { label: 0 | 1 };
export type SamResult = {
  /** Candidate masks at frame size, best first (the chooser's order for one click). */
  masks: Uint8Array[];
  ms: number;
  /** Encoder time for this frame if this call waited for it. */
  encodeMs?: number;
  ep: string;
};

let worker: Worker | null = null;
let failed: string | null = null;
let ep = "";
let nextKey = 1;
let nextId = 1;
const keys = new WeakMap<ImageData, number>();
const encoded = new Map<number, Promise<number>>(); // key -> encode ms (only the latest frame is kept)
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const encodeWaiters = new Map<number, { resolve: (ms: number) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (failed) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./sam.worker.ts", import.meta.url), { type: "module" });
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e);
    return null;
  }
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "warm") ep = m.ep;
    else if (m.type === "encoded") {
      ep = m.ep;
      encodeWaiters.get(m.key)?.resolve(m.ms);
      encodeWaiters.delete(m.key);
    } else if (m.type === "decoded") {
      pending.get(m.id)?.resolve(m);
      pending.delete(m.id);
    } else if (m.type === "error") {
      const err = new Error(m.message);
      if (m.op === "encode") {
        encodeWaiters.get(m.key)?.reject(err);
        encodeWaiters.delete(m.key);
        encoded.delete(m.key);
      } else if (m.op === "warm") {
        failed = m.message;
        console.warn("[sam] unavailable:", m.message);
      } else {
        pending.get(m.id)?.reject(err);
        pending.delete(m.id);
      }
    }
  };
  worker.onerror = (e) => {
    failed = e.message || "worker failed";
    for (const p of pending.values()) p.reject(new Error(failed));
    for (const p of encodeWaiters.values()) p.reject(new Error(failed));
    pending.clear();
    encodeWaiters.clear();
  };
  return worker;
}

/** Load the models in the background (call on mount). */
export function warmSam(): void {
  getWorker()?.postMessage({ type: "warm" });
}

export const samStatus = () => (failed ? `unavailable (${failed})` : ep || "loading");

/** Start encoding `frame` (idempotent per frame). Resolves with the encoder time. */
export function samEncode(frame: ImageData): Promise<number> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error(`SAM unavailable: ${failed}`));
  let key = keys.get(frame);
  if (key && encoded.has(key)) return encoded.get(key)!;
  key = nextKey++;
  keys.set(frame, key);
  encoded.clear(); // the worker keeps one embedding
  const k = key;
  const job = new Promise<number>((resolve, reject) => encodeWaiters.set(k, { resolve, reject }));
  encoded.set(k, job);
  const rgba = new Uint8ClampedArray(frame.data); // copy: the frame stays usable here
  w.postMessage({ type: "encode", key: k, w: frame.width, h: frame.height, rgba }, [rgba.buffer]);
  return job;
}

/** True once `frame`'s embedding is ready (or being computed). */
export const samHasFrame = (frame: ImageData) => {
  const k = keys.get(frame);
  return !!k && encoded.has(k);
};

/** Segment with SAM on `frame` (encodes first if needed). */
export async function samSegment(frame: ImageData, points: SamPoint[], opts: { chooser?: boolean } = {}): Promise<SamResult> {
  const w = getWorker();
  if (!w) throw new Error(`SAM unavailable: ${failed}`);
  const t0 = performance.now();
  const wasReady = samHasFrame(frame);
  const encodeMs = await samEncode(frame);
  const key = keys.get(frame)!;
  const id = nextId++;
  const res = await new Promise<any>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: "decode", key, id, points, single: opts.chooser !== false });
  });
  return { masks: res.masks, ms: Math.round(performance.now() - t0), encodeMs: wasReady ? undefined : encodeMs, ep };
}
