import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    // server/proxy.ts holds the Gemini key; the browser only ever talks to /api.
    proxy: { "/api": "http://localhost:8787" },
  },
});
