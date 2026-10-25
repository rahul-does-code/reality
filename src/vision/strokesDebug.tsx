// Standalone strokes debug page (strokes-debug.html): freeze a webcam frame, then with the mouse
// click (point segment), draw a closed loop (lasso) or an open scribble. Shift = add, Alt = subtract.
// Mouse events go through emitMouse -> pointer -> StrokeRecognizer, exactly like the hand would.
// "Remove hand" runs HandLandmarker (IMAGE mode) on the frozen frame and cuts its hull out.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HandLandmarker } from "@mediapipe/tasks-vision";
import { startCamera, stopCamera } from "../input/camera";
import { emitMouse, usePointerSamples } from "../input/pointer";
import { StrokeRecognizer, type Gesture } from "../input/strokes";
import { loadLocalModel, visionFileset } from "./assets";
import { handHullMask, removeHand, convexHull } from "./handMask";
import { combine, isClosed, selectStroke, strokeToScribble, type CombineMode } from "./lasso";
import { coverage, feather, type Point } from "./mask";
import { initSegmenter, segmentAt } from "./segmenter";

let handPromise: Promise<HandLandmarker> | null = null;
function initHandImage(): Promise<HandLandmarker> {
  handPromise ??= (async () => {
    const fileset = await visionFileset();
    const buf = await loadLocalModel("/models/hand_landmarker.task");
    const opts = { runningMode: "IMAGE" as const, numHands: 1 };
    return HandLandmarker.createFromOptions(fileset, {
      ...opts,
      baseOptions: buf
        ? { modelAssetBuffer: buf }
        : { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task" },
    });
  })();
  return handPromise;
}

function drawPath(ctx: CanvasRenderingContext2D, pts: Point[], close: boolean, color: string, width: number) {
  if (!pts.length) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  if (close) ctx.closePath();
  ctx.stroke();
}

function StrokesDebug() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const strokeRef = useRef<HTMLCanvasElement>(null);
  const frozenRef = useRef<ImageData | null>(null);
  const selRef = useRef<Uint8Array | null>(null);
  const handRef = useRef<{ lms: Point[]; hull: Uint8Array } | null>(null);
  const modeRef = useRef<CombineMode>("replace");
  const reqId = useRef(0);
  const [frozen, setFrozen] = useState(false);
  const [size, setSize] = useState({ w: 1280, h: 720 });
  const [removeHandOn, setRemoveHandOn] = useState(false);
  const [status, setStatus] = useState("loading camera + segmenter…");
  const [log, setLog] = useState<string[]>([]);
  const removeHandRef = useRef(removeHandOn);
  removeHandRef.current = removeHandOn;

  const onGestureRef = useRef<(g: Gesture) => Promise<void>>(async () => {});
  const recognizer = useRef(new StrokeRecognizer((g) => void onGestureRef.current(g)));

  const addLog = (line: string) => setLog((l) => [line, ...l].slice(0, 12));

  useEffect(() => {
    const video = videoRef.current!;
    startCamera(video)
      .then(() => initSegmenter())
      .then(() => setStatus("live: press Space or Freeze, then click / lasso / scribble"))
      .catch((e) => setStatus(`error: ${e instanceof Error ? e.message : String(e)}`));
    return () => stopCamera(video);
  }, []);

  // Live preview until frozen.
  useEffect(() => {
    if (frozen) return;
    const video = videoRef.current!;
    const canvas = frameRef.current!;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        setSize({ w, h });
      }
      canvas.getContext("2d")!.drawImage(video, 0, 0, w, h);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frozen]);

  const drawMask = useCallback(() => {
    const c = maskRef.current!;
    const { w, h } = size;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    const sel = selRef.current;
    if (sel) {
      const alpha = feather(sel, w, h, 3);
      const img = ctx.createImageData(w, h);
      for (let i = 0; i < alpha.length; i++) {
        if (alpha[i] <= 0.02) continue;
        img.data[i * 4 + 1] = 229;
        img.data[i * 4 + 2] = 255;
        img.data[i * 4 + 3] = Math.round(alpha[i] * 110);
      }
      ctx.putImageData(img, 0, 0);
    }
    const hand = handRef.current;
    if (hand && removeHandRef.current) {
      drawPath(ctx, convexHull(hand.lms), true, "rgba(255,80,80,0.9)", 2);
      ctx.fillStyle = "#ff5050";
      for (const p of hand.lms) ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
  }, [size]);

  const clearStroke = () => {
    const c = strokeRef.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
  };

  const freeze = useCallback(async () => {
    const canvas = frameRef.current!;
    const { width: w, height: h } = canvas;
    frozenRef.current = canvas.getContext("2d")!.getImageData(0, 0, w, h);
    selRef.current = null;
    handRef.current = null;
    recognizer.current.reset();
    setFrozen(true);
    strokeRef.current!.width = w;
    strokeRef.current!.height = h;
    drawMask();
    setStatus("frozen: click = point · loop = lasso · open line = scribble · Shift add · Alt subtract");
    const t0 = performance.now();
    try {
      const lm = await initHandImage();
      const res = lm.detect(frozenRef.current);
      const lms = res.landmarks[0]?.map((p) => ({ x: p.x * w, y: p.y * h }));
      if (lms) {
        const t1 = performance.now();
        handRef.current = { lms, hull: handHullMask(lms, w, h, 12) };
        addLog(`hand: detect ${Math.round(t1 - t0)}ms · hull ${Math.round(performance.now() - t1)}ms`);
      } else addLog(`hand: none found (${Math.round(performance.now() - t0)}ms)`);
      drawMask();
    } catch (e) {
      addLog(`hand: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [drawMask]);

  const resume = useCallback(() => {
    frozenRef.current = null;
    selRef.current = null;
    handRef.current = null;
    reqId.current++;
    recognizer.current.reset();
    setFrozen(false);
    clearStroke();
    maskRef.current!.getContext("2d")!.clearRect(0, 0, size.w, size.h);
    setStatus("live: press Space or Freeze");
  }, [size]);

  const onGesture = useCallback(
    async (g: Gesture) => {
      const frame = frozenRef.current;
      if (!frame) return;
      const ctx = strokeRef.current!.getContext("2d")!;
      if (g.kind === "progress") {
        ctx.clearRect(0, 0, frame.width, frame.height);
        drawPath(ctx, g.points, false, "#ffd400", 3);
        return;
      }
      if (g.kind === "cancel") {
        clearStroke();
        addLog("cancel (pointer left)");
        return;
      }
      const mode = modeRef.current;
      const id = ++reqId.current;
      const { width: w, height: h } = frame;
      let desc: string;
      let seg;
      if (g.kind === "click") {
        clearStroke();
        seg = { kind: "click", ...(await segmentAt(frame, g.p)) };
        desc = `click (${Math.round(g.ms)}ms press)`;
      } else {
        const closed = isClosed(g.points);
        ctx.clearRect(0, 0, w, h);
        drawPath(ctx, g.points, closed, closed ? "#ffd400" : "#ff9f1c", 2);
        if (!closed) {
          ctx.fillStyle = "#fff";
          for (const q of strokeToScribble(g.points, w, h)) ctx.fillRect(q.x * w - 2, q.y * h - 2, 4, 4);
        }
        seg = await selectStroke(frame, g.points);
        desc = `stroke ${g.points.length}pts ${Math.round(g.ms)}ms ${closed ? "closed" : "open"}`;
      }
      if (id !== reqId.current) return;
      const t0 = performance.now();
      let mask = combine(selRef.current, seg.mask, mode);
      const hand = handRef.current;
      let handNote = "";
      if (hand && removeHandRef.current) {
        const t1 = performance.now();
        mask = removeHand(mask, hand.hull, w, h);
        handNote = ` · removeHand ${Math.round(performance.now() - t1)}ms`;
      }
      const postMs = performance.now() - t0;
      selRef.current = mask;
      drawMask();
      addLog(
        `${desc} → ${seg.kind}/${seg.source} ${Math.round(seg.ms)}ms${seg.note ? ` (${seg.note})` : ""}` +
          ` · ${mode} ${Math.round(postMs)}ms${handNote} · cov ${(coverage(mask) * 100).toFixed(1)}%`,
      );
    },
    [drawMask],
  );

  onGestureRef.current = onGesture;
  usePointerSamples((s) => recognizer.current.feed(s));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      frozenRef.current ? resume() : void freeze();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [freeze, resume]);

  const onMouse = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!frozenRef.current) return;
    if (e.type === "mousedown") {
      e.preventDefault();
      modeRef.current = e.shiftKey ? "add" : e.altKey ? "subtract" : "replace";
    }
    emitMouse(e, e.currentTarget, size.w, size.h, e.type !== "mouseleave");
  };

  const layer: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%" };

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", color: "#eee", background: "#111", minHeight: "100vh", padding: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 8 }}>
        <strong>Strokes debug</strong>
        <button onClick={() => (frozen ? resume() : void freeze())}>{frozen ? "Resume (Space)" : "Freeze (Space)"}</button>
        <button
          disabled={!frozen}
          onClick={() => {
            selRef.current = null;
            clearStroke();
            drawMask();
          }}
        >
          Clear selection
        </button>
        <label>
          <input
            type="checkbox"
            checked={removeHandOn}
            onChange={(e) => {
              removeHandRef.current = e.target.checked;
              setRemoveHandOn(e.target.checked);
              drawMask();
            }}
          />{" "}
          remove hand (finger source)
        </label>
      </div>
      <div style={{ fontFamily: "monospace", marginBottom: 8 }}>{status}</div>
      <video ref={videoRef} playsInline muted style={{ display: "none" }} />
      <div style={{ position: "relative", maxWidth: "100%", aspectRatio: `${size.w} / ${size.h}` }}>
        <canvas ref={frameRef} style={layer} />
        <canvas ref={maskRef} style={{ ...layer, pointerEvents: "none" }} />
        <canvas
          ref={strokeRef}
          style={{ ...layer, cursor: frozen ? "crosshair" : "default" }}
          onMouseDown={onMouse}
          onMouseMove={onMouse}
          onMouseUp={onMouse}
          onMouseLeave={onMouse}
        />
      </div>
      <pre style={{ fontSize: 12, lineHeight: 1.5, marginTop: 8 }}>{log.join("\n")}</pre>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StrokesDebug />
  </React.StrictMode>,
);
