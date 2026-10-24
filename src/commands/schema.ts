// Voice-command contract shared by the browser (types) and server/proxy.ts (JSON Schema + validation).
// Keep this file free of DOM/Node APIs so both sides can import it.

export const OPS = ["recolor", "remove", "blur", "replace", "adjust", "undo", "retry"] as const;
export const TARGETS = ["pointed", "named"] as const;

export type Op = (typeof OPS)[number];
export type Target = (typeof TARGETS)[number];

/** Deltas applied to the previous edit. saturation/brightness in -1..1, hue in degrees -180..180. */
export interface Adjust {
  saturation: number;
  brightness: number;
  hue: number;
}

export interface Command {
  op: Op;
  target: Target;
  target_name: string | null;
  /** CSS color (name or #hex). */
  color: string | null;
  adjust: Adjust | null;
  /** Self-contained image-edit prompt, only for op "replace". */
  prompt: string | null;
  /** 0..1 strength, e.g. for blur. */
  intensity: number | null;
}

export interface CommandRequest {
  transcript: string;
  previous: Command | null;
}

export type CommandResponse = { command: Command; ms: number } | { error: string };

/** JSON Schema handed to Gemini as response_format.schema. */
export const COMMAND_JSON_SCHEMA = {
  type: "object",
  properties: {
    op: { type: "string", enum: [...OPS] },
    target: { type: "string", enum: [...TARGETS] },
    target_name: { type: ["string", "null"] },
    color: { type: ["string", "null"], description: "CSS color name or #rrggbb hex" },
    adjust: {
      type: ["object", "null"],
      properties: {
        saturation: { type: "number", description: "delta, -1..1" },
        brightness: { type: "number", description: "delta, -1..1" },
        hue: { type: "number", description: "delta in degrees, -180..180" },
      },
      required: ["saturation", "brightness", "hue"],
    },
    prompt: { type: ["string", "null"] },
    intensity: { type: ["number", "null"], description: "0..1" },
  },
  required: ["op", "target", "target_name", "color", "adjust", "prompt", "intensity"],
} as const;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";

/** Returns the command if it matches the schema exactly, otherwise a reason string. */
export function validateCommand(v: unknown): Command | string {
  if (!v || typeof v !== "object") return "not an object";
  const c = v as Record<string, unknown>;
  if (!OPS.includes(c.op as Op)) return `bad op: ${String(c.op)}`;
  if (!TARGETS.includes(c.target as Target)) return `bad target: ${String(c.target)}`;
  for (const k of ["target_name", "color", "prompt"] as const) {
    if (!isStrOrNull(c[k])) return `bad ${k}`;
  }
  if (c.intensity !== null && !isNum(c.intensity)) return "bad intensity";
  if (c.adjust !== null) {
    const a = c.adjust as Record<string, unknown> | undefined;
    if (!a || !isNum(a.saturation) || !isNum(a.brightness) || !isNum(a.hue)) return "bad adjust";
  }
  return {
    op: c.op as Op,
    target: c.target as Target,
    target_name: c.target_name as string | null,
    color: c.color as string | null,
    adjust: c.adjust as Adjust | null,
    prompt: c.prompt as string | null,
    intensity: c.intensity as number | null,
  };
}

// ---- Image-edit proxy contract (POST /api/edit), used by remove/replace ----

export interface EditRequest {
  /** Clean frame, JPEG base64 (no data: prefix), long side <= 1024px. */
  image: string;
  /** Same frame with the target tinted + outlined in magenta, JPEG base64. Gemini has no mask input. */
  highlight: string;
  /** What to do inside the highlighted region. */
  prompt: string;
  width: number;
  height: number;
  /** Per-request Meta latency settings (for scripts/test-edit.mjs); unset keys use .env. */
  meta?: Partial<MetaSpeedOptions>;
}

export interface MetaSpeedOptions {
  reasoning_strength: "low" | "high";
  enable_web_search: boolean;
  enable_image_search: boolean;
  enable_shell: boolean;
}

export type EditResponse = { image: string; mime: string; ms: number } | { error: string };
