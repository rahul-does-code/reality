// POST /api/segment-text: SAM 3.1 with a text concept prompt (docs: dev.meta.ai/docs/sam/segmenting).
// The input_text is just a short noun phrase ("shirt", "person"); the response has one box + mask per
// match (zero matches = 200 with empty text). Used for clothing words, where a Gemini box + MediaPipe
// point mask tends to come back as the whole person. Masks are sent as in /api/aimask.
import express, { Router } from "express";
import { decodeMaskToRaster, parseImageStream, recordsOfKind } from "@meta-sam/parser";
import type { AiBox, AiSamInstance } from "./aimask";

const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";
const SAM_MODEL = process.env.META_SAM_MODEL ?? "sam-3.1";
const SAM_TIMEOUT_MS = 10_000;

/** Same raster encoding as AiSamInstance (bit-packed, covers its box); no prompt role or name. */
export type TextInstance = Pick<AiSamInstance, "box" | "confidence" | "rw" | "rh" | "bits">;
export type SegmentTextRequest = { frame: string; width: number; height: number; phrase: string };
export type SegmentTextResponse = { instances: TextInstance[]; ms: number } | { error: string };

type SamResponse = { output?: { content?: { type?: string; text?: string }[] }[] };

async function samText(b: SegmentTextRequest): Promise<TextInstance[]> {
  const key = process.env.META_API_KEY;
  if (!key) throw new Error("META_API_KEY missing from .env");
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
            { type: "input_text", text: b.phrase },
            { type: "input_image", image_url: `data:image/jpeg;base64,${b.frame}` },
          ],
        },
      ],
      metadata: { include_confidence: "true", mask_encoding: "one_bit" },
    }),
  });
  if (!r.ok) throw new Error(`sam ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const out = ((await r.json()) as SamResponse).output?.flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")?.text ?? "";
  const lane = { item_id: "segtext", output_index: 0, content_index: 0 };
  async function* events() {
    yield { type: "response.output_text.done" as const, text: out, ...lane };
    yield { type: "response.completed" as const };
  }
  const result = await parseImageStream(events()).finalResult;
  if (result.diagnostics.length) console.warn(`[segtext] sam parser: ${result.diagnostics.map((d) => d.message).join("; ")}`);
  const { width: w, height: h } = b;
  return recordsOfKind(result.records, "mask").map((m) => {
    const raster = decodeMaskToRaster(m.mask);
    const packed = new Uint8Array(Math.ceil(raster.length / 8));
    for (let i = 0; i < raster.length; i++) if (raster[i]) packed[i >> 3] |= 1 << (i & 7);
    const box: AiBox = { x0: m.bounds.left / w, y0: m.bounds.top / h, x1: m.bounds.right / w, y1: m.bounds.bottom / h };
    return {
      box,
      confidence: m.confidence ?? null,
      rw: m.mask.width,
      rh: m.mask.height,
      bits: btoa(Array.from(packed, (c) => String.fromCharCode(c)).join("")),
    };
  });
}

export const samTextRouter = Router();

samTextRouter.post("/api/segment-text", express.json({ limit: "8mb" }), async (req, res) => {
  const b = req.body as Partial<SegmentTextRequest>;
  const phrase = typeof b?.phrase === "string" ? b.phrase.trim().slice(0, 60) : "";
  if (typeof b?.frame !== "string" || !Number.isInteger(b.width) || !Number.isInteger(b.height) || !phrase) {
    res.status(400).json({ error: "frame, width, height and phrase required" } satisfies SegmentTextResponse);
    return;
  }
  const t0 = performance.now();
  try {
    const instances = await samText({ ...(b as SegmentTextRequest), phrase });
    const ms = Math.round(performance.now() - t0);
    console.log(`[segtext] sam ${ms}ms "${phrase}" -> ${instances.length} match(es)`);
    res.json({ instances, ms } satisfies SegmentTextResponse);
  } catch (e) {
    const msg = e instanceof DOMException && e.name === "TimeoutError" ? "sam timed out" : e instanceof Error ? e.message : String(e);
    console.error("[segtext] error:", msg);
    res.status(502).json({ error: msg } satisfies SegmentTextResponse);
  }
});
