// Voice-command contract shared by the browser (types) and server/proxy.ts (JSON Schema + validation).
// Keep this file free of DOM/Node APIs so both sides can import it.

export const OPS = ["recolor", "remove", "blur", "replace", "adjust", "undo", "retry", "select"] as const;
export const TARGETS = ["pointed", "named"] as const;
export const SELECT_SOURCES = ["pointed", "named", "face_part"] as const;
export const FACE_PARTS = ["nose", "lips", "left_eye", "right_eye", "eyes", "eyebrows", "face", "hair"] as const;
export const REGION_SIDES = ["top", "bottom", "left", "right", "center"] as const;
export const REFINES = ["grow", "shrink"] as const;

export type Op = (typeof OPS)[number];
export type Target = (typeof TARGETS)[number];
export type SelectSource = (typeof SELECT_SOURCES)[number];
export type FacePart = (typeof FACE_PARTS)[number];
export type RegionSide = (typeof REGION_SIDES)[number];
export type Refine = (typeof REFINES)[number];

/** Keep only part of the selection's bounding box, e.g. the top half. fraction in 0..1. */
export interface Region {
  side: RegionSide;
  fraction: number;
}

/** What to select, separate from what to do with it (op). */
export interface Select {
  source: SelectSource;
  /** For source "named", e.g. "tree", "mug". */
  name: string | null;
  face_part: FacePart | null;
  region: Region | null;
  refine: Refine | null;
}

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
  /** null = use the current selection, exactly as before select existed. */
  select: Select | null;
}

export type CommandProvider = "gemini" | "meta";

export interface CommandRequest {
  transcript: string;
  previous: Command | null;
  /** Optional override of the server's COMMAND_PROVIDER. */
  provider?: CommandProvider | "auto";
  /** Frozen frame, JPEG base64 (no data: prefix), long side <= 512px. Gemini sees it; Meta stays text-only. */
  frame?: string;
  /** Pointed position, normalized 0..1 in frame space. Only used together with frame. */
  point?: { x: number; y: number } | null;
  /** Test override of the server's GEMINI_COMMAND_IMAGE_RESOLUTION (per-image token budget). */
  imageResolution?: "low" | "medium" | "high" | "ultra_high";
}

/**
 * provider = who answered; fallback = why Gemini was skipped, when Meta answered in auto mode;
 * image = the frame was sent to (and answered by) Gemini.
 */
export type CommandResponse =
  | { command: Command; ms: number; provider: CommandProvider; fallback?: string; image?: boolean }
  | { error: string };

// ---- Named-object segmentation (POST /api/segment-named) ----

export interface SegmentNamedRequest {
  /** Frozen frame, JPEG base64 (no data: prefix), long side <= 768px. */
  frame: string;
  /** Object to find, e.g. "tree", "taller bottle". */
  name: string;
}

/** One found instance, all coordinates normalized 0..1 in frame space. */
export interface NamedInstance {
  label: string;
  box: { x0: number; y0: number; x1: number; y1: number };
  /** Mask as one or more filled polygons of [x, y] points; null = box only (the default, see proxy). */
  polygons: [number, number][][] | null;
}

export type SegmentNamedResponse = { instances: NamedInstance[]; ms: number } | { error: string };

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
    select: {
      type: ["object", "null"],
      properties: {
        source: { type: "string", enum: [...SELECT_SOURCES] },
        name: { type: ["string", "null"], description: "object to find, for source named" },
        face_part: { type: ["string", "null"], enum: [...FACE_PARTS, null] },
        region: {
          type: ["object", "null"],
          properties: {
            side: { type: "string", enum: [...REGION_SIDES] },
            fraction: { type: "number", description: "0..1 share of the object to keep" },
          },
          required: ["side", "fraction"],
        },
        refine: { type: ["string", "null"], enum: [...REFINES, null] },
      },
      required: ["source", "name", "face_part", "region", "refine"],
    },
  },
  required: ["op", "target", "target_name", "color", "adjust", "prompt", "intensity", "select"],
} as const;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";

function validateSelect(v: unknown): Select | null | string {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return "bad select";
  const s = v as Record<string, unknown>;
  if (!SELECT_SOURCES.includes(s.source as SelectSource)) return `bad select.source: ${String(s.source)}`;
  if (!isStrOrNull(s.name)) return "bad select.name";
  const face = s.face_part ?? null;
  if (face !== null && !FACE_PARTS.includes(face as FacePart)) return `bad select.face_part: ${String(face)}`;
  const refine = s.refine ?? null;
  if (refine !== null && !REFINES.includes(refine as Refine)) return `bad select.refine: ${String(refine)}`;
  let region: Region | null = null;
  if (s.region !== null && s.region !== undefined) {
    const r = s.region as Record<string, unknown>;
    if (!REGION_SIDES.includes(r.side as RegionSide) || !isNum(r.fraction)) return "bad select.region";
    region = { side: r.side as RegionSide, fraction: Math.min(1, Math.max(0.05, r.fraction)) };
  }
  return {
    source: s.source as SelectSource,
    name: (s.name as string | null) ?? null,
    face_part: face as FacePart | null,
    region,
    refine: refine as Refine | null,
  };
}

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
  const select = validateSelect(c.select);
  if (typeof select === "string") return select;
  return {
    op: c.op as Op,
    target: c.target as Target,
    target_name: c.target_name as string | null,
    color: c.color as string | null,
    adjust: c.adjust as Adjust | null,
    prompt: c.prompt as string | null,
    intensity: c.intensity as number | null,
    select,
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
