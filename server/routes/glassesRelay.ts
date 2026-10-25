// Glasses relay: the iPhone app (Meta Wearables DAT, Mock Device Kit) pushes JPEG frames over a WebSocket;
// browsers read them back. One server on GLASSES_RELAY_PORT (default 8788):
//   ws://<laptop-ip>:8788/            phone -> relay, one binary JPEG per message
//   ws://<laptop-ip>:8788/glasses/ws  relay -> browser, latest JPEG per message (src/input/glassesSource.ts)
//   GET /glasses/stream.mjpg          latest frames as multipart MJPEG (open in any browser tab)
//   GET /glasses/latest.jpg           the latest frame
//   GET /glasses/status               JSON: connected phones, fps in, frame count
// Importing this module starts the server (server/proxy.ts imports it).
import http from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";

const PORT = Number(process.env.GLASSES_RELAY_PORT ?? 8788);
const BOUNDARY = "glassesframe";

let latest: Buffer | null = null;
let frameCount = 0;
let phones = 0;
const arrivals: number[] = []; // ms timestamps of the last second of frames, for fps
const mjpegClients = new Set<http.ServerResponse>();
const viewers = new Set<WebSocket>();

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

function writeMjpegPart(res: http.ServerResponse, jpeg: Buffer) {
  res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
  res.write(jpeg);
  res.write("\r\n");
}

function publish(jpeg: Buffer) {
  latest = jpeg;
  frameCount++;
  arrivals.push(Date.now());
  for (const res of mjpegClients) {
    // Skip slow clients instead of buffering frames for them (latest frame wins).
    if (res.writableLength > jpeg.length * 2) continue;
    writeMjpegPart(res, jpeg);
  }
  for (const ws of viewers) {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < jpeg.length * 2) ws.send(jpeg);
  }
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
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": latest.length }).end(latest);
    return;
  }
  if (path === "/glasses/stream.mjpg") {
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      Connection: "keep-alive",
      Pragma: "no-cache",
    });
    mjpegClients.add(res);
    if (latest) writeMjpegPart(res, latest);
    req.on("close", () => mjpegClients.delete(res));
    return;
  }
  if (path === "/glasses/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ phones, viewers: viewers.size, mjpegClients: mjpegClients.size, fpsIn: fpsIn(), frameCount }));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
});

const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });

wss.on("connection", (ws, req) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/glasses/ws") {
    viewers.add(ws);
    if (latest) ws.send(latest);
    ws.on("close", () => viewers.delete(ws));
    return;
  }
  // Anything else is a phone sending frames.
  phones++;
  console.log(`[glasses] phone connected from ${req.socket.remoteAddress} (${phones} total)`);
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return; // text messages are ignored (room for a hello/metadata later)
    const buf = toBuffer(data);
    if (isJpeg(buf)) publish(buf);
  });
  ws.on("close", () => {
    phones--;
    console.log(`[glasses] phone disconnected (${phones} left, ${frameCount} frames so far)`);
  });
});

server.on("error", (e) => console.error(`[glasses] relay failed on :${PORT}:`, e.message));
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[glasses] relay on :${PORT}  phone -> ws://<laptop-ip>:${PORT}  view -> http://localhost:${PORT}/glasses/stream.mjpg`);
});
