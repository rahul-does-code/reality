// The pointer track's only output. Hand tracking and the mouse both emit PointerSamples here;
// everything downstream (selection, cursor UI) reads samples and never touches the sources.
import { useEffect, useRef } from "react";

export type PointerSource = "finger" | "mouse";

export type PointerSample = {
  /** Frame px (the video/frozen frame resolution, not screen px). */
  x: number;
  y: number;
  /** performance.now() ms. */
  t: number;
  /** Pinch held (finger) or button held (mouse). */
  pressed: boolean;
  source: PointerSource;
  /** False once the hand is lost (finger) or the mouse leaves the frame. */
  handPresent: boolean;
  /** 0..1; always 1 for the mouse. */
  confidence: number;
};

type Listener = (s: PointerSample) => void;

const listeners = new Set<Listener>();
const latestBySource: Partial<Record<PointerSource, PointerSample>> = {};

export const pointer = {
  emit(s: PointerSample): void {
    latestBySource[s.source] = s;
    for (const fn of listeners) fn(s);
  },
  /** Returns an unsubscribe function. */
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  /** Most recent sample from `source`, or from either source when omitted. */
  latest(source?: PointerSource): PointerSample | null {
    if (source) return latestBySource[source] ?? null;
    const f = latestBySource.finger;
    const m = latestBySource.mouse;
    if (!f || !m) return f ?? m ?? null;
    return f.t >= m.t ? f : m;
  },
};

/** Subscribe for the component's lifetime; `fn` may change every render. */
export function usePointerSamples(fn: Listener): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => pointer.subscribe((s) => ref.current(s)), []);
}

/**
 * Emit a mouse sample from an event on an element that displays a frame of `frameW` x `frameH`.
 * `mirrored`: the element is shown with scaleX(-1), so screen-left is frame-right.
 */
export function emitMouse(
  e: { clientX: number; clientY: number; buttons: number },
  el: Element,
  frameW: number,
  frameH: number,
  present = true,
  mirrored = false,
): void {
  const rect = el.getBoundingClientRect();
  const rx = (e.clientX - rect.left) / rect.width;
  pointer.emit({
    x: Math.round((mirrored ? 1 - rx : rx) * frameW),
    y: Math.round(((e.clientY - rect.top) / rect.height) * frameH),
    t: performance.now(),
    pressed: present && (e.buttons & 1) === 1,
    source: "mouse",
    handPresent: present,
    confidence: 1,
  });
}
