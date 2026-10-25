// Tiny API proxy so API keys (GEMINI_API_KEY, META_API_KEY) stay server-side. Vite proxies /api/* here in dev.
// Run: npx tsx server/proxy.ts   (or `npm run dev:all` for this + Vite)
import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  COMMAND_JSON_SCHEMA,
  validateCommand,
  type Command,
  type CommandProvider,
  type CommandRequest,
  type CommandResponse,
  type EditRequest,
  type EditResponse,
  type MetaSpeedOptions,
  type NamedInstance,
  type SegmentNamedRequest,
  type SegmentNamedResponse,
} from "../src/commands/schema";

const PORT = Number(process.env.PROXY_PORT ?? 8787);
const API_KEY = process.env.GEMINI_API_KEY;
// Flash-Lite: ~3-5s here vs 25-45s for gemini-3.8-flash (which also rejects "minimal" thinking).
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
const THINKING = process.env.GEMINI_THINKING ?? "minimal";
// Per-image token budget for the command frame (docs: media resolution; Gemini 3 default = 1120
// tokens, low = 280). Pixel size doesn't change it: 768px and 512px frames both cost 1100 tokens.
// low measured ~15% faster on a real webcam frame and still resolved "taller"/"left" references.
const RESOLUTIONS = ["low", "medium", "high", "ultra_high"] as const;
type Resolution = (typeof RESOLUTIONS)[number];
const asResolution = (v: unknown): Resolution | undefined =>
  RESOLUTIONS.includes(v as Resolution) ? (v as Resolution) : undefined;
const COMMAND_IMAGE_RESOLUTION = asResolution(process.env.GEMINI_COMMAND_IMAGE_RESOLUTION) ?? "low";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

// Command parsing: COMMAND_PROVIDER=auto (default: Gemini, then Muse Spark on 429/5xx/timeout/bad JSON),
// gemini or meta (single provider, no fallback).
const PROVIDERS = ["gemini", "meta", "auto"] as const;
type ProviderMode = (typeof PROVIDERS)[number];
const asMode = (v: unknown): ProviderMode | null => (PROVIDERS.includes(v as ProviderMode) ? (v as ProviderMode) : null);
const COMMAND_PROVIDER: ProviderMode = asMode(process.env.COMMAND_PROVIDER) ?? "auto";
const COMMAND_TIMEOUT_MS = 8_000;
const META_CHAT_URL = "https://api.meta.ai/v1/chat/completions";
const META_TEXT_MODEL = process.env.META_TEXT_MODEL ?? "muse-spark-1.3";
// Reasoning can't be turned off on Muse Spark ("none" is a 400); "minimal" is the shortest pass.
const META_REASONING_EFFORT = process.env.META_REASONING_EFFORT ?? "minimal";

// Named-object segmentation (/api/segment-named). Measured on a test frame: flash-lite returns boxes in
// ~1.4s but its masks come back empty (and asking for them via the schema hangs); gemini-3.8-flash
// returns masks but took ~80s (and rejects "minimal" thinking). So by default only boxes are requested
// and the browser segments inside the box; GEMINI_SEGMENT_MASKS=true asks for masks too.
const SEGMENT_MODEL = process.env.GEMINI_SEGMENT_MODEL ?? MODEL;
const SEGMENT_MASKS = process.env.GEMINI_SEGMENT_MASKS === "true";
const SEGMENT_THINKING = process.env.GEMINI_SEGMENT_THINKING ?? "minimal"; // docs recommend minimal
const SEGMENT_TIMEOUT_MS = SEGMENT_MASKS ? 90_000 : 15_000;

// Image edits (remove/replace): IMAGE_PROVIDER=meta (default, Muse Image) or gemini.
const IMAGE_PROVIDER = process.env.IMAGE_PROVIDER === "gemini" ? "gemini" : "meta";
// Docs' recommended image-edit model; gemini-3.1-flash-lite-image is the faster/cheaper option.
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL ?? "gemini-nano-banana-2.1";
const META_API_KEY = process.env.META_API_KEY;
const META_URL = "https://api.meta.ai/v1/images/edits";
const META_IMAGE_MODEL = process.env.META_IMAGE_MODEL ?? "muse-image-1.0";
// Latency settings (see the Images schemas docs). Defaults are the fastest the API accepts:
// reasoning "low" = one generation pass, no self-refinement; tools off = no search/shell detours.
const envBool = (v: string | undefined, fallback: boolean) => (v === undefined ? fallback : v === "true");
const META_DEFAULTS: MetaSpeedOptions = {
  reasoning_strength: process.env.META_REASONING === "high" ? "high" : "low",
  enable_web_search: envBool(process.env.META_WEB_SEARCH, false),
  enable_image_search: envBool(process.env.META_IMAGE_SEARCH, false),
  enable_shell: envBool(process.env.META_SHELL, false),
};
const IMAGE_MODEL = IMAGE_PROVIDER === "meta" ? META_IMAGE_MODEL : GEMINI_IMAGE_MODEL;
const EDIT_TIMEOUT_MS = IMAGE_PROVIDER === "meta" ? 45_000 : 25_000;
const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

