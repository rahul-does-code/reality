// POST /api/aimask: what is at the pointed spot, then a SAM 3.1 mask for it.
// 1. Vision: Gemini (then Muse Spark 1.3 on 429/5xx/timeout/bad JSON, as /api/command does; straight to
//    Muse Spark if Gemini returned 429 in the last minute) gets the
//    512px frame with a red ring at the point and returns {name, bbox, alternatives}.
// 2. SAM 3.1 (docs: dev.meta.ai/docs/sam/segmenting): Responses API, model "sam-3.1", one input_text
//    with box/point prompt tokens and one input_image. One call carries several objects: 1 = the
//    vision box + a positive point at the marker, 2 = the point alone, 3.. = alternative boxes.
//    Output is the documented special-token text, decoded with Meta's @meta-sam/parser. Masks come
//    back per object as a raster covering that object's box (downscaled for big boxes), sent here
//    bit-packed; src/vision/aiMask.ts maps them onto the frame and picks one.
// Measured on a 1280x720 webcam frame: SAM 0.8-2.3s, zero matches = 200 with empty text.
import express, { Router } from "express";
import { decodeMaskToRaster, parseImageStream, recordsOfKind } from "@meta-sam/parser";
import { gemini429Recently, noteGeminiStatus } from "../geminiCooldown.js";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
const META_CHAT_URL = "https://api.meta.ai/v1/chat/completions";
const META_TEXT_MODEL = process.env.META_TEXT_MODEL ?? "muse-spark-1.3";
const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";
const SAM_MODEL = process.env.META_SAM_MODEL ?? "sam-3.1";
const VISION_TIMEOUT_MS = 8_000;
const SAM_TIMEOUT_MS = 10_000;
const MAX_ALTERNATIVES = 3;

/** Box in 0..1 frame coords. */
export type AiBox = { x0: number; y0: number; x1: number; y1: number };
export type AiVision = { name: string; bbox: AiBox; alternatives: { name: string; bbox: AiBox }[] };
/** One SAM object. role: which prompt produced it. bits: row-major 0/1 raster, packed 8 per byte, base64. */
export type AiSamInstance = {
  role: "vision" | "point" | "alternative";
  name: string;
  box: AiBox;
  confidence: number | null;
  rw: number;
  rh: number;
  bits: string;
};
export type AimaskRequest = {
  /** 512px JPEG base64 with the red ring drawn at the point. */
  marked: string;
  /** Unmarked JPEG base64 for SAM, and its pixel size. */
  frame: string;
  width: number;
  height: number;
  /** The point, 0..1. */
  point: { x: number; y: number };
};
export type AimaskResponse =
  | {
      vision: AiVision | null;
      visionProvider: "gemini" | "meta" | null;
      visionMs: number;
      visionError?: string;
      sam: AiSamInstance[] | null;
      samMs: number;
      samError?: string;
    }
  | { error: string };

class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const isTimeout = (e: unknown) => e instanceof DOMException && e.name === "TimeoutError";
const shouldFallback = (e: unknown) =>
  e instanceof ProviderError ? e.status === 429 || e.status >= 500 : e instanceof SyntaxError || isTimeout(e) || e instanceof TypeError;
const message = (e: unknown) => (isTimeout(e) ? "timed out" : e instanceof Error ? e.message : String(e));

// bbox: [ymin, xmin, ymax, xmax] normalized to 0-1000, Gemini's documented box_2d convention.
const BOX = { type: "array", items: { type: "integer" } };
const VISION_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    bbox: BOX,
    alternatives: { type: "array", items: { type: "object", properties: { name: { type: "string" }, bbox: BOX }, required: ["name", "bbox"] } },
  },
  required: ["name", "bbox", "alternatives"],
} as const;

const VISION_PROMPT = (p: { x: number; y: number }) =>
  `The user is pointing at the spot marked by the red ring, at x=${p.x.toFixed(3)}, y=${p.y.toFixed(3)} ` +
  `(normalized, origin top-left). Name the smallest meaningful object or region at the center of the ring ` +
  `(the ring itself is not part of the scene). Regions count: a window, a wall, the floor, the sky, a shirt, hair. ` +
  `Return JSON: "name" is a short noun phrase (2-4 words, e.g. "blue t-shirt", "yellow wall"), "bbox" its 2D ` +
  `bounding box as [ymin, xmin, ymax, xmax] normalized to 0-1000, and "alternatives" up to ${MAX_ALTERNATIVES} other ` +
  `plausible readings of what the ring points at (a larger or smaller object containing the spot), each {name, bbox}.`;

const toBox = (v: unknown): AiBox | null => {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === "number")) return null;
  const [ymin, xmin, ymax, xmax] = (v as number[]).map((n) => Math.min(1000, Math.max(0, n)) / 1000);
  return xmax > xmin && ymax > ymin ? { x0: xmin, y0: ymin, x1: xmax, y1: ymax } : null;
};

