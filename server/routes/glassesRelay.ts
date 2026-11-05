// Glasses relay: the iPhone app (Meta Wearables DAT, Mock Device Kit) pushes JPEG frames over a WebSocket;
// browsers read them back. One server on GLASSES_RELAY_PORT (default 8788):
//   ws://<laptop-ip>:8788/            phone -> relay, one binary JPEG per message, optionally preceded by a
//                                     text {"t": capture ms, "fps": phone send fps}
//   ws://<laptop-ip>:8788/glasses/ws  relay -> browser, text {"tPhone","tRelay"} then the JPEG
//                                     (src/input/glassesSource.ts)
// Every client gets only the latest frame: while a send to it is still being written, newer frames
// replace each other and it gets the newest once the write finishes. Nothing is ever queued per client.
//   GET /glasses/stream.mjpg          latest frames as multipart MJPEG (open in any browser tab)
//   GET /glasses/latest.jpg           the latest frame
//   GET /glasses/status               JSON: connected phones, fps in, frame count
// Overlay channel, the other direction (what the Ray-Ban Display shows, see src/edit/glassesOverlay.ts):
//   ws://<laptop-ip>:8788/glasses/overlay  browser -> relay, one binary 600x600 PNG per message, or the
//                                     text {"type":"clear"}. The relay passes the latest one to every
//                                     phone over the phone's own socket (latest wins, as above).
//   GET /glasses/overlay.png          the latest overlay image (404 after a clear)
// Glasses web app (glasses-webapp/, runs on the Ray-Ban Display and moves the overlay with the head):
//   On /glasses/overlay the browser also sends text {"type":"scene",id,t,image} (followed by the
//   scene PNG when image is true), {"type":"status",text} and {"type":"anchor",id,dx,dy,t}.
//   ws(s)://<host>/glasses/display    relay -> web app: the latest scene (JSON then PNG), status and
//                                     anchor, each only when it changed for that client; the web
//                                     app's {"type":"ping",t} gets {"type":"pong",t,server}.
// Hands-free control (glasses -> laptop):
//   The phone sends text {"type":"transcript",text,final} (glasses mic, DAT Speech) on its socket; the
//   web app sends {"type":"input",action:"select"|"undo"|"done"} (pinch on its buttons) on its socket.
//   ws://<laptop-ip>:8788/glasses/events  relay -> laptop browser: both, as they arrive (src/input/glassesEvents.ts)
// DIY glasses (hardware/glasses, firmware/reality-glasses): the ESP32 connects like the phone (camera
//   JPEGs on "/"), and on /glasses/display?raw=N gets each scene as N x N raw RGB565 (little-endian,
//   downscaled from the PNG here) after {"type":"scene",...,"fmt":"rgb565","w":N,"h":N}. Push-to-talk
//   audio arrives on its "/" socket as a binary WAV (16 kHz mono); laptop browsers get it on
//   /glasses/events as {"type":"audio"} followed by the WAV.
//   Microcontroller WebSocket libraries cap incoming messages (~15 KB for links2004 WebSockets), so
//   the firmware uses HTTP for the big pieces: /glasses/display?raw=N&fetch=1 sends only the scene
//   JSON, the frame comes from GET /glasses/scene.rgb565?n=N (header X-Scene-Id), and audio goes to
//   POST /glasses/audio (body = the WAV).
//   GET /glasses/app/                 the built web app (npm run build:glasses), so one HTTPS tunnel
//                                     to this port serves both the page and its socket.
// Importing this module starts the server (server/proxy.ts imports it).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { PNG } from "pngjs";

const PORT = Number(process.env.GLASSES_RELAY_PORT ?? 8788);
const BOUNDARY = "glassesframe";

type Frame = { jpeg: Buffer; tPhone: number | null; tRelay: number };
type Client = { busy: boolean; dirty: boolean };

let latest: Frame | null = null;
let frameCount = 0;
let phones = 0;
let phoneFps = 0; // send fps the phone reports
const arrivals: number[] = []; // ms timestamps of the last second of frames, for fps
const mjpegClients = new Map<http.ServerResponse, Client>();
const viewers = new Map<WebSocket, Client>();
// Overlay for the glasses display: null = nothing sent yet, "clear" = blank the display.
let overlay: Buffer | "clear" | null = null;
let overlayCount = 0;
const phoneClients = new Map<WebSocket, Client>();

