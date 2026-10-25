// Frozen frame -> small JPEG for Gemini (command parsing and named segmentation share it).
const MAX_SIDE = 768;

const cache = new WeakMap<ImageData, string>();

/** JPEG base64 (no data: prefix), long side <= 768px. Memoized per frame object. */
export function frameJpeg(frame: ImageData): string {
  const hit = cache.get(frame);
  if (hit) return hit;
  const full = document.createElement("canvas");
  full.width = frame.width;
  full.height = frame.height;
  full.getContext("2d")!.putImageData(frame, 0, 0);
  const scale = Math.min(1, MAX_SIDE / Math.max(frame.width, frame.height));
  const small = document.createElement("canvas");
  small.width = Math.round(frame.width * scale);
  small.height = Math.round(frame.height * scale);
  const ctx = small.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(full, 0, 0, small.width, small.height);
  const b64 = small.toDataURL("image/jpeg", 0.85).split(",")[1];
  cache.set(frame, b64);
  return b64;
}
