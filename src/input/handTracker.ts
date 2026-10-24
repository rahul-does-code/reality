// Hand pointer on the live <video> with MediaPipe HandLandmarker. Emits PointerSamples (see
// pointer.ts) and knows nothing about masks.
// - Position: One Euro filtered index fingertip (landmark 8), pushed ahead along the finger by
//   handTuning.aimAhead. While pinching, it is frozen at the press point and then follows the
//   thumb/index midpoint's motion, so closing the pinch doesn't drag the cursor.
// - Press: thumb-index distance / hand size, with hysteresis and a 2-frame debounce.
import { HandLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { loadLocalModel, visionFileset } from "../vision/assets";
import type { Point } from "../vision/mask";
import { pointer, type PointerSample } from "./pointer";

const LOCAL_MODEL = "/models/hand_landmarker.task";
const REMOTE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_DIP = 7;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;

const MIN_HAND_DETECTION_CONFIDENCE = 0.6;
const MIN_HAND_PRESENCE_CONFIDENCE = 0.6;
const MIN_TRACKING_CONFIDENCE = 0.6;

/**
 * One Euro filter on positions (frame px). Lower MIN_CUTOFF = less jitter at rest but more lag
 * on slow moves; higher BETA = less lag on fast moves. Tune MIN_CUTOFF first holding still, then
 * BETA while moving quickly.
 */
export const MIN_CUTOFF = 5.0;
export const BETA = 0.2;
/** One Euro filter on the pinch ratio (unitless, ~0.1 closed to ~1+ open). */
const PINCH_MIN_CUTOFF = 3.0;
const PINCH_BETA = 0.5;

/** Pinch ratio = |thumb tip - index tip| / |wrist - middle MCP|. Press below, release above. */
const PINCH_PRESS = 0.25;
const PINCH_RELEASE = 0.4;
/** Consecutive frames past a threshold before `pressed` changes. */
const PINCH_FRAMES = 2;

/** A dropped frame keeps the last position for this long; longer gaps restart the filters. */
const HOLD_MS = 150;
/** Missed frames before the hand is reported gone. */
const LOST_AFTER = 5;

/**
 * The frozen frame contains the hand itself, so segmenting exactly at the tip tends to pick the
 * finger. The aim projects past the tip along the last finger segment by this many segment
 * lengths (0 = the fingertip itself). Only applied while not pinching. Live-tunable via handTuning.
 */
export const AIM_AHEAD = 1.0;
export const handTuning = { aimAhead: AIM_AHEAD, minCutoff: MIN_CUTOFF, beta: BETA };

/** Old 4-frame EMA, kept only so the debug stats can compare its jitter against the One Euro. */
const EMA_ALPHA = 2 / (4 + 1);

export type HandStats = {
  delegate: "GPU" | "CPU" | null;
  /** Detections per second over the last second. */
  fps: number;
  confidence: number;
  pinchRatio: number | null;
  pressed: boolean;
  rawTip: Point | null;
  filteredTip: Point | null;
  /** Std dev (px) of the tip over the last second: raw landmark, old EMA, One Euro. */
  jitterRaw: number;
  jitterEma: number;
  jitterFiltered: number;
};

let landmarkerPromise: Promise<HandLandmarker> | null = null;
let delegateUsed: "GPU" | "CPU" | null = null;
/** detectForVideo needs strictly increasing timestamps for the shared landmarker's lifetime. */
let lastDetectTs = -1;
let videoTimeOffset = 0;

async function create(delegate: "GPU" | "CPU") {
  const fileset = await visionFileset();
  const buf = await loadLocalModel(LOCAL_MODEL);
  const lm = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: buf ? { modelAssetBuffer: buf, delegate } : { modelAssetPath: REMOTE_MODEL, delegate },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: MIN_HAND_DETECTION_CONFIDENCE,
    minHandPresenceConfidence: MIN_HAND_PRESENCE_CONFIDENCE,
    minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
  });
  delegateUsed = delegate;
  return lm;
}

/** Safe to call repeatedly; shares one landmarker. */
export function initHandTracker(): Promise<HandLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = create("GPU").catch((e) => {
      console.warn("[hand] GPU delegate failed, falling back to CPU", e);
      return create("CPU");
    });
    landmarkerPromise.catch(() => {
      landmarkerPromise = null; // allow retry on next call
    });
  }
  return landmarkerPromise;
}

/** Video time in ms, shifted so it keeps increasing across camera switches / restarts. */
function videoTimestamp(video: HTMLVideoElement): number {
  let ts = video.currentTime * 1000 + videoTimeOffset;
  if (ts <= lastDetectTs) {
    videoTimeOffset += lastDetectTs + 1 - ts;
    ts = lastDetectTs + 1;
  }
  lastDetectTs = ts;
  return ts;
}