// Glasses web app state: the latest of each, with a version so each client gets only what changed.
type Versioned<T> = { v: number; value: T };
let scene: Versioned<{ meta: string; png: Buffer | null }> = { v: 0, value: { meta: JSON.stringify({ type: "scene", id: 0, t: null, image: false }), png: null } };
let sceneId = 0; // the browser's id of the current scene (anchors for older scenes are dropped)
let status: Versioned<string> = { v: 0, value: JSON.stringify({ type: "status", text: "" }) };
let anchor: Versioned<string | null> = { v: 0, value: null };
type DisplayClient = { busy: boolean; dirty: boolean; scene: number; status: number; anchor: number; raw: number | null; fetch: boolean };
const displayClients = new Map<WebSocket, DisplayClient>();
const eventClients = new Set<WebSocket>();

/** Passes a glasses event (transcript or button) to every laptop browser listening. */
function publishEvent(json: string) {
  for (const ws of eventClients) if (ws.readyState === WebSocket.OPEN) ws.send(json);
}

/** Push-to-talk audio from the DIY glasses: {"type":"audio"} then the WAV, to every laptop browser. */
function publishAudio(wav: Buffer) {
  for (const ws of eventClients)
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "audio", t: Date.now() }));
      ws.send(wav);
    }
}

function isWav(buf: Buffer) {
  return buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
}
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../glasses-webapp/dist");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

// Scene PNG -> N x N RGB565 for the DIY glasses, cached per scene version and size.
let decoded: { v: number; png: PNG } | null = null;
const rawCache = new Map<number, { v: number; buf: Buffer }>();
function toRgb565(png: PNG, n: number): Buffer {
  const out = Buffer.alloc(n * n * 2);
  const { width: w, height: h, data } = png;
  for (let oy = 0; oy < n; oy++) {
    const y0 = Math.floor((oy * h) / n), y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * h) / n));
    for (let ox = 0; ox < n; ox++) {
      const x0 = Math.floor((ox * w) / n), x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * w) / n));
      let r = 0, g = 0, b = 0, cnt = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          const a = data[i + 3] / 255; // transparent = black (no light)
          r += data[i] * a;
          g += data[i + 1] * a;
          b += data[i + 2] * a;
          cnt++;
        }
      r /= cnt; g /= cnt; b /= cnt;
      out.writeUInt16LE(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3), (oy * n + ox) * 2);
    }
  }
  return out;
}
function rawScene(n: number): Buffer | null {
  const png = scene.value.png;
  if (!png) return null;
  const hit = rawCache.get(n);
  if (hit && hit.v === scene.v) return hit.buf;
  try {
    if (decoded?.v !== scene.v) decoded = { v: scene.v, png: PNG.sync.read(png) };
    const buf = toRgb565(decoded.png, n);
    rawCache.set(n, { v: scene.v, buf });
    return buf;
  } catch (e) {
    console.error("[glasses] scene PNG decode failed:", (e as Error).message);
    return null;
  }
}

function sendToDisplay(ws: WebSocket, c: DisplayClient) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (c.busy) {
    c.dirty = true;
    return;
  }
  const out: (string | Buffer)[] = [];
  if (c.scene !== scene.v) {
    if (c.raw) {
      const raw = rawScene(c.raw);
      out.push(JSON.stringify({ ...JSON.parse(scene.value.meta), image: !!raw, fmt: "rgb565", w: c.raw, h: c.raw }));
      if (raw && !c.fetch) out.push(raw);
    } else {
      out.push(scene.value.meta);
      if (scene.value.png) out.push(scene.value.png);
    }
    c.scene = scene.v;
  }
  if (c.status !== status.v) {
    out.push(status.value);
    c.status = status.v;
  }
  if (c.anchor !== anchor.v && anchor.value) {
    out.push(anchor.value);
    c.anchor = anchor.v;
  }
  c.dirty = false;
  if (!out.length) return;
  c.busy = true;
  out.forEach((m, i) =>
    ws.send(m, i < out.length - 1 ? undefined : () => {
      c.busy = false;
      if (c.dirty) sendToDisplay(ws, c);
    }),
  );
}

function displayChanged() {
  for (const [ws, c] of displayClients) sendToDisplay(ws, c);
}

function setScene(meta: string, png: Buffer | null) {
  scene = { v: scene.v + 1, value: { meta, png } };
  anchor = { v: anchor.v + 1, value: null }; // anchors belong to the scene they were found for
  displayChanged();
}

