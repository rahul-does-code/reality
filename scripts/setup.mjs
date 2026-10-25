// Run once: node scripts/setup.mjs
// 1) copies MediaPipe's WASM runtime into public/ so the app never depends on a CDN
// 2) downloads the interactive-segmentation, hand-landmarker and face-landmarker models into public/models/
//    (optional but faster/safer; the app falls back to fetching them from Google)
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const wasmSrc = "node_modules/@mediapipe/tasks-vision/wasm";
if (!existsSync(wasmSrc)) {
  console.error("Missing @mediapipe/tasks-vision. Run: npm install @mediapipe/tasks-vision");
  process.exit(1);
}
mkdirSync("public", { recursive: true });
cpSync(wasmSrc, "public/mediapipe-wasm", { recursive: true });
console.log("✓ copied wasm -> public/mediapipe-wasm");

const MODELS = {
  "magic_touch.tflite":
    "https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite",
  "hand_landmarker.task":
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  "face_landmarker.task":
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
};
mkdirSync("public/models", { recursive: true });
for (const [file, url] of Object.entries(MODELS)) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(`public/models/${file}`, Buffer.from(await res.arrayBuffer()));
    console.log(`✓ downloaded model -> public/models/${file}`);
  } catch (e) {
    console.warn(`! ${file} download failed (${e.message}). The app will fetch it from Google at runtime instead.`);
  }
}