export class HandTracker {
  private raf = 0;
  private running = false;
  private lastVideoTime = -1;
  private logTimer = 0;

  private tipF = new Euro2(MIN_CUTOFF, BETA);
  private dipF = new Euro2(MIN_CUTOFF, BETA);
  private midF = new Euro2(MIN_CUTOFF, BETA);
  private pinchF = new OneEuro(PINCH_MIN_CUTOFF, PINCH_BETA);
  private ema: Point | null = null;

  private missed = 0;
  private lastSeenTs = -Infinity;
  private last: PointerSample | null = null;
  private pressed = false;
  private pinchPending = 0;
  /** Cursor position and thumb/index midpoint at the moment of the press. */
  private anchor: { pos: Point; mid: Point } | null = null;

  private confidence = 0;
  private pinchRatio: number | null = null;
  private rawTip: Point | null = null;
  private filteredTip: Point | null = null;
  /** Detection times (performance.now) and tip histories for the last second. */
  private detections: number[] = [];
  private history: { t: number; raw: Point; ema: Point; filtered: Point }[] = [];

  async start(video: HTMLVideoElement): Promise<void> {
    if (this.running) return;
    this.running = true;
    const landmarker = await initHandTracker();
    if (!this.running) return; // stopped while the model loaded

    const tick = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      if (video.readyState < 2 || !video.videoWidth || video.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = video.currentTime;
      const ts = videoTimestamp(video);
      const res = landmarker.detectForVideo(video, ts);
      const now = performance.now();
      this.detections.push(now);
      this.update(res.landmarks[0], res.handedness[0]?.[0]?.score, video.videoWidth, video.videoHeight, ts, now);
    };
    this.raf = requestAnimationFrame(tick);
    this.logTimer = window.setInterval(() => {
      const s = this.stats();
      if (!s.rawTip) return;
      console.log(
        `[hand] ${s.fps.toFixed(1)} fps (${s.delegate}) · jitter px raw ${s.jitterRaw.toFixed(2)}` +
          ` · old EMA ${s.jitterEma.toFixed(2)} · One Euro ${s.jitterFiltered.toFixed(2)}`,
      );
    }, 2000);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    clearInterval(this.logTimer);
    if (this.last?.handPresent) this.lose(performance.now());
    this.resetFilters();
    this.lastVideoTime = -1;
    this.detections = [];
    this.history = [];
  }

  /** Snapshot for the debug HUD. */
  stats(): HandStats {
    const now = performance.now();
    this.trim(now);
    const pts = (k: "raw" | "ema" | "filtered") => this.history.map((h) => h[k]);
    return {
      delegate: delegateUsed,
      fps: this.detections.length,
      confidence: this.confidence,
      pinchRatio: this.pinchRatio,
      pressed: this.pressed,
      rawTip: this.rawTip,
      filteredTip: this.filteredTip,
      jitterRaw: stdDev(pts("raw")),
      jitterEma: stdDev(pts("ema")),
      jitterFiltered: stdDev(pts("filtered")),
    };
  }

  private trim(now: number) {
    while (this.detections.length && now - this.detections[0] > 1000) this.detections.shift();
    while (this.history.length && now - this.history[0].t > 1000) this.history.shift();
  }

  private resetFilters() {
    this.tipF.reset();
    this.dipF.reset();
    this.midF.reset();
    this.pinchF.reset();
    this.ema = null;
    this.pressed = false;
    this.pinchPending = 0;
    this.anchor = null;
  }

  private lose(now: number) {
    this.resetFilters();
    this.rawTip = this.filteredTip = null;
    this.pinchRatio = null;
    this.confidence = 0;
    const l = this.last;
    this.last = null;
    pointer.emit({
      x: l?.x ?? 0,
      y: l?.y ?? 0,
      t: now,
      pressed: false,
      source: "finger",
      handPresent: false,
      confidence: 0,
    });
  }

