// Hands-free control from the glasses, via the relay's /glasses/events socket:
//   transcript {text, final}  the glasses mic, transcribed on the glasses (DAT Speech, iPhone app)
//   input {action}            a pinch on a glasses web app button, or a DIY glasses button:
//                             "select" | "undo" | "done"
//   audio + WAV               push-to-talk from the DIY glasses mic (16 kHz mono), for /api/transcribe
// Like the pointer track, this only reports what happened; Stage decides what it means.

import { GLASSES_RELAY_PORT } from "./glassesSource";

export type GlassesEvent =
  | { type: "transcript"; text: string; final: boolean }
  | { type: "input"; action: "select" | "undo" | "done" }
  | { type: "audio"; wav: ArrayBuffer };

/** Glasses audio (WAV) -> text, through the proxy's /api/transcribe (Muse Voice). */
export async function transcribeGlassesAudio(wav: ArrayBuffer): Promise<string> {
  const r = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: wav,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!r.ok || typeof json.text !== "string") throw new Error(json.error ?? `transcribe ${r.status}`);
  return json.text;
}

/** Connects (and reconnects) until the returned function is called. */
export function listenGlassesEvents(onEvent: (e: GlassesEvent) => void): () => void {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:${GLASSES_RELAY_PORT}/glasses/events`;
  let ws: WebSocket | null = null;
  let closed = false;
  let timer = 0;
  let audioNext = false; // the next binary message is a WAV
  const connect = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        if (audioNext && ev.data instanceof ArrayBuffer) onEvent({ type: "audio", wav: ev.data });
        audioNext = false;
        return;
      }
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "audio") {
          audioNext = true;
          return;
        }
        if (m.type === "transcript" && typeof m.text === "string") onEvent({ type: "transcript", text: m.text, final: !!m.final });
        else if (m.type === "input" && ["select", "undo", "done"].includes(m.action)) onEvent({ type: "input", action: m.action });
      } catch {
        // not an event
      }
    };
    ws.onclose = () => {
      if (!closed) timer = window.setTimeout(connect, 1000);
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    ws?.close();
  };
}
