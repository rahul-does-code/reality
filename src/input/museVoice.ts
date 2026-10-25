// Push-to-talk via Meta Muse Voice Transcribe, a drop-in for PushToTalk in ./speech (same start/stop/
// cancel/listening shape). MediaRecorder captures the press; on release the clip is re-encoded to
// 16 kHz mono 16-bit WAV (the only format Muse's file endpoint accepts; webm/opus is a 400) and
// POSTed to /api/transcribe. Web Speech runs alongside as a shadow, so a Muse failure falls back to
// what Web Speech heard without asking the user to repeat, and it also feeds the live partials.
import { PushToTalk, speechSupported } from "./speech";

export type VoiceEngine = "webspeech" | "muse";
/** Which recognizer produced a transcript. */
export type VoicePath = "muse" | "webspeech";

/** What PushToTalk and MusePushToTalk both provide, so Stage can hold either. */
export interface PushToTalkLike {
  readonly listening: boolean;
  start(): void;
  stop(): Promise<string>;
  cancel(): void;
}

export type MuseVoiceErrorKind =
  | "unsupported" // no MediaRecorder / getUserMedia / OfflineAudioContext
  | "mic" // getUserMedia refused or failed
  | "decode" // recorded clip couldn't be decoded to PCM
  | "network" // proxy unreachable
  | "timeout"
  | "rate-limited" // Meta 429
  | "server"; // any other non-2xx from /api/transcribe (message carries Meta's status and error)

export class MuseVoiceError extends Error {
  constructor(
    public kind: MuseVoiceErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "MuseVoiceError";
  }
}

export type VoiceResult = {
  text: string;
  path: VoicePath;
  /** Release -> transcript, as the user feels it. */
  ms: number;
  /** /api/transcribe's own Meta round trip (absent if Muse wasn't reached). */
  serverMs?: number;
  /** Set when Muse failed; `text` is then Web Speech's (or "" if there was no fallback). */
  error?: MuseVoiceError;
};

export type MuseVoiceOptions = {
  /** Run Web Speech alongside and use it if Muse fails. Default: on when Web Speech exists. */
  fallback?: boolean;
  /** Keep the mic stream between presses so the first word isn't clipped. Default true. */
  keepMicOpen?: boolean;
  endpoint?: string;
};

const SAMPLE_RATE = 16_000;
const CLIENT_TIMEOUT_MS = 10_000; // the server gives Meta 8s
const MIN_CLIP_S = 0.15; // shorter than this is a tap, not speech

export const museVoiceSupported = (): boolean =>
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== "undefined" &&
  typeof OfflineAudioContext !== "undefined";

export const voiceSupported = (engine: VoiceEngine): boolean =>
  engine === "muse" ? museVoiceSupported() || speechSupported() : speechSupported();

/** Stage's engine toggle: one constructor call for either recognizer. */
export function createPushToTalk(engine: VoiceEngine, onPartial?: (text: string) => void): PushToTalkLike {
  return engine === "muse" ? new MusePushToTalk(onPartial) : new PushToTalk(onPartial);
}

type Recording = { rec: MediaRecorder; chunks: Blob[]; stopped: Promise<void> };

export class MusePushToTalk implements PushToTalkLike {
  /** Details of the last stop(): path, latency, Muse error if it fell back. */
  lastResult: VoiceResult | null = null;
  private stream: MediaStream | null = null;
  private recording: Promise<Recording> | null = null;
  private shadow: PushToTalk | null = null;
  private readonly fallback: boolean;
  private readonly keepMicOpen: boolean;
  private readonly endpoint: string;

  /** Called with the running transcript while listening (from the Web Speech shadow, if any). */
  constructor(
    private onPartial?: (text: string) => void,
    opts: MuseVoiceOptions = {},
  ) {
    this.fallback = opts.fallback ?? speechSupported();
    this.keepMicOpen = opts.keepMicOpen ?? true;
    this.endpoint = opts.endpoint ?? "/api/transcribe";
  }

  get listening(): boolean {
    return this.recording !== null || this.shadow !== null;
  }

  start(): void {
    if (this.listening) return;
    const muse = museVoiceSupported();
    if (!muse && !(this.fallback && speechSupported())) {
      throw new MuseVoiceError("unsupported", "Muse voice needs MediaRecorder + microphone access (try Chrome).");
    }
    if (this.fallback && speechSupported()) {
      const shadow = new PushToTalk(this.onPartial);
      try {
        shadow.start();
        this.shadow = shadow;
      } catch {
        /* Muse still works without it */
      }
    }
    if (muse) {
      this.recording = this.record();
      this.recording.catch(() => {}); // surfaced in stop()
    }
  }

