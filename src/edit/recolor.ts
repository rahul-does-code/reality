// Recolor: set hue + saturation toward the target, KEEP original lightness so shading/texture survive.
// Blended with the original by the feathered mask alpha. Pure CPU math, no model call.

function parseColor(css: string): [number, number, number] {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#000";
  ctx.fillStyle = css; // invalid strings are ignored, leaving black
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

/** Accumulated "adjust" deltas on top of a recolor: saturation/brightness -1..1, hue in degrees. */
export type RecolorAdjust = { saturation: number; brightness: number; hue: number };

/** Hue of a CSS color in degrees. */
export const hueOf = (css: string): number => rgbToHsl(...parseColor(css))[0] * 360;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Returns a NEW ImageData; the input is not modified (so history snapshots stay intact).
 * adjust shifts the target hue/saturation and moves each pixel's lightness toward white (+) or black (-).
 */
export function recolor(frame: ImageData, alpha: Float32Array, color: string, adjust?: RecolorAdjust): ImageData {
  const [tr, tg, tb] = parseColor(color);
  const [h0, ts] = rgbToHsl(tr, tg, tb);
  const th = (((h0 + (adjust?.hue ?? 0) / 360) % 1) + 1) % 1;
  const sat = clamp01(Math.min(1, ts * 0.9) + (adjust?.saturation ?? 0));
  const br = adjust?.brightness ?? 0;

  const out = new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
  const d = out.data;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i];
    if (a < 0.01) continue;
    const j = i * 4;
    const [, , l0] = rgbToHsl(d[j], d[j + 1], d[j + 2]);
    const l = br > 0 ? l0 + (1 - l0) * br : l0 * (1 + br);
    const [nr, ng, nb] = hslToRgb(th, sat, clamp01(l));
    d[j] = d[j] + (nr - d[j]) * a;
    d[j + 1] = d[j + 1] + (ng - d[j + 1]) * a;
    d[j + 2] = d[j + 2] + (nb - d[j + 2]) * a;
  }
  return out;
}
