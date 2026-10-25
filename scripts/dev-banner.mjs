// Prints one line per dev port once it is listening, plus the LAN address to type into the phone app.
import net from "node:net";
import os from "node:os";

const ports = [
  [5180, "vite dev server"],
  [8787, "proxy"],
  [8788, "glasses relay"],
];

function up(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

const pending = new Map(ports.map(([p, n]) => [p, n]));
const deadline = Date.now() + 60_000;
while (pending.size && Date.now() < deadline) {
  for (const [p, n] of [...pending]) {
    if (await up(p)) {
      console.log(`[dev] :${p} ${n} listening`);
      pending.delete(p);
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}
for (const [p, n] of pending) console.log(`[dev] :${p} ${n} NOT listening after 60s`);

const lan = (os.networkInterfaces().en0 ?? []).find((a) => a.family === "IPv4" && !a.internal)?.address;
console.log(lan ? `[dev] phone app relay address: ${lan}:8788` : "[dev] no en0 IPv4 address found; check the Wi-Fi connection");
