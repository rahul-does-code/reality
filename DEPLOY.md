# Deploying to Vercel

Vercel serves the Vite build (`dist/`) as static files and each `api/*.ts` file as a serverless
function. Every function re-exports `server/vercel.ts`, which runs the same Express app as
`npm run server` (`server/proxy.ts`), so the route logic lives in one place. There is no long-running
server and no WebSocket, so the glasses relay is off and the source dropdown hides "Glasses relay".
Local dev (`npm run dev`: Vite + proxy + relay) is unchanged.

`vercel.json` sets the build command to `node scripts/setup.mjs && npm run build`, which puts the MediaPipe
WASM and models in `public/` before Vite copies them into `dist/`. It also gives `edit`, `aimask`,
`transcribe` and `segment-text` a 60s `maxDuration`.

## Environment variables

Set these in Vercel under **Settings → Environment Variables**. Keys are read only from the
environment (`.env` is for local dev and is never committed). They are never logged or returned:
error responses have key names and values scrubbed.

| Name | Required | Default / values |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes | Gemini key (commands, named segmentation, aimask vision) |
| `META_API_KEY` | yes | Meta key (Muse Image edits, Muse Spark, SAM 3.1, Muse Voice) |
| `COMMAND_PROVIDER` | no | `auto` (Gemini, then Muse Spark on failure) · `gemini` · `meta` |
| `IMAGE_PROVIDER` | no | `meta` · `gemini` |
| `GEMINI_MODEL`, `GEMINI_THINKING`, `GEMINI_COMMAND_IMAGE_RESOLUTION` | no | see `server/proxy.ts` |
| `GEMINI_SEGMENT_MODEL`, `GEMINI_SEGMENT_MASKS`, `GEMINI_SEGMENT_THINKING`, `GEMINI_IMAGE_MODEL` | no | see `server/proxy.ts` |
| `META_TEXT_MODEL`, `META_REASONING_EFFORT`, `META_REASONING`, `META_WEB_SEARCH`, `META_IMAGE_SEARCH`, `META_SHELL`, `META_IMAGE_MODEL` | no | see `server/proxy.ts` |
| `META_SAM_MODEL`, `META_ASR_MODEL` | no | see `server/routes/` |
| `RATE_COMMAND_PER_MIN` | no | `30` per IP |
| `RATE_EDIT_PER_MIN` | no | `8` per IP |
| `RATE_EDIT_PER_DAY` | no | `300` total, per function instance |
| `RATE_OTHER_PER_MIN` | no | `30` per IP, each for transcribe / aimask / segment-named / segment-text |
| `RATE_API_PER_MIN` | no | `120` per IP across `/api` |

Only add the optional ones you want to change. An empty value is not the same as unset for the model names.

## Cost protection

- **Rate limits:** per-IP limits, best-effort and in memory, so each function instance counts separately. When a
  limit is hit the response is a 429 with a friendly message and `Retry-After`.
- **Body size:** request bodies are capped at 4.4 MB with a friendly 413 (Vercel's own limit is 4.5 MB). Frames
  are already sent as JPEG at 512–1024px, so an edit request is about 1–2 MB.
- **CORS:** `/api` only answers the app's own origin. Other origins get a 403.

## Steps

1. **Import:** vercel.com → **Add New… → Project** → import `rahul-does-code/reality` from GitHub. Vercel reads
   `vercel.json` (framework Vite, output `dist`, build command). Leave the root directory as `./`.
2. **Env vars:** before the first deploy, expand **Environment Variables** and add `GEMINI_API_KEY` and
   `META_API_KEY` (plus any optional ones) for Production and Preview. Then click **Deploy**.
   Later changes: **Settings → Environment Variables**, then **Deployments → ⋯ → Redeploy**.
3. **Domain:** **Settings → Domains → Add Domain** → `rahuldoescode.tech`, and accept the suggested `www`
   redirect. At the registrar, add the records the dashboard shows: an **A** record for `@` (typically
   `76.76.21.21`; use the value on your domain card) and a **CNAME** for `www` (the project-specific
   `…vercel-dns…` value shown). Remove conflicting A/AAAA/CNAME records for those names. Vercel issues the
   HTTPS certificate once DNS resolves.
4. **Verify:** `curl https://rahuldoescode.tech/api/health` returns `{"ok":true,...}`. Then open the site: the
   camera prompt appears, the source dropdown shows only "Webcam", and "make it pink" works.
