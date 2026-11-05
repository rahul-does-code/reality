// Hands-free control from the glasses, via the relay's /glasses/events socket:
//   transcript {text, final}  the glasses mic, transcribed on the glasses (DAT Speech, iPhone app)
//   input {action}            a pinch on a glasses web app button: "select" | "undo" | "done"
// Like the pointer track, this only reports what happened; Stage decides what it means.

import { GLASSES_RELAY_PORT } from "./glassesSource";

export type GlassesEvent =
  | { type: "transcript"; text: string; final: boolean }
  | { type: "input"; action: "select" | "undo" | "done" };

/** Connects (and reconnects) until the returned function is called. */
export function listenGlassesEvents(onEvent: (e: GlassesEvent) => void): () => void {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:${GLASSES_RELAY_PORT}/glasses/events`;
  let ws: WebSocket | null = null;
  let closed = false;
  let timer = 0;
  const connect = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const m = JSON.parse(ev.data);
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
