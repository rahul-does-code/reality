// Blur inside the mask. Uses canvas ctx.filter (GPU) where supported, else a CPU 3-pass box blur
// (a close Gaussian approximation). Composited back via the feathered alpha.
import { blendInside } from "./composite";

export const DEFAULT_BLUR = 0.6;

/** intensity 0..1 -> blur sigma ~2..40px */
export const blurRadius = (intensity: number) => 2 + Math.min(1, Math.max(0, intensity)) * 38;

let filterSupport: boolean | null = null;
function supportsCanvasFilter(): boolean {
  if (filterSupport === null) {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.filter = "blur(1px)";
    filterSupport = ctx.filter === "blur(1px)";
  }
  return filterSupport;
}

function blurWithFilter(frame: ImageData, px: number): Uint8ClampedArray {
  const src = document.createElement("canvas");
  src.width = frame.width;
  src.height = frame.height;
  src.getContext("2d")!.putImageData(frame, 0, 0);
  const dst = document.createElement("canvas");
  dst.width = frame.width;
  dst.height = frame.height;
  const ctx = dst.getContext("2d", { willReadFrequently: true })!;
  ctx.filter = `blur(${px}px)`;
  ctx.drawImage(src, 0, 0);
  // Near the borders the filter mixes in transparent pixels; getImageData un-premultiplies,
  // so RGB there is still a proper average of real pixels (we ignore the reduced alpha).
  return ctx.getImageData(0, 0, dst.width, dst.height).data;
}

/** One horizontal-or-vertical box pass with edge clamping, running sums: O(pixels). */
function boxPass(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, r: number, horizontal: boolean) {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = horizontal ? 4 : w * 4;
  const norm = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * w * 4 : line * 4;
    for (let ch = 0; ch < 3; ch++) {
      const at = (k: number) => src[base + Math.min(len - 1, Math.max(0, k)) * step + ch];
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += at(k);
      for (let k = 0; k < len; k++) {
        dst[base + k * step + ch] = sum * norm;
        sum += at(k + r + 1) - at(k - r);
      }
    }
  }
}

function blurOnCpu(frame: ImageData, sigma: number): Uint8ClampedArray {
  const { width: w, height: h } = frame;
  // Three box passes of radius ~sigma approximate a Gaussian with that sigma.
  const r = Math.max(1, Math.round(sigma));
  let a = new Uint8ClampedArray(frame.data);
  let b = new Uint8ClampedArray(frame.data.length);
  for (let pass = 0; pass < 3; pass++) {
    boxPass(a, b, w, h, r, true);
    [a, b] = [b, a];
    boxPass(a, b, w, h, r, false);
    [a, b] = [b, a];
  }
  return a;
}

/** Returns a NEW ImageData: `base` blurred inside `alpha`. Input is not modified. */
export function blurMasked(base: ImageData, alpha: Float32Array, intensity: number): ImageData {
  const px = blurRadius(intensity);
  const blurred = supportsCanvasFilter() ? blurWithFilter(base, px) : blurOnCpu(base, px);
  return blendInside(base, blurred, alpha);
}
