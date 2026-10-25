// Standalone face-parts debug page (face-debug.html): webcam + landmarks + part polygons + mask tint.
// Not part of the main app. The view is NOT mirrored, so "left_eye" (subject's left) shows on the
// image right.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { startCamera, stopCamera } from "../input/camera";
import type { Point } from "./mask";
import { detectFace, FACE_PARTS, initFace, partMask, partRings, type FacePart } from "./face";

const PART_COLORS: Record<FacePart, string> = {
  nose: "#ff9f1c",
  lips: "#ff4f8b",
  left_eye: "#2ec4b6",
  right_eye: "#3a86ff",
  eyes: "#8338ec",
  eyebrows: "#ffbe0b",
  face: "#80ed99",
};

function drawRings(ctx: CanvasRenderingContext2D, lms: Point[], part: FacePart, width: number) {
  ctx.strokeStyle = PART_COLORS[part];
  ctx.lineWidth = width;
  for (const ring of partRings(part, lms)) {
    ctx.beginPath();
    ring.forEach((i, k) => (k === 0 ? ctx.moveTo(lms[i].x, lms[i].y) : ctx.lineTo(lms[i].x, lms[i].y)));
    ctx.closePath();
    ctx.stroke();
  }
}

function FaceDebug() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [part, setPart] = useState<FacePart>("nose");
  const [showMask, setShowMask] = useState(true);
  const [showPoints, setShowPoints] = useState(true);
  const [showAll, setShowAll] = useState(true);
  const [showIndices, setShowIndices] = useState(false);
  const [status, setStatus] = useState("loading face model…");
  const opts = useRef({ part, showMask, showPoints, showAll, showIndices });
  opts.current = { part, showMask, showPoints, showAll, showIndices };

  useEffect(() => {
    const video = videoRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    let stopped = false;

    (async () => {
      try {
        await initFace();
        await startCamera(video);
      } catch (e) {
        setStatus(`error: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      while (!stopped) {
        await new Promise(requestAnimationFrame);
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) continue;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        ctx.drawImage(video, 0, 0, w, h);
        const frame = ctx.getImageData(0, 0, w, h);
        const t0 = performance.now();
        const lms = await detectFace(frame);
        const detectMs = performance.now() - t0;
        if (!lms) {
          setStatus(`no face (${detectMs.toFixed(0)} ms)`);
          continue;
        }
        const o = opts.current;
        let maskInfo = "";
        if (o.showMask) {
          const t1 = performance.now();
          const mask = partMask(lms, o.part, w, h, w, h);
          let n = 0;
          for (let i = 0; i < mask.length; i++) {
            if (!mask[i]) continue;
            n++;
            frame.data[i * 4] = (frame.data[i * 4] + 255) >> 1;
            frame.data[i * 4 + 1] >>= 1;
            frame.data[i * 4 + 2] = (frame.data[i * 4 + 2] + 255) >> 1;
          }
          ctx.putImageData(frame, 0, 0);
          maskInfo = ` · mask ${((100 * n) / mask.length).toFixed(2)}% in ${(performance.now() - t1).toFixed(0)} ms`;
        }
        if (o.showPoints) {
          ctx.fillStyle = "rgba(255,255,255,0.8)";
          for (const p of lms) ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
        }
        if (o.showIndices) {
          ctx.fillStyle = "#ff0";
          ctx.font = "9px monospace";
          lms.forEach((p, i) => ctx.fillText(String(i), p.x + 2, p.y - 2));
        }
        if (o.showAll) for (const p of FACE_PARTS) if (p !== "eyes") drawRings(ctx, lms, p, 1);
        drawRings(ctx, lms, o.part, 3);
        setStatus(`${lms.length} landmarks · detect ${detectMs.toFixed(0)} ms${maskInfo}`);
      }
    })();

    return () => {
      stopped = true;
      stopCamera(video);
    };
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", color: "#eee", background: "#111", minHeight: "100vh", padding: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 8 }}>
        <strong>Face debug</strong>
        {FACE_PARTS.map((p) => (
          <label key={p} style={{ color: PART_COLORS[p] }}>
            <input type="radio" name="part" checked={part === p} onChange={() => setPart(p)} /> {p}
          </label>
        ))}
        <label><input type="checkbox" checked={showMask} onChange={(e) => setShowMask(e.target.checked)} /> mask</label>
        <label><input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} /> points</label>
        <label><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> all outlines</label>
        <label><input type="checkbox" checked={showIndices} onChange={(e) => setShowIndices(e.target.checked)} /> indices</label>
      </div>
      <div style={{ fontFamily: "monospace", marginBottom: 8 }}>{status}</div>
      <video ref={videoRef} playsInline muted style={{ display: "none" }} />
      <canvas ref={canvasRef} style={{ maxWidth: "100%", height: "auto" }} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FaceDebug />
  </React.StrictMode>
);
