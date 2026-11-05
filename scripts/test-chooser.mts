// samChooser.ts features must equal the Python ones the chooser was trained on (scripts/chooser/feats.py).
// Usage: npm run test:chooser
import { readFileSync } from "node:fs";
import { chooserFeatures, chooserScores } from "../src/vision/samChooser";
const cases = JSON.parse(readFileSync(new URL("./chooser-parity.json", import.meta.url), "utf8"));
let worst = 0;
// Same synthetic logits as the generator: three soft blobs with a ripple (f32, like the decoder).
function logits(c: { blobs: number[][]; empty?: number }): Float32Array {
  const L = new Float32Array(3 * 256 * 256);
  c.blobs.forEach(([a, b, r], i) => {
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++)
        L[i * 65536 + y * 256 + x] = c.empty === i ? -5 : 4 * (1 - Math.hypot(x - a, y - b) / r) + 0.6 * Math.sin(x * 0.37 + y * 0.11 * (i + 1));
  });
  return L;
}
for (const c of cases) {
  const f = chooserFeatures(logits(c), Float32Array.from(c.pred), c.cx, c.cy);
  for (let i = 0; i < 3; i++) for (let k = 0; k < f[i].length; k++) worst = Math.max(worst, Math.abs(f[i][k] - c.f[i][k]));
  const s = chooserScores(f);
  if (s.length !== 3 || s.some((v) => !Number.isFinite(v))) throw new Error("bad scores");
}
console.log(`${worst < 1e-3 ? "ok  " : "FAIL"} features match Python on ${cases.length} cases (max diff ${worst.toExponential(2)})`);
process.exit(worst < 1e-3 ? 0 : 1);
