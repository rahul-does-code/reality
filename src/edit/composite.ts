// Mask-limited compositing. Pixels with alpha ~0 are copied from `base` untouched, so everything
// outside the (feathered) mask stays pixel-identical no matter what the source image contains.

/** Returns a NEW ImageData: `base` blended toward `src` RGBA by `alpha`. */
export function blendInside(base: ImageData, src: Uint8ClampedArray, alpha: Float32Array): ImageData {
  const out = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
  const d = out.data;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i];
    if (a < 0.01) continue;
    const j = i * 4;
    d[j] = d[j] + (src[j] - d[j]) * a;
    d[j + 1] = d[j + 1] + (src[j + 1] - d[j + 1]) * a;
    d[j + 2] = d[j + 2] + (src[j + 2] - d[j + 2]) * a;
  }
  return out;
}

/** Scales `edited` (any size) to the frame size and blends it into `base` inside `alpha`. */
export function composite(base: ImageData, edited: CanvasImageSource, alpha: Float32Array): ImageData {
  const c = document.createElement("canvas");
  c.width = base.width;
  c.height = base.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(edited, 0, 0, c.width, c.height);
  return blendInside(base, ctx.getImageData(0, 0, c.width, c.height).data, alpha);
}
