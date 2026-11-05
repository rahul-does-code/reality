// Pointer (hand) eval.
// 1) Runs the app's HandLandmarker on still photos of hands (Open Images val, 30 frames each with
//    sensor noise) in headless Chromium: detection rate and the real per-frame fingertip/DIP noise.
// 2) Replays that noise on synthetic pointing motions through the One Euro filter + aim-ahead the
//    app uses, for the current settings and a grid: jitter at rest, lag while moving, and the
//    error 150ms after a fast reach stops (when you would pinch).
// Usage: npx tsx scripts/eval-hand.mts <dir with hands/*.jpg> [n photos]
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Euro2 } from "../src/input/oneEuro";

const { chromium } = createRequire(import.meta.url)("playwright");
const [dir = "evaldata", nArg = "150"] = process.argv.slice(2);
type R = { file: string; found: number; tips: ([number, number] | null)[]; dips: ([number, number] | null)[]; size: number };
// The browser part is slow on CPU; its results are cached next to the photos (delete to rerun).
const cache = join(dir, `hands-results-${nArg}.json`);
let res: R[];
if (existsSync(cache)) res = JSON.parse(readFileSync(cache, "utf8"));
else {
  const { createServer } = await import("vite");
  const server = await createServer({ server: { port: 5198, strictPort: false, hmr: false }, logLevel: "error" });
  await server.listen();
  const browser = await chromium.launch({ args: ["--disable-gpu"] });
  const page = await browser.newPage();
  await page.route("**/evaldata/**", (route: any) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/evaldata\//, ""));
    try { route.fulfill({ body: readFileSync(join(dir, rel)) }); } catch { route.fulfill({ status: 404 }); }
  });
  await page.goto(`${server.resolvedUrls!.local[0]}eval/hand.html`);
  await page.waitForFunction(() => document.getElementById("log")?.textContent === "ready", null, { timeout: 120000 });
  const files = readdirSync(join(dir, "hands")).filter((f) => f.endsWith(".jpg")).sort().slice(0, Number(nArg));
  const out: R[] = await page.evaluate((f: string[]) => (window as any).runEval(f), files);
  await browser.close();
  await server.close();
  writeFileSync(cache, JSON.stringify(out));
  res = out;
}

// --- 1) detection + raw noise ---
const FR = res[0]?.tips.length ?? 30;
const any = res.filter((r) => r.found > 0);
const full = res.filter((r) => r.found === FR);
console.log(`photos ${res.length}: hand found in any frame ${any.length} (${pct(any.length / res.length)}), in every frame ${full.length} (${pct(full.length / res.length)})`);
console.log(`frames with a hand, among photos where it was found: ${pct(any.reduce((s, r) => s + r.found, 0) / (any.length * FR))}`);
// Noise normalized to a 150px hand (wrist to middle knuckle, ~arm's length at 720p).
const HAND = 150;
const noise: { tip: [number, number]; dip: [number, number] }[][] = full.map((r) => {
  const m = (a: [number, number][]) => [a.reduce((s, p) => s + p[0], 0) / a.length, a.reduce((s, p) => s + p[1], 0) / a.length];
  const t = r.tips as [number, number][], d = r.dips as [number, number][];
  const mt = m(t), md = m(d), k = HAND / r.size;
  return t.map((p, i) => ({ tip: [(p[0] - mt[0]) * k, (p[1] - mt[1]) * k], dip: [(d[i][0] - md[0]) * k, (d[i][1] - md[1]) * k] }));
});
const rad = (xs: [number, number][]) => Math.sqrt(xs.reduce((s, p) => s + p[0] ** 2 + p[1] ** 2, 0) / xs.length);
const allTip = noise.flat().map((n) => n.tip), allAim = noise.flat().map((n) => [2 * n.tip[0] - n.dip[0], 2 * n.tip[1] - n.dip[1]] as [number, number]);
console.log(`raw landmark noise (px, 150px hand): fingertip ${rad(allTip).toFixed(2)} · aim point (aimAhead 1) ${rad(allAim).toFixed(2)}`);