function toVision(text: string): AiVision {
  const j = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as { name?: unknown; bbox?: unknown; alternatives?: unknown };
  const bbox = toBox(j.bbox);
  if (typeof j.name !== "string" || !j.name.trim() || !bbox) throw new SyntaxError(`vision JSON missing name/bbox: ${text.slice(0, 200)}`);
  const alternatives = (Array.isArray(j.alternatives) ? j.alternatives : [])
    .map((a: { name?: unknown; bbox?: unknown }) => ({ name: typeof a?.name === "string" ? a.name.trim() : "", bbox: toBox(a?.bbox) }))
    .filter((a): a is { name: string; bbox: AiBox } => !!a.name && !!a.bbox)
    .slice(0, MAX_ALTERNATIVES);
  return { name: j.name.trim(), bbox, alternatives };
}

type Interaction = { steps?: { type?: string; content?: { type?: string; text?: string }[] }[] };

async function visionGemini(b: AimaskRequest, signal: AbortSignal): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new ProviderError(500, "GEMINI_API_KEY missing from .env");
  const r = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    signal,
    body: JSON.stringify({
      model: GEMINI_MODEL,
      store: false,
      input: [
        { type: "text", text: VISION_PROMPT(b.point) },
        { type: "image", mime_type: "image/jpeg", data: b.marked },
      ],
      generation_config: { thinking_level: "minimal" },
      response_format: { type: "text", mime_type: "application/json", schema: VISION_SCHEMA },
    }),
  });
  noteGeminiStatus(r.status);
  if (!r.ok) throw new ProviderError(r.status, `gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return ((await r.json()) as Interaction).steps
    ?.filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("") ?? "";
}

type ChatCompletion = { choices?: { message?: { content?: string | { text?: string }[] | null } }[] };

async function visionMeta(b: AimaskRequest, signal: AbortSignal): Promise<string> {
  const key = process.env.META_API_KEY;
  if (!key) throw new ProviderError(500, "META_API_KEY missing from .env");
  const r = await fetch(META_CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    signal,
    body: JSON.stringify({
      model: META_TEXT_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `${VISION_PROMPT(b.point)} Reply with the JSON object only.` },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b.marked}` } },
          ],
        },
      ],
      reasoning_effort: process.env.META_REASONING_EFFORT ?? "minimal",
      response_format: { type: "json_schema", json_schema: { name: "PointedObject", schema: VISION_SCHEMA, strict: false } },
    }),
  });
  if (!r.ok) throw new ProviderError(r.status, `meta ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const content = ((await r.json()) as ChatCompletion).choices?.[0]?.message?.content;
  return Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : (content ?? "");
}

async function vision(b: AimaskRequest): Promise<{ vision: AiVision; provider: "gemini" | "meta"; fallback?: string }> {
  // A 429 in the last minute (here or in /api/command) means the next Gemini call likely 429s too.
  if (gemini429Recently()) {
    return { vision: toVision(await visionMeta(b, AbortSignal.timeout(VISION_TIMEOUT_MS))), provider: "meta", fallback: "gemini 429 in the last minute" };
  }
  try {
    return { vision: toVision(await visionGemini(b, AbortSignal.timeout(VISION_TIMEOUT_MS))), provider: "gemini" };
  } catch (e) {
    if (!shouldFallback(e)) throw e;
    const fallback = message(e);
    console.warn(`[aimask] gemini failed (${fallback}), retrying with meta`);
    return { vision: toVision(await visionMeta(b, AbortSignal.timeout(VISION_TIMEOUT_MS))), provider: "meta", fallback };
  }
}

/** Docs (segmenting with prompts): pixel coords in the media's own size, x2/y2 inclusive, same w/h on every token. */
function samPrompt(b: AimaskRequest, v: AiVision | null): { text: string; objects: { role: AiSamInstance["role"]; name: string }[] } {
  const { width: w, height: h } = b;
  const px = Math.min(w - 1, Math.floor(b.point.x * w));
  const py = Math.min(h - 1, Math.floor(b.point.y * h));
  const point = `<|point;x=${px};y=${py};w=${w};h=${h}|>`;
  const contains = (box: AiBox) => b.point.x >= box.x0 && b.point.x <= box.x1 && b.point.y >= box.y0 && b.point.y <= box.y1;
  const box = (bx: AiBox) => {
    const x1 = Math.min(w - 1, Math.floor(bx.x0 * w));
    const y1 = Math.min(h - 1, Math.floor(bx.y0 * h));
    const x2 = Math.max(x1, Math.min(w - 1, Math.ceil(bx.x1 * w) - 1));
    const y2 = Math.max(y1, Math.min(h - 1, Math.ceil(bx.y1 * h) - 1));
    return `<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${w};h=${h}|>`;
  };
  const objects: { role: AiSamInstance["role"]; name: string; tokens: string }[] = [];
  // The marker point goes with a box only when it lies inside it (a positive point outside the object contradicts it).
  if (v) objects.push({ role: "vision", name: v.name, tokens: box(v.bbox) + (contains(v.bbox) ? point : "") });
  objects.push({ role: "point", name: v?.name ?? "object", tokens: point });
  for (const a of v?.alternatives ?? []) objects.push({ role: "alternative", name: a.name, tokens: box(a.bbox) + (contains(a.bbox) ? point : "") });
  // Object ids are 1-based positions in `objects`.
  return { text: "<0f>" + objects.map((o, i) => `${i + 1}${o.tokens}`).join(","), objects };
}

type SamResponse = { output?: { content?: { type?: string; text?: string }[] }[] };

async function sam(b: AimaskRequest, v: AiVision | null): Promise<AiSamInstance[]> {
  const key = process.env.META_API_KEY;
  if (!key) throw new ProviderError(500, "META_API_KEY missing from .env");
  const { text, objects } = samPrompt(b, v);
  // Non-streaming: same format in one response (docs: "Stream the response").
  const r = await fetch(META_RESPONSES_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(SAM_TIMEOUT_MS),
    body: JSON.stringify({
      model: SAM_MODEL,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text },
            { type: "input_image", image_url: `data:image/jpeg;base64,${b.frame}` },
          ],
        },
      ],
      metadata: { include_confidence: "true", mask_encoding: "one_bit" },
    }),
  });
  if (!r.ok) throw new ProviderError(r.status, `sam ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const out = ((await r.json()) as SamResponse).output?.flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")?.text ?? "";
  // Feed the complete text to the parser as a finished one-lane stream.
  const lane = { item_id: "aimask", output_index: 0, content_index: 0 };
  async function* events() {
    yield { type: "response.output_text.done" as const, text: out, ...lane };
    yield { type: "response.completed" as const };
  }
  const result = await parseImageStream(events()).finalResult;
  if (result.diagnostics.length) console.warn(`[aimask] sam parser: ${result.diagnostics.map((d) => d.message).join("; ")}`);
  const { width: w, height: h } = b;
  return recordsOfKind(result.records, "mask").flatMap((m) => {
    const o = objects[Number(m.objectId) - 1];
    if (!o) return [];
    const raster = decodeMaskToRaster(m.mask);
    const packed = new Uint8Array(Math.ceil(raster.length / 8));
    for (let i = 0; i < raster.length; i++) if (raster[i]) packed[i >> 3] |= 1 << (i & 7);
    return [
      {
        role: o.role,
        name: o.name,
        box: { x0: m.bounds.left / w, y0: m.bounds.top / h, x1: m.bounds.right / w, y1: m.bounds.bottom / h },
        confidence: m.confidence ?? null,
        rw: m.mask.width,
        rh: m.mask.height,
        bits: btoa(Array.from(packed, (c) => String.fromCharCode(c)).join("")),
      },
    ];
  });
}

