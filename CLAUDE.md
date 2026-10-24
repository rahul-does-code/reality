# Reality is yours (HackTX 2026)

## Goal
Wearing smart glasses (today: a webcam/phone stream), you look at the world, point at something and
say what to change; that object changes on the live view. Examples: "make it pink", "turn that
into a cardboard box", "remove that", "change my nose", "only the top half of this can".
The video source is swappable (webcam now, glasses relay later), so everything downstream must only
depend on a frame plus pointer samples plus a voice command.

## Architecture: selection is separate from operation
frame + pointer samples + voice -> SELECTION (a mask) -> OPERATION (recolor/blur/remove/replace)
- Operations: recolor and blur run locally; remove/replace call Meta Muse Image via the proxy (~9s).
- Selection types: pointed object (segmentation at a point), lasso/scribble strokes, face parts
  (MediaPipe FaceLandmarker), named objects ("the tree", via text-prompted segmentation),
  and spatial/refine modifiers ("top half", "bigger", add/subtract).
- Gemini parses speech into a command JSON with an optional `select` object plus an `op`.

## Two independent tracks (do not mix them)
1. POINTER: hand tracking quality (smooth, low lag, reliable pinch = press). It only emits
   PointerSample { x, y, t, pressed, source: "finger"|"mouse", handPresent, confidence }.
   It knows nothing about masks. The mouse emits the same samples.
2. SELECTION: reads PointerSample (and voice) and produces masks. It never touches the hand tracker
   directly, so it can be built and tested with the mouse.

## Layout
src/input (camera, handTracker, speech, pointer), src/vision (segmenter, mask, face, select),
src/commands (schema, geminiParse, history), src/edit (recolor, blur, replace, remove, composite),
src/ui/Stage.tsx, server/proxy.ts (all API keys stay server-side; .env is never committed).

## Rules
Keep changes minimal; don't refactor unrelated files; run `npm run build` at the end of every
task; commit after each working step. All code is written during HackTX, so keep commit history
honest. Segment on the ORIGINAL frozen frame; edits blend only inside the feathered mask so pixels
outside it stay identical. Don't invent API parameters; read the docs (dev.meta.ai, Gemini docs).
