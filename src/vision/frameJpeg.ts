// Frozen frame -> small JPEG for Gemini: 512px/q0.7 for command parsing (only needs the gist),
// 768px/q0.85 for named segmentation (boxes need detail).
const cache = new WeakMap<ImageData, Map<string, string>>();

/** JPEG base64 (no data: prefix), long side <= maxSide. Memoized per (frame object, size, quality). */
export function frameJpeg(frame: ImageData, maxSide = 768, quality = 0.85): string {
  let byKey = cache.get(frame);
  if (!byKey) cache.set(frame, (byKey = new Map()));
  const key = `${maxSide}/${quality}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const full = document.createElement("canvas");
  full.width = frame.width;
  full.height = frame.height;
  full.getContext("2d")!.putImageData(frame, 0, 0);
  const scale = Math.min(1, maxSide / Math.max(frame.width, frame.height));
  const small = document.createElement("canvas");
  small.width = Math.round(frame.width * scale);
  small.height = Math.round(frame.height * scale);
  const ctx = small.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(full, 0, 0, small.width, small.height);
  const b64 = small.toDataURL("image/jpeg", quality).split(",")[1];
  byKey.set(key, b64);
  return b64;
}
