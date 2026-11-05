// Picks which of EfficientSAM's 3 candidate masks is the WHOLE pointed object.
// SAM's own choice (highest predicted IoU) is often a part (a mug's label, a shirt's pocket); a small
// model trained on Open Images whole-object masks (scripts/train-chooser.py) scores each candidate
// from cheap mask features instead. Pure code (no DOM) so it runs in the SAM worker and in tests.
// Features must match feats.py in the training script exactly.
import { CHOOSER } from "./samChooserWeights";

export const LOW = 256; // decoder mask resolution (the encoder's stretched 1024x1024 input / 4)
export const NF = 13;

/** Features for candidate masks `logits` (3 x 256 x 256), predicted IoUs `pred`, click in 256-space. */
export function chooserFeatures(logits: Float32Array, pred: ArrayLike<number>, cx: number, cy: number): Float32Array[] {
  const N = LOW * LOW;
  const area = [0, 0, 0];
  const hi = [0, 0, 0];
  const lo = [0, 0, 0];
  const border = [0, 0, 0];
  const sx = [0, 0, 0];
  const sy = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const o = i * N;
    for (let y = 0; y < LOW; y++) {
      for (let x = 0; x < LOW; x++) {
        const v = logits[o + y * LOW + x];
        if (v > 1) hi[i]++;
        if (v > -1) lo[i]++;
        if (v > 0) {
          area[i]++;
          sx[i] += x;
          sy[i] += y;
          if (y === 0 || y === LOW - 1) border[i]++;
          if (x === 0 || x === LOW - 1) border[i]++;
        }
      }
    }
  }
  // Pairwise overlaps for nesting.
  const inter = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let k = 0; k < N; k++) {
    const a = logits[k] > 0, b = logits[N + k] > 0, c = logits[2 * N + k] > 0;
    if (a && b) inter[0][1]++;
    if (a && c) inter[0][2]++;
    if (b && c) inter[1][2]++;
  }
  inter[1][0] = inter[0][1];
  inter[2][0] = inter[0][2];
  inter[2][1] = inter[1][2];

  const pmax = Math.max(pred[0], pred[1], pred[2]);
  const la = area.map((a) => Math.log(a / N + 1e-4));
  const lamax = Math.max(...la);
  const order = [0, 1, 2].sort((a, b) => area[a] - area[b] || a - b);
  const ix = Math.min(LOW - 1, Math.max(0, Math.floor(cx)));
  const iy = Math.min(LOW - 1, Math.max(0, Math.floor(cy)));
  const out: Float32Array[] = [];
  for (let i = 0; i < 3; i++) {
    const n = area[i];
    let comp = 0, dist = 3, nest = 0;
    if (n > 0) {
      comp = componentSize(logits, i * N, ix, iy) / n;
      dist = Math.min(3, Math.hypot(sx[i] / n - cx, sy[i] / n - cy) / Math.sqrt(n));
      let s = 0;
      for (let j = 0; j < 3; j++) if (j !== i) s += inter[i][j] / Math.max(1, area[j]);
      nest = s / 2;
    }
    out.push(
      Float32Array.from([
        pred[i],
        pred[i] - pmax,
        la[i],
        la[i] - lamax,
        hi[i] / Math.max(1, lo[i]),
        order.indexOf(i) / 2,
        border[i] / 1024,
        comp,
        dist,
        nest,
        i === 0 ? 1 : 0,
        i === 1 ? 1 : 0,
        i === 2 ? 1 : 0,
      ]),
    );
  }
  return out;
}

/** 4-connected component size at (x, y) in mask (logits > 0) starting at offset o; 0 if (x, y) is off. */
function componentSize(logits: Float32Array, o: number, x: number, y: number): number {
  if (!(logits[o + y * LOW + x] > 0)) return 0;
  const seen = new Uint8Array(LOW * LOW);
  const stack = new Int32Array(LOW * LOW);
  let sp = 0, n = 0;
  stack[sp++] = y * LOW + x;
  seen[y * LOW + x] = 1;
  while (sp) {
    const k = stack[--sp];
    n++;
    const kx = k % LOW;
    const nb = [kx > 0 ? k - 1 : -1, kx < LOW - 1 ? k + 1 : -1, k >= LOW ? k - LOW : -1, k < LOW * (LOW - 1) ? k + LOW : -1];
    for (const q of nb) {
      if (q >= 0 && !seen[q] && logits[o + q] > 0) {
        seen[q] = 1;
        stack[sp++] = q;
      }
    }
  }
  return n;
}

/** Score per candidate (higher = more likely the whole object). Falls back to predicted IoU. */
export function chooserScores(feats: Float32Array[]): number[] {
  const w = CHOOSER;
  if (!w) return feats.map((f) => f[0]);
  return feats.map((f) => {
    const x = Array.from(f, (v, k) => (v - w.mean[k]) / w.std[k]);
    // One hidden layer (ReLU) -> scalar score.
    let s = w.b2;
    for (let h = 0; h < w.b1.length; h++) {
      let a = w.b1[h];
      for (let k = 0; k < x.length; k++) a += w.w1[h][k] * x[k];
      if (a > 0) s += w.w2[h] * a;
    }
    return s;
  });
}
