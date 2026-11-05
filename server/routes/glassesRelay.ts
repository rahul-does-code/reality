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
// Importing this module starts the server (server/proxy.ts imports it).
import http from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";

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
    res.end(JSON.stringify({ phones, viewers: viewers.size, mjpegClients: mjpegClients.size, fpsIn: fpsIn(), phoneFps, frameCount, overlayCount }));
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
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        try {
          if (JSON.parse(toBuffer(data).toString()).type === "clear") publishOverlay("clear");
        } catch {
          // not a command; ignore
        }
        return;
      }
      const buf = toBuffer(data);
      if (isPng(buf)) publishOverlay(buf);
    });
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
        tPhone = typeof meta.t === "number" ? meta.t : null;
        if (typeof meta.fps === "number") phoneFps = meta.fps;
      } catch {
        // not metadata; ignore
      }
      return;
    }
    const buf = toBuffer(data);
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
