import { useCallback, useEffect, useRef, useState } from "react";
import { listCameras, startCamera, stopCamera } from "../input/camera";
import { FrameHistory } from "../commands/history";
import { initSegmenter } from "../vision/segmenter";
import { resolveSelection, segmentPointed } from "../vision/select";
import { frameJpeg } from "../vision/frameJpeg";
import { bbox, feather, type Point } from "../vision/mask";
import { recolor } from "../edit/recolor";
import { blurMasked, DEFAULT_BLUR } from "../edit/blur";
import { composite, dimInside } from "../edit/composite";
import { removeObject } from "../edit/remove";
import { replaceObject } from "../edit/replace";
import { editTimeoutMs, maskDataUrl } from "../edit/modelEdit";
import { Timeline } from "../commands/timeline";

const CROSSFADE_MS = 400;
import { PushToTalk, speechSupported } from "../input/speech";
import { AIM_AHEAD, BETA, HandTracker, MIN_CUTOFF, handTuning } from "../input/handTracker";
import { emitMouse, pointer, usePointerSamples, type PointerSource } from "../input/pointer";
import { parseCommand } from "../commands/geminiParse";
import type { Command, Select } from "../commands/schema";

const SWATCHES = ["#ff3ca0", "#e5322d", "#2f6bff", "#22b55e", "#ffd21f", "#8a3ffc"];

