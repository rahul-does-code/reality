// Reality is yours, on the Meta Ray-Ban Display: draws the laptop's edit overlay on the glasses and
// keeps it on the object as the head moves. The laptop (src/edit/glassesOverlay.ts via the relay's
// /glasses/display socket) sends:
//   scene  {id, t, image} + PNG  the overlay for a frozen frame and when that frame was captured
//   anchor {id, dx, dy, t}       where the laptop's tracker found the object in a later frame
//   status {text}                the voice/edit status, drawn head-locked
// Between those, the head's rotation since the frame's capture time (gyro) shifts and rolls the
// overlay: turning left moves the world right by ppd px per degree, looking up moves it down.
//
// URL parameters: relay=<ws(s) url> (default: this host's /glasses/display), ppd=<px per degree, 30
// = 600 px over a 20 degree display>, lag=<ms between camera capture and relay arrival, 150>.

import { HeadPose, cross, dot, unit, type Vec3 } from "./headPose";

const PX = 600;
const params = new URLSearchParams(location.search);
const PPD = Number(params.get("ppd")) || 30;
const LAG_MS = Number(params.get("lag") ?? 150);
const RELAY_URL =
  params.get("relay") ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/glasses/display`;
const AXES_KEY = "headAxes";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const statusEl = document.getElementById("status")!;
const hudEl = document.getElementById("hud")!;
const controls = document.getElementById("controls")!;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const calibrateBtn = document.getElementById("calibrate") as HTMLButtonElement;
const infoBtn = document.getElementById("info") as HTMLButtonElement;

const pose = new HeadPose();

// Head axes in the device frame: +x = look up, +y = turn left (right-handed, +z points back).
type Axes = { up: Vec3; left: Vec3 };
let axes: Axes = loadAxes();

function loadAxes(): Axes {
  try {
    const a = JSON.parse(localStorage.getItem(AXES_KEY) ?? "null");
    if (Array.isArray(a?.up) && Array.isArray(a?.left)) return a;
  } catch {
    // storage blocked or corrupt
  }
  return { up: [1, 0, 0], left: [0, 1, 0] };
}

// ---- state from the laptop ----
type Scene = { id: number; t: number | null; img: ImageBitmap | null };
let scene: Scene = { id: 0, t: null, img: null };
let anchor: { dx: number; dy: number; t: number } | null = null;
let pendingScene: { id: number; t: number | null } | null = null; // waiting for its PNG
let connected = false;
// Relay clock minus local clock (ms), from the ping with the shortest round trip.
let clockOffset = 0;
let bestRtt = Infinity;

function connect() {
  const ws = new WebSocket(RELAY_URL);
  ws.binaryType = "blob";
  let pinger = 0;
  ws.onopen = () => {
    connected = true;
    bestRtt = Infinity;
    const ping = () => ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
    ping();
    pinger = window.setInterval(ping, 2000);
  };
  ws.onclose = () => {
    connected = false;
    clearInterval(pinger);
    setTimeout(connect, 1000);
  };
  ws.onmessage = async (ev) => {
    if (typeof ev.data !== "string") {
      const meta = pendingScene;
      pendingScene = null;
      if (!meta) return;
      try {
        const img = await createImageBitmap(ev.data as Blob);
        scene.img?.close();
        scene = { ...meta, img };
      } catch {
        // corrupt image: keep the old scene
      }
      return;
    }
    let m: any;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === "pong") {
      const now = Date.now();
      const rtt = now - m.t;
      if (rtt <= bestRtt) {
        bestRtt = rtt;
        clockOffset = m.server - (m.t + now) / 2;
      }
    } else if (m.type === "scene") {
      anchor = null;
      if (m.image) pendingScene = { id: m.id, t: m.t };
      else {
        scene.img?.close();
        scene = { id: m.id, t: m.t, img: null };
      }
    } else if (m.type === "anchor") {
      if (m.id === (pendingScene?.id ?? scene.id)) anchor = { dx: m.dx, dy: m.dy, t: m.t };
    } else if (m.type === "status") {
      statusEl.textContent = m.text;
      statusEl.hidden = !m.text;
    }
  };
}

/** Local Date.now() time when a frame that reached the relay at relay time t was captured. */
function captureTime(tRelay: number) {
  return tRelay - clockOffset - LAG_MS;
}

// ---- drawing ----
let shift = { dx: 0, dy: 0, roll: 0 };
let frames = 0;
let fps = 0;
let fpsFrom = performance.now();

function draw() {
  requestAnimationFrame(draw);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, PX, PX); // transparent canvas over a black page: nothing lit
  const img = scene.img;
  if (img) {
    let dx = 0, dy = 0, roll = 0;
    const base = anchor ?? (scene.t != null ? { dx: 0, dy: 0, t: scene.t } : null);
    if (base) {
      // Head rotation since the frame (or the tracker's fix) was captured, in head axes.
      const r = pose.since(captureTime(base.t));
      const up = dot(r, axes.up);
      const left = dot(r, axes.left);
      const back = dot(r, cross(axes.up, axes.left));
      dx = base.dx + (left * 180) / Math.PI * PPD;
      dy = base.dy + (up * 180) / Math.PI * PPD;
      roll = back; // head tilts counterclockwise -> the world turns clockwise on the display
    }
    shift = { dx, dy, roll };
    ctx.translate(PX / 2 + dx, PX / 2 + dy);
    ctx.rotate(roll);
    ctx.drawImage(img, -PX / 2, -PX / 2, PX, PX);
  }
  frames++;
  const now = performance.now();
  if (now - fpsFrom >= 1000) {
    fps = Math.round((frames * 1000) / (now - fpsFrom));
    frames = 0;
    fpsFrom = now;
  }
  if (!hudEl.hidden) {
    hudEl.textContent =
      `${connected ? "connected" : "connecting..."} · ${fps} fps\n` +
      `head: ${pose.source} ${pose.rate}/s\n` +
      `clock ${Math.round(clockOffset)} ms (rtt ${bestRtt === Infinity ? "-" : Math.round(bestRtt)})\n` +
      `scene ${scene.id}${anchor ? " · anchored" : ""}\n` +
      `shift ${Math.round(shift.dx)}, ${Math.round(shift.dy)} · roll ${((shift.roll * 180) / Math.PI).toFixed(1)}°`;
  }
}

// ---- controls: hidden after start; the first D-pad/pinch only shows them, so a pinch on the
// (invisible) focused button can't fire it by accident ----
let hideTimer = 0;
function showControls() {
  controls.classList.remove("faded");
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => controls.classList.add("faded"), 6000);
}
function guard(e: Event) {
  if (!controls.classList.contains("faded")) {
    showControls();
    return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  showControls();
}
document.addEventListener("keydown", guard, true);
document.addEventListener("click", guard, true);

async function requestSensors() {
  // iOS-style permission prompts where they exist; elsewhere these are undefined.
  const req = async (c: unknown) => {
    const f = (c as { requestPermission?: () => Promise<string> }).requestPermission;
    if (typeof f === "function") await f.call(c).catch(() => "denied");
  };
  await req(window.DeviceMotionEvent);
  await req(window.DeviceOrientationEvent);
}

startBtn.addEventListener("click", async () => {
  await requestSensors();
  pose.start();
  startBtn.hidden = true;
  calibrateBtn.hidden = false;
  infoBtn.hidden = false;
  calibrateBtn.focus();
  showControls();
});

infoBtn.addEventListener("click", () => {
  hudEl.hidden = !hudEl.hidden;
});

// Calibration: which device axes are "turn left" and "look up", measured from two head turns.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function measureTurn(prompt: string): Promise<Vec3 | null> {
  statusEl.hidden = false;
  statusEl.textContent = `${prompt} in 3...`;
  await wait(1000);
  statusEl.textContent = `${prompt} now`;
  const t0 = Date.now();
  await wait(1500);
  const r = pose.since(t0);
  return Math.hypot(...r) > (10 * Math.PI) / 180 ? unit(r) : null;
}

calibrateBtn.addEventListener("click", async () => {
  if (pose.source === "none") {
    statusEl.hidden = false;
    statusEl.textContent = "No head sensor data yet";
    return;
  }
  calibrateBtn.disabled = true;
  const left = await measureTurn("Turn your head left");
  const up = left && (await measureTurn("Look up"));
  if (left && up) {
    // Make "up" perpendicular to "left".
    const d = dot(up, left);
    axes = { left, up: unit([up[0] - d * left[0], up[1] - d * left[1], up[2] - d * left[2]]) };
    try {
      localStorage.setItem(AXES_KEY, JSON.stringify(axes));
    } catch {
      // not remembered
    }
    statusEl.textContent = "Calibrated";
  } else statusEl.textContent = "Didn't see enough head movement; try again";
  calibrateBtn.disabled = false;
  setTimeout(() => (statusEl.hidden = !statusEl.textContent || statusEl.textContent === "Calibrated"), 2000);
});

// Test hooks for scripts/test-glasses-webapp.mjs.
Object.assign(window, { __glasses: { pose, get shift() { return shift; }, get scene() { return scene; }, get anchor() { return anchor; } } });

connect();
requestAnimationFrame(draw);
startBtn.focus();
