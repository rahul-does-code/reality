// Sends sample utterances to the running proxy and prints the parsed commands.
// Usage: npm run server (in another terminal), then: npm run test:commands
// Utterances run in order and each result becomes `previous` for the next, like a real session
// (undo/retry don't replace the context, matching Stage.tsx).
const BASE = process.env.PROXY_URL ?? "http://localhost:8787";

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

let previous = null;
let failures = 0;

for (const entry of UTTERANCES) {
  const [transcript, check] = Array.isArray(entry) ? entry : [entry, null];
  const t0 = performance.now();
  let line;
  try {
    const res = await fetch(`${BASE}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript, previous }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    const c = body.command;
    if (c.op !== "undo" && c.op !== "retry") previous = c;
    const fields = Object.entries(c)
      .filter(([k, v]) => k !== "op" && v !== null)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" ");
    line = `${c.op.padEnd(8)} ${fields}`;
    if (check && !check(c)) {
      failures++;
      line = `MISMATCH ${line}`;
    }
  } catch (e) {
    failures++;
    line = `ERROR ${e.message}`;
  }
  const ms = String(Math.round(performance.now() - t0)).padStart(5);
  console.log(`${ms}ms  ${JSON.stringify(transcript).padEnd(42)} -> ${line}`);
}

console.log(failures ? `\n${failures} failed` : "\nall parsed");
process.exit(failures ? 1 : 0);