function serveApp(urlPath: string, res: http.ServerResponse) {
  const rel = decodeURIComponent(urlPath.slice("/glasses/app/".length)) || "index.html";
  const file = path.resolve(APP_DIR, rel);
  if (!file.startsWith(APP_DIR + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" }).end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found (did you run npm run build:glasses?)");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(data);
  });
}

function isJpeg(buf: Buffer) {
  return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8;
}

function fpsIn() {
  const cutoff = Date.now() - 1000;
  while (arrivals.length && arrivals[0] < cutoff) arrivals.shift();
  return arrivals.length;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Returns false when the socket is backed up ("drain" fires once it has flushed). */
function writeMjpegPart(res: http.ServerResponse, jpeg: Buffer): boolean {
  res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
  res.write(jpeg);
  return res.write("\r\n");
}

function sendToViewer(ws: WebSocket, c: Client) {
  if (!latest || ws.readyState !== WebSocket.OPEN) return;
  if (c.busy) {
    c.dirty = true;
    return;
  }
  c.busy = true;
  c.dirty = false;
  ws.send(JSON.stringify({ tPhone: latest.tPhone, tRelay: latest.tRelay }));
  ws.send(latest.jpeg, () => {
    c.busy = false;
    if (c.dirty) sendToViewer(ws, c);
  });
}

function sendToMjpeg(res: http.ServerResponse, c: Client) {
  if (!latest || res.destroyed) return;
  if (c.busy) {
    c.dirty = true;
    return;
  }
  c.dirty = false;
  if (!writeMjpegPart(res, latest.jpeg)) {
    c.busy = true;
    res.once("drain", () => {
      c.busy = false;
      if (c.dirty) sendToMjpeg(res, c);
    });
  }
}

function sendOverlayToPhone(ws: WebSocket, c: Client) {
  if (overlay === null || ws.readyState !== WebSocket.OPEN) return;
  if (c.busy) {
    c.dirty = true;
    return;
  }
  c.busy = true;
  c.dirty = false;
  const done = () => {
    c.busy = false;
    if (c.dirty) sendOverlayToPhone(ws, c);
  };
  if (overlay === "clear") ws.send(JSON.stringify({ type: "clear" }), done);
  else ws.send(overlay, done);
}

function publishOverlay(next: Buffer | "clear") {
  overlay = next;
  overlayCount++;
  for (const [ws, c] of phoneClients) sendOverlayToPhone(ws, c);
}

function isPng(buf: Buffer) {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function publish(jpeg: Buffer, tPhone: number | null) {
  latest = { jpeg, tPhone, tRelay: Date.now() };
  frameCount++;
  arrivals.push(latest.tRelay);
  for (const [res, c] of mjpegClients) sendToMjpeg(res, c);
  for (const [ws, c] of viewers) sendToViewer(ws, c);
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  const path = (req.url ?? "/").split("?")[0];

  if (path === "/glasses/latest.jpg") {
    if (!latest) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("no frame yet");
      return;
    }
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": latest.jpeg.length }).end(latest.jpeg);
    return;
  }
  if (path === "/glasses/app") {
    res.writeHead(301, { Location: "/glasses/app/" }).end();
    return;
  }
  if (path.startsWith("/glasses/app/")) {
    serveApp(path, res);
    return;
  }
  if (path === "/glasses/scene.rgb565") {
    const n = Number(new URL(req.url ?? "/", "http://x").searchParams.get("n"));
    if (!Number.isInteger(n) || n < 16 || n > 320) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("n must be 16..320");
      return;
    }
    const raw = rawScene(n);
    if (!raw) {
      res.writeHead(204, { "X-Scene-Id": String(sceneId) }).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": raw.length, "X-Scene-Id": String(sceneId) }).end(raw);
    return;
  }
  if (path === "/glasses/audio" && req.method === "POST") {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (d: Buffer) => {
      size += d.length;
      if (size <= 4 * 1024 * 1024) chunks.push(d);
    });
    req.on("end", () => {
      const wav = Buffer.concat(chunks);
      if (size > 4 * 1024 * 1024 || !isWav(wav)) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("expected a WAV under 4 MB");
        return;
      }
      publishAudio(wav);
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    });
    return;
  }
  if (path === "/glasses/overlay.png") {
    if (!Buffer.isBuffer(overlay)) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("no overlay");
      return;
    }
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": overlay.length }).end(overlay);
    return;
  }
  if (path === "/glasses/stream.mjpg") {
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      Connection: "keep-alive",
      Pragma: "no-cache",
    });
    const c = { busy: false, dirty: false };
    mjpegClients.set(res, c);
    sendToMjpeg(res, c);
    req.on("close", () => mjpegClients.delete(res));
    return;
  }
  if (path === "/glasses/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ phones, viewers: viewers.size, mjpegClients: mjpegClients.size, fpsIn: fpsIn(), phoneFps, frameCount, overlayCount, displays: displayClients.size, scene: sceneId }));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
});

