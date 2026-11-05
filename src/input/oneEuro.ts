// One Euro filter, shared by the hand tracker and the pointer-filter eval (scripts/eval-hand.mjs).
import type { Point } from "../vision/mask";

/** One Euro filter (Casiez et al. 2012): an adaptive low-pass whose cutoff rises with speed. */
export class OneEuro {
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

export class Euro2 {
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

