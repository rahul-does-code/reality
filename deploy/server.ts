// Production entry: one Node process on one port serves the built dist/ and mounts the /api routes
// from server/proxy.ts behind rate limits, tight CORS and key scrubbing. Caddy terminates HTTPS in front.
// Run: npm run build:prod && npm run start:prod   (PORT defaults to 3000)
import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Defaults for production; a value in .env or the shell wins. GLASSES_RELAY=on starts the :8788 relay.
process.env.PROXY_EMBEDDED = "1";
process.env.GLASSES_RELAY ??= "off";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1"; // only Caddy talks to us
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
// Extra origins allowed to call /api cross-origin (comma separated). Same-origin needs nothing.
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
const LIMITS = {
  command: num(process.env.RATE_COMMAND_PER_MIN, 30),
  edit: num(process.env.RATE_EDIT_PER_MIN, 8),
  editDaily: num(process.env.RATE_EDIT_PER_DAY, 300),
  other: num(process.env.RATE_OTHER_PER_MIN, 30), // transcribe, aimask, segment-named, each
  api: num(process.env.RATE_API_PER_MIN, 120), // everything under /api, per IP
};

const { app: api } = await import("../server/proxy");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback"); // req.ip = client IP from Caddy's X-Forwarded-For

// ---- rate limiting (in memory; fine for one process) ----
const BUSY = "Lots of people are changing reality right now. Please wait a minute and try again.";
const DAILY = "Today's image edits are used up. Recolor and blur still work; edits come back tomorrow.";

/** Fixed one-minute window per IP and bucket. */
function perMinute(bucket: string, max: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, 60_000).unref();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? "?";
    let h = hits.get(key);
    if (!h || h.reset <= now) hits.set(key, (h = { n: 0, reset: now + 60_000 }));
    if (++h.n > max) {
      res.set("Retry-After", String(Math.ceil((h.reset - now) / 1000)));
      res.status(429).json({ error: BUSY, rateLimited: bucket });
      return;
    }
    next();
  };
}

/** Global cap across all IPs, reset at UTC midnight. */
function perDay(max: number) {
  let day = "";
  let n = 0;
  return (_req: Request, res: Response, next: NextFunction) => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) [day, n] = [today, 0];
    if (n >= max) {
      res.status(429).json({ error: DAILY, rateLimited: "daily" });
      return;
    }
    n++;
    next();
  };
}

// ---- CORS: same-origin only unless CORS_ORIGINS lists more ----
function sameOriginOrAllowed(req: Request, res: Response, next: NextFunction) {
  const origin = req.get("origin");
  if (!origin) return next();
  let host = "";
  try {
    host = new URL(origin).host;
  } catch {
    /* malformed origin -> rejected below */
  }
  if (host && host === req.get("host")) return next();
  if (CORS_ORIGINS.includes(origin)) return next();
  res.status(403).json({ error: "This API only answers the app's own page." });
}

// ---- never let key names or values leave the server ----
const SECRET_NAME = /\b[A-Z][A-Z0-9_]*(?:API_KEY|_KEY|_SECRET|_TOKEN)\b/g;
const secretValues = () =>
  Object.entries(process.env)
    .filter(([k, v]) => /KEY|SECRET|TOKEN/.test(k) && v && v.length >= 8)
    .map(([, v]) => v!);
function scrub(text: string) {
  let out = text.replace(SECRET_NAME, "server credentials").replace(/\s*(?:from|in|to) \.env\b/g, "");
  for (const v of secretValues()) out = out.split(v).join("[redacted]");
  return out;
}
function scrubDeep(v: unknown): unknown {
  if (typeof v === "string") return scrub(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]));
  return v;
}
function scrubJson(_req: Request, res: Response, next: NextFunction) {
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    // Successful edits carry megabytes of base64; only error-ish bodies can mention keys.
    if (res.statusCode >= 400 || (body && typeof body === "object" && "error" in body)) body = scrubDeep(body);
    return json(body);
  };
  next();
}

app.use("/api", scrubJson);
app.use("/api", sameOriginOrAllowed);
if (CORS_ORIGINS.length) app.use("/api", cors({ origin: CORS_ORIGINS }));
app.use("/api", perMinute("api", LIMITS.api));
app.post("/api/command", perMinute("command", LIMITS.command));
app.post("/api/edit", perMinute("edit", LIMITS.edit), perDay(LIMITS.editDaily));
for (const p of ["/api/transcribe", "/api/aimask", "/api/segment-named"]) app.post(p, perMinute(p, LIMITS.other));
app.use(api);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "not found" });
});
// Body too large, bad JSON, or anything thrown: a short message, never a stack.
app.use("/api", (err: { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error("api error:", err);
  res.status(status).json({ error: err.type === "entity.too.large" ? "image too large" : "request failed" });
});

// ---- the built app ----
// Vite's hashed assets never change; models/wasm and index.html are revalidated.
app.use("/assets", express.static(path.join(DIST, "assets"), { immutable: true, maxAge: "1y", fallthrough: false }));
app.use(express.static(DIST, { maxAge: "1h", setHeaders: (res, file) => file.endsWith(".html") && res.set("Cache-Control", "no-cache") }));
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  res.set("Cache-Control", "no-cache").sendFile(path.join(DIST, "index.html"));
});

app.listen(PORT, HOST, (err?: Error) => {
  if (err) {
    console.error(`server failed to listen on ${HOST}:${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`reality-is-yours on http://${HOST}:${PORT} (dist ${DIST}, relay ${process.env.GLASSES_RELAY}, limits ${JSON.stringify(LIMITS)})`);
});
