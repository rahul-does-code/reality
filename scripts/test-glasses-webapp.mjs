// Tests the glasses web app (glasses-webapp/) in headless Chromium against a real relay, standing in
// for the laptop (scene/anchor/status messages) and for the glasses' gyro (DeviceMotionEvents):
// head turns move the overlay the right way, anchors re-base it, Select reaches the laptop, and
// Calibrate learns new head axes.
// Usage: npm run build:glasses && npm run test:glasses
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { WebSocket } from "ws";

const PORT = 8798;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const relay = spawn("npx", ["tsx", "server/routes/glassesRelay.ts"], {
  env: { ...process.env, GLASSES_RELAY_PORT: String(PORT) },
  stdio: "ignore",
});
const browser = await chromium.launch();
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/glasses/status`)).ok) break;
    } catch {
      await sleep(200);
    }
  }
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  page.on("pageerror", (e) => check("no page errors", false, e.message));
  // lag=0: frames are timestamped at capture in this test.
  await page.goto(`http://127.0.0.1:${PORT}/glasses/app/?lag=0&ppd=30`);
  await page.keyboard.press("Enter"); // pinch on Start

  // The laptop side: a white square in the middle of the scene.
  const png = Buffer.from(
    (
      await page.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = c.height = 600;
        const x = c.getContext("2d");
        x.fillStyle = "#000";
        x.fillRect(0, 0, 600, 600);
        x.fillStyle = "#fff";
        x.fillRect(280, 280, 40, 40);
        return c.toDataURL("image/png");
      })
    ).split(",")[1],
    "base64",
  );
  const laptop = new WebSocket(`ws://127.0.0.1:${PORT}/glasses/overlay`);
  await new Promise((r) => laptop.on("open", r));
  const state = () =>
    page.evaluate(() => {
      const g = window.__glasses;
      return { scene: g.scene.id, img: !!g.scene.img, ...g.shift, anchor: g.anchor };
    });
  // Rotation rate (deg/s) about device x (beta), y (gamma), z (alpha) for ms.
  const turn = (beta, gamma, alpha, ms) =>
    page.evaluate(
      async ([beta, gamma, alpha, ms]) => {
        const send = (b, g, a) =>
          window.dispatchEvent(new DeviceMotionEvent("devicemotion", { rotationRate: { alpha: a, beta: b, gamma: g }, interval: 16 }));
        send(0, 0, 0);
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
          send(beta, gamma, alpha);
          await new Promise((r) => setTimeout(r, 16));
        }
        send(0, 0, 0);
      },
      [beta, gamma, alpha, ms],
    );
  const newScene = async (id) => {
    await turn(0, 0, 0, 50); // a pose sample before the capture time
    laptop.send(JSON.stringify({ type: "scene", id, t: Date.now(), image: true }));
    laptop.send(png);
    await sleep(300);
  };

  await newScene(1);
  let s = await state();
  check("scene arrives", s.scene === 1 && s.img, JSON.stringify(s));
  check("no shift before any head motion", near(s.dx, 0, 1) && near(s.dy, 0, 1), `${s.dx}, ${s.dy}`);

  await turn(0, 10, 0, 500); // ~5 deg about +y: turn left -> world moves right by ~150 px
  s = await state();
  check("turn left moves the overlay right", near(s.dx, 150, 25) && near(s.dy, 0, 5), `${Math.round(s.dx)}, ${Math.round(s.dy)}`);

  await newScene(2);
  await turn(10, 0, 0, 500); // ~5 deg about +x: look up -> world moves down
  s = await state();
  check("look up moves the overlay down", near(s.dy, 150, 25) && near(s.dx, 0, 5), `${Math.round(s.dx)}, ${Math.round(s.dy)}`);

  await newScene(3);
  await turn(0, 0, 20, 500); // ~10 deg about +z: head tilts counterclockwise -> overlay turns clockwise
  s = await state();
  check("head roll rotates the overlay", near((s.roll * 180) / Math.PI, 10, 2), `${((s.roll * 180) / Math.PI).toFixed(1)} deg`);

  await newScene(4);
  await turn(0, 10, 0, 300); // head turns before the tracker's frame...
  laptop.send(JSON.stringify({ type: "anchor", id: 4, dx: -60, dy: 25, t: Date.now() }));
  await sleep(200);
  s = await state();
  check("anchor replaces the motion before it", near(s.dx, -60, 4) && near(s.dy, 25, 4), `${Math.round(s.dx)}, ${Math.round(s.dy)}`);
  await turn(0, 10, 0, 300); // ...and only motion after the anchor adds to it (~3 deg -> ~90 px)
  s = await state();
  check("motion after the anchor adds to it", near(s.dx, -60 + 90, 20), `${Math.round(s.dx)}`);
  laptop.send(JSON.stringify({ type: "anchor", id: 3, dx: 300, dy: 0, t: Date.now() }));
  await sleep(200);
  check("anchors for an old scene are ignored", near((await state()).dx, -60 + 90, 20));

  laptop.send(JSON.stringify({ type: "status", text: "made it pink" }));
  await sleep(200);
  check("status shows", (await page.locator("#status").innerText()) === "made it pink");

  // A pinch with Select focused (the default after Start) reaches the laptop, even with the controls faded.
  const events = new WebSocket(`ws://127.0.0.1:${PORT}/glasses/events`);
  await new Promise((r) => events.on("open", r));
  const got = [];
  events.on("message", (d) => got.push(JSON.parse(String(d))));
  await page.keyboard.press("Enter");
  await sleep(300);
  check("pinch on Select reaches the laptop", got.some((e) => e.type === "input" && e.action === "select"), JSON.stringify(got));
  events.close();

  // Calibrate with glasses whose "turn left" is device +z and "look up" is device -y.
  await page.keyboard.press("ArrowRight"); // D-pad: wake the controls (faded after 6 s)
  await page.locator("#calibrate").focus();
  await page.keyboard.press("Enter");
  await sleep(1100);
  await turn(0, 0, 15, 1400);
  await sleep(1100);
  await turn(0, -15, 0, 1400);
  await sleep(300);
  check("calibration succeeds", (await page.locator("#status").innerText()) === "Calibrated");
  await newScene(5);
  await turn(0, 0, 10, 500); // device +z is now "turn left"
  s = await state();
  check("calibrated axes are used", near(s.dx, 150, 25) && near(s.dy, 0, 8), `${Math.round(s.dx)}, ${Math.round(s.dy)}`);

  laptop.send(JSON.stringify({ type: "clear" }));
  await sleep(300);
  s = await state();
  check("clear removes the scene", !s.img && s.scene === 0);
  laptop.close();
} finally {
  await browser.close();
  relay.kill();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