const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export const aimaskRouter = Router();

aimaskRouter.post("/api/aimask", express.json({ limit: "8mb" }), async (req, res) => {
  const b = req.body as Partial<AimaskRequest>;
  if (
    typeof b?.marked !== "string" ||
    typeof b.frame !== "string" ||
    !Number.isInteger(b.width) ||
    !Number.isInteger(b.height) ||
    !unit(b.point?.x) ||
    !unit(b.point?.y)
  ) {
    res.status(400).json({ error: "marked, frame, width, height and point {x,y} (0..1) required" } satisfies AimaskResponse);
    return;
  }
  const body = b as AimaskRequest;
  const t0 = performance.now();
  let v: AiVision | null = null;
  let visionProvider: "gemini" | "meta" | null = null;
  let visionError: string | undefined;
  try {
    const got = await vision(body);
    v = got.vision;
    visionProvider = got.provider;
    if (got.fallback) console.log(`[aimask] vision via meta: ${got.fallback}`);
  } catch (e) {
    visionError = message(e);
  }
  const visionMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  let instances: AiSamInstance[] | null = null;
  let samError: string | undefined;
  try {
    instances = await sam(body, v);
  } catch (e) {
    samError = message(e);
  }
  const samMs = Math.round(performance.now() - t1);
  console.log(
    `[aimask] vision ${visionProvider ?? "failed"} ${visionMs}ms ${v ? `"${v.name}" +${v.alternatives.length} alt` : visionError}` +
      ` · sam ${samMs}ms ${instances ? `${instances.length} mask(s) ${instances.map((i) => i.role).join(",")}` : samError}`,
  );
  res.json({
    vision: v,
    visionProvider,
    visionMs,
    ...(visionError ? { visionError } : {}),
    sam: instances,
    samMs,
    ...(samError ? { samError } : {}),
  } satisfies AimaskResponse);
});