if (!API_KEY && (COMMAND_PROVIDER !== "meta" || IMAGE_PROVIDER === "gemini")) {
  console.error("GEMINI_API_KEY missing: add it to .env");
  process.exit(1);
}
if (IMAGE_PROVIDER === "meta" && !META_API_KEY) {
  console.warn("META_API_KEY missing: /api/edit will fail until it's in .env (or set IMAGE_PROVIDER=gemini)");
}
if (COMMAND_PROVIDER !== "gemini" && !META_API_KEY) {
  console.warn(`META_API_KEY missing: COMMAND_PROVIDER=${COMMAND_PROVIDER} can't use Muse Spark until it's in .env`);
}

const SYSTEM_PROMPT = `You turn one spoken photo-editing command into JSON for a live camera editor.
The user has frozen a camera frame and may be pointing at an object with their finger.

Rules:
- Output ONLY JSON that matches the response schema. Every field is required; use null when a field does not apply.
- op must be one of: recolor, remove, blur, replace, adjust, undo, retry, select. Never invent other ops. If the request is unclear, pick the closest op.
- "that", "this", "it", "here", "there" refer to what the user is pointing at: target "pointed", target_name null. Never put a pronoun in target_name.
- If the user names an object ("the mug", "my shirt"), use target "named" and target_name set to that object (short noun phrase, no article). If they both point and name ("make this cup red"), use target "pointed" and still fill target_name.
- recolor: color is a CSS color name or #rrggbb hex. Map descriptive colors to hex (e.g. "baby blue" -> "#89cff0").
- Refinements of the previous edit ("less", "more", "darker", "lighter", "brighter", "more saturated", "warmer", "a bit more blue") are op "adjust", with the same target as the previous command and adjust deltas: saturation and brightness in -1..1, hue in degrees -180..180. Use small steps (about 0.15-0.3) unless the user says "a lot" or "way". Fields that don't change are 0. For "less"/"more" of a blur, use op "adjust" with all deltas 0 and intensity set to the new strength.
- "again", "one more time", "do it again", "redo" are op "retry" with the target copied from the previous command.
- "undo", "go back", "revert" are op "undo". ("never mind" is a deselect, see below.)
- blur: intensity 0..1 (default 0.6).
- remove: erase the object and fill the background naturally.
- replace: prompt is a self-contained image-edit instruction for an image model that will only see the image and this prompt. Describe what to put in place of the target, and explicitly say to preserve the scene's lighting, shadows, perspective and scale and leave everything else unchanged.
- color is null unless op is recolor (or adjust toward a named color). prompt is null unless op is replace. adjust is null unless op is adjust.

Selection (the "select" field says WHAT to edit; op says what to DO):
- select is null when the user just points ("make that red", "get rid of this") or repeats/undoes/adjusts an edit. Then the current selection is used.
- Otherwise select = { source, name, face_part, region, refine, invert }, with null for parts that don't apply and invert false unless stated below:
  - source "face_part" for the user's own face: face_part one of nose, lips, left_eye, right_eye, eyes, eyebrows, face, hair ("my mouth" -> lips, "my eyes" -> eyes).
  - source "named" when the user names an object to find in the scene: name is a short noun phrase without article ("the tree" -> "tree"). Also set target "named" and target_name.
  - source "pointed" when they point ("this", "that"), including with a region or refine.
  - source "background" for "the background" / "behind me" / "everything else": everything except the current selection. name null, invert false. Never use source "named" with name "background".
  - invert true for "everything except X" / "all but X" / "everything but this": select X as usual (named, pointed or face_part) and set invert true.
  - region { side: top|bottom|left|right|center, fraction 0..1 } keeps only part of the object: "top half" -> top 0.5, "left third" -> left 0.33, "the middle" -> center 0.5.
  - refine "grow" or "shrink" changes the size of the current selection: "a bit bigger", "grow it", "include more" -> grow; "smaller", "tighter", "less of it" -> shrink. Copy source, name and face_part from the previous command's select if it had one, else source "pointed"; region null.
  - refine "clear" deselects: "deselect", "clear selection", "never mind", "select nothing" -> op select, select {source pointed, refine clear}, everything else null.
  - refine "only" narrows to part of the current object: "only the top half", "just the left side", "only the handle", "only the top half of this can". Use op select (unless a new edit is also spoken) with either a region (source pointed) or, for a named part, source named with a name that says whose part it is ("mug handle"). The app re-applies the previous edit to just that part.
- If the utterance only chooses or resizes what is selected and asks for no edit ("select the tree", "only the top half of this can", "a bit bigger", "change my nose"), op is "select" and color, adjust, prompt, intensity are null.
- If it asks for an edit too ("make the top half of this can red", "blur my face"), use that op and fill select.
- "bigger"/"smaller" are refine (op select), not adjust. adjust is only for color/brightness/strength of the previous edit.

Image (only when one is attached): it is the frozen frame the user is looking at, and the text may say where they point.
- Use it to resolve descriptions: "the one on the left", "the taller one", "the red cup". If the description picks out an object, use select source "named" with a name that identifies that one object in the image ("leftmost mug", "taller bottle"), not just its category.
- Plain "this"/"that" with no description still means the pointed object (select null or source "pointed").

Examples:
- "change my nose" -> op select, select {source face_part, face_part nose}
- "only the top half of this can" -> op select, target pointed, select {source pointed, region {side top, fraction 0.5}, refine only}
- "just the left side" (previous op recolor) -> op select, select {source pointed, region {side left, fraction 0.5}, refine only}
- "blur the background" -> op blur, target named, target_name "background", intensity 0.6, select {source background, invert false}
- "blur everything except the bottle" -> op blur, target named, target_name "bottle", intensity 0.6, select {source named, name "bottle", invert true}
- "only the handle" (previous op recolor on a mug) -> op select, target named, target_name "mug handle", select {source named, name "mug handle", refine only}
- "deselect" / "never mind" -> op select, select {source pointed, refine clear}
- "select the tree" -> op select, target named, target_name "tree", select {source named, name "tree"}
- "a bit bigger" (previous select {source named, name "tree"}) -> op select, select {source named, name "tree", refine grow}`;

