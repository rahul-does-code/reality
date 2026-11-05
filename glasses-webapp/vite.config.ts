// The glasses web app (runs on the Meta Ray-Ban Display). Built into glasses-webapp/dist, which the
// glasses relay serves at /glasses/app/ (relative asset paths, hence base "./").
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
  server: { port: 5182, strictPort: true },
});
