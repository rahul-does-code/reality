// Shared MediaPipe asset loading: WASM from public/, models local-first (see scripts/setup.mjs).
import { FilesetResolver } from "@mediapipe/tasks-vision";

const WASM_PATH = "/mediapipe-wasm";

let filesetPromise: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null;

export function visionFileset() {
  filesetPromise ??= FilesetResolver.forVisionTasks(WASM_PATH);
  return filesetPromise;
}

/** Fetches a model from public/models, or null if it isn't there (caller falls back to remote). */
export async function loadLocalModel(path: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(path);
    const type = r.headers.get("content-type") ?? "";
    // Vite serves index.html for missing files, so reject HTML responses.
    if (r.ok && !type.includes("text/html")) return new Uint8Array(await r.arrayBuffer());
  } catch {
    /* fall through to remote */
  }
  return null;
}
