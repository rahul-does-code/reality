import { useCallback, useEffect, useRef, useState } from "react";
import { listCameras, startCamera, stopCamera } from "../input/camera";
import { FrameHistory } from "../commands/history";
import { initSegmenter, segmentAt } from "../vision/segmenter";
import { feather, type Point } from "../vision/mask";
import { recolor } from "../edit/recolor";
import { PushToTalk, speechSupported } from "../input/speech";
import { HandTracker } from "../input/handTracker";
import { parseCommand } from "../commands/geminiParse";
import type { Command } from "../commands/schema";

const SWATCHES = ["#ff3ca0", "#e5322d", "#2f6bff", "#22b55e", "#ffd21f", "#8a3ffc"];

export default function Stage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef(new FrameHistory());
  const reqId = useRef(0);
  // Mirrors of state that async flows (voice, hand) read after awaits.
  const alphaRef = useRef<Float32Array | null>(null);
  const segPromiseRef = useRef<Promise<void> | null>(null);

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

  // Voice: hold V (or the mic button) to talk; release -> transcript -> Gemini -> dispatch.
  const pttRef = useRef<PushToTalk | null>(null);
  const lastEditRef = useRef<Command | null>(null); // context for "less"/"again", sent as `previous`
  const [listening, setListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState(
    speechSupported() ? "hold V to talk" : "Voice commands need the Web Speech API (Chrome/Edge). Use the text box instead.",
  );
  const [devText, setDevText] = useState("");

  // Hand mode: fingertip cursor on the live feed; holding V freezes + points at the fingertip.
  const trackerRef = useRef<HandTracker | null>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const [handMode, setHandMode] = useState(false);
  const [handStatus, setHandStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [handSeen, setHandSeen] = useState(false);

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
        if (cancelled) return;
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
    alphaRef.current = null;
    segPromiseRef.current = null;
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
  // The returned promise is also kept in segPromiseRef so commands can wait for the mask.
  const runSegment = useCallback((p: Point): Promise<void> => {
    const original = historyRef.current.original;
    if (!original) return Promise.resolve();
    const id = ++reqId.current;
    setBusy(true);
    alphaRef.current = null;
    setAlpha(null);
    const job = segmentAt(original, p).then((res) => {
      if (id !== reqId.current) return; // a newer click or a resume superseded this one
      const a = feather(res.mask, original.width, original.height, 3);
      alphaRef.current = a;
      setAlpha(a);
      setSegInfo(`${res.source} · ${Math.round(res.ms)}ms${res.note ? ` · ${res.note}` : ""}`);
      setBusy(false);
    });
    segPromiseRef.current = job;
    return job;
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

  const recolorWith = useCallback((c: string): boolean => {
    const canvas = canvasRef.current;
    const cur = historyRef.current.current;
    const a = alphaRef.current;
    if (!canvas || !cur || !a) return false;
    const out = recolor(cur, a, c);
    canvas.getContext("2d")!.putImageData(out, 0, 0);
    historyRef.current.push(out);
    setDepth(historyRef.current.depth);
    return true;
  }, []);

  const applyRecolor = useCallback(() => recolorWith(color), [recolorWith, color]);

  // Executes a parsed command and returns a short status for the voice line.
  const dispatch = useCallback(
    (cmd: Command, isRetry = false): string => {
      switch (cmd.op) {
        case "undo":
          if (!historyRef.current.canUndo) return "nothing to undo";
          undo();
          return "undone";
        case "retry": {
          const prev = lastEditRef.current;
          if (!prev) return "nothing to retry";
          if (isRetry) return "retry loop ignored";
          return `retry: ${dispatch(prev, true)}`;
        }
        case "recolor": {
          if (!cmd.color || !CSS.supports("color", cmd.color)) return `recolor: bad color "${cmd.color}"`;
          if (!historyRef.current.current) return "freeze the frame first (Space)";
          if (!alphaRef.current) return "point at (click) an object first";
          if (!recolorWith(cmd.color)) return "recolor failed";
          if (/^#[0-9a-f]{6}$/i.test(cmd.color)) setColor(cmd.color);
          if (!isRetry) lastEditRef.current = cmd;
          // Named targets aren't segmented by name yet; the current selection stands in.
          const note = cmd.target === "named" && cmd.target_name ? ` (used selection for "${cmd.target_name}")` : "";
          return `recolored ${cmd.color}${note}`;
        }
        default:
          console.log("[voice] op not implemented yet:", cmd);
          if (!isRetry) lastEditRef.current = cmd;
          return `${cmd.op} not implemented yet`;
      }
    },
    [undo, recolorWith],
  );
  // The parse is async, so call through a ref to get the dispatch with current state.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const runCommand = useCallback(async (transcript: string) => {
    if (!transcript) {
      setVoiceStatus("didn't catch that");
      return;
    }
    setVoiceStatus(`"${transcript}" · parsing...`);
    try {
      const { command, ms } = await parseCommand(transcript, lastEditRef.current);
      console.log("[voice]", transcript, command);
      await segPromiseRef.current; // a hand-mode point may still be segmenting
      const result = dispatchRef.current(command);
      const detail = [command.op, command.target_name, command.color].filter(Boolean).join(" ");
      setVoiceStatus(`"${transcript}" → ${detail} · ${result} · ${ms}ms`);
    } catch (e) {
      setVoiceStatus(`"${transcript}" · error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const startTalking = useCallback(() => {
    if (!speechSupported() || pttRef.current?.listening) return;
    pttRef.current ??= new PushToTalk((t) => setVoiceStatus(`listening... "${t}"`));
    try {
      pttRef.current.start();
      setListening(true);
      setVoiceStatus("listening...");
    } catch (e) {
      setVoiceStatus(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stopTalking = useCallback(async () => {
    const ptt = pttRef.current;
    if (!ptt?.listening) return;
    setListening(false);
    try {
      void runCommand(await ptt.stop());
    } catch (e) {
      setVoiceStatus(e instanceof Error ? e.message : String(e));
    }
  }, [runCommand]);

  // Push-to-talk press. In hand mode it also freezes (if live) and points at the fingertip
  // as of this instant. If already frozen, the frame is kept so refinements chain on it; a
  // visible hand re-points, otherwise the current selection stays.
  const pttDown = useCallback(() => {
    if (handMode) {
      if (!historyRef.current.current) freeze();
      const aim = trackerRef.current?.state?.aim;
      if (aim) {
        setPoint(aim);
        void runSegment(aim);
      }
      startTalking();
      if (!aim) setVoiceStatus("listening... (no hand seen: click the object to point)");
      return;
    }
    startTalking();
  }, [handMode, freeze, runSegment, startTalking]);

  // Fingertip tracking runs only while hand mode is on. The cursor is moved directly on the
  // DOM so 30-60 updates/s don't re-render the whole stage.
  useEffect(() => {
    if (!handMode) return;
    const video = videoRef.current!;
    const cursor = cursorRef.current;
    setHandStatus("loading");
    const tracker = new HandTracker((st) => {
      setHandSeen(st !== null);
      if (!cursor) return;
      cursor.style.display = st ? "block" : "none";
      if (st && video.videoWidth) {
        cursor.style.left = `${(st.tip.x / video.videoWidth) * 100}%`;
        cursor.style.top = `${(st.tip.y / video.videoHeight) * 100}%`;
      }
    });
    trackerRef.current = tracker;
    tracker
      .start(video)
      .then(() => setHandStatus("ready"))
      .catch((e) => {
        console.error("hand tracker init failed", e);
        setHandStatus("failed");
      });
    return () => {
      tracker.stop();
      trackerRef.current = null;
      setHandSeen(false);
      if (cursor) cursor.style.display = "none";
    };
  }, [handMode]);

  // Hold V to talk. Releasing outside the window (blur) also ends the utterance.
  useEffect(() => {
    const isV = (e: KeyboardEvent) => e.key.toLowerCase() === "v";
    const inField = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      return tag === "SELECT" || tag === "INPUT";
    };
    const onDown = (e: KeyboardEvent) => {
      if (isV(e) && !e.repeat && !inField(e)) pttDown();
    };
    const onUp = (e: KeyboardEvent) => {
      if (isV(e)) void stopTalking();
    };
    const onBlur = () => void stopTalking();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [pttDown, stopTalking]);

  useEffect(() => () => pttRef.current?.cancel(), []);

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
    ? handMode
      ? "point with your index finger and hold V"
      : "press Space to freeze the frame"
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
        <div ref={cursorRef} className="hand-cursor" />
        <div className="badge badge-right">
          model: {modelState}
          {handMode && ` · hand: ${handStatus === "ready" ? (handSeen ? "tracking" : "no hand") : handStatus}`}
        </div>
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
          <input type="checkbox" checked={handMode} onChange={(e) => setHandMode(e.target.checked)} />
          Hand mode
        </label>
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

      <div className="voice">
        <button
          className={listening ? "mic on" : "mic"}
          disabled={!speechSupported()}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            pttDown();
          }}
          onPointerUp={() => void stopTalking()}
          onPointerCancel={() => void stopTalking()}
        >
          {listening ? "● Listening" : "Hold to talk (V)"}
        </button>
        {import.meta.env.DEV && (
          <form
            className="dev-cmd"
            onSubmit={(e) => {
              e.preventDefault();
              void runCommand(devText.trim());
            }}
          >
            <input
              value={devText}
              onChange={(e) => setDevText(e.target.value)}
              placeholder="dev: type a command, e.g. make that red"
            />
          </form>
        )}
        <span className="voice-status">{voiceStatus}</span>
      </div>
    </div>
  );
}
