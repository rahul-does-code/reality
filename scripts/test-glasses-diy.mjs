// Tests the relay's DIY-glasses paths with plain WebSocket clients standing in for the ESP32, the
// laptop browser and the overlay sender: raw RGB565 scenes on /glasses/display?raw=N, push-to-talk
// WAVs from the device socket to /glasses/events, and button input from the display socket.
// Usage: npm run test:diy
import { spawn } from "node:child_process";
import { PNG } from "pngjs";
import { WebSocket } from "ws";

const PORT = 8799;
const N = 128;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
}
const open = async (path) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
  await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
  return ws;
};
const collect = (ws) => {
  const got = [];
  ws.on("message", (d, bin) => got.push(bin ? Buffer.from(d) : JSON.parse(String(d))));
  return got;
};

const relay = spawn("npx", ["tsx", "server/routes/glassesRelay.ts"], { env: { ...process.env, GLASSES_RELAY_PORT: String(PORT) }, stdio: "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/glasses/status`)).ok) break;
    } catch {
      await sleep(200);
    }
  }

  // 1. A scene (600x600, black with a pink square 240..360 and a white pixel row at y=0) reaches a
  //    raw client as 128x128 RGB565.
  const glasses = await open(`/glasses/display?raw=${N}`);
  const shown = collect(glasses);
  const laptop = await open("/glasses/overlay");
  const png = new PNG({ width: 600, height: 600 });
  for (let y = 0; y < 600; y++)
    for (let x = 0; x < 600; x++) {
      const i = (y * 600 + x) * 4;
      const pink = x >= 240 && x < 360 && y >= 240 && y < 360;
      png.data[i] = pink ? 255 : 0;
      png.data[i + 1] = pink ? 60 : 0;
      png.data[i + 2] = pink ? 160 : 0;
      png.data[i + 3] = 255;
    }
  laptop.send(JSON.stringify({ type: "scene", id: 7, t: Date.now(), image: true }));
  laptop.send(PNG.sync.write(png));
  await sleep(500);
  const metaIdx = shown.findIndex((m) => !Buffer.isBuffer(m) && m.type === "scene" && m.id === 7);
  const meta = shown[metaIdx];
  const raw = shown[metaIdx + 1];
  check("raw scene meta", meta && meta.fmt === "rgb565" && meta.w === N && meta.h === N && meta.image, JSON.stringify(meta));
  check("raw scene size", Buffer.isBuffer(raw) && raw.length === N * N * 2, raw && raw.length);
  if (Buffer.isBuffer(raw)) {
    const px = (x, y) => raw.readUInt16LE((y * N + x) * 2);
    const want = ((255 >> 3) << 11) | ((60 >> 2) << 5) | (160 >> 3);
    check("center is pink", px(64, 64) === want, px(64, 64).toString(16));
    check("corner is black (no light)", px(2, 2) === 0, px(2, 2).toString(16));
  }

  // 2. Push-to-talk: a WAV on the device socket reaches the laptop's events socket.
  const events = await open("/glasses/events");
  const heard = collect(events);
  const device = await open("/");
  const wav = Buffer.alloc(44 + 3200);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + 3200, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(3200, 40);
  device.send(wav);
  await sleep(300);
  const ai = heard.findIndex((m) => !Buffer.isBuffer(m) && m.type === "audio");
  check("audio event then the WAV", ai >= 0 && Buffer.isBuffer(heard[ai + 1]) && heard[ai + 1].equals(wav), JSON.stringify(heard.map((m) => (Buffer.isBuffer(m) ? `${m.length}B` : m.type))));

  // 3. Buttons and clock pings on the display socket.
  glasses.send(JSON.stringify({ type: "input", action: "undo" }));
  glasses.send(JSON.stringify({ type: "ping", t: 123 }));
  await sleep(300);
  check("button reaches the laptop", heard.some((m) => !Buffer.isBuffer(m) && m.type === "input" && m.action === "undo"));
  check("ping gets a pong", shown.some((m) => !Buffer.isBuffer(m) && m.type === "pong" && m.t === 123 && typeof m.server === "number"));

  for (const ws of [glasses, laptop, events, device]) ws.close();
} finally {
  relay.kill();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