// Muse Spark gets the schema as response_format too; this is a belt-and-braces reminder for its output.
const META_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

Output format: reply with exactly one JSON object with the keys op, target, target_name, color, adjust, prompt, intensity, select. No markdown, no code fences, no text before or after the JSON.`;

const app = express();
app.use(cors());
const imageJson = express.json({ limit: "8mb" });
app.use((await import("./routes/transcribe")).transcribeRouter); // POST /api/transcribe (Muse Voice)

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: MODEL, segmentModel: SEGMENT_MODEL, commandProvider: COMMAND_PROVIDER, metaTextModel: META_TEXT_MODEL, imageProvider: IMAGE_PROVIDER, imageModel: IMAGE_MODEL, editTimeoutMs: EDIT_TIMEOUT_MS });
});

// Running average Gemini latency with and without the frame, so the log shows what the image adds.
const geminiMs = { text: { n: 0, sum: 0 }, image: { n: 0, sum: 0 } };
const avgMs = (k: keyof typeof geminiMs) => (geminiMs[k].n ? Math.round(geminiMs[k].sum / geminiMs[k].n) : null);

const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

app.post("/api/command", imageJson, async (req, res) => {
  const t0 = performance.now();
  const body = req.body as Partial<CommandRequest>;
  const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    res.status(400).json({ error: "transcript required" } satisfies CommandResponse);
    return;
  }
  const previous = body.previous ?? null;
  const input = `Previous command: ${previous ? JSON.stringify(previous) : "none"}\nUtterance: "${transcript}"`;
  // Optional frozen frame (+ point), sent to whichever provider answers.
  const frame = typeof body.frame === "string" && body.frame ? body.frame : null;
  const point = frame && body.point && unit(body.point.x) && unit(body.point.y) ? body.point : null;
  const imageInput = frame
    ? {
        frame,
        resolution: asResolution(body.imageResolution) ?? COMMAND_IMAGE_RESOLUTION,
        text:
          `${input}\nThe attached image is the frozen camera frame. ` +
          (point
            ? `The user is pointing at x=${point.x.toFixed(2)},y=${point.y.toFixed(2)} (normalized, origin top-left).`
            : "The user is not pointing at anything."),
      }
    : null;
  // Per-request override (used by scripts/test-commands.mjs to compare providers).
  const mode = asMode(body.provider) ?? COMMAND_PROVIDER;

  let provider: CommandProvider = mode === "meta" ? "meta" : "gemini";
  let fallback: string | undefined;
  try {
    let command: Command;
    try {
      command = await parseWith(provider, input, imageInput);
    } catch (e) {
      if (mode !== "auto" || !shouldFallback(e)) throw e;
      fallback = errorMessage(e);
      console.warn(`gemini failed (${fallback}), retrying with meta`);
      provider = "meta";
      command = await parseWith(provider, input, imageInput);
    }
    const ms = Math.round(performance.now() - t0);
    const image = !!imageInput;
    let imageNote = "";
    if (provider === "gemini") {
      const k = image ? "image" : "text";
      geminiMs[k].n++;
      geminiMs[k].sum += ms;
      const textAvg = avgMs("text");
      if (image) {
        const kb = Math.round(frame!.length / 1024);
        imageNote = ` +image ${kb}kB b64${textAvg !== null ? `, ~${ms - textAvg}ms over text-only avg ${textAvg}ms` : ", no text-only baseline yet"}`;
      }
    } else if (image) {
      imageNote = ` +image ${Math.round(frame!.length / 1024)}kB b64`;
    }
    console.log(`[${ms}ms ${provider}${fallback ? " fallback" : ""}${imageNote}] "${transcript}" -> ${JSON.stringify(command)}`);
    res.json({ command, ms, provider, ...(fallback ? { fallback } : {}), ...(image ? { image } : {}) } satisfies CommandResponse);
  } catch (e) {
    const msg = errorMessage(e);
    console.error(`${provider} command error:`, msg);
    const status = e instanceof ProviderError ? (e.status === 429 ? 429 : 502) : isTimeout(e) ? 504 : 500;
    const prefix = fallback ? `gemini failed (${fallback}); then ` : "";
    res.status(status).json({ error: `${prefix}${msg}` } satisfies CommandResponse);
  }
});

/** Model output that isn't JSON or doesn't pass validateCommand. */
class SchemaError extends Error {}

const isTimeout = (e: unknown) => e instanceof DOMException && e.name === "TimeoutError";

/** 429, 5xx, timeout, network failure or schema-invalid output: worth a second provider. */
function shouldFallback(e: unknown): boolean {
  if (e instanceof ProviderError) return e.status === 429 || e.status >= 500;
  return e instanceof SchemaError || isTimeout(e) || e instanceof TypeError; // TypeError = fetch failed
}

function errorMessage(e: unknown): string {
  if (isTimeout(e)) return `timed out after ${COMMAND_TIMEOUT_MS / 1000}s`;
  // fetch() reports network failures as TypeError("fetch failed") with the reason in .cause.
  const cause = e instanceof TypeError ? (e.cause as { code?: string; message?: string } | undefined) : undefined;
  if (cause) return `${e instanceof Error ? e.message : String(e)} (${cause.code ?? cause.message ?? "unknown cause"})`;
  return e instanceof Error ? e.message : String(e);
}

type ImageInput = { frame: string; text: string; resolution?: Resolution };

async function parseWith(provider: CommandProvider, input: string, image: ImageInput | null): Promise<Command> {
  const signal = AbortSignal.timeout(COMMAND_TIMEOUT_MS);
  const text =
    provider === "meta" ? await commandTextFromMeta(input, image, signal) : await commandTextFromGemini(input, image, signal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SchemaError(`${provider} returned non-JSON: ${text.slice(0, 200)}`);
  }
  const command = validateCommand(parsed);
  if (typeof command === "string") throw new SchemaError(`${provider} schema mismatch (${command}): ${text.slice(0, 200)}`);
  return command;
}

async function commandTextFromGemini(input: string, image: ImageInput | null, signal: AbortSignal): Promise<string> {
  if (!API_KEY) throw new ProviderError(500, "GEMINI_API_KEY missing from .env");
  const t0 = performance.now();
  const payload = JSON.stringify({
    model: MODEL,
    system_instruction: SYSTEM_PROMPT,
    // Docs (image understanding): text part, then the image part as base64 with its mime_type.
    input: image
      ? [
          { type: "text", text: image.text },
          {
            type: "image",
            mime_type: "image/jpeg",
            data: image.frame,
            ...(image.resolution ? { resolution: image.resolution } : {}),
          },
        ]
      : input,
    store: false,
    generation_config: { thinking_level: THINKING },
    response_format: { type: "text", mime_type: "application/json", schema: COMMAND_JSON_SCHEMA },
  });
  const tag = image ? `image ${Math.round(image.frame.length / 1024)}kB b64 res=${image.resolution ?? "default"}` : "text";
  try {
    const r = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
      signal,
      body: payload,
    });
    const headersMs = Math.round(performance.now() - t0);
    if (!r.ok) {
      const detail = await r.text();
      throw new ProviderError(r.status, `gemini ${r.status}: ${detail.slice(0, 300)}`);
    }
    const json = (await r.json()) as Interaction;
    const u = json.usage;
    const imgTokens = u?.input_tokens_by_modality?.find((m) => m.modality === "image")?.tokens;
    console.log(
      `[gemini] ${tag}, payload ${Math.round(payload.length / 1024)}kB: response headers ${headersMs}ms, ` +
        `body ${Math.round(performance.now() - t0)}ms; tokens in ${u?.total_input_tokens ?? "?"}` +
        `${imgTokens !== undefined ? ` (image ${imgTokens})` : ""}, thought ${u?.total_thought_tokens ?? 0}, out ${u?.total_output_tokens ?? "?"}`,
    );
    return extractText(json);
  } catch (e) {
    if (isTimeout(e)) console.warn(`[gemini] ${tag}, payload ${Math.round(payload.length / 1024)}kB: timed out after ${Math.round(performance.now() - t0)}ms`);
    throw e;
  }
}

type ChatCompletion = { choices?: { message?: { content?: string | { type?: string; text?: string }[] | null } }[] };

async function commandTextFromMeta(input: string, image: ImageInput | null, signal: AbortSignal): Promise<string> {
  if (!META_API_KEY) throw new ProviderError(500, "META_API_KEY missing from .env");
  const r = await fetch(META_CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${META_API_KEY}` },
    signal,
    body: JSON.stringify({
      model: META_TEXT_MODEL,
      messages: [
        { role: "system", content: META_SYSTEM_PROMPT },
        // Docs (image understanding): images go in the user message as image_url parts; base64
        // data URLs are accepted. No resolution/detail parameter is documented.
        {
          role: "user",
          content: image
            ? [
                { type: "text", text: image.text },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image.frame}` } },
              ]
            : input,
        },
      ],
      reasoning_effort: META_REASONING_EFFORT,
      // Structured output (docs: /docs/structured-output). strict stays false: the schema uses
      // ["string","null"] type arrays and no additionalProperties, which the strict-subset check
      // may reject; output is still constrained to the schema, and validateCommand checks it anyway.
      response_format: {
        type: "json_schema",
        json_schema: { name: "Command", schema: COMMAND_JSON_SCHEMA, strict: false },
      },
    }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    throw new ProviderError(r.status, `meta ${r.status}: ${detail || r.statusText}`);
  }
  const content = ((await r.json()) as ChatCompletion).choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : (content ?? "");
  // Strip a code fence in case the model wraps the JSON despite the instructions.
  return text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
}

/** Provider failure carrying the upstream HTTP status and error body for the stage. */
class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type EditInput = {
  image: string;
  highlight: string;
  prompt: string;
  width: number;
  height: number;
  meta: Partial<MetaSpeedOptions>;
};
type EditOutput = { data: string; mime: string };

const GEMINI_EDIT_INSTRUCTIONS = (prompt: string) => `You are given two images of the same photo.
Image 1 is the original photo. Image 2 is identical except the region to edit is tinted magenta and outlined.
Edit image 1 ONLY inside the highlighted region: ${prompt}
Keep everything else identical: same framing, camera angle, lighting, colors, and resolution.
Output only the edited version of image 1, with no magenta tint or outline.`;

async function editWithGemini(b: EditInput, signal: AbortSignal): Promise<EditOutput> {
  const ratio = b.width / b.height;
  const aspect = ASPECTS.reduce((best, a) => {
    const [w, h] = a.split(":").map(Number);
    const [bw, bh] = best.split(":").map(Number);
    return Math.abs(Math.log(w / h / ratio)) < Math.abs(Math.log(bw / bh / ratio)) ? a : best;
  });
  const r = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": API_KEY! },
    signal,
    body: JSON.stringify({
      model: GEMINI_IMAGE_MODEL,
      store: false,
      input: [
        { type: "text", text: GEMINI_EDIT_INSTRUCTIONS(b.prompt) },
        { type: "image", mime_type: "image/jpeg", data: b.image },
        { type: "image", mime_type: "image/jpeg", data: b.highlight },
      ],
      response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: aspect, image_size: "1K" },
    }),
  });
  if (!r.ok) {
    const detail = await r.text();
    let msg = detail.slice(0, 300);
    try {
      msg = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* keep raw text */
    }
    throw new ProviderError(r.status, `gemini ${r.status}: ${msg}`);
  }
  const out = extractImage(await r.json());
  if (!out) throw new ProviderError(502, "gemini returned no image");
  return out;
}

const META_EDIT_PROMPT = (prompt: string) =>
  `@Image1 is the photo. @Image2 is the same photo with the target object tinted magenta and outlined. ${prompt.replace(/[.\s]+$/, "")}. Edit only the highlighted object in @Image1 and keep everything else identical.`;

let loggedMetaKeys = false;

type MetaImagesResponse = { data?: { b64_json?: string; url?: string }[]; output_format?: string };

/** Merges validated per-request overrides onto the .env defaults. */
function metaSpeed(o: Partial<MetaSpeedOptions>): MetaSpeedOptions {
  const out = { ...META_DEFAULTS };
  if (o.reasoning_strength === "low" || o.reasoning_strength === "high") out.reasoning_strength = o.reasoning_strength;
  for (const k of ["enable_web_search", "enable_image_search", "enable_shell"] as const) {
    if (typeof o[k] === "boolean") out[k] = o[k];
  }
  return out;
}

async function editWithMeta(b: EditInput, signal: AbortSignal): Promise<EditOutput> {
  if (!META_API_KEY) throw new ProviderError(500, "META_API_KEY missing from .env");
  const speed = metaSpeed(b.meta);
  const r = await fetch(META_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${META_API_KEY}` },
    signal,
    body: JSON.stringify({
      model: META_IMAGE_MODEL,
      prompt: META_EDIT_PROMPT(b.prompt),
      n: 1,
      images: [
        { image_url: `data:image/jpeg;base64,${b.image}` },
        { image_url: `data:image/jpeg;base64,${b.highlight}` },
      ],
      // Not in the minimal example, but documented: size sets the aspect ratio (so the composite
      // isn't stretched) and output_format overrides the webp default.
      size: `${b.width}x${b.height}`,
      output_format: "jpeg",
      reasoning_strength: speed.reasoning_strength,
      tool_enablement: {
        enable_web_search: speed.enable_web_search,
        enable_image_search: speed.enable_image_search,
        enable_shell: speed.enable_shell,
      },
    }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 500);
    throw new ProviderError(r.status, `meta ${r.status}: ${detail || r.statusText}`);
  }
  const json = (await r.json()) as MetaImagesResponse;
  if (!loggedMetaKeys) {
    loggedMetaKeys = true;
    console.log("[meta] response keys:", Object.keys(json), "data[0] keys:", Object.keys(json.data?.[0] ?? {}));
  }
  const item = json.data?.[0];
  const mime = `image/${json.output_format ?? "jpeg"}`;
  if (item?.b64_json) return { data: item.b64_json, mime };
  if (item?.url) {
    const img = await fetch(item.url, { signal });
    if (!img.ok) throw new ProviderError(502, `meta image url fetch ${img.status}`);
    const type = img.headers.get("content-type") ?? mime;
    return { data: Buffer.from(await img.arrayBuffer()).toString("base64"), mime: type };
  }
  throw new ProviderError(502, "meta returned no image (no b64_json or url in data[0])");
}

app.post("/api/edit", imageJson, async (req, res) => {
  const t0 = performance.now();
  const b = req.body as Partial<EditRequest>;
  if (typeof b?.image !== "string" || typeof b.highlight !== "string" || typeof b.prompt !== "string" || !b.prompt.trim()) {
    res.status(400).json({ error: "image, highlight and prompt required" } satisfies EditResponse);
    return;
  }
  const input: EditInput = {
    image: b.image,
    highlight: b.highlight,
    prompt: b.prompt.trim(),
    width: Math.round(b.width ?? 1024),
    height: Math.round(b.height ?? 576),
    meta: b.meta && typeof b.meta === "object" ? b.meta : {},
  };

  try {
    const signal = AbortSignal.timeout(EDIT_TIMEOUT_MS);
    const out = IMAGE_PROVIDER === "meta" ? await editWithMeta(input, signal) : await editWithGemini(input, signal);
    const ms = Math.round(performance.now() - t0);
    console.log(`[${ms}ms] ${IMAGE_PROVIDER} edit "${input.prompt}" -> ${out.mime}, ${Math.round(out.data.length / 1024)}kB b64`);
    res.json({ image: out.data, mime: out.mime, ms } satisfies EditResponse);
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    console.error(`${IMAGE_PROVIDER} edit error:`, e instanceof Error ? e.message : e);
    const status = e instanceof ProviderError ? (e.status === 429 ? 429 : 502) : timedOut ? 504 : 500;
    const msg = timedOut
      ? `${IMAGE_PROVIDER} image model timed out after ${EDIT_TIMEOUT_MS / 1000}s`
      : e instanceof Error
        ? e.message
        : String(e);
    res.status(status).json({ error: msg } satisfies EditResponse);
  }
});

// Response schema from the docs' segmentation example: box_2d [ymin, xmin, ymax, xmax] normalized to
// 0-1000, plus (masks on) the mask as an integer array of arrays.
const SEGMENT_SCHEMA = {
  type: "object",
  properties: {
    boxes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          box_2d: { type: "array", items: { type: "integer" } },
          ...(SEGMENT_MASKS ? { mask: { type: "array", items: { type: "array", items: { type: "integer" } } } } : {}),
          label: { type: "string" },
        },
        required: SEGMENT_MASKS ? ["box_2d", "mask", "label"] : ["box_2d", "label"],
      },
    },
  },
  required: ["boxes"],
} as const;