  /** Stops listening and resolves with the transcript ("" if nothing was heard). Throws MuseVoiceError only if Muse failed and there was no fallback. */
  async stop(): Promise<string> {
    const r = await this.stopDetailed();
    if (r.error && r.path === "muse") throw r.error;
    return r.text;
  }

  /** Like stop(), but never throws: a Muse failure comes back as `error` with the fallback text. */
  async stopDetailed(): Promise<VoiceResult> {
    const t0 = performance.now();
    const recording = this.recording;
    const shadow = this.shadow;
    this.recording = null;
    this.shadow = null;
    const shadowText = shadow ? shadow.stop().catch(() => "") : null;

    let result: VoiceResult;
    try {
      if (!recording) throw new MuseVoiceError("unsupported", "Muse voice isn't supported in this browser");
      const blob = await this.finish(await recording);
      const tWav = performance.now();
      const wav = await toWav(blob);
      const encMs = Math.round(performance.now() - tWav);
      if (!wav) {
        result = { text: "", path: "muse", ms: Math.round(performance.now() - t0) };
      } else {
        const { text, serverMs } = await this.transcribe(wav);
        const ms = Math.round(performance.now() - t0);
        console.log(`[muse voice] ${ms}ms release->text (wav ${encMs}ms, meta ${serverMs}ms, ${Math.round(wav.size / 1024)}kB) "${text}"`);
        result = { text, path: "muse", ms, serverMs };
      }
    } catch (e) {
      const error = e instanceof MuseVoiceError ? e : new MuseVoiceError("server", e instanceof Error ? e.message : String(e));
      const text = shadowText ? await shadowText : "";
      const ms = Math.round(performance.now() - t0);
      const path: VoicePath = shadowText ? "webspeech" : "muse";
      console.warn(`[muse voice] ${error.kind}: ${error.message}${shadowText ? ` -> web speech fallback ${ms}ms "${text}"` : ""}`);
      result = { text, path, ms, error };
    }
    if (!this.keepMicOpen) this.releaseMic();
    this.lastResult = result;
    return result;
  }

  /** Abandons the current press (no transcript) and releases the mic. */
  cancel(): void {
    this.shadow?.cancel();
    this.shadow = null;
    const recording = this.recording;
    this.recording = null;
    void recording?.then(({ rec }) => rec.state !== "inactive" && rec.stop()).catch(() => {});
    this.releaseMic();
  }

  private async record(): Promise<Recording> {
    try {
      this.stream ??= await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      throw new MuseVoiceError("mic", `microphone unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const rec = new MediaRecorder(this.stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
    rec.start();
    return { rec, chunks, stopped };
  }

  private async finish({ rec, chunks, stopped }: Recording): Promise<Blob> {
    if (rec.state !== "inactive") rec.stop(); // flushes the last chunk, then fires onstop
    await stopped;
    return new Blob(chunks, { type: rec.mimeType });
  }

  private async transcribe(wav: Blob): Promise<{ text: string; serverMs?: number }> {
    let r: Response;
    try {
      r = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: wav,
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") throw new MuseVoiceError("timeout", `transcribe timed out after ${CLIENT_TIMEOUT_MS / 1000}s`);
      throw new MuseVoiceError("network", `transcribe proxy unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const json = (await r.json().catch(() => ({}))) as { text?: string; ms?: number; error?: string };
    if (!r.ok || typeof json.text !== "string") {
      const kind: MuseVoiceErrorKind = r.status === 429 ? "rate-limited" : r.status === 504 ? "timeout" : "server";
      throw new MuseVoiceError(kind, json.error ?? `transcribe ${r.status} ${r.statusText}`, r.status);
    }
    return { text: json.text, serverMs: json.ms };
  }

  private releaseMic(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/** MediaRecorder clip -> 16 kHz mono 16-bit PCM WAV, or null if it's too short to be speech. */
async function toWav(blob: Blob): Promise<Blob | null> {
  if (!blob.size) return null;
  let audio: AudioBuffer;
  try {
    // decodeAudioData resamples to the context's rate, so a 16 kHz context does the conversion.
    audio = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(await blob.arrayBuffer());
  } catch (e) {
    throw new MuseVoiceError("decode", `couldn't decode ${blob.type || "recording"}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (audio.duration < MIN_CLIP_S) return null;
  const n = audio.length;
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  out.setUint32(16, 16, true); // fmt chunk size
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, audio.sampleRate, true);
  out.setUint32(28, audio.sampleRate * 2, true); // byte rate
  out.setUint16(32, 2, true); // block align
  out.setUint16(34, 16, true); // bits per sample
  str(36, "data");
  out.setUint32(40, n * 2, true);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const ch of channels) s += ch[i];
    s = Math.max(-1, Math.min(1, s / channels.length));
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([out], { type: "audio/wav" });
}
