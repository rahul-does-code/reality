import { useCallback, useEffect, useRef, useState } from "react";
import { listCameras, startCamera, stopCamera } from "../input/camera";
import { FrameHistory } from "../commands/history";
import { initSegmenter } from "../vision/segmenter";
import { initFace } from "../vision/face";
import { resolveSelection, segmentPointed, type CurrentSelection, type Selection } from "../vision/select";
import { frameJpeg } from "../vision/frameJpeg";
import { bbox, coverage, feather, type Point } from "../vision/mask";
import { combine, isClosed, selectStroke, type CombineMode } from "../vision/lasso";
import { handHullInFrame, removeHand } from "../vision/handMask";
import { StrokeRecognizer, type Gesture } from "../input/strokes";
import { recolor } from "../edit/recolor";
import { blurMasked, DEFAULT_BLUR } from "../edit/blur";
import { composite, dimInside } from "../edit/composite";
import { removeObject } from "../edit/remove";
import { replaceObject } from "../edit/replace";
import { editTimeoutMs, maskDataUrl } from "../edit/modelEdit";
import { Timeline } from "../commands/timeline";
import { LiveRecolor } from "../edit/liveRecolor";

const CROSSFADE_MS = 400;
import { speechSupported } from "../input/speech";
import { createPushToTalk, MusePushToTalk, voiceSupported, type PushToTalkLike, type VoiceEngine } from "../input/museVoice";
import { AIM_AHEAD, BETA, HandTracker, MIN_CUTOFF, handTuning } from "../input/handTracker";
import { emitMouse, pointer, usePointerSamples } from "../input/pointer";
import { parseCommand } from "../commands/geminiParse";
import type { Command, Select } from "../commands/schema";

const SWATCHES = ["#ff3ca0", "#e5322d", "#2f6bff", "#22b55e", "#ffd21f", "#8a3ffc"];
const HINTS = ["make it pink", "blur that", "turn that into a cardboard box", "make the taller one red", "change my nose"];

/** Human message for a getUserMedia / speech failure. */
function permissionMessage(what: "Camera" | "Microphone", e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  const msg = e instanceof Error ? e.message : String(e);
  if (name === "NotAllowedError" || /not-allowed|denied|permission/i.test(msg))
    return `${what} access denied. Allow it in the browser's site settings (address bar), then reload.`;
  if (name === "NotFoundError") return `No ${what.toLowerCase()} found.`;
  if (name === "NotReadableError") return `${what} is in use by another app.`;
  return `${what} error: ${msg}`;
}