const SEGMENT_PROMPT = (name: string) =>
  (SEGMENT_MASKS
    ? `Find every "${name}" in the image. Give the segmentation masks for them. ` +
      `Output a JSON list of segmentation masks where each entry contains the 2D bounding box in the key "box_2d", ` +
      `the segmentation mask in key "mask", and the text label in the key "label". Use descriptive labels. `
    : `Detect every "${name}" in the image. Output a JSON list where each entry contains the 2D bounding box ` +
      `in the key "box_2d" and the text label in the key "label". Use descriptive labels. `) +
  `If there is no "${name}", return an empty list.`;

type RawBox = { box_2d?: unknown; mask?: unknown; label?: unknown };
type Pt = [number, number];

/**
 * 0-1000 model output -> 0..1 frame coords. The docs call the mask a polygon of [x, y] points "inside
 * the bounding box" without saying relative to what: if most points land in the box as image coords,
 * use them as-is, otherwise read them as box-relative. gemini-3.8-flash instead returned 4-int
 * [ymin, xmin, ymax, xmax] rectangles (image coords); those become one rectangle polygon each.
 */
function toInstance(b: RawBox): (NamedInstance & { maskKind: string }) | null {
  const box = b.box_2d;
  if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === "number")) return null;
  const [ymin, xmin, ymax, xmax] = (box as number[]).map((v) => Math.min(1000, Math.max(0, v)) / 1000);
  if (xmax <= xmin || ymax <= ymin) return null;
  const rows = Array.isArray(b.mask)
    ? (b.mask as unknown[]).filter((p): p is number[] => Array.isArray(p) && p.every((v) => typeof v === "number"))
    : [];
  const pts = rows.filter((r) => r.length === 2) as Pt[];
  const rects = rows.filter((r) => r.length === 4);
  let polygons: Pt[][] | null = null;
  let maskKind = "none";
  if (pts.length >= 3) {
    const tol = 0.02;
    const inBox = pts.filter(
      ([x, y]) => x / 1000 >= xmin - tol && x / 1000 <= xmax + tol && y / 1000 >= ymin - tol && y / 1000 <= ymax + tol,
    ).length;
    const imageFrame = inBox / pts.length >= 0.8;
    maskKind = `${pts.length}pt/${imageFrame ? "image" : "box"}`;
    polygons = [
      pts.map(([x, y]): Pt =>
        imageFrame ? [x / 1000, y / 1000] : [xmin + (x / 1000) * (xmax - xmin), ymin + (y / 1000) * (ymax - ymin)],
      ),
    ];
  } else if (rects.length) {
    maskKind = `${rects.length}rect`;
    polygons = rects.map(([y0, x0, y1, x1]): Pt[] => {
      const [a, b2, c, d] = [x0 / 1000, y0 / 1000, x1 / 1000, y1 / 1000];
      return [[a, b2], [c, b2], [c, d], [a, d]];
    });
  }
  const label = typeof b.label === "string" ? b.label : "";
  return { label, box: { x0: xmin, y0: ymin, x1: xmax, y1: ymax }, polygons, maskKind };
}

