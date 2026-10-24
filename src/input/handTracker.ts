// Index-fingertip tracking on the live <video> with MediaPipe HandLandmarker.
// Runs once per animation frame (skipping frames where the video hasn't advanced) and reports
// landmark 8 in frame pixel coords, smoothed with an EMA.
import { HandLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { loadLocalModel, visionFileset } from "../vision/assets";
import type { Point } from "../vision/mask";

const LOCAL_MODEL = "/models/hand_landmarker.task";
const REMOTE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const INDEX_DIP = 7;
const INDEX_TIP = 8;
/** EMA weight for an N-frame window: 2 / (N + 1), N = 4. */
const EMA_ALPHA = 2 / (4 + 1);
/** Frames without a hand before we report "lost" (absorbs single-frame detection dropouts). */
const LOST_AFTER = 5;
/**
 * The frozen frame contains the hand itself, so segmenting exactly at the tip tends to pick the
 * finger. `aim` projects past the tip along the last finger segment by this many segment lengths.
 * Set to 0 to aim at the fingertip itself.
 */
const AIM_AHEAD = 1.0;

export type HandState = {
  /** Smoothed index fingertip (landmark 8), frame px. */
  tip: Point;
  /** Point just beyond the fingertip, frame px; what pointing should select. */
  aim: Point;
};

let landmarkerPromise: Promise<HandLandmarker> | null = null;

async function create(delegate: "GPU" | "CPU") {
  const fileset = await visionFileset();
  const buf = await loadLocalModel(LOCAL_MODEL);
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: buf ? { modelAssetBuffer: buf, delegate } : { modelAssetPath: REMOTE_MODEL, delegate },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

/** Safe to call repeatedly; shares one landmarker. */
export function initHandTracker(): Promise<HandLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = create("GPU").catch(() => create("CPU"));
    landmarkerPromise.catch(() => {
      landmarkerPromise = null; // allow retry on next call
    });
  }
  return landmarkerPromise;
}

export class HandTracker {
  private raf = 0;
  private running = false;
  private lastVideoTime = -1;
  private missed = 0;
  private smooth: { tip: Point; dip: Point } | null = null;
  private _state: HandState | null = null;

  /** `onUpdate` fires every processed frame with the smoothed state, or null when no hand is seen. */
  constructor(private onUpdate: (s: HandState | null) => void) {}

  /** Latest smoothed state; read this at the moment of an action (e.g. V press). */
  get state(): HandState | null {
    return this._state;
  }

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
      const res = landmarker.detectForVideo(video, performance.now());
      this.update(res.landmarks[0], video.videoWidth, video.videoHeight);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.smooth = null;
    this._state = null;
    this.lastVideoTime = -1;
  }

  private update(hand: NormalizedLandmark[] | undefined, w: number, h: number) {
    if (!hand) {
      if (++this.missed >= LOST_AFTER && this._state) {
        this.smooth = null;
        this._state = null;
        this.onUpdate(null);
      }
      return;
    }
    this.missed = 0;
    const tip = { x: hand[INDEX_TIP].x * w, y: hand[INDEX_TIP].y * h };
    const dip = { x: hand[INDEX_DIP].x * w, y: hand[INDEX_DIP].y * h };
    const s = this.smooth;
    // Fresh hand: seed the average instead of easing in from a stale position.
    this.smooth = s ? { tip: ema(s.tip, tip), dip: ema(s.dip, dip) } : { tip, dip };

    const t = this.smooth.tip;
    const d = this.smooth.dip;
    const aim = {
      x: clamp(Math.round(t.x + (t.x - d.x) * AIM_AHEAD), 0, w - 1),
      y: clamp(Math.round(t.y + (t.y - d.y) * AIM_AHEAD), 0, h - 1),
    };
    this._state = { tip: { x: Math.round(t.x), y: Math.round(t.y) }, aim };
    this.onUpdate(this._state);
  }
}

const ema = (prev: Point, next: Point): Point => ({
  x: prev.x + (next.x - prev.x) * EMA_ALPHA,
  y: prev.y + (next.y - prev.y) * EMA_ALPHA,
});

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
