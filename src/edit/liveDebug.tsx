// Standalone live-recolor debug page (live-debug.html): webcam, mouse = point, color picker.
// Not part of the main app. The view is NOT mirrored. Mouse leaving the video = point lost (fades).
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { startCamera, stopCamera } from "../input/camera";
import type { Point } from "../vision/mask";
import { LiveRecolor, type LiveStats } from "./liveRecolor";

function LiveDebug() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef(new LiveRecolor());
  const point = useRef<Point | null>(null);
  const [color, setColor] = useState("#ff4f8b");
  const [on, setOn] = useState(true);
  const [stats, setStats] = useState<LiveStats>(live.current.stats);
  const [status, setStatus] = useState("starting camera…");

  useEffect(() => {
    const video = videoRef.current!;
    startCamera(video)
      .then(() => setStatus("hover the mouse over an object"))
      .catch((e) => setStatus(`error: ${e instanceof Error ? e.message : String(e)}`));
    const id = setInterval(() => setStats({ ...live.current.stats }), 250);
    (window as unknown as { __live: LiveRecolor }).__live = live.current; // for console measurements
    return () => {
      clearInterval(id);
      live.current.stop();
      stopCamera(video);
    };
  }, []);

  useEffect(() => {
    if (!on) return live.current.stop();
    live.current.start(videoRef.current!, () => point.current, color, canvasRef.current!);
    return () => live.current.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);

  useEffect(() => live.current.setColor(color), [color]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    point.current = {
      x: ((e.clientX - r.left) / r.width) * el.width,
      y: ((e.clientY - r.top) / r.height) * el.height,
    };
  };

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <label>
          color <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <label>
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> live recolor
        </label>
        <code>
          {stats.fps} fps · render {stats.renderMs} ms · seg {stats.segMs} ms · mask {stats.hasMask ? "yes" : "no"}
        </code>
        <span style={{ opacity: 0.7 }}>{status}</span>
      </div>
      <video ref={videoRef} playsInline muted style={{ display: "none" }} />
      <canvas
        ref={canvasRef}
        onMouseMove={onMove}
        onMouseLeave={() => (point.current = null)}
        style={{ width: "min(100%, 1280px)", display: "block", cursor: "crosshair" }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<LiveDebug />);