app.post("/api/segment-named", imageJson, async (req, res) => {
  const t0 = performance.now();
  const b = req.body as Partial<SegmentNamedRequest>;
  const name = typeof b?.name === "string" ? b.name.trim() : "";
  if (typeof b?.frame !== "string" || !b.frame || !name) {
    res.status(400).json({ error: "frame and name required" } satisfies SegmentNamedResponse);
    return;
  }
  if (!API_KEY) {
    res.status(500).json({ error: "GEMINI_API_KEY missing from .env" } satisfies SegmentNamedResponse);
    return;
  }
  try {
    const r = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
      signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS),
      body: JSON.stringify({
        model: SEGMENT_MODEL,
        store: false,
        input: [
          { type: "text", text: SEGMENT_PROMPT(name) },
          { type: "image", mime_type: "image/jpeg", data: b.frame },
        ],
        generation_config: { thinking_level: SEGMENT_THINKING },
        response_format: { type: "text", mime_type: "application/json", schema: SEGMENT_SCHEMA },
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      throw new ProviderError(r.status, `gemini ${r.status}: ${detail.slice(0, 300)}`);
    }
    const text = extractText(await r.json());
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProviderError(502, `gemini returned non-JSON: ${text.slice(0, 200)}`);
    }
    // Schema says { boxes: [...] }; accept a bare list too, as in the docs' prompt.
    const raw = Array.isArray(parsed) ? parsed : ((parsed as { boxes?: unknown })?.boxes ?? []);
    const found = (Array.isArray(raw) ? (raw as RawBox[]) : []).map(toInstance).filter((i) => i !== null);
    const ms = Math.round(performance.now() - t0);
    const kinds = found.map((i) => `${i.label || "?"}:${i.maskKind}`).join(", ");
    console.log(`[${ms}ms segment ${SEGMENT_MODEL}${SEGMENT_MASKS ? " masks" : ""}] "${name}" -> ${found.length} instance(s) ${kinds}`);
    const instances: NamedInstance[] = found.map(({ label, box, polygons }) => ({ label, box, polygons }));
    res.json({ instances, ms } satisfies SegmentNamedResponse);
  } catch (e) {
    const timedOut = isTimeout(e);
    const msg = timedOut ? `segmentation timed out after ${SEGMENT_TIMEOUT_MS / 1000}s` : e instanceof Error ? e.message : String(e);
    console.error("segment-named error:", msg);
    const status = e instanceof ProviderError ? (e.status === 429 ? 429 : 502) : timedOut ? 504 : 500;
    res.status(status).json({ error: msg } satisfies SegmentNamedResponse);
  }
});

