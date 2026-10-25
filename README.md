# Reality is yours

Look at the world, point at something and say what to change; it changes on the live view.
"make it pink", "blur that", "turn that into a cardboard box", "make the taller one red",
"change my nose". Built at HackTX 2026.

Today a camera stream, built for the first-person view from Ray-Ban Meta glasses.

## Setup

Requires Node 20+ and Chrome or Edge (Web Speech, MediaPipe on WebGL).

```sh
npm install
node scripts/setup.mjs   # copies the MediaPipe WASM into public/ and downloads the models
```

Create `.env` in the project root (never committed). Variable names:

- `GEMINI_API_KEY`: command parsing, named-object lookup ("the tree")
- `META_API_KEY`: Muse Image (remove/replace), Muse Voice Transcribe, Muse Spark command fallback
- Optional: `PROXY_PORT`, `COMMAND_PROVIDER` (auto | gemini | meta), `IMAGE_PROVIDER` (meta | gemini),
  `GEMINI_MODEL`, `GEMINI_THINKING`, `GEMINI_COMMAND_IMAGE_RESOLUTION`, `GEMINI_SEGMENT_MODEL`,
  `GEMINI_SEGMENT_MASKS`, `GEMINI_SEGMENT_THINKING`, `GEMINI_IMAGE_MODEL`, `META_TEXT_MODEL`,
  `META_REASONING_EFFORT`, `META_IMAGE_MODEL`, `META_REASONING`, `META_WEB_SEARCH`,
  `META_IMAGE_SEARCH`, `META_SHELL`, `META_ASR_MODEL`

## Run

```sh
npm run dev:all          # web app on http://localhost:5180, API proxy on :8787
```

Space freezes the frame. Click to point (Shift+drag adds, Alt+drag subtracts), draw a loop to
lasso, or draw a line to scribble. Hold V (or the mic button) and speak. U undoes, Esc deselects,
F toggles fullscreen. "Hand mode" points with your index finger and pinches to press. "Live recolor"
recolors what you point at on the moving video.

Debug pages: `/strokes-debug.html`, `/live-debug.html`, `/voice-debug.html`, `/face-debug.html`.

## Architecture

1. Input: a swappable video source plus a pointer track (hand tracking or mouse) that emits only `PointerSample`s.
2. Gestures: a recognizer turns samples into clicks and strokes (closed = lasso, open = scribble).
3. Voice: Web Speech or Muse Voice transcribes; Gemini (Muse Spark fallback) parses it into a command JSON with an optional `select` and an `op`.
4. Selection: point segmentation (MediaPipe), lasso/scribble, face parts (FaceLandmarker), named objects (Gemini boxes) and region/refine/add/subtract modifiers produce one mask, always on the original frozen frame.
5. Operation: recolor and blur run locally; remove/replace call Muse Image through `server/proxy.ts`, which holds every API key.
6. Composite: edits blend only inside the feathered mask, so pixels outside it stay identical; history gives undo.
