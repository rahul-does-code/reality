import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Cross-origin isolation lets ONNX Runtime (EfficientSAM, src/vision/sam.worker.ts) use WASM
// threads. "credentialless" still allows no-cors cross-origin loads (e.g. the glasses MJPEG relay).
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" };

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    headers: isolation,
    // server/proxy.ts holds the Gemini key; the browser only ever talks to /api.
    proxy: { "/api": "http://localhost:8787" },
  },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  worker: { format: "es" },
});
