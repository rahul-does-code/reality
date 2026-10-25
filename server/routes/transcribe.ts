// POST /api/transcribe: raw audio body (Content-Type audio/wav) -> Meta Muse Voice Transcribe -> { text, ms }.
// Docs (dev.meta.ai/docs/api-reference/voice/transcribe + /schemas): multipart/form-data with a JSON
// `request` part and an `audio` part; WAV only, mono 16-bit PCM at 16 or 24 kHz (anything else is a
// 400 "The 'audio' part must be a mono 16-bit PCM WAV at 16 or 24 kHz"), <=10 min, <=32 MB body.
// MediaRecorder's webm/opus is rejected, so src/input/museVoice.ts re-encodes to 16 kHz WAV in the
// browser; this route checks the WAV header and returns 415 for anything else instead of guessing.
import express, { Router } from "express";

const META_ASR_URL = "https://api.meta.ai/v1/asr/transcribe";
const ASR_MODEL = process.env.META_ASR_MODEL ?? "muse-voice-transcribe-1.0";
const TRANSCRIBE_TIMEOUT_MS = 8_000;

export type TranscribeResponse = { text: string; ms: number; audioMs?: number; sessionId?: string } | { error: string; status?: number };

type MetaTranscribe = {
  sessionId?: string;
  transcript?: string;
  audioDurationMs?: number;
  error?: { type?: string; code?: string | null; param?: string | null; message?: string };
};

/** Null if `b` is a WAV Muse accepts, otherwise why not. */
function wavProblem(b: Buffer): string | null {
  if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") {
    return "body is not a WAV file (Muse Voice accepts only mono 16-bit PCM WAV at 16 or 24 kHz)";
  }
  // Walk the chunks to "fmt " (it isn't always at offset 12).
  for (let o = 12; o + 8 <= b.length; o += 8 + b.readUInt32LE(o + 4) + (b.readUInt32LE(o + 4) & 1)) {
    if (b.toString("ascii", o, o + 4) !== "fmt ") continue;
    const format = b.readUInt16LE(o + 8);
    const channels = b.readUInt16LE(o + 10);
    const rate = b.readUInt32LE(o + 12);
    const bits = b.readUInt16LE(o + 22);
    if (format !== 1 || channels !== 1 || bits !== 16 || (rate !== 16000 && rate !== 24000)) {
      return `WAV is format ${format}, ${channels}ch, ${bits}-bit, ${rate} Hz; Muse Voice needs PCM (1), 1ch, 16-bit, 16000 or 24000 Hz`;
    }
    return null;
  }
  return "WAV has no fmt chunk";
}

export const transcribeRouter = Router();

transcribeRouter.post(
  "/api/transcribe",
  express.raw({ type: () => true, limit: "32mb" }),
  async (req, res) => {
    const t0 = performance.now();
    const key = process.env.META_API_KEY;
    if (!key) {
      res.status(500).json({ error: "META_API_KEY missing from .env" } satisfies TranscribeResponse);
      return;
    }
    const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const problem = wavProblem(audio);
    if (problem) {
      res.status(415).json({ error: `${problem} (got ${req.headers["content-type"] ?? "no content-type"}, ${audio.length} bytes)` } satisfies TranscribeResponse);
      return;
    }

    const form = new FormData();
    form.append(
      "request",
      new Blob([JSON.stringify({ model: ASR_MODEL, audioEncoding: "WAV", mode: "PUSH_TO_TALK" })], { type: "application/json" }),
    );
    form.append("audio", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "recording.wav");

    try {
      const r = await fetch(META_ASR_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
        body: form,
      });
      const raw = await r.text();
      let json: MetaTranscribe = {};
      try {
        json = JSON.parse(raw) as MetaTranscribe;
      } catch {
        /* keep raw text for the error */
      }
      const ms = Math.round(performance.now() - t0);
      if (!r.ok) {
        const e = json.error;
        const detail = e ? `${e.type ?? "error"}${e.code ? `/${e.code}` : ""}: ${e.message ?? ""}` : raw.slice(0, 300) || r.statusText;
        console.error(`[${ms}ms transcribe] meta ${r.status} ${detail} (session ${json.sessionId ?? "?"})`);
        // 429 passes through so the client can tell "rate limited" from "broken".
        res.status(r.status === 429 ? 429 : 502).json({ error: `meta ${r.status}: ${detail}`, status: r.status } satisfies TranscribeResponse);
        return;
      }
      const text = (json.transcript ?? "").trim();
      console.log(`[${ms}ms transcribe ${ASR_MODEL}] ${json.audioDurationMs ?? "?"}ms audio, ${Math.round(audio.length / 1024)}kB -> "${text}"`);
      res.json({ text, ms, audioMs: json.audioDurationMs, sessionId: json.sessionId } satisfies TranscribeResponse);
    } catch (e) {
      const timedOut = e instanceof DOMException && e.name === "TimeoutError";
      const msg = timedOut ? `meta transcribe timed out after ${TRANSCRIBE_TIMEOUT_MS / 1000}s` : e instanceof Error ? e.message : String(e);
      console.error("transcribe error:", msg);
      res.status(timedOut ? 504 : 502).json({ error: msg } satisfies TranscribeResponse);
    }
  },
);
