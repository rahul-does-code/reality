// Head orientation on the glasses, with a short history so the overlay can be moved by how far the
// head turned since a camera frame was taken. Prefers the gyro (devicemotion rotationRate, integrated
// into a quaternion in the device frame); falls back to deviceorientation angles when there is none.

export type Quat = [number, number, number, number]; // w, x, y, z
export type Vec3 = [number, number, number];

const DEG = Math.PI / 180;
const HISTORY_MS = 4000;

export function mul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

export function conj(q: Quat): Quat {
  return [q[0], -q[1], -q[2], -q[3]];
}

function normalize(q: Quat): Quat {
  const n = Math.hypot(...q) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Rotation by vector v (axis * angle, radians). */
export function fromRotVec(v: Vec3): Quat {
  const a = Math.hypot(...v);
  if (a < 1e-9) return [1, v[0] / 2, v[1] / 2, v[2] / 2];
  const s = Math.sin(a / 2) / a;
  return [Math.cos(a / 2), v[0] * s, v[1] * s, v[2] * s];
}

/** Axis * angle (radians) of q. */
export function toRotVec(q: Quat): Vec3 {
  const [w, x, y, z] = q[0] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
  const s = Math.hypot(x, y, z);
  if (s < 1e-9) return [2 * x, 2 * y, 2 * z];
  const a = 2 * Math.atan2(s, w);
  return [(x / s) * a, (y / s) * a, (z / s) * a];
}

/** W3C deviceorientation angles (degrees, intrinsic Z-X'-Y'') as a quaternion. */
export function fromEuler(alpha: number, beta: number, gamma: number): Quat {
  return mul(mul(fromRotVec([0, 0, alpha * DEG]), fromRotVec([beta * DEG, 0, 0])), fromRotVec([0, gamma * DEG, 0]));
}

export function dot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function unit(v: Vec3): Vec3 {
  const n = Math.hypot(...v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

type Sample = { t: number; q: Quat }; // t = Date.now() ms

export class HeadPose {
  source: "none" | "gyro" | "orientation" = "none";
  rate = 0; // samples per second, for the readout
  private q: Quat = [1, 0, 0, 0];
  private lastT = 0;
  private history: Sample[] = [];
  private count = 0;
  private countFrom = Date.now();

  start() {
    window.addEventListener("devicemotion", this.onMotion);
    window.addEventListener("deviceorientation", this.onOrientation);
  }

  stop() {
    window.removeEventListener("devicemotion", this.onMotion);
    window.removeEventListener("deviceorientation", this.onOrientation);
  }

  /** Current orientation (device frame relative to an arbitrary start). */
  now(): Quat {
    return this.q;
  }

  /** Orientation at time t (Date.now() ms): the last sample at or before t, else the oldest. */
  at(t: number): Quat {
    const h = this.history;
    for (let i = h.length - 1; i >= 0; i--) if (h[i].t <= t) return h[i].q;
    return h[0]?.q ?? this.q;
  }

  /** Rotation from the pose at time t to now, as a rotation vector in the device frame at t (radians). */
  since(t: number): Vec3 {
    return toRotVec(mul(conj(this.at(t)), this.q));
  }

  private push(t: number) {
    this.history.push({ t, q: this.q });
    while (this.history.length && this.history[0].t < t - HISTORY_MS) this.history.shift();
    this.count++;
    if (t - this.countFrom >= 1000) {
      this.rate = Math.round((this.count * 1000) / (t - this.countFrom));
      this.count = 0;
      this.countFrom = t;
    }
  }

  private onMotion = (e: DeviceMotionEvent) => {
    const r = e.rotationRate;
    if (!r || r.alpha == null || r.beta == null || r.gamma == null) return;
    this.source = "gyro";
    const t = Date.now();
    const dt = this.lastT ? Math.min(0.1, Math.max(0, (t - this.lastT) / 1000)) : 0;
    this.lastT = t;
    // rotationRate: alpha about z, beta about x, gamma about y, deg/s, in the device frame.
    this.q = normalize(mul(this.q, fromRotVec([r.beta * DEG * dt, r.gamma * DEG * dt, r.alpha * DEG * dt])));
    this.push(t);
  };

  private onOrientation = (e: DeviceOrientationEvent) => {
    if (this.source === "gyro" || e.alpha == null || e.beta == null || e.gamma == null) return;
    this.source = "orientation";
    this.q = fromEuler(e.alpha, e.beta, e.gamma);
    this.push(Date.now());
  };
}
