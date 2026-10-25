// Shared memory of Gemini 429s (free tier: 15 RPM, and 429s come back instantly), so routes can
// skip straight to Muse Spark for a while instead of spending a request on another 429.
const COOLDOWN_MS = 60_000;
let last429 = 0;

/** Record a Gemini HTTP status; only 429 matters. */
export function noteGeminiStatus(status: number): void {
  if (status === 429) last429 = Date.now();
}

/** Gemini returned 429 within the last minute. */
export const gemini429Recently = (): boolean => Date.now() - last429 < COOLDOWN_MS;
