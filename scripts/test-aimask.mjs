// Runs /api/aimask (vision + SAM 3.1) on a saved frame at 4 points and prints source, name and timing.
// Usage: npm run server (in another terminal), then:
//   npx tsx scripts/test-aimask.mjs --frame frame.jpg [--points "0.55,0.2;0.86,0.35;0.15,0.25;0.35,0.85"]
//     [--gap 4500] [--out dir]
// --gap ms waits between points (Gemini free tier: 15 requests/minute, so --gap 4500). --out writes
// <dir>/aimask-<i>.jpg with the chosen mask tinted red. Needs ffmpeg (ring drawing, resizing).
// The picking and sanity checks are the app's own (src/vision/aiMask.ts). MediaPipe can't run in Node,
// so where the app would try "box+mediapipe" this prints the rounded-box result it falls back to.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { bboxMask, pickSam, sane, targetBox } from "../src/vision/aiMask.ts";
import { coverage } from "../src/vision/mask.ts";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const FRAME = arg("frame");
if (!FRAME) throw new Error("--frame <jpeg> required");
const POINTS = (arg("points") ?? "0.55,0.2;0.86,0.35;0.15,0.25;0.35,0.85").split(";").map((s) => s.split(",").map(Number));
const GAP_MS = Number(arg("gap") ?? 0);
const OUT = arg("out");
const BASE = process.env.PROXY_URL ?? "http://localhost:8787";

const [W, H] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", FRAME])
  .toString()
  .trim()
  .split(",")
  .map(Number);
const rgb = (w, h) => execFileSync("ffmpeg", ["-v", "error", "-i", FRAME, "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 28 });
const jpeg = (buf, w, h) =>
  execFileSync("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", "-", "-q:v", "3", "-f", "mjpeg", "-"], { input: buf, maxBuffer: 1 << 28 });
const fit = (side) => {
  const s = Math.min(1, side / Math.max(W, H));
  return [Math.round(W * s), Math.round(H * s)];
};

// Same sizes as the app: 512px marked frame, 1024px frame for SAM.
const [mw, mh] = fit(512);
const [sw, sh] = fit(1024);
const samFrame = jpeg(rgb(sw, sh), sw, sh).toString("base64");
const small = rgb(mw, mh);

/** Red ring (and dot) at normalized (x, y), like markedJpeg in aiMask.ts. */
function marked(x, y) {
  const buf = Buffer.from(small);
  const r = Math.max(10, Math.round(Math.min(mw, mh) * 0.035));
  const lw = Math.max(3, r / 4);
  for (let py = 0; py < mh; py++)
    for (let px = 0; px < mw; px++) {
      if (Math.abs(Math.hypot(px - x * mw, py - y * mh) - r) > lw / 2) continue;
      const i = (py * mw + px) * 3;
      buf[i] = 255;
      buf[i + 1] = 0;
      buf[i + 2] = 0;
    }
  return jpeg(buf, mw, mh).toString("base64");
}

console.log(`frame ${FRAME} ${W}x${H}; marked ${mw}x${mh}, sam ${sw}x${sh}; ${POINTS.length} points, gap ${GAP_MS}ms`);
const full = OUT ? rgb(W, H) : null;
if (OUT) mkdirSync(OUT, { recursive: true });

for (const [i, [x, y]] of POINTS.entries()) {
  if (i && GAP_MS) await new Promise((r) => setTimeout(r, GAP_MS));
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/aimask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marked: marked(x, y), frame: samFrame, width: sw, height: sh, point: { x, y } }),
  });
  const body = await res.json();
  const ms = Math.round(performance.now() - t0);
  if (body.error) {
    console.log(`#${i} (${x},${y}) ${res.status} ${body.error}`);
    continue;
  }
  const p = { x: x * W, y: y * H };
  const target = body.vision ? targetBox(body, p, W, H) : null;
  let source = "mediapipe-or-fallback";
  let mask = null;
  let detail = "";
  const pick = body.sam?.length ? pickSam(body.sam, target?.bbox ?? null, p, W, H) : null;
  if (pick) {
    source = "sam";
    mask = pick.mask;
    detail = `${pick.inst.role} prompt, box IoU ${pick.iou.toFixed(2)}, conf ${pick.inst.confidence?.toFixed(2)}`;
  } else if (target) {
    const rect = bboxMask(target.bbox, W, H);
    if (sane(rect, W, H, p)) {
      source = "bbox (app tries box+mediapipe first)";
      mask = rect;
    }
  }
  const alts = body.vision?.alternatives.map((a) => a.name).join(", ") || "-";
  console.log(
    `#${i} (${x},${y}) source=${source} name="${target?.name ?? "-"}" alts=[${alts}] ` +
      `total ${ms}ms (vision ${body.visionProvider ?? "failed"} ${body.visionMs}ms, sam ${body.samMs}ms, ${body.sam?.length ?? 0} masks)` +
      `${mask ? ` coverage ${(coverage(mask) * 100).toFixed(1)}%` : ""}${detail ? ` · ${detail}` : ""}` +
      `${body.visionError ? ` · vision: ${body.visionError}` : ""}${body.samError ? ` · sam: ${body.samError}` : ""}`,
  );
  if (OUT && mask) {
    const buf = Buffer.from(full);
    for (let k = 0; k < W * H; k++) if (mask[k]) buf[k * 3] = Math.min(255, buf[k * 3] * 0.4 + 153), (buf[k * 3 + 1] *= 0.5), (buf[k * 3 + 2] *= 0.5);
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const k = (Math.round(p.y) + dy) * W + Math.round(p.x) + dx;
        if (k >= 0 && k < W * H) buf.fill(255, k * 3, k * 3 + 3);
      }
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-i", "-", `${OUT}/aimask-${i}.jpg`], { input: buf });
  }
}
