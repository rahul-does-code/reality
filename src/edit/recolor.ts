// Recolor in OKLab (perceptual): every masked pixel takes the target hue and chroma, and the
// region's lightness is shifted toward the target's while each pixel keeps its offset from the
// region's mean, so shading and texture survive. A white mug made pink is pink (not white), a
// black shirt made white is white. Chroma is clipped to the sRGB gamut per lightness so bright or
// dark pixels never wrap to odd colors. Blended with the original by the feathered mask alpha.
// Pure CPU math, no model call.

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

// --- sRGB <-> OKLab (https://bottosson.github.io/posts/oklab/) ---

const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
// linear 0..1 -> sRGB 0..255, sampled finely enough that rounding hides the steps.
const LUT_N = 4096;
const TO_SRGB = new Uint8ClampedArray(LUT_N + 1);
for (let i = 0; i <= LUT_N; i++) {
  const c = i / LUT_N;
  TO_SRGB[i] = Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
}
const toSrgb = (v: number) => TO_SRGB[(v <= 0 ? 0 : v >= 1 ? 1 : v) * LUT_N + 0.5 | 0];

/** OKLab lightness of an sRGB pixel. */
function lightness(r: number, g: number, b: number): number {
  const lr = TO_LINEAR[r], lg = TO_LINEAR[g], lb = TO_LINEAR[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return 0.2104542553 * l + 0.793617963 * m - 0.0040720468 * s;
}

function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = TO_LINEAR[r], lg = TO_LINEAR[g], lb = TO_LINEAR[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617963 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab -> linear sRGB (may be out of 0..1). */
function oklabToLinear(L: number, a: number, b: number, out: Float64Array): void {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
}

const L_BINS = 128;
/** Largest in-gamut chroma for direction (ca, cb) at each lightness bin (binary search per bin). */
function maxChromaByLightness(ca: number, cb: number): Float32Array {
  const out = new Float32Array(L_BINS + 1);
  const rgb = new Float64Array(3);
  for (let i = 0; i <= L_BINS; i++) {
    const L = i / L_BINS;
    let lo = 0;
    let hi = 0.4;
    for (let k = 0; k < 14; k++) {
      const c = (lo + hi) / 2;
      oklabToLinear(L, ca * c, cb * c, rgb);
      const ok = rgb[0] >= 0 && rgb[0] <= 1 && rgb[1] >= 0 && rgb[1] <= 1 && rgb[2] >= 0 && rgb[2] <= 1;
      if (ok) lo = c;
      else hi = c;
    }
    out[i] = lo;
  }
  return out;
}

/** Accumulated "adjust" deltas on top of a recolor: saturation/brightness -1..1, hue in degrees. */
export type RecolorAdjust = { saturation: number; brightness: number; hue: number };

/** Hue of a CSS color in degrees. */
export const hueOf = (css: string): number => rgbToHsl(...parseColor(css))[0] * 360;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** How far the region's mean lightness moves toward the target's (1 = all the way). */
const LIGHTNESS_PULL = 0.8;

/**
 * Returns a NEW ImageData; the input is not modified (so history snapshots stay intact).
 * adjust shifts the target hue/saturation and moves each pixel's lightness toward white (+) or black (-).
 */
export function recolor(frame: ImageData, alpha: Float32Array, color: string, adjust?: RecolorAdjust): ImageData {
  const [tL, ta, tb] = rgbToOklab(...parseColor(color));
  const tC = Math.hypot(ta, tb);
  const th = Math.atan2(tb, ta) + ((adjust?.hue ?? 0) * Math.PI) / 180;
  const ca = Math.cos(th);
  const cb = Math.sin(th);
  const chroma = tC * clamp(1 + (adjust?.saturation ?? 0), 0, 2);
  const br = adjust?.brightness ?? 0;
  const maxC = chroma > 0 ? maxChromaByLightness(ca, cb) : null;

  const out = new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
  const d = out.data;

  // Pass 1: alpha-weighted mean lightness of the region.
  let sum = 0;
  let wsum = 0;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i];
    if (a < 0.5) continue;
    const j = i * 4;
    sum += lightness(d[j], d[j + 1], d[j + 2]) * a;
    wsum += a;
  }
  if (!wsum) {
    for (let i = 0; i < alpha.length; i++) {
      if (alpha[i] < 0.01) continue;
      const j = i * 4;
      sum += lightness(d[j], d[j + 1], d[j + 2]) * alpha[i];
      wsum += alpha[i];
    }
  }
  const mean = wsum ? sum / wsum : 0.5;
  const newMean = mean + (tL - mean) * LIGHTNESS_PULL;
  // Lifting a dark region stretches its (small) shading a little so it doesn't go flat; darkening
  // a bright one compresses it so highlights don't punch through. Kept within 0.7..1.6.
  const contrast = clamp(Math.sqrt((newMean + 0.05) / (mean + 0.05)), 0.7, 1.6);

  // Pass 2: new lightness, target hue/chroma (gamut-clipped), blend by alpha.
  const rgb = new Float64Array(3);
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i];
    if (a < 0.01) continue;
    const j = i * 4;
    const l0 = lightness(d[j], d[j + 1], d[j + 2]);
    let L = clamp(newMean + (l0 - mean) * contrast, 0.02, 0.99);
    if (br) L = br > 0 ? L + (1 - L) * br : L * (1 + br);
    const c = maxC ? Math.min(chroma, maxC[(L * L_BINS + 0.5) | 0]) : 0;
    oklabToLinear(L, ca * c, cb * c, rgb);
    d[j] = d[j] + (toSrgb(rgb[0]) - d[j]) * a;
    d[j + 1] = d[j + 1] + (toSrgb(rgb[1]) - d[j + 1]) * a;
    d[j + 2] = d[j + 2] + (toSrgb(rgb[2]) - d[j + 2]) * a;
  }
  return out;
}
