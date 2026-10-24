// Sends an image + prompt through the proxy's /api/edit and prints timing.
// Usage: npm run server (in another terminal), then:
//   npm run test:edit -- [path/to/photo.jpg] ["prompt"]            one call, proxy's .env settings
//   npm run test:edit -- --bench [path/to/photo.jpg] ["prompt"]    Meta latency settings, cumulative
// With no path on macOS, uses the system wallpaper (resized with sips). The same image is sent
// as the "highlight" too (there's no canvas in Node), so this measures the round trip, not mask fidelity.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.PROXY_URL ?? "http://localhost:8787";
const MAC_SAMPLE = "/System/Library/Wallpapers/.default/DefaultAerial.jpg";
const CALLS_PER_SETTING = 2;

const args = process.argv.slice(2);
const bench = args[0] === "--bench";
if (bench) args.shift();
const [argPath, argPrompt] = args;
const prompt = argPrompt ?? "Add a small red sailboat on the water";
const dir = mkdtempSync(join(tmpdir(), "test-edit-"));

const source = argPath ?? (existsSync(MAC_SAMPLE) ? MAC_SAMPLE : null);
if (!source) {
  console.error("usage: npm run test:edit -- [--bench] path/to/photo.jpg [prompt]");
  process.exit(1);
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
if (!health) {
  console.error(`proxy not reachable at ${BASE}; start it with: npm run server`);
  process.exit(1);
}
console.log(`provider ${health.imageProvider}/${health.imageModel} · timeout ${health.editTimeoutMs / 1000}s`);
console.log(`prompt: "${prompt}"\n`);

if (!bench) {
  const input = prepare(1024);
  console.log(`input ${input.width}x${input.height}, ${Math.round(input.bytes / 1024)}kB`);
  const r = await editOnce(input, undefined);
  if (!r.ok) {
    console.log(`FAILED in ${r.ms}ms (HTTP ${r.status}): ${r.error}`);
    process.exit(1);
  }
  console.log(`OK in ${r.ms}ms round trip (${r.proxyMs}ms in proxy) · ${r.mime}, ${r.kb}kB`);
  console.log(`saved ${r.saved}`);
  process.exit(0);
}

if (health.imageProvider !== "meta") {
  console.error("--bench measures Meta settings; start the proxy with IMAGE_PROVIDER=meta");
  process.exit(1);
}

// Each step adds one change on top of the previous step. Step 1 states the API defaults explicitly.
const STEPS = [
  { label: "API defaults (high, all tools on)", side: 1024, meta: { reasoning_strength: "high", enable_web_search: true, enable_image_search: true, enable_shell: true } },
  { label: "+ reasoning_strength low", side: 1024, meta: { reasoning_strength: "low" } },
  { label: "+ enable_web_search false", side: 1024, meta: { enable_web_search: false } },
  { label: "+ enable_image_search false", side: 1024, meta: { enable_image_search: false } },
  { label: "+ enable_shell false", side: 1024, meta: { enable_shell: false } },
  { label: "+ 768px input (long side)", side: 768, meta: {} },
];

const rows = [];
let meta = {};
for (const step of STEPS) {
  meta = { ...meta, ...step.meta };
  const input = prepare(step.side);
  const times = [];
  const errors = [];
  for (let i = 0; i < CALLS_PER_SETTING; i++) {
    const r = await editOnce(input, meta);
    if (r.ok) times.push(r.ms);
    else errors.push(`HTTP ${r.status}: ${r.error}`);
    console.log(`  ${step.label} #${i + 1}: ${r.ok ? `${(r.ms / 1000).toFixed(1)}s` : `REJECTED ${errors.at(-1)}`}`);
  }
  rows.push({ label: step.label, input: `${input.width}x${input.height}`, times, errors });
}

console.log(`\n| setting (cumulative) | input | avg s | runs |`);
console.log(`|---|---|---|---|`);
for (const r of rows) {
  const avg = r.times.length ? (r.times.reduce((a, b) => a + b, 0) / r.times.length / 1000).toFixed(1) : "—";
  const runs = r.times.map((t) => (t / 1000).toFixed(1)).join(", ") + (r.errors.length ? ` · ${r.errors.length} rejected` : "");
  console.log(`| ${r.label} | ${r.input} | ${avg} | ${runs} |`);
}
for (const r of rows.filter((x) => x.errors.length)) console.log(`\n${r.label}: ${r.errors[0]}`);

/** JPEG base64 with long side <= maxSide (macOS sips), like the app sends. */
function prepare(maxSide) {
  let path = source;
  if (process.platform === "darwin") {
    path = join(dir, `input-${maxSide}.jpg`);
    execFileSync("sips", ["-Z", String(maxSide), "-s", "format", "jpeg", source, "--out", path], { stdio: "ignore" });
  } else if (maxSide !== 1024) {
    console.warn(`  (no sips: sending ${source} unresized for the ${maxSide}px step)`);
  }
  const buf = readFileSync(path);
  return { image: buf.toString("base64"), bytes: buf.length, ...jpegSize(buf) };
}

async function editOnce(input, metaOptions) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      image: input.image,
      highlight: input.image,
      prompt,
      width: input.width,
      height: input.height,
      ...(metaOptions && { meta: metaOptions }),
    }),
  });
  const body = await res.json();
  const ms = Math.round(performance.now() - t0);
  if (body.error) return { ok: false, ms, status: res.status, error: body.error };
  const saved = join(dir, `output-${Date.now()}.${body.mime.split("/")[1] ?? "img"}`);
  writeFileSync(saved, Buffer.from(body.image, "base64"));
  return { ok: true, ms, proxyMs: body.ms, mime: body.mime, kb: Math.round((body.image.length * 3) / 4 / 1024), saved };
}

/** Reads width/height from a JPEG's SOF marker. */
function jpegSize(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error(`${source} is not a JPEG`);
  let i = 2;
  while (i < b.length) {
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error("no JPEG size marker found");
}