export default function Stage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  // Dimmed/desaturated masked region while a model edit runs; fades out over the result.
  const pendingRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef(new FrameHistory());
  const reqId = useRef(0);
  // Mirrors of state that async flows (voice, hand) read after awaits.
  const alphaRef = useRef<Float32Array | null>(null);
  const maskRef = useRef<Uint8Array | null>(null); // binary selection behind alphaRef, for refines
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
  const pttRef = useRef<PushToTalk | null>(null);
  const lastEditRef = useRef<Command | null>(null); // context for "less"/"again", sent as `previous`
  const [listening, setListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState(
    speechSupported() ? "hold V to talk" : "Voice commands need the Web Speech API (Chrome/Edge). Use the text box instead.",
  );
  const [devText, setDevText] = useState("");
  // Model edit in flight: the mask (as a data URL) the shimmer is clipped to.
  const [thinkingMask, setThinkingMask] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
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
  // Last `pressed` per source, to act on the press edge only.
  const pressedRef = useRef<Record<PointerSource, boolean>>({ finger: false, mouse: false });

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
    maskRef.current = null;
    pointRef.current = null;
    segPromiseRef.current = null;
    setPoint(null);
    setSelTag(null);
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
    pointRef.current = p;
    alphaRef.current = null;
    maskRef.current = null;
    setAlpha(null);
    setSelTag(null);
    const job = segmentPointed(original, p).then((res) => {
      if (id !== reqId.current) return; // a newer click or a resume superseded this one
      const a = feather(res.mask, original.width, original.height, 3);
      maskRef.current = res.mask;
      alphaRef.current = a;
      setAlpha(a);
      setSegInfo(`${res.source} · ${Math.round(res.ms)}ms${res.note ? ` · ${res.note}` : ""}`);
      setBusy(false);
    });
    segPromiseRef.current = job;
    return job;
  }, []);

  // The mouse on the frozen canvas emits the same PointerSamples as the hand.
  const onCanvasMouse = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (frozen) emitMouse(e, e.currentTarget, size.w, size.h, true, mirror);
  };
  const onCanvasLeave = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (frozen) emitMouse(e, e.currentTarget, size.w, size.h, false, mirror);
  };

  // Selection reads samples only: a press (click or pinch) on the frozen frame points there.
  // The finger also drives the on-screen cursor, moved on the DOM to avoid re-renders.
  usePointerSamples((s) => {
    const wasPressed = pressedRef.current[s.source];
    pressedRef.current[s.source] = s.pressed;
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
    if (s.pressed && !wasPressed && historyRef.current.current) {
      const p = { x: s.x, y: s.y };
      setPoint(p);
      void runSegment(p);
    }
  });

  const pushFrame = useCallback((out: ImageData) => {
    canvasRef.current?.getContext("2d")!.putImageData(out, 0, 0);
    historyRef.current.push(out);
    setDepth(historyRef.current.depth);
  }, []);

  const recolorWith = useCallback(
    (c: string): boolean => {
      const cur = historyRef.current.current;
      const a = alphaRef.current;
      if (!canvasRef.current || !cur || !a) return false;
      pushFrame(recolor(cur, a, c));
      return true;
    },
    [pushFrame],
  );

  const blurWith = useCallback(
    (base: ImageData, a: Float32Array, intensity: number) => {
      const out = blurMasked(base, a, intensity);
      pushFrame(out);
      const prev = lastBlurRef.current;
      if (prev && prev.base === base && prev.alpha === a) prev.results.push(out);
      else lastBlurRef.current = { base, alpha: a, results: [out] };
    },
    [pushFrame],
  );

  const showEditError = useCallback((msg: string) => {
    setEditError(msg);
    // Long enough to read a provider's status + error body.
    setTimeout(() => setEditError((m) => (m === msg ? null : m)), 12000);
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

      setEditError(null);
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
        timeline?.mark("composited");
        edited.close();
        return op === "remove" ? "removed" : "replaced";
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[edit] ${op} failed`, e);
        if (op === "remove" && historyRef.current.current === base) {
          blurWith(base, a, 1);
          showEditError(`Remove failed (${msg}). Applied a heavy blur instead.`);
          return "model failed, heavy blur instead";
        }
        showEditError(`${op === "remove" ? "Remove" : "Replace"} failed: ${msg}`);
        return `${op} failed: ${msg}`;
      } finally {
        modelBusyRef.current = false;
        setThinkingMask(null);
        setPendingOn(false); // CSS transition fades the dimmed layer out over CROSSFADE_MS
      }
    },
    [pushFrame, blurWith, showEditError],
  );

  const applyRecolor = useCallback(() => recolorWith(color), [recolorWith, color]);

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
      // whatever happens to be selected.
      const select: Select | null =
        cmd.select ??
        (cmd.target === "named" && cmd.target_name && ["recolor", "blur", "remove", "replace"].includes(cmd.op)
          ? { source: "named", name: cmd.target_name, face_part: null, region: null, refine: null }
          : null);
      // A voice `select` replaces the current selection before the op runs on it. On failure
      // (e.g. a name that isn't found) nothing changes: no edit, and the old selection stays.
      if (select && cmd.op !== "undo" && cmd.op !== "retry") {
        const original = historyRef.current.original;
        if (!original) return "freeze the frame first (Space)";
        const id = ++reqId.current;
        setBusy(true);
        const sel = await resolveSelection(select, original, pointRef.current, maskRef.current);
        if (id !== reqId.current) return "selection superseded by a new point";
        setBusy(false);
        if ("error" in sel) return sel.error;
        maskRef.current = sel.mask;
        alphaRef.current = sel.alpha;
        setAlpha(sel.alpha);
        setSegInfo(`select · ${sel.note}`);
        const { width: w, height: h } = original;
        const b = bbox(sel.mask, w, h);
        const at = b ? { x: (b.x + b.w / 2) / w, y: b.y / h } : null;
        if (sel.label === "selection") setSelTag((t) => (t && at ? { ...t, ...at } : t));
        else setSelTag(sel.label !== "pointed" && at ? { text: sel.label, ...at } : null);
        if (select.source === "named") {
          // The mask now comes from the name, so the old point no longer describes the selection.
          pointRef.current = null;
          segPromiseRef.current = null;
          setPoint(null);
        }
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
    [undo, recolorWith, blurWith, modelOp],
  );
  // The parse is async, so call through a ref to get the dispatch with current state.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const runCommand = useCallback(async (transcript: string, timeline: Timeline) => {
    if (!transcript) {
      setVoiceStatus("didn't catch that");
      return;
    }
    timeline.setLabel(JSON.stringify(transcript));
    setVoiceStatus(`"${transcript}" · parsing...`);
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
      setVoiceStatus(`"${transcript}" → ${detail} · working...`);
      const result = await dispatchRef.current(command, false, timeline);
      if (command.op !== "remove" && command.op !== "replace") timeline.mark("applied");
      setVoiceStatus(`"${transcript}" → ${detail} · ${result} · ${via} ${ms}ms`);
    } catch (e) {
      setVoiceStatus(`"${transcript}" · error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      timeline.print();
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
    const timeline = new Timeline("voice", "speech end");
    try {
      const transcript = await ptt.stop();
      timeline.mark("transcript");
      void runCommand(transcript, timeline);
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
        : selTag
          ? `selected: ${selTag.text} · ${segInfo}`
          : "click an object";

  return (
    <div className="stage-wrap">
      <div className="stage" style={{ aspectRatio: `${size.w} / ${size.h}` }}>
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
        {error && <div className="error">Camera error: {error}</div>}
        <div className="badge">
          {frozen ? "FROZEN" : "LIVE"}
          {busy ? " · …" : ""}
        </div>
        {editError && <div className="error">{editError}</div>}
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
        <span className="voice-status">{voiceStatus}</span>
      </div>
    </div>
  );
}
