// Tiny API proxy so GEMINI_API_KEY stays server-side. Vite proxies /api/* here in dev.
// Run: npx tsx server/proxy.ts   (or `npm run dev:all` for this + Vite)
import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  COMMAND_JSON_SCHEMA,
  validateCommand,
  type CommandRequest,
  type CommandResponse,
} from "../src/commands/schema";

const PORT = Number(process.env.PROXY_PORT ?? 8787);
const API_KEY = process.env.GEMINI_API_KEY;
// Flash-Lite: ~3-5s here vs 25-45s for gemini-3.8-flash (which also rejects "minimal" thinking).
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
const THINKING = process.env.GEMINI_THINKING ?? "minimal";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

if (!API_KEY) {
  console.error("GEMINI_API_KEY missing: add it to .env");
  process.exit(1);
}

const SYSTEM_PROMPT = `You turn one spoken photo-editing command into JSON for a live camera editor.
The user has frozen a camera frame and may be pointing at an object with their finger.

Rules:
- Output ONLY JSON that matches the response schema. Every field is required; use null when a field does not apply.
- op must be one of: recolor, remove, blur, replace, adjust, undo, retry. Never invent other ops. If the request is unclear, pick the closest op.
- "that", "this", "it", "here", "there" refer to what the user is pointing at: target "pointed", target_name null. Never put a pronoun in target_name.
- If the user names an object ("the mug", "my shirt"), use target "named" and target_name set to that object (short noun phrase, no article). If they both point and name ("make this cup red"), use target "pointed" and still fill target_name.
- recolor: color is a CSS color name or #rrggbb hex. Map descriptive colors to hex (e.g. "baby blue" -> "#89cff0").
- Refinements of the previous edit ("less", "more", "darker", "lighter", "brighter", "more saturated", "warmer", "a bit more blue") are op "adjust", with the same target as the previous command and adjust deltas: saturation and brightness in -1..1, hue in degrees -180..180. Use small steps (about 0.15-0.3) unless the user says "a lot" or "way". Fields that don't change are 0. For "less"/"more" of a blur, use op "adjust" with all deltas 0 and intensity set to the new strength.
- "again", "one more time", "do it again", "redo" are op "retry" with the target copied from the previous command.
- "undo", "go back", "never mind", "revert" are op "undo".
- blur: intensity 0..1 (default 0.6).
- remove: erase the object and fill the background naturally.
- replace: prompt is a self-contained image-edit instruction for an image model that will only see the image and this prompt. Describe what to put in place of the target, and explicitly say to preserve the scene's lighting, shadows, perspective and scale and leave everything else unchanged.
- color is null unless op is recolor (or adjust toward a named color). prompt is null unless op is replace. adjust is null unless op is adjust.`;

const app = express();
app.use(cors());
app.use(express.json({ limit: "32kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: MODEL });
});

app.post("/api/command", async (req, res) => {
  const t0 = performance.now();
  const body = req.body as Partial<CommandRequest>;
  const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    res.status(400).json({ error: "transcript required" } satisfies CommandResponse);
    return;
  }
  const previous = body.previous ?? null;
  const input = `Previous command: ${previous ? JSON.stringify(previous) : "none"}\nUtterance: "${transcript}"`;

  try {
    const r = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify({
        model: MODEL,
        system_instruction: SYSTEM_PROMPT,
        input,
        store: false,
        generation_config: { thinking_level: THINKING },
        response_format: { type: "text", mime_type: "application/json", schema: COMMAND_JSON_SCHEMA },
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error(`gemini ${r.status}:`, detail);
      res.status(502).json({ error: `gemini ${r.status}: ${detail.slice(0, 300)}` } satisfies CommandResponse);
      return;
    }
    const text = extractText(await r.json());
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      res.status(502).json({ error: `model returned non-JSON: ${text.slice(0, 200)}` } satisfies CommandResponse);
      return;
    }
    const command = validateCommand(parsed);
    if (typeof command === "string") {
      res.status(502).json({ error: `schema mismatch (${command}): ${text.slice(0, 200)}` } satisfies CommandResponse);
      return;
    }
    const ms = Math.round(performance.now() - t0);
    console.log(`[${ms}ms] "${transcript}" -> ${JSON.stringify(command)}`);
    res.json({ command, ms } satisfies CommandResponse);
  } catch (e) {
    console.error("proxy error", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) } satisfies CommandResponse);
  }
});

/** Concatenates the text parts of the interaction's model_output steps. */
function extractText(json: unknown): string {
  const steps = (json as { steps?: { type?: string; content?: { type?: string; text?: string }[] }[] }).steps ?? [];
  return steps
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

app.listen(PORT, () => {
  console.log(`proxy on http://localhost:${PORT} (model ${MODEL})`);
});
