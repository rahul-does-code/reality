// What the Meta Ray-Ban Display shows: a 600x600 image where black is transparent (the display is
// additive), so only the edit is drawn: pixels that differ from the original frozen frame, a white
// outline around the current selection, and a status strip. The relay (server/routes/glassesRelay.ts,
// /glasses/overlay) passes it to the iPhone app, which puts it on the display with DAT's Image view.
// The same socket also feeds the glasses web app (glasses-webapp/), which draws the overlay on the
// glasses itself and moves it with the head: a "scene" (the overlay without the status strip, plus the
// time its frame was captured), the status as text, and "anchors" (where the tracker found the object).
//
// Which part of the camera frame the display covers:
//   "whole":   the whole frame letterboxed into the square (for the phone's mock display preview)
//   "aligned": a square window of the frame, centered at (cx, cy) with side `size` (all fractions of
//              the frame width/height/width). The glasses display covers only ~20 deg of the camera's
//              much wider view, so on real glasses this window is what lines the overlay up with the
//              world. Tune it by eye; it assumes the head hasn't moved since the frame was frozen.

import { GLASSES_RELAY_PORT } from "../input/glassesSource";

export const DISPLAY_PX = 600;

export type GlassesView =
  | { mode: "off" }
  | { mode: "whole" }
  | { mode: "aligned"; cx: number; cy: number; size: number };

const STORAGE_KEY = "glassesView";
export const DEFAULT_ALIGNED = { cx: 0.5, cy: 0.5, size: 0.3 };

export function loadGlassesView(): GlassesView {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (v?.mode === "whole" || v?.mode === "off") return { mode: v.mode };
    if (v?.mode === "aligned" && [v.cx, v.cy, v.size].every((n) => typeof n === "number"))
      return { mode: "aligned", cx: v.cx, cy: v.cy, size: v.size };
  } catch {
    // storage blocked or corrupt: use the default
  }
  return { mode: "whole" };
}

export function saveGlassesView(v: GlassesView) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    // storage blocked: the setting just isn't remembered
  }
}

/** The frame-px rectangle the display shows (may extend past the frame in "whole" mode). */
export function displayWindow(view: GlassesView, w: number, h: number) {
  if (view.mode === "aligned") {
    const side = view.size * w;
    return { x: view.cx * w - side / 2, y: view.cy * h - side / 2, side };
  }
  const side = Math.max(w, h);
  return { x: (w - side) / 2, y: (h - side) / 2, side };
}

export type OverlayInput = {
  original: ImageData | null; // the frozen frame (null when live)
  current: ImageData | null; // the frame after every edit so far
  alpha: Float32Array | null; // current selection, frame-sized
  status: string;
  view: GlassesView;
  test?: boolean; // calibration pattern instead of the edit
  tCapture?: number | null; // relay-clock ms when the frozen frame was captured
};

/** Messages to the relay for the glasses web app (text JSON; a scene with an image is followed by its PNG). */
export type SceneMessage = { type: "scene"; id: number; t: number | null; image: boolean };
export type AnchorMessage = { type: "anchor"; id: number; dx: number; dy: number; t: number };
export type StatusMessage = { type: "status"; text: string };

function toCanvas(img: ImageData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.putImageData(img, 0, 0);
  return c;
}

/** `img` cropped to the display window and scaled to 600x600 (outside the frame stays transparent black). */
function windowPixels(img: CanvasImageSource, win: { x: number; y: number; side: number }): Uint8ClampedArray {
  const c = document.createElement("canvas");
  c.width = c.height = DISPLAY_PX;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const k = DISPLAY_PX / win.side;
  ctx.setTransform(k, 0, 0, k, -win.x * k, -win.y * k);
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, DISPLAY_PX, DISPLAY_PX).data;
}

