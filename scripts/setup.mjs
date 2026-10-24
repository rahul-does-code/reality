// Run once: node scripts/setup.mjs
// 1) copies MediaPipe's WASM runtime into public/ so the app never depends on a CDN
// 2) downloads the interactive-segmentation model into public/models/ (optional but faster/safer)
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const wasmSrc = "node_modules/@mediapipe/tasks-vision/wasm";
if (!existsSync(wasmSrc)) {
  console.error("Missing @mediapipe/tasks-vision. Run: npm install @mediapipe/tasks-vision");
  process.exit(1);
}
mkdirSync("public", { recursive: true });
cpSync(wasmSrc, "public/mediapipe-wasm", { recursive: true });
console.log("✓ copied wasm -> public/mediapipe-wasm");

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite";
mkdirSync("public/models", { recursive: true });
try {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  writeFileSync("public/models/magic_touch.tflite", Buffer.from(await res.arrayBuffer()));
  console.log("✓ downloaded model -> public/models/magic_touch.tflite");
} catch (e) {
  console.warn(`! model download failed (${e.message}). The app will fetch it from Google at runtime instead.`);
}
