import { useCallback, useEffect, useRef, useState } from "react";
import { listCameras, startCamera, stopCamera } from "../input/camera";
import { FrameHistory } from "../commands/history";
import { initSegmenter, segmentAt } from "../vision/segmenter";
import { feather, type Point } from "../vision/mask";
import { recolor } from "../edit/recolor";

const SWATCHES = ["#ff3ca0", "#e5322d", "#2f6bff", "#22b55e", "#ffd21f", "#8a3ffc"];

export default function Stage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef(new FrameHistory());
  const reqId = useRef(0);

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [point, setPoint] = useState<Point | null>(null);
  const [size, setSize] = useState({ w: 1280, h: 720 });
  const [depth, setDepth] = useState(0);

  const [alpha, setAlpha] = useState<Float32Array | null>(null);
  const [busy, setBusy] = useState(false);
  const [showMask, setShowMask] = useState(true);
  const [segInfo, setSegInfo] = useState("");
  const [modelState, setModelState] = useState<"loading" | "ready" | "failed">("loading");
  const [color, setColor] = useState(SWATCHES[0]);

  // Preload the segmentation model so the first click is fast.
  useEffect(() => {
    initSegmenter()
      .then(() => setModelState("ready"))
      .catch((e) => {
        console.error("segmenter init failed", e);
        setModelState("failed");
        setSegInfo(`model failed: ${e instanceof Error ? e.message : String(e)} (circle fallback active)`);
      });
  }, []);

  // Start / switch camera
  useEffect(() => {
    const video = videoRef.current!;
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        await startCamera(video, deviceId);
        if (cancelled) return;
        setCameras(await listCameras());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      stopCamera(video);
    };
  }, [deviceId]);

  const clearSelection = useCallback(() => {
    reqId.current++; // invalidate any in-flight segmentation
    setPoint(null);
    setAlpha(null);
    setBusy(false);
    setSegInfo((s) => (s.startsWith("model failed") ? s : ""));
  }, []);

  const freeze = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    setSize({ w: video.videoWidth, h: video.videoHeight });
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0);
    historyRef.current.reset(ctx.getImageData(0, 0, canvas.width, canvas.height));
    setDepth(0);
    clearSelection();
    setFrozen(true);
  }, [clearSelection]);

  const resume = useCallback(() => {
    historyRef.current.clear();
    setDepth(0);
    clearSelection();
    setFrozen(false);
  }, [clearSelection]);

  const undo = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const frame = historyRef.current.undo();
    if (frame) canvas.getContext("2d")!.putImageData(frame, 0, 0);
    setDepth(historyRef.current.depth);
  }, []);

  // Segment on the ORIGINAL frozen frame so earlier edits never confuse the model.
  const runSegment = useCallback(async (p: Point) => {
    const original = historyRef.current.original;
    if (!original) return;
    const id = ++reqId.current;
    setBusy(true);
    setAlpha(null);
    const res = await segmentAt(original, p);
    if (id !== reqId.current) return; // a newer click or a resume superseded this one
    setAlpha(feather(res.mask, original.width, original.height, 3));
    setSegInfo(`${res.source} · ${Math.round(res.ms)}ms${res.note ? ` · ${res.note}` : ""}`);
    setBusy(false);
  }, []);

  // Click-to-point (stand-in for the fingertip). Maps screen px -> frame px.
  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!frozen) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const p = {
      x: Math.round(((e.clientX - rect.left) / rect.width) * size.w),
      y: Math.round(((e.clientY - rect.top) / rect.height) * size.h),
    };
    setPoint(p);
    void runSegment(p);
  };

  const applyRecolor = useCallback(() => {
    const canvas = canvasRef.current;
    const cur = historyRef.current.current;
    if (!canvas || !cur || !alpha) return;
    const out = recolor(cur, alpha, color);
    canvas.getContext("2d")!.putImageData(out, 0, 0);
    historyRef.current.push(out);
    setDepth(historyRef.current.depth);
  }, [alpha, color]);

  // Mask overlay (separate canvas, never baked into the frame)
  useEffect(() => {
    const c = overlayRef.current;
    if (!c) return;
    c.width = size.w;
    c.height = size.h;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!frozen || !showMask || !alpha) return;
    const img = ctx.createImageData(size.w, size.h);
    for (let i = 0; i < alpha.length; i++) {
      const a = alpha[i];
      if (a > 0.02) {
        const j = i * 4;
        img.data[j] = 0;
        img.data[j + 1] = 229;
        img.data[j + 2] = 255;
        img.data[j + 3] = Math.round(a * 110);
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [alpha, showMask, frozen, size]);

  // Keyboard: Space = freeze/resume, U = undo, R = recolor
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "SELECT" || tag === "INPUT") return;
      if (e.code === "Space") {
        e.preventDefault();
        frozen ? resume() : freeze();
      } else if (e.key.toLowerCase() === "u") undo();
      else if (e.key.toLowerCase() === "r") applyRecolor();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frozen, freeze, resume, undo, applyRecolor]);

  const readout = !frozen
    ? "press Space to freeze the frame"
    : busy
      ? "segmenting..."
      : point
        ? `point (${point.x}, ${point.y}) · ${segInfo}`
        : "click an object";

  return (
    <div className="stage-wrap">
      <div className="stage" style={{ aspectRatio: `${size.w} / ${size.h}` }}>
        <video
          ref={videoRef}
          playsInline
          muted
          className="layer"
          style={{ visibility: frozen ? "hidden" : "visible" }}
          onLoadedMetadata={(e) =>
            setSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })
          }
        />
        <canvas
          ref={canvasRef}
          className="layer"
          style={{ visibility: frozen ? "visible" : "hidden", cursor: frozen ? "crosshair" : "default" }}
          onClick={onCanvasClick}
        />
        <canvas ref={overlayRef} className="layer" style={{ pointerEvents: "none" }} />
        {frozen && point && (
          <div
            className="marker"
            style={{ left: `${(point.x / size.w) * 100}%`, top: `${(point.y / size.h) * 100}%` }}
          />
        )}
        {error && <div className="error">Camera error: {error}</div>}
        <div className="badge">
          {frozen ? "FROZEN" : "LIVE"}
          {busy ? " · …" : ""}
        </div>
        <div className="badge badge-right">model: {modelState}</div>
      </div>

      <div className="controls">
        {frozen ? (
          <button onClick={resume}>Resume live (Space)</button>
        ) : (
          <button onClick={freeze}>Freeze (Space)</button>
        )}
        <button onClick={undo} disabled={depth === 0}>
          Undo (U){depth ? ` · ${depth}` : ""}
        </button>
        <button onClick={applyRecolor} disabled={!frozen || !alpha || busy}>
          Recolor (R)
        </button>
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          title="Target color"
          className="color"
        />
        {SWATCHES.map((s) => (
          <button
            key={s}
            className="swatch"
            style={{ background: s, outline: s === color ? "2px solid #fff" : "none" }}
            onClick={() => setColor(s)}
            aria-label={`Use ${s}`}
          />
        ))}
        <label className="check">
          <input type="checkbox" checked={showMask} onChange={(e) => setShowMask(e.target.checked)} />
          Show mask
        </label>
        {cameras.length > 1 && (
          <select value={deviceId ?? ""} onChange={(e) => setDeviceId(e.target.value || undefined)}>
            <option value="">Default camera</option>
            {cameras.map((c, i) => (
              <option key={c.deviceId} value={c.deviceId}>
                {c.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
        )}
        <span className="readout">{readout}</span>
      </div>
    </div>
  );
}
