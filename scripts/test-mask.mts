// edgeAlpha (guided-filter mask edges) without a browser.
// Usage: npm run test:mask
import { edgeAlpha, feather } from "../src/vision/mask";

const W = 120;
const H = 90;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}

// Frame: dark background, bright square at x 40..79, y 25..64.
const data = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const v = x >= 40 && x < 80 && y >= 25 && y < 65 ? 220 : 30;
    const j = (y * W + x) * 4;
    data[j] = data[j + 1] = data[j + 2] = v;
    data[j + 3] = 255;
  }
const frame = { width: W, height: H, data } as unknown as ImageData;

// A sloppy mask: 3px too wide on the right, 3px short on the left.
const mask = new Uint8Array(W * H);
for (let y = 25; y < 65; y++) for (let x = 43; x < 83; x++) mask[y * W + x] = 1;

const a = edgeAlpha(mask, frame, 8);
const at = (x: number, y: number) => a[y * W + x];
const f = feather(mask, W, H, 3);

check("interior is solid", at(60, 45) > 0.98, at(60, 45).toFixed(3));
check("overshoot past the real edge drops", at(81, 45) < 0.2, `edge ${at(81, 45).toFixed(3)} vs feather ${f[45 * W + 81].toFixed(3)}`);
check("missed strip inside the real edge is recovered", at(41, 45) > 0.8, `edge ${at(41, 45).toFixed(3)} vs feather ${f[45 * W + 41].toFixed(3)}`);
check("far outside stays exactly 0", at(5, 5) === 0 && at(110, 80) === 0);
let leak = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x < 25 || x > 98 || y < 10 || y > 80) && a[y * W + x] > 0) leak++;
check("no alpha beyond the band", leak === 0, `${leak} px`);
check("empty mask -> all zero", edgeAlpha(new Uint8Array(W * H), frame).every((v) => v === 0));

// Flat frame (no edges to snap to): behaves like a feather around the mask.
const flat = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(128) } as unknown as ImageData;
const af = edgeAlpha(mask, flat, 8);
check("flat frame keeps the mask interior", af[45 * W + 60] > 0.98);
check("flat frame: outside the mask fades", af[45 * W + 90] < 0.05, af[45 * W + 90].toFixed(3));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
