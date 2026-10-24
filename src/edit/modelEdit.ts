// Shared client for model-backed edits (remove/replace) via POST /api/edit.
// Gemini image models take no mask, so we send the clean frame plus a copy with the target
// tinted + outlined; the real mask is applied locally afterwards by composite().
import type { EditRequest, EditResponse } from "../commands/schema";
import type { Timeline } from "../commands/timeline";

const MAX_SIDE = 1024;
/** Used until /api/health reports the active provider's timeout (meta: 45s, gemini: 25s). */
const DEFAULT_TIMEOUT_MS = 45_000;
/** Extra time so the proxy's own timeout error (with provider detail) arrives before ours. */
const CLIENT_SLACK_MS = 2_000;

let timeoutPromise: Promise<number> | null = null;
/** Called on mount too, so the first edit doesn't wait on /api/health. */
export function editTimeoutMs(): Promise<number> {
  timeoutPromise ??= fetch("/api/health")
    .then((r) => r.json() as Promise<{ editTimeoutMs?: number }>)
    .then((h) => h.editTimeoutMs ?? DEFAULT_TIMEOUT_MS)
    .catch(() => {
      timeoutPromise = null; // proxy may not be up yet; ask again next time
      return DEFAULT_TIMEOUT_MS;
    });
  return timeoutPromise;
}

function toCanvas(frame: ImageData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = frame.width;
  c.height = frame.height;
  c.getContext("2d")!.putImageData(frame, 0, 0);
  return c;
}

function scaledCopy(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

/** Mask as a white-with-alpha canvas at frame size (also the CSS mask for the shimmer). */
function maskCanvas(alpha: Float32Array, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const img = new ImageData(w, h);
  for (let i = 0; i < alpha.length; i++) {
    const j = i * 4;
    img.data[j] = img.data[j + 1] = img.data[j + 2] = 255;
    img.data[j + 3] = alpha[i] * 255;
  }
  c.getContext("2d")!.putImageData(img, 0, 0);
  return c;
}

export function maskDataUrl(alpha: Float32Array, w: number, h: number): string {
  return maskCanvas(alpha, w, h).toDataURL("image/png");
}

/** Frame with the masked region tinted magenta and given a 2px magenta outline. */
function highlight(frame: HTMLCanvasElement, mask: HTMLCanvasElement): HTMLCanvasElement {
  const { width: w, height: h } = frame;
  const out = scaledCopy(frame, w, h);
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, w, h);
  const m = scaledCopy(mask, w, h).getContext("2d")!.getImageData(0, 0, w, h).data;
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && m[(y * w + x) * 4 + 3] > 127;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!inside(x, y)) continue;
      const edge = !inside(x - 2, y) || !inside(x + 2, y) || !inside(x, y - 2) || !inside(x, y + 2);
      const t = edge ? 1 : 0.45;
      img.data[i] += (255 - img.data[i]) * t;
      img.data[i + 1] -= img.data[i + 1] * t;
      img.data[i + 2] += (255 - img.data[i + 2]) * t;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

const jpegBase64 = (c: HTMLCanvasElement) => c.toDataURL("image/jpeg", 0.9).split(",")[1];

/**
 * Sends `frame` (+ highlighted copy of `alpha`) and `prompt` to the image model.
 * Resolves with the edited image at whatever size the model returned; rejects on error/timeout.
 */
export async function modelEdit(
  frame: ImageData,
  alpha: Float32Array,
  prompt: string,
  timeline?: Timeline,
): Promise<ImageBitmap> {
  const scale = Math.min(1, MAX_SIDE / Math.max(frame.width, frame.height));
  const w = Math.round(frame.width * scale);
  const h = Math.round(frame.height * scale);
  const small = scaledCopy(toCanvas(frame), w, h);
  const body: EditRequest = {
    image: jpegBase64(small),
    highlight: jpegBase64(highlight(small, maskCanvas(alpha, frame.width, frame.height))),
    prompt,
    width: w,
    height: h,
  };

  // Send first; only then wait for the (normally cached) timeout value to arm the timer.
  const ctrl = new AbortController();
  const request = fetch("/api/edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  });
  timeline?.mark("model started");
  const timeoutMs = await editTimeoutMs();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs + CLIENT_SLACK_MS);
  try {
    const res = await request;
    let data: EditResponse;
    try {
      data = (await res.json()) as EditResponse;
    } catch {
      throw new Error(`proxy ${res.status}: is the server running? (npm run dev:all)`);
    }
    if ("error" in data) throw new Error(data.error);
    const blob = await (await fetch(`data:${data.mime};base64,${data.image}`)).blob();
    const bitmap = await createImageBitmap(blob);
    timeline?.mark("model returned");
    return bitmap;
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`image model timed out after ${timeoutMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