// --- 2) filter replay ---
const DT = 1000 / 30;
type P = { x: number; y: number };
function trajectory(): { t: number; p: P; phase: "hold" | "move" | "settle" }[] {
  const out: { t: number; p: P; phase: "hold" | "move" | "settle" }[] = [];
  let t = 0, p = { x: 400, y: 360 };
  const hold = (ms: number) => { for (let e = 0; e < ms; e += DT) out.push({ t: (t += DT), p: { ...p }, phase: e < 400 ? "settle" : "hold" }); };
  const reach = (dx: number, dy: number, ms: number) => {
    const p0 = { ...p };
    for (let e = DT; e <= ms; e += DT) {
      const s = e / ms, mj = 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5; // minimum-jerk reach
      p = { x: p0.x + dx * mj, y: p0.y + dy * mj };
      out.push({ t: (t += DT), p: { ...p }, phase: "move" });
    }
  };
  hold(1500); reach(500, 120, 350); hold(1200); reach(-150, 40, 1000); hold(1200); reach(-300, -150, 300); hold(1200);
  return out;
}
const traj = trajectory();
/** dirCutoff: if set, the aim direction (tip - dip) gets its own, steadier filter (the app's mode). */
function replay(minCutoff: number, beta: number, aimAhead: number, dirCutoff = 0) {
  const tipF = new Euro2(minCutoff, beta), dipF = new Euro2(minCutoff, beta), dirF = new Euro2(dirCutoff || 1, 0.001);
  let hj: number[] = [], mv: number[] = [], click: number[] = [];
  for (const [si, seq] of noise.entries()) {
    tipF.reset(); dipF.reset(); dirF.reset();
    let sinceStop = -1;
    traj.forEach((s, i) => {
      const n = seq[(i + si * 7) % seq.length];
      // DIP sits ~0.3 hand lengths behind the tip along the finger (pointing up-left-ish).
      const tip = tipF.filter({ x: s.p.x + n.tip[0], y: s.p.y + n.tip[1] }, s.t);
      const dip = dipF.filter({ x: s.p.x + 0.3 * HAND * 0.6 + n.dip[0], y: s.p.y + 0.3 * HAND * 0.8 + n.dip[1] }, s.t);
      const trueAim = { x: s.p.x - 0.3 * HAND * 0.6 * aimAhead, y: s.p.y - 0.3 * HAND * 0.8 * aimAhead };
      let aim = { x: tip.x + (tip.x - dip.x) * aimAhead, y: tip.y + (tip.y - dip.y) * aimAhead };
      if (dirCutoff) {
        const rawTip = { x: s.p.x + n.tip[0], y: s.p.y + n.tip[1] };
        const rawDip = { x: s.p.x + 0.3 * HAND * 0.6 + n.dip[0], y: s.p.y + 0.3 * HAND * 0.8 + n.dip[1] };
        const dir = dirF.filter({ x: rawTip.x - rawDip.x, y: rawTip.y - rawDip.y }, s.t);
        aim = { x: tip.x + dir.x * aimAhead, y: tip.y + dir.y * aimAhead };
      }
      const err = Math.hypot(aim.x - trueAim.x, aim.y - trueAim.y);
      if (s.phase === "move") { mv.push(err); sinceStop = 0; }
      else { if (sinceStop >= 0) sinceStop += DT; if (s.phase === "hold") hj.push(err); }
      if (sinceStop >= 150 && sinceStop < 150 + DT) click.push(err);
    });
  }
  const m = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  return { rest: Math.sqrt(m(hj.map((v) => v * v))), lag: m(mv), click: m(click) };
}
console.log("\npointer filter (aim point, px; 150px hand, 30 fps)");
console.log("minCutoff  beta    aimAhead          | jitter at rest | error while moving | error 150ms after stop");
const show = (c: number, b: number, a: number, tag = "", dir = 0) => {
  const r = replay(c, b, a, dir);
  console.log(`${c.toFixed(2).padStart(9)}  ${b.toFixed(3).padStart(6)}  ${a.toFixed(1).padStart(8)}${dir ? ` dir ${dir}Hz` : "         "} | ${r.rest.toFixed(2).padStart(14)} | ${r.lag.toFixed(1).padStart(18)} | ${r.click.toFixed(2).padStart(22)} ${tag}`);
  return r;
};
show(5, 0.2, 1, "<- current");
const grid: { c: number; b: number; r: ReturnType<typeof replay> }[] = [];
for (const c of [0.3, 0.5, 0.8, 1.2, 2, 3, 5]) for (const b of [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2]) grid.push({ c, b, r: replay(c, b, 1) });
// Objective: what a user feels when they pinch on a target (steadiness at rest + error at the
// press), among settings whose trailing while moving stays under MAX_LAG px.
const MAX_LAG = Number(process.env.MAX_LAG ?? 8);
const ok = grid.filter((g) => g.r.lag <= MAX_LAG).sort((a, z) => a.r.rest + a.r.click - (z.r.rest + z.r.click));
console.log(`best with error while moving <= ${MAX_LAG}px:`);
for (const g of ok.slice(0, 4)) show(g.c, g.b, 1);
// Same, with the aim direction on its own steady filter.
const gridD: { c: number; b: number; d: number; r: ReturnType<typeof replay> }[] = [];
for (const c of [0.8, 1.2, 2, 3, 5]) for (const b of [0.01, 0.02, 0.05, 0.1]) for (const d of [0.3, 0.6, 1]) gridD.push({ c, b, d, r: replay(c, b, 1, d) });
const okD = gridD.filter((g) => g.r.lag <= MAX_LAG).sort((a, z) => a.r.rest + a.r.click - (z.r.rest + z.r.click));
console.log(`with a separate aim-direction filter, error while moving <= ${MAX_LAG}px:`);
for (const g of okD.slice(0, 4)) show(g.c, g.b, 1, "", g.d);
function pct(v: number) { return `${(v * 100).toFixed(0)}%`; }
