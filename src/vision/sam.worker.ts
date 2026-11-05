// EfficientSAM-Ti (Apache-2.0, github.com/yformer/EfficientSAM) in a worker, so the ~0.3-2s image
// encoder never blocks the UI. Encoder: WebGPU if available, else multithreaded WASM. Decoder
// (tiny, ~20-60ms): WASM. Models are fetched from /models (scripts/setup.mjs downloads them).
// Protocol (all coordinates in frame px):
//   {type:"encode", key, w, h, rgba}                 -> {type:"encoded", key, ms, ep} | {type:"error"}
//   {type:"decode", key, id, points:[{x,y,label}], single} -> {type:"decoded", id, key, mask, scores, chosen, ms}
import * as ort from "onnxruntime-web/webgpu";
import { chooserFeatures, chooserScores, LOW } from "./samChooser";

// Only the .wasm comes from public/ (the bundle embeds its JS glue; Vite can't import public/ files).
ort.env.wasm.wasmPaths = { wasm: "/ort/ort-wasm-simd-threaded.asyncify.wasm" };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const ENCODER = "/models/efficient_sam_vitt_encoder.onnx";
const DECODER = "/models/efficient_sam_vitt_decoder.onnx";

let encoderP: Promise<{ s: ort.InferenceSession; ep: string }> | null = null;
let decoderP: Promise<ort.InferenceSession> | null = null;
let current: { key: number; w: number; h: number; emb: ort.Tensor } | null = null;

async function encoder(): Promise<{ s: ort.InferenceSession; ep: string }> {
  encoderP ??= (async () => {
    const buf = await (await fetch(ENCODER)).arrayBuffer();
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu && (await gpu.requestAdapter().catch(() => null))) {
      try {
        return { s: await ort.InferenceSession.create(buf, { executionProviders: ["webgpu"] }), ep: "webgpu" };
      } catch (e) {
        console.warn("[sam] WebGPU encoder failed, using WASM", e);
      }
    }
    return { s: await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] }), ep: `wasm x${ort.env.wasm.numThreads}` };
  })();
  encoderP.catch(() => (encoderP = null));
  return encoderP;
}

function decoder(): Promise<ort.InferenceSession> {
  decoderP ??= fetch(DECODER)
    .then((r) => r.arrayBuffer())
    .then((b) => ort.InferenceSession.create(b, { executionProviders: ["wasm"] }));
  decoderP.catch(() => (decoderP = null));
  return decoderP;
}

/** Bilinear upsample of one 256x256 logit map to w x h (align_corners=false), thresholded at 0. */
function upsample(logits: Float32Array, o: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const xs0 = new Int32Array(w), xs1 = new Int32Array(w), fx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const s = Math.max(0, ((x + 0.5) * LOW) / w - 0.5);
    xs0[x] = Math.min(LOW - 1, Math.floor(s));
    xs1[x] = Math.min(LOW - 1, xs0[x] + 1);
    fx[x] = s - xs0[x];
  }
  for (let y = 0; y < h; y++) {
    const s = Math.max(0, ((y + 0.5) * LOW) / h - 0.5);
    const y0 = Math.min(LOW - 1, Math.floor(s)), y1 = Math.min(LOW - 1, y0 + 1), fy = s - y0;
    const r0 = o + y0 * LOW, r1 = o + y1 * LOW;
    for (let x = 0; x < w; x++) {
      const a = logits[r0 + xs0[x]] + (logits[r0 + xs1[x]] - logits[r0 + xs0[x]]) * fx[x];
      const b = logits[r1 + xs0[x]] + (logits[r1 + xs1[x]] - logits[r1 + xs0[x]]) * fx[x];
      out[y * w + x] = a + (b - a) * fy > 0 ? 1 : 0;
    }
  }
  return out;
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  try {
    if (m.type === "warm") {
      await Promise.all([encoder(), decoder()]);
      self.postMessage({ type: "warm", ep: (await encoder()).ep });
    } else if (m.type === "encode") {
      const t0 = performance.now();
      const { s, ep } = await encoder();
      const { w, h } = m;
      const rgba: Uint8ClampedArray = m.rgba;
      const px = w * h;
      const chw = new Float32Array(3 * px);
      for (let i = 0; i < px; i++) {
        chw[i] = rgba[i * 4] / 255;
        chw[px + i] = rgba[i * 4 + 1] / 255;
        chw[2 * px + i] = rgba[i * 4 + 2] / 255;
      }
      const out = await s.run({ batched_images: new ort.Tensor("float32", chw, [1, 3, h, w]) });
      let emb = out.image_embeddings;
      // Keep the embedding on the CPU for the WASM decoder.
      if (emb.location !== "cpu") emb = new ort.Tensor("float32", (await emb.getData(true)) as Float32Array, emb.dims);
      current = { key: m.key, w, h, emb };
      self.postMessage({ type: "encoded", key: m.key, ms: Math.round(performance.now() - t0), ep });
    } else if (m.type === "decode") {
      const t0 = performance.now();
      const c = current;
      if (!c || c.key !== m.key) throw new Error("no embedding for this frame");
      const dec = await decoder();
      const pts: { x: number; y: number; label: number }[] = m.points;
      // The decoder scales points by 256 / orig_im_size, i.e. coordinates in 256-space with
      // orig_im_size = 256x256 give the raw low-res logits without a full-size upsample.
      const coords = new Float32Array(pts.length * 2);
      pts.forEach((p, i) => {
        coords[i * 2] = ((p.x + 0.5) * LOW) / c.w;
        coords[i * 2 + 1] = ((p.y + 0.5) * LOW) / c.h;
      });
      const out = await dec.run({
        image_embeddings: c.emb,
        batched_point_coords: new ort.Tensor("float32", coords, [1, 1, pts.length, 2]),
        batched_point_labels: new ort.Tensor("float32", Float32Array.from(pts, (p) => p.label), [1, 1, pts.length]),
        orig_im_size: new ort.Tensor("int64", BigInt64Array.from([BigInt(LOW), BigInt(LOW)]), [2]),
      });
      const logits = out.output_masks.data as Float32Array; // [1,1,3,256,256]
      const pred = out.iou_predictions.data as Float32Array; // [1,1,3]
      // One click: the trained chooser picks the whole object. More points: the user is steering,
      // so SAM's own best guess is right.
      const scores = pts.length === 1 && m.single !== false ? chooserScores(chooserFeatures(logits, pred, coords[0], coords[1])) : Array.from(pred);
      const order = [0, 1, 2].sort((a, b) => scores[b] - scores[a]);
      const masks = order.map((i) => upsample(logits, i * LOW * LOW, c.w, c.h));
      self.postMessage(
        { type: "decoded", id: m.id, key: m.key, masks, order, pred: Array.from(pred), ms: Math.round(performance.now() - t0) },
        { transfer: masks.map((x) => x.buffer) },
      );
    }
  } catch (e) {
    self.postMessage({ type: "error", id: m.id, key: m.key, op: m.type, message: e instanceof Error ? e.message : String(e) });
  }
};