export default function Stage() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  // In-progress stroke (lasso/scribble) drawn in frame px, inside the mirrored layer.
  const strokeRef = useRef<HTMLCanvasElement>(null);
  // How the next gesture combines with the current selection: the mouse sets it per press
  // (Shift add, Alt subtract); a voice "add this" / "not this part" overrides it once.
  const modeRef = useRef<CombineMode>("replace");
  const voiceModeRef = useRef<CombineMode | null>(null);
  // Dimmed/desaturated masked region while a model edit runs; fades out over the result.
  const pendingRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef(new FrameHistory());
  const reqId = useRef(0);
  // Mirrors of state that async flows (voice, hand) read after awaits.
  const alphaRef = useRef<Float32Array | null>(null);
  const maskRef = useRef<Uint8Array | null>(null); // binary selection behind alphaRef, for refines
  // The selection before any inversion ("the background" is its inverse), what it is, and how it was made.
  const subjectRef = useRef<Uint8Array | null>(null);
  const labelRef = useRef<string | null>(null);
  const sourceRef = useRef<string | null>(null);
  // The last edit actually applied: enough to undo it and redo it on a narrower selection
  // ("only the top half"). after = the frame it produced (it's only scoped while still showing).
  const appliedRef = useRef<{
    op: "recolor" | "blur" | "remove" | "replace";
    color?: string;
    intensity?: number;
    prompt?: string;
    what?: string;
    before: ImageData;
    after: ImageData;
    sel: NonNullable<CurrentSelection>;
  } | null>(null);
  const pointRef = useRef<Point | null>(null);
  const segPromiseRef = useRef<Promise<void> | null>(null);
  // Last blur: the frame it was applied on, its mask, and every frame it produced, so an
  // intensity "adjust" right after re-blurs from the pre-blur frame instead of stacking.
  const lastBlurRef = useRef<{ base: ImageData; alpha: Float32Array; results: ImageData[] } | null>(null);
  const modelBusyRef = useRef(false);

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [point, setPoint] = useState<Point | null>(null);
  // Label chip over a voice-resolved selection (e.g. "taller bottle (named)"); x, y = top center of
  // the mask in 0..1 frame coords. Pointed selections show the marker instead.
  const [selTag, setSelTag] = useState<{ text: string; x: number; y: number } | null>(null);
  const [size, setSize] = useState({ w: 1280, h: 720 });
  const [depth, setDepth] = useState(0);

  const [alpha, setAlpha] = useState<Float32Array | null>(null);
  const [busy, setBusy] = useState(false);
  const [showMask, setShowMask] = useState(true);
  const [segInfo, setSegInfo] = useState("");
  const [modelState, setModelState] = useState<"loading" | "ready" | "failed">("loading");
  const [color, setColor] = useState(SWATCHES[0]);
  // Display-only: the stage's frame layers get scaleX(-1). All data stays in raw frame px.
  const [mirror, setMirror] = useState(true);

  // Voice: hold V (or the mic button) to talk; release -> transcript -> Gemini -> dispatch.
  const pttRef = useRef<PushToTalkLike | null>(null);
  // Voice source: Web Speech in the browser, or Muse Voice Transcribe (falls back to Web Speech).
  const [voiceEngine, setVoiceEngine] = useState<VoiceEngine>("webspeech");
  const lastEditRef = useRef<Command | null>(null); // context for "less"/"again", sent as `previous`
  const [listening, setListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState(
    speechSupported() ? "hold V to talk" : "Voice commands need the Web Speech API (Chrome/Edge). Use the text box instead.",
  );
  const [devText, setDevText] = useState("");
  // Model edit in flight: the mask (as a data URL) the shimmer is clipped to.
  const [thinkingMask, setThinkingMask] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingOn, setPendingOn] = useState(false);

  // Warm the proxy's timeout setting so the first model edit doesn't wait on it.
  useEffect(() => {
    void editTimeoutMs();
  }, []);

  // Hand mode: fingertip cursor on the live feed; holding V freezes + points at the fingertip.
  const trackerRef = useRef<HandTracker | null>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const [handMode, setHandMode] = useState(false);
  const [handStatus, setHandStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [handSeen, setHandSeen] = useState(false);
  const [aimAhead, setAimAhead] = useState(AIM_AHEAD);
  const [minCutoff, setMinCutoff] = useState(MIN_CUTOFF);
  const [beta, setBeta] = useState(BETA);
  const [showHud, setShowHud] = useState(false);
  const hudRef = useRef<HTMLPreElement>(null);
  const rawDotRef = useRef<HTMLDivElement>(null);

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

  // Preload FaceLandmarker so the first "change my nose" doesn't wait on the model download.
  useEffect(() => {
    initFace().catch((e) => console.warn("[face] init failed", e));
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
        setError(permissionMessage("Camera", e));
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
    maskRef.current = null;
    subjectRef.current = null;
    labelRef.current = null;
    sourceRef.current = null;
    pointRef.current = null;
    segPromiseRef.current = null;
    setPoint(null);
    setSelTag(null);
    setAlpha(null);
    setBusy(false);
    setSegInfo((s) => (s.startsWith("model failed") ? s : ""));
  }, []);

  const clearStroke = useCallback(() => {
    const c = strokeRef.current;
    c?.getContext("2d")!.clearRect(0, 0, c.width, c.height);
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
    appliedRef.current = null;
    setFrozen(true);
  }, [clearSelection]);

  const resume = useCallback(() => {
    recognizer.current.reset();
    voiceModeRef.current = null;
    clearStroke();
    historyRef.current.clear();
    setDepth(0);
    clearSelection();
    appliedRef.current = null;
    setFrozen(false);
  }, [clearSelection, clearStroke]);

  const undo = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const frame = historyRef.current.undo();
    if (frame) canvas.getContext("2d")!.putImageData(frame, 0, 0);
    setDepth(historyRef.current.depth);
  }, []);

  const drawStroke = useCallback((points: Point[]) => {
    const c = strokeRef.current;
    if (!c || !points.length) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    const closed = isClosed(points);
    ctx.strokeStyle = closed ? "#ffd400" : "#ff9f1c";
    ctx.lineWidth = Math.max(2, c.width / 400);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (closed) ctx.closePath();
    ctx.stroke();
  }, []);

  /**
   * A finished click or stroke -> selection. Segments on the ORIGINAL frozen frame so earlier edits
   * never confuse the model: click = segment at the point, closed stroke = lasso, open = scribble.
   * Combined with the current selection per `mode`; finger gestures get the hand cut out. The
   * promise is kept in segPromiseRef so commands can wait for the mask.
   */
  const selectGesture = useCallback(
    (g: Extract<Gesture, { kind: "click" | "stroke" }>, mode: CombineMode): Promise<void> => {
      const original = historyRef.current.original;
      if (!original) return Promise.resolve();
      const { width: w, height: h } = original;
      const id = ++reqId.current;
      const prev = mode === "replace" ? null : maskRef.current;
      const prevLabel = labelRef.current ?? "selection";
      setBusy(true);
      if (g.kind === "click" && mode === "replace") {
        pointRef.current = g.p;
        setPoint(g.p);
        alphaRef.current = null;
        maskRef.current = null;
        setAlpha(null);
        setSelTag(null);
      }
      const job = (async () => {
        const seg =
          g.kind === "click" ? { kind: "pointed" as const, ...(await segmentPointed(original, g.p)) } : await selectStroke(original, g.points);
        if (id !== reqId.current) return; // a newer gesture or a resume superseded this one
        let mask = combine(prev, seg.mask, mode);
        const notes = [`${seg.kind} ${seg.source} ${Math.round(seg.ms)}ms${seg.note ? ` (${seg.note})` : ""}`];
        if (mode !== "replace") notes.push(mode);
        if (g.source === "finger") {
          const hull = await handHullInFrame(original);
          if (id !== reqId.current) return;
          if (hull) {
            mask = removeHand(mask, hull, w, h);
            notes.push("hand removed");
          }
        }
        clearStroke();
        setBusy(false);
        if (coverage(mask) === 0) {
          setSegInfo(`${notes.join(" · ")} · selection is empty`);
          if (mode === "subtract") clearSelection();
          return;
        }
        const label = mode === "replace" ? seg.kind : `${prevLabel} ${mode === "add" ? "+" : "−"} ${seg.kind}`;
        const usedPoint = g.kind === "click" && mode === "replace";
        if (usedPoint) {
          pointRef.current = g.p;
          setPoint(g.p);
        }
        const sel = { mask, subject: mask, alpha: feather(mask, w, h, 3), note: notes.join(" · "), label, source: "pointed" as const, usedPoint };
        applySelection(sel, original, g.kind === "click" ? (g.source === "finger" ? "pinch" : "click") : seg.kind);
      })();
      segPromiseRef.current = job;
      return job;
    },
    // applySelection (declared below) and clearSelection have no deps, so they never change.
    [clearStroke],
  );
  const selectGestureRef = useRef(selectGesture);
  selectGestureRef.current = selectGesture;

  /** Point selection at p (hand-mode push-to-talk re-points at the fingertip). */
  const runSegment = useCallback(
    (p: Point, source: "finger" | "mouse" = "finger") =>
      selectGestureRef.current({ kind: "click", p, source, ms: 0 }, "replace"),
    [],
  );

  const recognizer = useRef(
    new StrokeRecognizer((g) => {
      if (g.kind === "progress") drawStrokeRef.current(g.points);
      else if (g.kind === "cancel") clearStrokeRef.current();
      else {
        const mode = voiceModeRef.current ?? (g.source === "mouse" ? modeRef.current : "replace");
        voiceModeRef.current = null;
        void selectGestureRef.current(g, mode);
      }
    }),
  );
  const drawStrokeRef = useRef(drawStroke);
  drawStrokeRef.current = drawStroke;
  const clearStrokeRef = useRef(clearStroke);
  clearStrokeRef.current = clearStroke;

  // The mouse on the frozen canvas emits the same PointerSamples as the hand.
  const onCanvasMouse = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.type === "mousedown") modeRef.current = e.shiftKey ? "add" : e.altKey ? "subtract" : "replace";
    if (frozen) emitMouse(e, e.currentTarget, size.w, size.h, true, mirror);
  };
  const onCanvasLeave = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (frozen) emitMouse(e, e.currentTarget, size.w, size.h, false, mirror);
  };

  // Selection reads samples only: on the frozen frame they feed the gesture recognizer, which
  // selects on release (click/pinch = point, loop = lasso, line = scribble).
  // The finger also drives the on-screen cursor, moved on the DOM to avoid re-renders.
  usePointerSamples((s) => {
    if (s.source === "finger") {
      setHandSeen(s.handPresent);
      const cursor = cursorRef.current;
      if (cursor) {
        cursor.style.display = s.handPresent ? "block" : "none";
        cursor.classList.toggle("pressed", s.pressed);
        cursor.style.left = `${(s.x / size.w) * 100}%`;
        cursor.style.top = `${(s.y / size.h) * 100}%`;
      }
    }
    if (historyRef.current.current) recognizer.current.feed(s);
  });

  const pushFrame = useCallback((out: ImageData) => {
    canvasRef.current?.getContext("2d")!.putImageData(out, 0, 0);
    historyRef.current.push(out);
    setDepth(historyRef.current.depth);
  }, []);

  /** Remember an applied edit with the selection it used (see appliedRef). */
  const recordEdit = useCallback(
    (e: { op: "recolor" | "blur" | "remove" | "replace"; color?: string; intensity?: number; prompt?: string; what?: string }, before: ImageData) => {
      const mask = maskRef.current;
      const after = historyRef.current.current;
      if (!mask || !after) return;
      const sel = { mask, subject: subjectRef.current ?? mask, label: labelRef.current ?? "selection" };
      appliedRef.current = { ...e, before, after, sel };
    },
    [],
  );

  const recolorWith = useCallback(
    (c: string): boolean => {
      const cur = historyRef.current.current;
      const a = alphaRef.current;
      if (!canvasRef.current || !cur || !a) return false;
      pushFrame(recolor(cur, a, c));
      recordEdit({ op: "recolor", color: c }, cur);
      return true;
    },
    [pushFrame, recordEdit],
  );

  const blurWith = useCallback(
    (base: ImageData, a: Float32Array, intensity: number) => {
      const out = blurMasked(base, a, intensity);
      pushFrame(out);
      recordEdit({ op: "blur", intensity }, base);
      const prev = lastBlurRef.current;
      if (prev && prev.base === base && prev.alpha === a) prev.results.push(out);
      else lastBlurRef.current = { base, alpha: a, results: [out] };
    },
    [pushFrame, recordEdit],
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    // Long enough to read a provider's status + error body.
    setTimeout(() => setToast((m) => (m === msg ? null : m)), 12000);
  }, []);

  /**
   * remove/replace via the image model. The model sees the clean ORIGINAL frame; its output is
   * composited into the current frame only inside the mask, so earlier edits elsewhere survive
   * and everything outside the mask stays pixel-identical. Remove falls back to a heavy blur.
   */
  const modelOp = useCallback(
    async (op: "remove" | "replace", prompt: string, what: string, timeline?: Timeline): Promise<string> => {
      const original = historyRef.current.original;
      const base = historyRef.current.current;
      const a = alphaRef.current;
      if (!original || !base || !a) return "point at an object first";
      if (modelBusyRef.current) return "another edit is still running";
      modelBusyRef.current = true;
      // Fire the request first (modelEdit encodes and sends synchronously); UI feedback after.
      const request = op === "remove" ? removeObject(original, a, timeline) : replaceObject(original, a, prompt, timeline);

      setToast(null);
      setVoiceStatus(op === "remove" ? `Removing ${what}...` : `Replacing with: ${prompt}`);
      const pending = pendingRef.current;
      if (pending) {
        pending.width = base.width;
        pending.height = base.height;
        pending.getContext("2d")!.putImageData(dimInside(base, a), 0, 0);
      }
      setPendingOn(true);
      setThinkingMask(maskDataUrl(a, original.width, original.height));

      try {
        const edited = await request;
        // Undo/resume/another edit while we waited would make this result stale.
        if (historyRef.current.current !== base) return "frame changed during the edit; result discarded";
        // Final composite goes under the dimmed layer, which then fades out: a crossfade.
        pushFrame(composite(base, edited, a));
        recordEdit({ op, prompt, what }, base);
        timeline?.mark("composited");
        edited.close();
        return op === "remove" ? "removed" : "replaced";
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[edit] ${op} failed`, e);
        if (op === "remove" && historyRef.current.current === base) {
          blurWith(base, a, 1);
          showToast(`Remove failed (${msg}). Applied a heavy blur instead.`);
          return "model failed, heavy blur instead";
        }
        showToast(`${op === "remove" ? "Remove" : "Replace"} failed: ${msg}`);
        return `${op} failed: ${msg}`;
      } finally {
        modelBusyRef.current = false;
        setThinkingMask(null);
        setPendingOn(false); // CSS transition fades the dimmed layer out over CROSSFADE_MS
      }
    },
    [pushFrame, blurWith, showToast, recordEdit],
  );

  const applyRecolor = useCallback(() => recolorWith(color), [recolorWith, color]);

  /**
   * The one place a resolved selection reaches the screen: mask, overlay, label chip and marker
   * all describe `sel`. The marker/point survive only if the mask was segmented at that point.
   */
  const applySelection = useCallback((sel: Selection, original: ImageData, how: string) => {
    maskRef.current = sel.mask;
    subjectRef.current = sel.subject;
    labelRef.current = sel.label;
    sourceRef.current = `${how}${sel.source === "selection" ? " (on current selection)" : ""}`;
    alphaRef.current = sel.alpha;
    setAlpha(sel.alpha);
    setSegInfo(`select · ${sel.note}`);
    const { width: w, height: h } = original;
    const b = bbox(sel.mask, w, h);
    setSelTag(sel.label !== "pointed" && b ? { text: sel.label, x: (b.x + b.w / 2) / w, y: b.y / h } : null);
    if (!sel.usedPoint) {
      pointRef.current = null;
      segPromiseRef.current = null;
      setPoint(null);
    }
  }, []);

  // Executes a parsed command and returns a short status for the voice line.
  const dispatch = useCallback(
    async (cmd: Command, isRetry = false, timeline?: Timeline): Promise<string> => {
      const needSelection = () =>
        !historyRef.current.current
          ? "freeze the frame first (Space)"
          : !alphaRef.current
            ? "point at (click) an object first"
            : null;
      // An edit on a named target with no select is looked up by name too, never applied to
      // whatever happens to be selected ("background" means the inverse of the selection).
      const parsed =
        // "only the handle" sometimes arrives as source pointed + a name: it's a named part.
        cmd.select?.refine === "only" && cmd.select.source === "pointed" && cmd.select.name
          ? { ...cmd.select, source: "named" as const }
          : cmd.select;
      const select: Select | null =
        parsed ??
        (cmd.target === "named" && cmd.target_name && ["recolor", "blur", "remove", "replace"].includes(cmd.op)
          ? cmd.target_name.trim().toLowerCase() === "background"
            ? { source: "background", name: null, face_part: null, region: null, refine: null, invert: false }
            : { source: "named", name: cmd.target_name, face_part: null, region: null, refine: null, invert: false }
          : null);
      if (select?.refine === "clear") {
        clearSelection();
        return "selection cleared";
      }
      if (select?.refine === "add" || select?.refine === "subtract") {
        voiceModeRef.current = select.refine;
        return `next click or stroke will ${select.refine === "add" ? "add to" : "cut from"} the selection`;
      }
      const original = historyRef.current.original;
      const current = (): CurrentSelection =>
        maskRef.current
          ? { mask: maskRef.current, subject: subjectRef.current ?? maskRef.current, label: labelRef.current ?? "selection" }
          : null;

      // "only the top half" right after an edit (and no new op): undo that edit, narrow the
      // selection it used, and redo the same edit with the same parameters on the narrower one.
      const last = appliedRef.current;
      if (cmd.op === "select" && select?.refine === "only" && original && last && historyRef.current.current === last.after) {
        const id = ++reqId.current;
        setBusy(true);
        // Narrow the edit's own mask: a stored point would re-segment, a name is looked up afresh.
        const narrowPoint = select.source === "pointed" ? null : pointRef.current;
        const sel = await resolveSelection({ ...select, refine: null }, original, narrowPoint, last.sel);
        if (id !== reqId.current) return "selection superseded by a new point";
        setBusy(false);
        if ("error" in sel) return sel.error;
        while (historyRef.current.current !== last.before && historyRef.current.canUndo) historyRef.current.undo();
        if (historyRef.current.current !== last.before) return "couldn't undo the last edit to narrow it";
        canvasRef.current?.getContext("2d")!.putImageData(last.before, 0, 0);
        setDepth(historyRef.current.depth);
        applySelection(sel, original, "scope");
        timeline?.mark("selection resolved");
        let result: string;
        if (last.op === "recolor") result = recolorWith(last.color!) ? `recolored ${last.color}` : "recolor failed";
        else if (last.op === "blur") {
          blurWith(last.before, alphaRef.current!, last.intensity ?? DEFAULT_BLUR);
          result = `blurred ${Math.round((last.intensity ?? DEFAULT_BLUR) * 100)}%`;
        } else result = await modelOp(last.op, last.prompt ?? "", last.what ?? "that", timeline);
        return `redid the last edit on ${sel.label}: ${result}`;
      }

      // A voice `select` replaces the current selection before the op runs on it. On failure
      // (e.g. a name that isn't found) nothing changes: no edit, and the old selection stays.
      if (select && cmd.op !== "undo" && cmd.op !== "retry") {
        if (!original) return "freeze the frame first (Space)";
        const id = ++reqId.current;
        setBusy(true);
        const sel = await resolveSelection(select, original, pointRef.current, current());
        if (id !== reqId.current) return "selection superseded by a new point";
        setBusy(false);
        if ("error" in sel) return sel.error;
        applySelection(sel, original, select.source);
        timeline?.mark("selection resolved");
        if (cmd.op === "select") {
          if (!isRetry) lastEditRef.current = cmd;
          return `selected ${sel.label}${sel.note ? ` (${sel.note})` : ""}`;
        }
      }
      switch (cmd.op) {
        case "select":
          return "select: nothing to change";
        case "undo":
          if (!historyRef.current.canUndo) return "nothing to undo";
          undo();
          return "undone";
        case "retry": {
          const prev = lastEditRef.current;
          if (!prev) return "nothing to retry";
          if (isRetry) return "retry loop ignored";
          return `retry: ${await dispatch(prev, true, timeline)}`;
        }
        case "recolor": {
          if (!cmd.color || !CSS.supports("color", cmd.color)) return `recolor: bad color "${cmd.color}"`;
          const missing = needSelection();
          if (missing) return missing;
          if (!recolorWith(cmd.color)) return "recolor failed";
          if (/^#[0-9a-f]{6}$/i.test(cmd.color)) setColor(cmd.color);
          if (!isRetry) lastEditRef.current = cmd;
          return `recolored ${cmd.color}`;
        }
        case "blur": {
          const missing = needSelection();
          if (missing) return missing;
          const intensity = cmd.intensity ?? DEFAULT_BLUR;
          blurWith(historyRef.current.current!, alphaRef.current!, intensity);
          if (!isRetry) lastEditRef.current = cmd;
          return `blurred ${Math.round(intensity * 100)}%`;
        }
        case "adjust": {
          const blur = lastBlurRef.current;
          const cur = historyRef.current.current;
          // "less"/"more" right after a blur: redo it from the pre-blur frame at the new strength.
          if (cmd.intensity !== null && blur && cur && blur.results.includes(cur)) {
            blurWith(blur.base, blur.alpha, cmd.intensity);
            if (!isRetry) lastEditRef.current = cmd;
            return `blur → ${Math.round(Math.min(1, Math.max(0, cmd.intensity)) * 100)}%`;
          }
          console.log("[voice] adjust not implemented for this edit yet:", cmd);
          return "adjust only works right after a blur for now";
        }
        case "remove":
        case "replace": {
          const missing = needSelection();
          if (missing) return missing;
          const prompt = cmd.op === "replace" ? cmd.prompt?.trim() : "";
          if (cmd.op === "replace" && !prompt) return "replace: no prompt from the parser";
          const what = cmd.target_name ?? "that";
          const result = await modelOp(cmd.op, prompt ?? "", what, timeline);
          if (!isRetry) lastEditRef.current = cmd;
          return result;
        }
      }
    },
    [undo, recolorWith, blurWith, modelOp, clearSelection, applySelection],
  );
  // The parse is async, so call through a ref to get the dispatch with current state.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // Dev log after every command: what the overlay shows and edits will use.
  const logSelection = useCallback((what: string) => {
    const mask = maskRef.current;
    const original = historyRef.current.original;
    const b = mask && original ? bbox(mask, original.width, original.height) : null;
    console.log(
      `[sel] ${JSON.stringify(what)}: source=${sourceRef.current ?? "none"} label=${labelRef.current ?? "none"} ` +
        `bbox=${b ? `${b.x},${b.y} ${b.w}x${b.h}` : "none"} point=${pointRef.current ? `${Math.round(pointRef.current.x)},${Math.round(pointRef.current.y)}` : "none"}`,
    );
  }, []);

  // heard: which recognizer answered and how fast, e.g. "muse 640ms" (empty for typed commands).
  const runCommand = useCallback(async (transcript: string, timeline: Timeline, heard = "") => {
    const h = heard ? `[${heard}] ` : "";
    if (!transcript) {
      setVoiceStatus(`${h}didn't catch that`);
      return;
    }
    timeline.setLabel(JSON.stringify(transcript));
    setVoiceStatus(`${h}"${transcript}" · parsing...`);
    try {
      // Frozen: Gemini also gets the original frame and the pointed position (normalized).
      const original = historyRef.current.original;
      const p = pointRef.current;
      const frame = original ? frameJpeg(original, 512, 0.7) : undefined;
      const point = original && p ? { x: p.x / original.width, y: p.y / original.height } : null;
      const { command, ms, provider, fallback, image } = await parseCommand(transcript, lastEditRef.current, frame, point);
      const via = `${provider}${image ? " +image" : frame ? " text-only" : ""}${fallback ? " (fallback)" : ""}`;
      if (fallback) console.warn("[voice] gemini fallback:", fallback);
      if (frame) console.log(`[voice] parse ${ms}ms, ${image ? "with image" : "image not used"} (${Math.round(frame.length / 1024)}kB b64)`);
      timeline.mark("command parsed");
      console.log("[voice]", transcript, command);
      // Only wait if a hand-mode point is genuinely still segmenting; otherwise dispatch now.
      if (!alphaRef.current && segPromiseRef.current) {
        await segPromiseRef.current;
        timeline.mark("mask ready");
      }
      const detail = [command.op, command.target_name, command.color].filter(Boolean).join(" ");
      setVoiceStatus(`${h}"${transcript}" → ${detail} · working...`);
      const result = await dispatchRef.current(command, false, timeline);
      logSelection(transcript);
      if (command.op !== "remove" && command.op !== "replace") timeline.mark("applied");
      setVoiceStatus(`${h}"${transcript}" → ${detail} · ${result} · ${via} ${ms}ms`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setVoiceStatus(`${h}"${transcript}" · error: ${msg}`);
      showToast(`Command failed: ${msg}`);
    } finally {
      timeline.print();
    }
  }, [showToast]);

  const startTalking = useCallback(() => {
    if (!voiceSupported(voiceEngine) || pttRef.current?.listening) return;
    pttRef.current ??= createPushToTalk(voiceEngine, (t) => setVoiceStatus(`listening... "${t}"`));
    try {
      pttRef.current.start();
      setListening(true);
      setVoiceStatus("listening...");
    } catch (e) {
      setVoiceStatus(e instanceof Error ? e.message : String(e));
    }
  }, [voiceEngine]);

  // Switching the voice source drops the old recognizer (and its open mic).
  useEffect(() => {
    pttRef.current?.cancel();
    pttRef.current = null;
    setListening(false);
  }, [voiceEngine]);

  const stopTalking = useCallback(async () => {
    const ptt = pttRef.current;
    if (!ptt?.listening) return;
    setListening(false);
    const timeline = new Timeline("voice", "speech end");
    const t0 = performance.now();
    try {
      let transcript: string;
      let heard: string;
      if (ptt instanceof MusePushToTalk) {
        const r = await ptt.stopDetailed();
        transcript = r.text;
        heard = `${r.path === "muse" ? "muse" : "web speech (muse failed)"} ${r.ms}ms`;
        if (r.error) {
          console.warn("[voice] muse failed, used web speech:", r.error);
          if (r.error.kind === "mic") showToast(permissionMessage("Microphone", r.error));
          if (r.path === "muse") throw r.error; // no Web Speech to fall back to
        }
      } else {
        transcript = await ptt.stop();
        heard = `web speech ${Math.round(performance.now() - t0)}ms`;
      }
      timeline.mark("transcript");
      void runCommand(transcript, timeline, heard);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setVoiceStatus(msg);
      if (/not-allowed|denied|permission|microphone/i.test(msg)) showToast(permissionMessage("Microphone", e));
      else showToast(`Voice failed: ${msg}`);
    }
  }, [runCommand, showToast]);

  // Push-to-talk press. In hand mode it also freezes (if live) and points at the fingertip
  // as of this instant. If already frozen, the frame is kept so refinements chain on it; a
  // visible hand re-points, otherwise the current selection stays.
  const pttDown = useCallback(() => {
    if (handMode) {
      if (!historyRef.current.current) freeze();
      const s = pointer.latest("finger");
      const aim = s?.handPresent ? { x: s.x, y: s.y } : null;
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

  // Live recolor on the unfrozen view: recolors whatever the finger (or the hovering mouse) points
  // at, in the current color. Runs only while live; freezing or resuming tears it down.
  const liveRef = useRef<LiveRecolor | null>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  const [liveOn, setLiveOn] = useState(false);
  const [liveInfo, setLiveInfo] = useState("");
  const colorRef = useRef(color);
  colorRef.current = color;
  useEffect(() => {
    if (!liveOn || frozen) return;
    const live = (liveRef.current ??= new LiveRecolor());
    const present = (src: "finger" | "mouse") => {
      const s = pointer.latest(src);
      return s?.handPresent ? s : null;
    };
    const getPoint = () => {
      const f = present("finger");
      const m = present("mouse");
      const s = f && m ? (f.t >= m.t ? f : m) : (f ?? m);
      return s ? { x: s.x, y: s.y } : null;
    };
    live.start(videoRef.current!, getPoint, colorRef.current, liveCanvasRef.current!);
    // Both fps side by side, so a live-recolor cost on hand tracking shows up immediately.
    const id = window.setInterval(() => {
      const st = live.stats;
      const hand = trackerRef.current?.stats();
      setLiveInfo(`live ${st.fps} fps · render ${st.renderMs}ms · seg ${st.segMs}ms${hand ? ` · hand ${hand.fps} fps` : ""}`);
    }, 500);
    return () => {
      clearInterval(id);
      live.stop();
      setLiveInfo("");
    };
  }, [liveOn, frozen]);
  useEffect(() => liveRef.current?.setColor(color), [color]);

  // Fingertip tracking runs only while hand mode is on; it feeds the pointer samples above.
  useEffect(() => {
    if (!handMode) return;
    const video = videoRef.current!;
    const cursor = cursorRef.current;
    setHandStatus("loading");
    const tracker = new HandTracker();
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

  useEffect(() => {
    handTuning.aimAhead = aimAhead;
    handTuning.minCutoff = minCutoff;
    handTuning.beta = beta;
  }, [aimAhead, minCutoff, beta]);

  // Debug HUD: refreshed a few times a second straight into the DOM.
  useEffect(() => {
    if (!showHud || !handMode) return;
    const id = window.setInterval(() => {
      const st = trackerRef.current?.stats();
      const hud = hudRef.current;
      const dot = rawDotRef.current;
      if (!st || !hud) return;
      const pt = (p: { x: number; y: number } | null) => (p ? `${Math.round(p.x)},${Math.round(p.y)}` : "-");
      hud.textContent = [
        `tracking ${st.fps} fps (${st.delegate ?? "?"})`,
        `confidence ${st.confidence.toFixed(2)}`,
        `pinch ratio ${st.pinchRatio?.toFixed(2) ?? "-"}${st.pressed ? " PRESSED" : ""}`,
        `tip raw ${pt(st.rawTip)} · filtered ${pt(st.filteredTip)}`,
        `jitter 1s px: raw ${st.jitterRaw.toFixed(2)} · old EMA ${st.jitterEma.toFixed(2)} · One Euro ${st.jitterFiltered.toFixed(2)}`,
      ].join("\n");
      if (dot) {
        dot.style.display = st.rawTip ? "block" : "none";
        if (st.rawTip) {
          dot.style.left = `${(st.rawTip.x / size.w) * 100}%`;
          dot.style.top = `${(st.rawTip.y / size.h) * 100}%`;
        }
      }
    }, 250);
    return () => clearInterval(id);
  }, [showHud, handMode, size]);

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
      } else if (e.key === "Escape") clearSelection();
      else if (e.key.toLowerCase() === "u") undo();
      else if (e.key.toLowerCase() === "r") applyRecolor();
      else if (e.key.toLowerCase() === "f") {
        const p = document.fullscreenElement ? document.exitFullscreen() : wrapRef.current?.requestFullscreen();
        p?.catch((err) => showToast(`Fullscreen failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frozen, freeze, resume, undo, applyRecolor, clearSelection, showToast]);

  // Last-resort net: any async failure nobody caught becomes a toast instead of a silent console error.
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      showToast(`Something failed: ${r instanceof Error ? r.message : String(r)}`);
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, [showToast]);

  // Cycling hint: what to point at and say.
  const [hint, setHint] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setHint((i) => (i + 1) % HINTS.length), 3500);
    return () => clearInterval(id);
  }, []);

  const readout = !frozen
    ? handMode
      ? "point with your index finger and hold V"
      : "press Space to freeze the frame"
    : busy
      ? "segmenting..."
      : point
        ? `point (${point.x}, ${point.y}) · ${segInfo}`
        : selTag
          ? `selected: ${selTag.text} · ${segInfo}`
          : "click an object";

  return (
    <div className="stage-wrap" ref={wrapRef}>
      <div className="stage" style={{ aspectRatio: `${size.w} / ${size.h}`, "--ar": size.w / size.h } as React.CSSProperties}>
        {/* Everything in frame coordinates lives here, so one transform keeps it all aligned. */}
        <div className="layer" style={{ transform: mirror ? "scaleX(-1)" : undefined }}>
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
          {/* Live recolor output; the hovering mouse is its pointer (same samples as on the frozen frame). */}
          <canvas
            ref={liveCanvasRef}
            className="layer"
            style={{ display: liveOn && !frozen ? "block" : "none" }}
            onMouseMove={(e) => emitMouse(e, e.currentTarget, size.w, size.h, true, mirror)}
            onMouseLeave={(e) => emitMouse(e, e.currentTarget, size.w, size.h, false, mirror)}
          />
          <canvas
            ref={canvasRef}
            className="layer"
            style={{ visibility: frozen ? "visible" : "hidden", cursor: frozen ? "crosshair" : "default" }}
            onMouseDown={onCanvasMouse}
            onMouseUp={onCanvasMouse}
            onMouseMove={onCanvasMouse}
            onMouseLeave={onCanvasLeave}
          />
          <canvas
            ref={pendingRef}
            className={pendingOn ? "layer pending on" : "layer pending"}
            style={{ "--crossfade": `${CROSSFADE_MS}ms` } as React.CSSProperties}
          />
          <canvas ref={overlayRef} className="layer" style={{ pointerEvents: "none" }} />
          <canvas ref={strokeRef} width={size.w} height={size.h} className="layer" style={{ pointerEvents: "none" }} />
          {frozen && point && (
            <div
              className="marker"
              style={{ left: `${(point.x / size.w) * 100}%`, top: `${(point.y / size.h) * 100}%` }}
            />
          )}
          {thinkingMask && (
            <div
              className="thinking"
              style={{ maskImage: `url(${thinkingMask})`, WebkitMaskImage: `url(${thinkingMask})` }}
            />
          )}
          <div ref={cursorRef} className="hand-cursor" />
          {showHud && handMode && <div ref={rawDotRef} className="hand-raw" />}
        </div>
        {/* Outside the mirrored layer so the text reads normally; x is mirrored by hand. */}
        {frozen && selTag && alpha && (
          <div
            className="sel-label"
            style={{ left: `${(mirror ? 1 - selTag.x : selTag.x) * 100}%`, top: `max(${selTag.y * 100}%, 30px)` }}
          >
            {selTag.text}
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="badge">
          {frozen ? "FROZEN" : "LIVE"}
          {busy ? " · …" : ""}
        </div>
        {toast && <div className="error">{toast}</div>}
        <div className="hint">
          point, then say: <b>{HINTS[hint]}</b>
        </div>
        {showHud && handMode && (
          <div className="hand-hud">
            <pre ref={hudRef} />
            <label title="One Euro min cutoff (Hz): lower = steadier at rest, laggier on slow moves">
              min cutoff
              <input
                type="range"
                min={0.05}
                max={5}
                step={0.05}
                value={minCutoff}
                onChange={(e) => setMinCutoff(Number(e.target.value))}
              />
              {minCutoff.toFixed(2)}
            </label>
            <label title="One Euro beta: higher = less lag on fast moves, more jitter while moving">
              beta
              <input
                type="range"
                min={0}
                max={0.2}
                step={0.001}
                value={beta}
                onChange={(e) => setBeta(Number(e.target.value))}
              />
              {beta.toFixed(3)}
            </label>
          </div>
        )}
        <div className="badge badge-right">
          model: {modelState}
          {handMode && ` · hand: ${handStatus === "ready" ? (handSeen ? "tracking" : "no hand") : handStatus}`}
          {liveInfo && ` · ${liveInfo}`}
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
        <button onClick={clearSelection} disabled={!alpha && !point}>
          Clear selection (Esc)
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
        {handMode && (
          <>
            <label className="check" title="How far past the fingertip to point, in finger-segment lengths (not while pinching)">
              Aim ahead
              <input
                type="range"
                min={0}
                max={3}
                step={0.1}
                value={aimAhead}
                onChange={(e) => setAimAhead(Number(e.target.value))}
              />
              {aimAhead.toFixed(1)}
            </label>
            <label className="check">
              <input type="checkbox" checked={showHud} onChange={(e) => setShowHud(e.target.checked)} />
              Hand HUD
            </label>
          </>
        )}
        <label className="check" title="Recolor the pointed object on the live video (finger or mouse hover)">
          <input type="checkbox" checked={liveOn} onChange={(e) => setLiveOn(e.target.checked)} />
          Live recolor
        </label>
        <label className="check">
          <input type="checkbox" checked={showMask} onChange={(e) => setShowMask(e.target.checked)} />
          Show mask
        </label>
        <label className="check">
          <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
          Mirror view
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
          disabled={!voiceSupported(voiceEngine)}
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
              void runCommand(devText.trim(), new Timeline("typed", "text submitted"));
            }}
          >
            <input
              value={devText}
              onChange={(e) => setDevText(e.target.value)}
              placeholder="dev: type a command, e.g. make that red"
            />
          </form>
        )}
        <label className="check" title="Speech recognizer. Muse falls back to Web Speech on any error.">
          Voice
          <select value={voiceEngine} onChange={(e) => setVoiceEngine(e.target.value as VoiceEngine)}>
            <option value="webspeech">Web Speech</option>
            <option value="muse">Muse</option>
          </select>
        </label>
        <span className="voice-status">{voiceStatus}</span>
      </div>
      {/* Fullscreen (F) hides the controls; this thin line keeps the status visible. */}
      <div className="status-line">
        {readout} · {voiceStatus}
      </div>
    </div>
  );
}
