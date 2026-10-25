// Browser side of the command parser: transcript -> Command via the /api/command proxy.
// The Gemini key never leaves the server.
import type { Command, CommandProvider, CommandRequest, CommandResponse } from "./schema";

/** frame/point (normalized 0..1) are optional: with them Gemini also sees the frozen frame. */
export async function parseCommand(
  transcript: string,
  previous: Command | null,
  frame?: string,
  point?: { x: number; y: number } | null,
): Promise<{ command: Command; ms: number; provider: CommandProvider; fallback?: string; image?: boolean }> {
  const res = await fetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript, previous, frame, point } satisfies CommandRequest),
  });
  let body: CommandResponse;
  try {
    body = (await res.json()) as CommandResponse;
  } catch {
    throw new Error(`proxy ${res.status}: is the server running? (npm run dev:all)`);
  }
  if ("error" in body) throw new Error(body.error);
  return body;
}