const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });

wss.on("connection", (ws, req) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/glasses/ws") {
    const c = { busy: false, dirty: false };
    viewers.set(ws, c);
    sendToViewer(ws, c);
    ws.on("close", () => viewers.delete(ws));
    return;
  }
  if (path === "/glasses/overlay") {
    let sceneMeta: string | null = null; // a scene whose PNG is the next binary message
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        const text = toBuffer(data).toString();
        let m: { type?: string; id?: unknown; image?: unknown };
        try {
          m = JSON.parse(text);
        } catch {
          return; // not a command; ignore
        }
        if (m.type === "clear") {
          publishOverlay("clear");
          sceneId = 0;
          setScene(JSON.stringify({ type: "scene", id: 0, t: null, image: false }), null);
        } else if (m.type === "scene") {
          sceneId = Number(m.id) || 0;
          if (m.image) sceneMeta = text;
          else setScene(text, null);
        } else if (m.type === "status") {
          status = { v: status.v + 1, value: text };
          displayChanged();
        } else if (m.type === "anchor" && Number(m.id) === sceneId) {
          anchor = { v: anchor.v + 1, value: text };
          displayChanged();
        }
        return;
      }
      const buf = toBuffer(data);
      if (!isPng(buf)) return;
      if (sceneMeta) {
        setScene(sceneMeta, buf);
        sceneMeta = null;
      } else publishOverlay(buf);
    });
    return;
  }
  if (path === "/glasses/display") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const rawN = Number(q.get("raw"));
    const raw = Number.isInteger(rawN) && rawN >= 16 && rawN <= 320 ? rawN : null;
    const c: DisplayClient = { busy: false, dirty: false, scene: -1, status: -1, anchor: -1, raw, fetch: q.get("fetch") === "1" };
    displayClients.set(ws, c);
    console.log(`[glasses] display ${raw ? `(DIY glasses, ${raw}x${raw} RGB565)` : "web app"} connected (${displayClients.size})`);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        const m = JSON.parse(toBuffer(data).toString());
        if (m.type === "ping") ws.send(JSON.stringify({ type: "pong", t: m.t, server: Date.now() }));
        else if (m.type === "input" && typeof m.action === "string")
          publishEvent(JSON.stringify({ type: "input", action: m.action, t: Date.now() }));
      } catch {
        // ignore
      }
    });
    ws.on("close", () => displayClients.delete(ws));
    sendToDisplay(ws, c);
    return;
  }
  if (path === "/glasses/events") {
    eventClients.add(ws);
    ws.on("close", () => eventClients.delete(ws));
    return;
  }
  // Anything else is a phone sending frames (and receiving overlays on the same socket).
  phones++;
  const phoneClient = { busy: false, dirty: false };
  phoneClients.set(ws, phoneClient);
  sendOverlayToPhone(ws, phoneClient);
  console.log(`[glasses] phone connected from ${req.socket.remoteAddress} (${phones} total)`);
  let tPhone: number | null = null; // from the text message that precedes each frame
  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const meta = JSON.parse(toBuffer(data).toString());
        if (meta.type === "transcript") {
          if (typeof meta.text === "string")
            publishEvent(JSON.stringify({ type: "transcript", text: meta.text, final: !!meta.final, t: Date.now() }));
          return;
        }
        tPhone = typeof meta.t === "number" ? meta.t : null;
        if (typeof meta.fps === "number") phoneFps = meta.fps;
      } catch {
        // not metadata; ignore
      }
      return;
    }
    const buf = toBuffer(data);
    if (isWav(buf)) {
      publishAudio(buf);
      return;
    }
    if (isJpeg(buf)) publish(buf, tPhone);
    tPhone = null;
  });
  ws.on("close", () => {
    phoneClients.delete(ws);
    phones--;
    console.log(`[glasses] phone disconnected (${phones} left, ${frameCount} frames so far)`);
  });
});

server.on("error", (e) => console.error(`[glasses] relay failed on :${PORT}:`, e.message));
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[glasses] relay on :${PORT}  phone -> ws://<laptop-ip>:${PORT}  view -> http://localhost:${PORT}/glasses/stream.mjpg`);
});
