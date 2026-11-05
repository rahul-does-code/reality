// Hand eval page (driven by scripts/eval-hand.mjs): the app's HandLandmarker (same model and
// options, initHandTracker) on still photos of hands, 30 frames each with webcam-like sensor
// noise. Reports detection rate and the raw index-fingertip noise per frame, which
// scripts/eval-hand.mjs replays through the pointer filter.
import { initHandTracker } from "../src/input/handTracker";

const FRAMES = 30;
const NOISE = 4; // per-pixel Gaussian sigma, 8-bit levels (a typical 720p webcam indoors)

function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

const log = document.getElementById("log")!;
(window as any).runEval = async (files: string[]) => {
  const lm = await initHandTracker();
  let ts = 1;
  const out: { file: string; w: number; h: number; found: number; tips: ([number, number] | null)[]; dips: ([number, number] | null)[]; size: number }[] = [];
  for (const [n, file] of files.entries()) {
    const img = new Image();
    img.src = `/evaldata/hands/${file}`;
    await img.decode();
    const s = 1280 / Math.max(img.naturalWidth, img.naturalHeight);
    const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, w, h);
    const base = ctx.getImageData(0, 0, w, h);
    const tips: ([number, number] | null)[] = [];
    const dips: ([number, number] | null)[] = [];
    let size = 0;
    for (let f = 0; f < FRAMES; f++) {
      const frame = new ImageData(new Uint8ClampedArray(base.data), w, h);
      const d = frame.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = gauss() * NOISE;
        d[i] += g;
        d[i + 1] += g;
        d[i + 2] += g;
      }
      ts += 33;
      const r = lm.detectForVideo(frame, ts);
      const hand = r.landmarks[0];
      if (!hand) {
        tips.push(null);
        dips.push(null);
        continue;
      }
      tips.push([hand[8].x * w, hand[8].y * h]);
      dips.push([hand[7].x * w, hand[7].y * h]);
      size = Math.hypot((hand[0].x - hand[9].x) * w, (hand[0].y - hand[9].y) * h);
    }
    // A gap between photos so the tracker doesn't carry one hand's ROI into the next photo.
    ts += 5000;
    out.push({ file, w, h, found: tips.filter(Boolean).length, tips, dips, size });
    log.textContent = `${n + 1} / ${files.length}`;
  }
  return out;
};
log.textContent = "ready";