export function renderOverlay(input: OverlayInput): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = out.height = DISPLAY_PX;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, DISPLAY_PX, DISPLAY_PX);
  const { original, current, alpha, view } = input;

  if (input.test) {
    // Border, center cross and corner ticks: compare where they land on the real world with the
    // dashed window on the laptop stage, then adjust the window.
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 4;
    ctx.strokeRect(10, 10, DISPLAY_PX - 20, DISPLAY_PX - 20);
    ctx.beginPath();
    ctx.moveTo(DISPLAY_PX / 2 - 30, DISPLAY_PX / 2);
    ctx.lineTo(DISPLAY_PX / 2 + 30, DISPLAY_PX / 2);
    ctx.moveTo(DISPLAY_PX / 2, DISPLAY_PX / 2 - 30);
    ctx.lineTo(DISPLAY_PX / 2, DISPLAY_PX / 2 + 30);
    ctx.stroke();
  } else if (original && current) {
    const win = displayWindow(view, current.width, current.height);
    const img = ctx.getImageData(0, 0, DISPLAY_PX, DISPLAY_PX);
    const d = img.data;
    if (current !== original) {
      // Edited pixels only, faded in by how much they changed, so unchanged pixels stay black.
      const a = windowPixels(toCanvas(original), win);
      const b = windowPixels(toCanvas(current), win);
      for (let i = 0; i < d.length; i += 4) {
        const diff = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        const k = Math.min(1, Math.max(0, (diff - 10) / 30));
        if (k === 0) continue;
        d[i] = b[i] * k;
        d[i + 1] = b[i + 1] * k;
        d[i + 2] = b[i + 2] * k;
      }
    }
    if (alpha) {
      // White outline of the selection: inside pixels with an outside pixel 3 px away.
      const m = new ImageData(current.width, current.height);
      for (let i = 0; i < alpha.length; i++) m.data[i * 4 + 3] = alpha[i] > 0.5 ? 255 : 0;
      const s = windowPixels(toCanvas(m), win);
      const inside = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < DISPLAY_PX && y < DISPLAY_PX && s[(y * DISPLAY_PX + x) * 4 + 3] > 127;
      for (let y = 0; y < DISPLAY_PX; y++)
        for (let x = 0; x < DISPLAY_PX; x++) {
          if (!inside(x, y)) continue;
          if (inside(x - 3, y) && inside(x + 3, y) && inside(x, y - 3) && inside(x, y + 3)) continue;
          const j = (y * DISPLAY_PX + x) * 4;
          d[j] = d[j + 1] = d[j + 2] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
  }

  if (input.status) {
    // Dark gray, not black: black would be transparent and the text unreadable over the world.
    ctx.font = "bold 22px system-ui, sans-serif";
    const text = input.status.length > 48 ? input.status.slice(0, 47) + "…" : input.status;
    const w = Math.min(DISPLAY_PX - 32, ctx.measureText(text).width + 32);
    ctx.fillStyle = "#1C1E21";
    ctx.beginPath();
    ctx.roundRect((DISPLAY_PX - w) / 2, DISPLAY_PX - 64, w, 44, 12);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, DISPLAY_PX / 2, DISPLAY_PX - 42, DISPLAY_PX - 48);
  }
  return out;
}

/**
 * WebSocket to the relay's /glasses/overlay. update() renders and sends at most every MIN_GAP_MS;
 * newer updates replace older pending ones, and nothing is sent while the socket is still writing.
 */
export class GlassesOverlaySink {
  private static MIN_GAP_MS = 250;
  private ws: WebSocket | null = null;
  private closed = false;
  private pending: OverlayInput | null = null;
  private timer = 0;
  private lastSent = 0;
  private sending = false;
  private reconnectTimer = 0;
  private sceneKey: unknown[] = [];
  private sceneId = 0;
  private lastStatus: string | null = null;
  sent = 0;

  constructor(private url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:${GLASSES_RELAY_PORT}/glasses/overlay`) {
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    ws.onopen = () => {
      // A fresh relay connection gets everything again.
      this.sceneKey = [];
      this.lastStatus = null;
      this.schedule();
    };
    ws.onclose = () => {
      if (!this.closed) this.reconnectTimer = window.setTimeout(() => this.connect(), 1000);
    };
    this.ws = ws;
  }

  update(input: OverlayInput) {
    this.pending = input;
    this.schedule();
  }

  /** Current scene id (anchors refer to it). */
  get scene() {
    return this.sceneId;
  }

  /** Where the tracker found the object: frame-px offset from the frozen position, at relay time t. */
  anchor(dxFrame: number, dyFrame: number, t: number, view: GlassesView, w: number, h: number) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const k = DISPLAY_PX / displayWindow(view, w, h).side;
    const msg: AnchorMessage = { type: "anchor", id: this.sceneId, dx: dxFrame * k, dy: dyFrame * k, t };
    this.ws.send(JSON.stringify(msg));
  }

  clear() {
    this.pending = null;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "clear" }));
  }

  private schedule() {
    if (this.timer || this.sending || !this.pending) return;
    const wait = Math.max(0, this.lastSent + GlassesOverlaySink.MIN_GAP_MS - performance.now());
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      void this.flush();
    }, wait);
  }

  private async flush() {
    const ws = this.ws;
    const input = this.pending;
    if (!input || !ws || ws.readyState !== WebSocket.OPEN) return;
    this.pending = null;
    this.sending = true;
    try {
      const png = async (c: HTMLCanvasElement) =>
        (await new Promise<Blob | null>((r) => c.toBlob(r, "image/png")))?.arrayBuffer() ?? null;
      // For the phone (DAT Display): one image with the status burned in.
      const phonePng = await png(renderOverlay(input));
      if (phonePng && !this.closed && ws.readyState === WebSocket.OPEN) {
        ws.send(phonePng);
        this.sent++;
      }
      // For the glasses web app: the scene only when it changed (it re-anchors there), status as text.
      const key = [input.original, input.current, input.alpha, JSON.stringify(input.view), !!input.test, input.tCapture];
      if (key.some((v, i) => v !== this.sceneKey[i])) {
        this.sceneKey = key;
        const image = !!input.test || !!input.original;
        const scenePng = image ? await png(renderOverlay({ ...input, status: "" })) : null;
        if (!this.closed && ws.readyState === WebSocket.OPEN) {
          const msg: SceneMessage = { type: "scene", id: ++this.sceneId, t: input.test ? null : input.tCapture ?? null, image: !!scenePng };
          ws.send(JSON.stringify(msg));
          if (scenePng) ws.send(scenePng);
        }
      }
      if (input.status !== this.lastStatus && ws.readyState === WebSocket.OPEN) {
        this.lastStatus = input.status;
        const msg: StatusMessage = { type: "status", text: input.status };
        ws.send(JSON.stringify(msg));
      }
    } finally {
      this.sending = false;
      this.lastSent = performance.now();
      this.schedule();
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
