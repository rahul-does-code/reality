// Sends sample utterances to the running proxy and prints the parsed commands.
// Usage: npm run server (in another terminal), then: npm run test:commands
// Runs the suite once per provider mode (TEST_PROVIDERS, default "gemini,meta"; "auto" also works) and
// prints pass rate and latency per answering provider. Unchecked utterances pass if they parse.
// Utterances run in order and each result becomes `previous` for the next, like a real session
// (undo/retry don't replace the context, matching Stage.tsx).
const BASE = process.env.PROXY_URL ?? "http://localhost:8787";
const MODES = (process.env.TEST_PROVIDERS ?? "gemini,meta").split(",").map((m) => m.trim()).filter(Boolean);

const UTTERANCES = [
  "make that red",
  "a little darker",
  "more saturated",
  "do it again",
  "undo",
  "turn the mug baby blue",
  "blur the background",
  "less",
  "get rid of this",
  "replace that with a potted cactus",
  "make it warmer",
  "paint my shirt the color of a lemon",
  // Selection (select object), each with a check on the parsed command.
  ["change my nose", (c) => c.select?.source === "face_part" && c.select.face_part === "nose"],
  ["only the top half of this can", (c) => c.select?.source === "pointed" && c.select.region?.side === "top" && c.select.region.fraction === 0.5],
  ["select the tree", (c) => c.op === "select" && c.select?.source === "named" && c.select.name === "tree"],
  ["a bit bigger", (c) => c.op === "select" && c.select?.refine === "grow"],
  ["make the left third of this red", (c) => c.op === "recolor" && c.select?.region?.side === "left" && Math.abs(c.select.region.fraction - 0.33) < 0.02],
];

/** Runs every utterance with the given provider override; returns one row per utterance. */
async function runSuite(mode) {
  console.log(`\n=== provider ${mode} ===`);
  let previous = null;
  const rows = [];
  for (const entry of UTTERANCES) {
    const [transcript, check] = Array.isArray(entry) ? entry : [entry, null];
    const t0 = performance.now();
    let line;
    let provider = "error";
    let pass = false;
    try {
      const res = await fetch(`${BASE}/api/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript, previous, provider: mode }),
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      provider = body.provider ?? "?";
      const c = body.command;
      if (c.op !== "undo" && c.op !== "retry") previous = c;
      const fields = Object.entries(c)
        .filter(([k, v]) => k !== "op" && v !== null)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join(" ");
      line = `${c.op.padEnd(8)} ${fields}`;
      pass = !check || check(c);
      if (!pass) line = `MISMATCH ${line}`;
      if (body.fallback) line += `  [fallback: ${body.fallback.slice(0, 80)}]`;
    } catch (e) {
      line = `ERROR ${e.message}`;
    }
    const ms = Math.round(performance.now() - t0);
    rows.push({ mode, provider, pass, ms });
    console.log(`${String(ms).padStart(5)}ms  ${provider.padEnd(6)} ${JSON.stringify(transcript).padEnd(42)} -> ${line}`);
  }
  return rows;
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

const all = [];
for (const mode of MODES) all.push(...(await runSuite(mode)));

console.log("\nmode    answered by  pass        avg ms  p50 ms  p90 ms  max ms");
for (const mode of MODES) {
  const rows = all.filter((r) => r.mode === mode);
  for (const provider of [...new Set(rows.map((r) => r.provider))]) {
    const g = rows.filter((r) => r.provider === provider);
    const passed = g.filter((r) => r.pass).length;
    const ms = g.map((r) => r.ms).sort((a, b) => a - b);
    const avg = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length);
    const rate = `${passed}/${g.length} ${Math.round((100 * passed) / g.length)}%`;
    console.log(
      `${mode.padEnd(7)} ${provider.padEnd(12)} ${rate.padEnd(11)} ${[avg, pct(ms, 0.5), pct(ms, 0.9), ms.at(-1)].map((n) => String(n).padStart(6)).join("  ")}`,
    );
  }
}

const failures = all.filter((r) => !r.pass).length;
console.log(failures ? `\n${failures} failed` : "\nall parsed");
process.exit(failures ? 1 : 0);