type Block = { type?: string; text?: string; data?: string; mime_type?: string };
type Usage = {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  input_tokens_by_modality?: { modality?: string; tokens?: number }[];
};
type Interaction = { steps?: { type?: string; content?: Block[] }[]; output_image?: Block; usage?: Usage };

/** Last image block of the model output (what the SDK's `output_image` returns). */
function extractImage(json: unknown): { data: string; mime: string } | null {
  const j = json as Interaction;
  const blocks = (j.steps ?? []).filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []);
  const img = blocks.filter((c) => c.type === "image" && c.data).pop() ?? j.output_image;
  return img?.data ? { data: img.data, mime: img.mime_type ?? "image/jpeg" } : null;
}

/** Concatenates the text parts of the interaction's model_output steps. */
function extractText(json: unknown): string {
  const steps = (json as Interaction).steps ?? [];
  return steps
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

app.listen(PORT, (err?: Error) => {
  // Express 5 reports listen errors (e.g. EADDRINUSE) here instead of throwing.
  if (err) {
    console.error(`proxy failed to listen on :${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`proxy on http://localhost:${PORT} (commands ${COMMAND_PROVIDER}: ${MODEL} / ${META_TEXT_MODEL}, image ${IMAGE_PROVIDER}/${IMAGE_MODEL})`);
});