  private update(
    hand: NormalizedLandmark[] | undefined,
    score: number | undefined,
    w: number,
    h: number,
    ts: number,
    now: number,
  ) {
    if (!hand) {
      this.missed++;
      if (this.missed >= LOST_AFTER) {
        if (this.last) this.lose(now);
      } else if (this.last && ts - this.lastSeenTs <= HOLD_MS) {
        // Single dropout: hold the last position (and press state).
        pointer.emit({ ...this.last, t: now });
      }
      return;
    }
    // Back after a longer gap: start the filters fresh instead of easing from a stale position.
    if (ts - this.lastSeenTs > HOLD_MS) this.resetFilters();
    this.missed = 0;
    this.lastSeenTs = ts;
    // HandLandmarker doesn't expose the presence score; the handedness score is the closest
    // per-frame confidence (hands below MIN_HAND_PRESENCE_CONFIDENCE are dropped anyway).
    this.confidence = score ?? 1;

    // Position filters follow the live-tunable values (the pinch filter keeps its own).
    for (const f of [this.tipF, this.dipF, this.midF]) f.tune(handTuning.minCutoff, handTuning.beta);
    const px = (i: number): Point => ({ x: hand[i].x * w, y: hand[i].y * h });
    const rawTip = px(INDEX_TIP);
    const thumb = px(THUMB_TIP);
    const tip = this.tipF.filter(rawTip, ts);
    const dip = this.dipF.filter(px(INDEX_DIP), ts);
    const mid = this.midF.filter({ x: (thumb.x + rawTip.x) / 2, y: (thumb.y + rawTip.y) / 2 }, ts);
    const handSize = Math.max(1, dist(px(WRIST), px(MIDDLE_MCP)));
    const ratio = this.pinchF.filter(dist(thumb, rawTip) / handSize, ts);

    const e = this.ema;
    this.ema = e ? { x: e.x + (rawTip.x - e.x) * EMA_ALPHA, y: e.y + (rawTip.y - e.y) * EMA_ALPHA } : rawTip;
    this.rawTip = rawTip;
    this.filteredTip = tip;
    this.pinchRatio = ratio;
    this.history.push({ t: now, raw: rawTip, ema: this.ema, filtered: tip });

    const aimAhead = handTuning.aimAhead;
    const aim = { x: tip.x + (tip.x - dip.x) * aimAhead, y: tip.y + (tip.y - dip.y) * aimAhead };

    // Hysteresis + debounce: only flip after PINCH_FRAMES frames past the far threshold.
    const want = this.pressed ? ratio <= PINCH_RELEASE : ratio < PINCH_PRESS;
    if (want !== this.pressed) {
      if (++this.pinchPending >= PINCH_FRAMES) {
        this.pinchPending = 0;
        this.pressed = want;
        // Freeze where the cursor was just before the press; release goes back to the aim.
        this.anchor = want ? { pos: this.last ? { x: this.last.x, y: this.last.y } : aim, mid } : null;
      }
    } else {
      this.pinchPending = 0;
    }

    const a = this.anchor;
    const pos = this.pressed && a ? { x: a.pos.x + mid.x - a.mid.x, y: a.pos.y + mid.y - a.mid.y } : aim;
    this.last = {
      x: clamp(Math.round(pos.x), 0, w - 1),
      y: clamp(Math.round(pos.y), 0, h - 1),
      t: now,
      pressed: this.pressed,
      source: "finger",
      handPresent: true,
      confidence: this.confidence,
    };
    pointer.emit(this.last);
  }
}

/** One Euro filter (Casiez et al. 2012): an adaptive low-pass whose cutoff rises with speed. */
class OneEuro {
  private prev: number | null = null;
  private dPrev = 0;
  private tPrev = 0;

  constructor(
    private minCutoff: number,
    private beta: number,
    private dCutoff = 1.0,
  ) {}

  reset() {
    this.prev = null;
  }

  tune(minCutoff: number, beta: number) {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }

  /** `tMs` must increase between calls. */
  filter(x: number, tMs: number): number {
    if (this.prev === null) {
      this.prev = x;
      this.dPrev = 0;
      this.tPrev = tMs;
      return x;
    }
    const dt = Math.max(1e-3, (tMs - this.tPrev) / 1000);
    this.tPrev = tMs;
    const d = (x - this.prev) / dt;
    this.dPrev += (d - this.dPrev) * smoothing(this.dCutoff, dt);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dPrev);
    this.prev += (x - this.prev) * smoothing(cutoff, dt);
    return this.prev;
  }
}

class Euro2 {
  private fx: OneEuro;
  private fy: OneEuro;
  constructor(minCutoff: number, beta: number) {
    this.fx = new OneEuro(minCutoff, beta);
    this.fy = new OneEuro(minCutoff, beta);
  }
  reset() {
    this.fx.reset();
    this.fy.reset();
  }
  tune(minCutoff: number, beta: number) {
    this.fx.tune(minCutoff, beta);
    this.fy.tune(minCutoff, beta);
  }
  filter(p: Point, tMs: number): Point {
    return { x: this.fx.filter(p.x, tMs), y: this.fy.filter(p.y, tMs) };
  }
}

const smoothing = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

/** Radial std dev: sqrt(var x + var y). */
function stdDev(pts: Point[]): number {
  if (pts.length < 2) return 0;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let v = 0;
  for (const p of pts) v += (p.x - mx) ** 2 + (p.y - my) ** 2;
  return Math.sqrt(v / pts.length);
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
