// Face parts with MediaPipe FaceLandmarker (478 landmarks: 468 mesh + 10 iris). Masks are filled
// polygons built from MediaPipe's own connection sets, plus a hand-picked nose outline.
// Left/right follow MediaPipe: "left_eye" is the subject's left (image right in an unmirrored frame).
import { FaceLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { loadLocalModel, visionFileset } from "./assets";
import type { Point } from "./mask";

const LOCAL_MODEL = "/models/face_landmarker.task";
const REMOTE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/** Faces detected per frame; the largest one is used. */
const MAX_FACES = 4;

export const FACE_PARTS = ["nose", "lips", "left_eye", "right_eye", "eyes", "eyebrows", "face"] as const;
export type FacePart = (typeof FACE_PARTS)[number];

type Edge = { start: number; end: number };

/**
 * Nose outline (face-mesh indices), clockwise from the nasion (168) down the subject's left side,
 * around the nostrils through subnasale (2), and back up the right side. Checked against
 * canonical_face_model.obj: symmetric and clear of the eye and lip polygons.
 */
export const NOSE_OUTLINE = [
  168, 417, 465, 412, 399, 456, 420, 429, 279, 294, 327, 326, 2, 97, 98, 64, 49, 209, 198, 236, 174, 188, 245, 193,
];

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

async function create(delegate: "GPU" | "CPU") {
  const fileset = await visionFileset();
  const buf = await loadLocalModel(LOCAL_MODEL);
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: buf ? { modelAssetBuffer: buf, delegate } : { modelAssetPath: REMOTE_MODEL, delegate },
    runningMode: "IMAGE",
    numFaces: MAX_FACES,
  });
}

/** Call on mount so the first detection is fast. Safe to call repeatedly. */
export function initFace(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = create("GPU").catch((e) => {
      console.warn("[face] GPU delegate failed, falling back to CPU", e);
      return create("CPU");
    });
    landmarkerPromise.catch(() => {
      landmarkerPromise = null; // allow retry on next call
    });
  }
  return landmarkerPromise;
}

/** Area of a face's landmark bounding box (normalized units; only used for comparison). */
function faceArea(lms: NormalizedLandmark[]): number {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const l of lms) {
    x0 = Math.min(x0, l.x);
    y0 = Math.min(y0, l.y);
    x1 = Math.max(x1, l.x);
    y1 = Math.max(y1, l.y);
  }
  return (x1 - x0) * (y1 - y0);
}

/** Landmarks of the largest face in frame pixel coords (478 points), or null if there is no face. */
export async function detectFace(frame: ImageData): Promise<Point[] | null> {
  const lm = await initFace();
  const faces = lm.detect(frame).faceLandmarks;
  if (!faces.length) return null;
  let best = faces[0];
  for (const f of faces) if (faceArea(f) > faceArea(best)) best = f;
  return best.map((l) => ({ x: l.x * frame.width, y: l.y * frame.height }));
}

/**
 * Turns an unordered edge set into rings of landmark indices. Closed loops (eyes, lips, oval)
 * become one ring each; open polylines (each eyebrow's upper and lower line) are joined pairwise
 * into one ring, reversing the second so the ends meet.
 */
export function edgesToRings(edges: Edge[], pts: Point[]): number[][] {
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => adj.set(a, [...(adj.get(a) ?? []), b]);
  for (const { start, end } of edges) {
    link(start, end);
    link(end, start);
  }
  const seen = new Set<number>();
  const walk = (from: number) => {
    const path = [from];
    seen.add(from);
    for (let cur = from; ; ) {
      const next = adj.get(cur)!.find((n) => !seen.has(n));
      if (next === undefined) return path;
      path.push(next);
      seen.add(next);
      cur = next;
    }
  };
  const rings: number[][] = [];
  const open: number[][] = [];
  // Open paths start at their ends (degree 1); whatever is left over is closed loops.
  for (const [n, ns] of adj) if (ns.length === 1 && !seen.has(n)) open.push(walk(n));
  for (const n of adj.keys()) if (!seen.has(n)) rings.push(walk(n));

  const d = (a: number, b: number) => Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
  for (let i = 0; i + 1 < open.length; i += 2) {
    const a = open[i];
    const b = open[i + 1];
    const tail = a[a.length - 1];
    rings.push([...a, ...(d(tail, b[b.length - 1]) < d(tail, b[0]) ? [...b].reverse() : b)]);
  }
  return rings;
}

/** Rings (landmark indices) outlining a face part. Lips are outer + inner ring (filled even-odd). */
export function partRings(part: FacePart, pts: Point[]): number[][] {
  const F = FaceLandmarker;
  switch (part) {
    case "nose":
      return [NOSE_OUTLINE];
    case "lips":
      return edgesToRings(F.FACE_LANDMARKS_LIPS, pts);
    case "left_eye":
      return edgesToRings(F.FACE_LANDMARKS_LEFT_EYE, pts);
    case "right_eye":
      return edgesToRings(F.FACE_LANDMARKS_RIGHT_EYE, pts);
    case "eyes":
      return [...partRings("left_eye", pts), ...partRings("right_eye", pts)];
    case "eyebrows":
      return [
        ...edgesToRings(F.FACE_LANDMARKS_LEFT_EYEBROW, pts),
        ...edgesToRings(F.FACE_LANDMARKS_RIGHT_EYEBROW, pts),
      ];
    case "face":
      return edgesToRings(F.FACE_LANDMARKS_FACE_OVAL, pts);
  }
}

/**
 * Binary mask (1 = part, w*h) for a face part of the largest face, or null if there is no face.
 * Landmarks are found on `frame` and scaled to w x h.
 */
export async function faceMask(frame: ImageData, part: FacePart, w: number, h: number): Promise<Uint8Array | null> {
  const lms = await detectFace(frame);
  if (!lms) return null;
  return partMask(lms, part, frame.width, frame.height, w, h);
}

/**
 * Rasterizes a part from landmarks given in a frameW x frameH frame into a w x h binary mask.
 * Rings are filled even-odd, so the lips mask excludes the open mouth while separate parts
 * (two eyes) fill independently.
 */
export function partMask(lms: Point[], part: FacePart, frameW: number, frameH: number, w: number, h: number): Uint8Array {
  const sx = w / frameW;
  const sy = h / frameH;
  const path = new Path2D();
  for (const ring of partRings(part, lms)) {
    ring.forEach((i, k) => {
      const x = lms[i].x * sx;
      const y = lms[i].y * sy;
      if (k === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    path.closePath();
  }
  const ctx = new OffscreenCanvas(w, h).getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fill(path, "evenodd");
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  // Antialiased edges count as inside at >= 50% coverage.
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
  return out;
}
