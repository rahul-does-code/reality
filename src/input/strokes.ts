// Gesture recognizer over PointerSamples (pointer.ts): turns press/move/release into a click or a
// stroke. Pure state machine, no DOM and no masks; the selection track decides what a gesture means.
// - click: press and release with < CLICK_MAX_MOVE px of movement and < CLICK_MAX_MS, or any press
//   whose whole path is shorter than CLICK_MAX_MOVE (a slow pinch held still is still a click).
// - stroke: everything else. Points are frame px, points closer than MIN_STEP px are dropped, and
//   "progress" fires on every kept point so the UI can draw the stroke while dragging.
// - cancel: the hand (or mouse) left mid-press; the UI should clear the live stroke.
// Each source (finger, mouse) is tracked separately so they can't corrupt each other's gesture.
import type { Point } from "../vision/mask";
import type { PointerSample, PointerSource } from "./pointer";

export const CLICK_MAX_MOVE = 12;
export const CLICK_MAX_MS = 300;
export const MIN_STEP = 3;

export type Gesture =
  | { kind: "click"; p: Point; source: PointerSource; ms: number }
  | { kind: "progress"; points: Point[]; source: PointerSource }
  | { kind: "stroke"; points: Point[]; source: PointerSource; ms: number }
  | { kind: "cancel"; source: PointerSource };

type Active = { t0: number; start: Point; points: Point[]; maxMove: number; pathLen: number };

export class StrokeRecognizer {
  private active: Partial<Record<PointerSource, Active>> = {};

  constructor(private onGesture: (g: Gesture) => void) {}

  feed(s: PointerSample): void {
    const a = this.active[s.source];
    const p = { x: s.x, y: s.y };

    if (!a) {
      if (s.pressed && s.handPresent) {
        this.active[s.source] = { t0: s.t, start: p, points: [p], maxMove: 0, pathLen: 0 };
      }
      return;
    }

    if (!s.handPresent) {
      delete this.active[s.source];
      this.onGesture({ kind: "cancel", source: s.source });
      return;
    }

    if (s.pressed) {
      const last = a.points[a.points.length - 1];
      const step = Math.hypot(p.x - last.x, p.y - last.y);
      if (step < MIN_STEP) return;
      a.points.push(p);
      a.pathLen += step;
      a.maxMove = Math.max(a.maxMove, Math.hypot(p.x - a.start.x, p.y - a.start.y));
      this.onGesture({ kind: "progress", points: a.points.slice(), source: s.source });
      return;
    }

    // Release. The release sample's own position is ignored: un-pinching jolts the fingertip.
    delete this.active[s.source];
    const ms = s.t - a.t0;
    const click = (a.maxMove < CLICK_MAX_MOVE && ms < CLICK_MAX_MS) || a.pathLen < CLICK_MAX_MOVE;
    if (click) this.onGesture({ kind: "click", p: a.start, source: s.source, ms });
    else this.onGesture({ kind: "stroke", points: a.points, source: s.source, ms });
  }

  /** Drop any in-progress gesture (e.g. on resume/unfreeze). */
  reset(): void {
    this.active = {};
  }

  /** True while `source` (or any source) is mid-press. */
  isActive(source?: PointerSource): boolean {
    return source ? !!this.active[source] : Object.keys(this.active).length > 0;
  }
}
