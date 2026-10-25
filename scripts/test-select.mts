// Selection logic without a browser: background / invert / region on the current selection.
// (Pointed and named sources need the MediaPipe segmenter and a canvas, so they're tested in the app.)
// Usage: npm run test:select
import { resolveSelection, type CurrentSelection } from "../src/vision/select";
import { bbox, coverage } from "../src/vision/mask";
import type { Select } from "../src/commands/schema";

const W = 40;
const H = 30;
const frame = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) } as unknown as ImageData;

// Subject: a 10x20 block at x 15..24, y 5..24.
const subject = new Uint8Array(W * H);
for (let y = 5; y < 25; y++) for (let x = 15; x < 25; x++) subject[y * W + x] = 1;
const current: CurrentSelection = { mask: subject, subject, label: "bottle (named)" };

const sel = (s: Partial<Select>): Select => ({
  source: "pointed",
  name: null,
  face_part: null,
  region: null,
  refine: null,
  invert: false,
  ...s,
});

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}

// "blur the background" with no selection: refuse.
{
  const r = await resolveSelection(sel({ source: "background" }), frame, null, null);
  check("background without a selection refuses", "error" in r && r.error === "Point at the subject first, then say 'blur the background'", JSON.stringify(r));
}

// "blur the background" with a selection: exactly the inverse of the subject.
{
  const r = await resolveSelection(sel({ source: "background" }), frame, null, current);
  const ok = !("error" in r) && r.mask.every((v, i) => v === 1 - subject[i]) && r.subject === subject;
  check("background = inverse of the selection", ok, "error" in r ? r.error : r.label);
  // Saying it again starts from that result and must not flip back to the subject.
  if (!("error" in r)) {
    const again = await resolveSelection(sel({ source: "background" }), frame, null, { mask: r.mask, subject: r.subject, label: r.label });
    check("background twice stays the background", !("error" in again) && again.mask.every((v, i) => v === r.mask[i]));
  }
}

// "everything except this" on the current selection: invert.
{
  const r = await resolveSelection(sel({ invert: true }), frame, null, current);
  const ok = !("error" in r) && r.mask.every((v, i) => v === 1 - subject[i]) && r.label.startsWith("everything except");
  check("invert on the current selection", ok, "error" in r ? r.error : r.label);
}

// "only the top half" on the selection (no point): top half of the mask's box, nothing else.
{
  const r = await resolveSelection(sel({ region: { side: "top", fraction: 0.5 }, refine: "only" }), frame, null, current);
  const b = !("error" in r) ? bbox(r.mask, W, H) : null;
  const ok = !!b && b.x === 15 && b.w === 10 && b.y === 5 && b.h === 10 && !("error" in r) && !r.usedPoint;
  check("only the top half narrows the current mask", ok, b ? `bbox ${b.x},${b.y} ${b.w}x${b.h}` : "error" in r ? r.error : "empty");
}

// "a bit bigger": grows the current selection.
{
  const r = await resolveSelection(sel({ refine: "grow" }), frame, null, current);
  check("grow enlarges the selection", !("error" in r) && coverage(r.mask) > coverage(subject));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
