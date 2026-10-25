// Glasses relay source: JPEG frames from the iPhone app (Meta Wearables DAT) via server/routes/glassesRelay.ts,
// drawn onto a canvas and exposed as canvas.captureStream(30). Same shape as startCamera/stopCamera, so
// everything downstream still only sees a playing <video>.
// Frames come over a WebSocket as blobs (not the MJPEG <img>): a cross-origin <img> would taint the canvas,
// and both captureStream and getImageData (segmentation) need an untainted one.

export const GLASSES_RELAY_PORT = 8788;
const FIRST_FRAME_TIMEOUT_MS = 8_000;
const RECONNECT_MS = 1_000;

type Active = {
  ws: WebSocket | null;
  canvas: HTMLCanvasElement;
  stream: MediaStream;
  closed: boolean;
  reconnectTimer?: number;
  wake: () => void; // ends the first-frame wait when the source is stopped early
};

let startToken = 0; // guards against overlapping starts (React StrictMode runs effects twice in dev)
let active: Active | null = null;
let frames = 0;
let lastFrameAt = 0;

export function defaultGlassesUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.hostname}:${GLASSES_RELAY_PORT}/glasses/ws`;
}

/** Frames drawn since the page loaded and the time of the last one (for fps/stall readouts). */
export function glassesStats() {
  return { frames, lastFrameAt };
}

export async function startGlassesSource(
  video: HTMLVideoElement,
  url: string = defaultGlassesUrl()
): Promise<MediaStream> {
  const token = ++startToken;
  stopGlassesSource(video);

  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext("2d")!;
  const stream = canvas.captureStream(30);
  let resolveFirst!: () => void;
  const firstFrame = new Promise<void>((r) => (resolveFirst = r));
  const state: Active = { ws: null, canvas, stream, closed: false, wake: resolveFirst };
  active = state;
  let pending: Blob | null = null; // newest frame waiting to be decoded; older ones are dropped
  let decoding = false;

  const drawNext = async () => {
    if (decoding || !pending || state.closed) return;
    decoding = true;
    const blob = pending;
    pending = null;
    try {
      const bmp = await createImageBitmap(blob);
      if (!state.closed) {
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        ctx.drawImage(bmp, 0, 0);
        frames++;
        lastFrameAt = performance.now();
        resolveFirst();
      }
      bmp.close();
    } catch {
      // corrupt/partial JPEG: skip it
    } finally {
      decoding = false;
      if (pending) void drawNext();
    }
  };

  const connect = () => {
    if (state.closed) return;
    const ws = new WebSocket(url);
    ws.binaryType = "blob";
    ws.onmessage = (ev) => {
      if (!(ev.data instanceof Blob)) return;
      pending = ev.data;
      void drawNext();
    };
    ws.onclose = () => {
      if (!state.closed) state.reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
    };
    state.ws = ws;
  };
  connect();

  // Resolve only once a real frame is on the canvas, so video.videoWidth/Height are the frame's size.
  let timer = 0;
  try {
    await Promise.race([
      firstFrame,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error(`No frames from the glasses relay (${url}). Is the iPhone app streaming?`)),
          FIRST_FRAME_TIMEOUT_MS
        );
      }),
    ]);
  } catch (e) {
    if (active === state) stopGlassesSource(video);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (token !== startToken || state.closed) {
    // Stopped, or superseded by a newer start (which already tore this source down).
    return stream;
  }
  video.srcObject = stream;
  try {
    await video.play();
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "AbortError")) throw e;
  }
  return stream;
}

export function stopGlassesSource(video?: HTMLVideoElement) {
  const state = active;
  active = null;
  if (state) {
    state.closed = true;
    clearTimeout(state.reconnectTimer);
    state.ws?.close();
    state.stream.getTracks().forEach((t) => t.stop());
    state.wake();
  }
  if (video && (!state || video.srcObject === state.stream)) video.srcObject = null;
}
