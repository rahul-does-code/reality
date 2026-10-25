// Clothing words ("my shirt") are looked up with a SAM text prompt on the noun phrase, never with a
// Gemini box + MediaPipe point mask: MediaPipe at a point on a shirt returns the whole person, and
// that passed the IoU check against the shirt box. Masks taller than half the body box are rejected.
import type { SegmentTextRequest, SegmentTextResponse, TextInstance } from "../../server/routes/samtext";
import { samToMask } from "./aiMask";
import { frameJpeg } from "./frameJpeg";
import { bbox, coverage, type Point } from "./mask";

const CLOTHING = /\b(t-?shirts?|shirts?|tees?|jackets?|hoodies?|sweaters?|coats?|pants|jeans|trousers|shorts|hats?|caps?|shoes?|sneakers?|boots?|dress(?:es)?|skirts?)\b/i;
/** A clothing mask taller than this share of the body box is the person, not the garment. */
export const MAX_BODY_HEIGHT_SHARE = 0.5;
const SAM_SIDE = 1024;

export const isClothing = (name: string) => CLOTHING.test(name);

/** "my red shirt" -> "red shirt": SAM concept prompts are short noun phrases, not sentences. */
export const nounPhrase = (name: string) => name.trim().toLowerCase().replace(/^(?:my|the|a|an|his|her|their|that|this)\s+/, "");

type Box = { x: number; y: number; w: number; h: number };
type Cand = { mask: Uint8Array; box: Box; confidence: number | null };

const areaOf = (b: Box) => b.w * b.h;
function distance(b: Box, p: Point): number {
  return Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.w)), Math.max(b.y - p.y, 0, p.y - (b.y + b.h)));
}

/**
 * The garment among `shirts`: inside the body box (the person containing/nearest the point, else the
 * biggest), at most MAX_BODY_HEIGHT_SHARE of its height, nearest the point (else most confident).
 * Without a person match there is no body box, and only the nearest/most confident one is chosen.
 */
export function pickClothing(
  shirts: Cand[],
  people: Cand[],
  p: Point | null,
): { cand: Cand; body: Box | null; rejected: number } | { error: string } {
  if (!shirts.length) return { error: "no match" };
  const body =
    (p ? [...people].sort((a, b) => distance(a.box, p) - distance(b.box, p) || areaOf(a.box) - areaOf(b.box))[0] : [...people].sort((a, b) => areaOf(b.box) - areaOf(a.box))[0])?.box ?? null;
  let rejected = 0;
  const ok = shirts.filter((c) => {
    if (body) {
      const cx = c.box.x + c.box.w / 2;
      const cy = c.box.y + c.box.h / 2;
      const inside = cx >= body.x && cx <= body.x + body.w && cy >= body.y && cy <= body.y + body.h;
      if (!inside || c.box.h > MAX_BODY_HEIGHT_SHARE * body.h) {
        rejected++;
        return false;
      }
    }
    return true;
  });
  if (!ok.length) return { error: `all ${shirts.length} mask(s) over ${MAX_BODY_HEIGHT_SHARE * 100}% of the body box height` };
  ok.sort((a, b) => (p ? distance(a.box, p) - distance(b.box, p) || areaOf(a.box) - areaOf(b.box) : (b.confidence ?? 0) - (a.confidence ?? 0)));
  return { cand: ok[0], body, rejected };
}

async function findText(frame: ImageData, phrase: string): Promise<{ instances: TextInstance[]; ms: number }> {
  const s = Math.min(1, SAM_SIDE / Math.max(frame.width, frame.height));
  const body: SegmentTextRequest = {
    frame: frameJpeg(frame, SAM_SIDE, 0.9),
    width: Math.round(frame.width * s), // frameJpeg's size
    height: Math.round(frame.height * s),
    phrase,
  };
  const res = await fetch("/api/segment-text", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let json: SegmentTextResponse;
  try {
    json = (await res.json()) as SegmentTextResponse;
  } catch {
    throw new Error(`proxy ${res.status}: is the server running?`);
  }
  if ("error" in json) throw new Error(json.error);
  return json;
}

/** SAM text prompt for the garment (and "person", for the body box) -> one mask. */
export async function segmentClothing(
  frame: ImageData,
  name: string,
  p: Point | null,
): Promise<{ mask: Uint8Array; note: string; name: string } | { error: string }> {
  const { width: w, height: h } = frame;
  const phrase = nounPhrase(name);
  let found: Awaited<ReturnType<typeof findText>>;
  let persons: Awaited<ReturnType<typeof findText>>;
  try {
    [found, persons] = await Promise.all([findText(frame, phrase), findText(frame, "person")]);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const toCand = (i: TextInstance): Cand | null => {
    const mask = samToMask(i, w, h);
    const box = bbox(mask, w, h);
    return box ? { mask, box, confidence: i.confidence } : null;
  };
  const picked = pickClothing(found.instances.map(toCand).filter((c) => c !== null), persons.instances.map(toCand).filter((c) => c !== null), p);
  if ("error" in picked) return { error: `"${phrase}": ${picked.error}` };
  const cov = `${(coverage(picked.cand.mask) * 100).toFixed(1)}%`;
  const height = picked.body ? `, ${Math.round((picked.cand.box.h / picked.body.h) * 100)}% of body height` : ", no body box";
  const note = `sam text "${phrase}" ${found.ms}ms · mask ${cov} of frame${height}${picked.rejected ? ` · rejected ${picked.rejected}` : ""}`;
  return { mask: picked.cand.mask, note, name: phrase };
}
