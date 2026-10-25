// Vercel entry: every api/*.ts function re-exports this handler, which runs the same Express app as
// `npm run server` (server/proxy.ts) behind per-IP rate limits, a body-size cap, same-origin CORS and
// key scrubbing. No listen(), no glasses relay (no WebSockets on Vercel). Keys come from Vercel env vars.
import type { IncomingMessage, ServerResponse } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";

process.env.PROXY_EMBEDDED = "1";
process.env.GLASSES_RELAY = "off";
const { app: api } = await import("./proxy.js");

// Vercel rejects request bodies over 4.5 MB itself; stay just under it with our own friendly 413.
const MAX_BODY = 4_400_000;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
// Per function instance (memory isn't shared between instances), so these are best-effort.
const LIMITS = {
  command: num(process.env.RATE_COMMAND_PER_MIN, 30),
  edit: num(process.env.RATE_EDIT_PER_MIN, 8),
  editDaily: num(process.env.RATE_EDIT_PER_DAY, 300),
  other: num(process.env.RATE_OTHER_PER_MIN, 30), // transcribe, aimask, segment-named, segment-text, each
  api: num(process.env.RATE_API_PER_MIN, 120), // everything under /api
};
const BUSY = "Lots of people are changing reality right now. Please wait a minute and try again.";
const DAILY = "Today's image edits are used up. Recolor and blur still work; edits come back tomorrow.";

// Vercel sets x-real-ip / x-forwarded-for to the client address (it overwrites what the client sends).
function clientIp(req: IncomingMessage) {
  const real = req.headers["x-real-ip"];
  const fwd = req.headers["x-forwarded-for"];
  return (typeof real === "string" && real) || (typeof fwd === "string" && fwd.split(",")[0].trim()) || req.socket?.remoteAddress || "?";
}

/** Fixed one-minute window per IP and bucket. */
function perMinute(bucket: string, max: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    const key = clientIp(req);
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

/** Cap across all IPs, reset at UTC midnight. */
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

/** The app's own page only; there is no cross-origin client. */
function sameOrigin(req: Request, res: Response, next: NextFunction) {
  const origin = req.get("origin");
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get("host")) return next();
  } catch {
    /* malformed origin -> rejected below */
  }
  res.status(403).json({ error: "This API only answers the app's own page." });
}

// Key names (GEMINI_API_KEY...) and key values never leave the server, even inside upstream errors.
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
    // Successful edits carry megabytes of base64; only error bodies can mention keys.
    if (res.statusCode >= 400 || (body && typeof body === "object" && "error" in body)) body = scrubDeep(body);
    return json(body);
  };
  next();
}

const app = express();
app.disable("x-powered-by");
app.use("/api", scrubJson, sameOrigin, perMinute("api", LIMITS.api));
app.post("/api/command", perMinute("command", LIMITS.command));
app.post("/api/edit", perMinute("edit", LIMITS.edit), perDay(LIMITS.editDaily));
for (const p of ["/api/transcribe", "/api/aimask", "/api/segment-named", "/api/segment-text"]) app.post(p, perMinute(p, LIMITS.other));
app.use(api);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "not found" });
});
app.use("/api", (err: { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error("api error:", err);
  res.status(status).json({ error: "request failed" });
});

/** Request body as bytes. Vercel's helpers have usually buffered it already and replay it via data/end. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: object) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * Vercel consumes the request stream before calling us, so the routes' express.json()/express.raw()
 * would see a finished request and skip it (and Vercel's own req.body is undefined for audio/wav).
 * Parse here the way those middlewares would; they then skip because the stream is finished.
 */
export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    const declared = Number(req.headers["content-length"] ?? 0);
    const raw = declared > MAX_BODY ? null : await readBody(req);
    if (!raw) return sendJson(res, 413, { error: "That frame is too large to send. Try again with a smaller image." });
    const type = String(req.headers["content-type"] ?? "");
    if (/^application\/json/i.test(type)) {
      try {
        req.body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      } catch {
        return sendJson(res, 400, { error: "request failed" });
      }
    } else req.body = raw;
  }
  app(req as Request, res as Response);
}
