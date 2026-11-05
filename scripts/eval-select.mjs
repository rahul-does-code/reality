// Selection quality eval: serves a labeled set (index.json, img/, gt/) to eval/select.html in
// headless Chromium and prints mIoU, boundary IoU, failure rates and latency per method.
// Usage: node scripts/eval-select.mjs <dataset dir> [limit] [method substring ...]
//   (REFINE=n adds n corrective clicks per object; default 2)
// Build a dataset from Open Images with scripts/eval-prep.py.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Playwright is resolved like require() does (a global install works; no project dependency).
const { chromium } = createRequire(import.meta.url)("playwright");

const [dir = "evaldata/set", limitArg, ...only] = process.argv.slice(2);
const refine = Number(process.env.REFINE ?? 2);
// Own Vite server with HMR off, so editing source files can't reload the page mid-run.
const { createServer } = await import("vite");
const server = await createServer({ server: { port: 5199, strictPort: false, hmr: false }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
// No GPU process: headless software GL only slows things down (MediaPipe runs on its CPU delegate here).
const browser = await chromium.launch({ args: ["--disable-gpu"] });
const page = await browser.newPage();
page.on("console", (m) => /error/i.test(m.type()) && console.log("[page]", m.text().slice(0, 300)));
await page.route("**/evaldata/**", (route) => {
  const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/evaldata\//, ""));
  try {
    route.fulfill({ body: readFileSync(join(dir, rel)) });
  } catch {
    route.fulfill({ status: 404 });
  }
});
await page.goto(`${base}/eval/select.html`);
await page.waitForFunction(() => document.getElementById("log")?.textContent === "ready", null, { timeout: 120000 });
const rows = await page.evaluate((o) => window.runEval(o), { limit: limitArg ? Number(limitArg) : undefined, only: only.length ? only : undefined, refine });
writeFileSync(join(dir, "results.json"), JSON.stringify(rows));
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const pct = (a, q) => [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))];
for (const click of [...new Set(rows.map((r) => r.click))]) {
  console.log(`\nclick = ${click}`);
  console.log("method".padEnd(44), "mIoU  bIoU  >0.8  <0.5  fallback  ms p50  ms p90");
  for (const m of [...new Set(rows.map((r) => r.method))]) {
    const rs = rows.filter((r) => r.method === m && r.click === click);
    if (!rs.length) continue;
    const iou = rs.map((r) => r.iou);
    console.log(
      m.padEnd(44),
      mean(iou).toFixed(3),
      mean(rs.map((r) => r.biou)).toFixed(3),
      mean(iou.map((v) => +(v > 0.8))).toFixed(2).padStart(5),
      mean(iou.map((v) => +(v < 0.5))).toFixed(2).padStart(5),
      mean(rs.map((r) => +(r.note === "fallback"))).toFixed(2).padStart(9),
      pct(rs.map((r) => r.ms), 0.5).toFixed(0).padStart(7),
      pct(rs.map((r) => r.ms), 0.9).toFixed(0).padStart(7),
    );
  }
}
const enc = rows.filter((r) => r.encodeMs > 0).map((r) => r.encodeMs);
if (enc.length) console.log(`\nSAM encoder per frame (headless, WASM): p50 ${pct(enc, 0.5).toFixed(0)}ms p90 ${pct(enc, 0.9).toFixed(0)}ms`);
await browser.close();
await server.close();
