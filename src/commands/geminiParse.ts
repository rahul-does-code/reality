// Browser side of the command parser: transcript -> Command via the /api/command proxy.
// The Gemini key never leaves the server.
import type { Command, CommandRequest, CommandResponse } from "./schema";

export async function parseCommand(transcript: string, previous: Command | null): Promise<{ command: Command; ms: number }> {
  const res = await fetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript, previous } satisfies CommandRequest),
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
