// Standalone Bun script used as a fake CDP engine process by recipe-launcher.test.ts. Not imported by tests.
// Usage: bun fake-cdp-engine.test-support.ts --port <n> --storage-dir <dir>
//   [--behavior ready|ignore-close|exit-early|never-ready] [--ws-host <host>] [--stderr-bytes <n>] [--spawn-child] [extra args]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const port = Number(option("--port"));
const storageDir = option("--storage-dir");
const behavior = option("--behavior") ?? "ready";
const wsHost = option("--ws-host");
const stderrBytes = Number(option("--stderr-bytes") ?? "0");

const child = argv.includes("--spawn-child")
  ? Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
  : undefined;

if (storageDir) {
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(
    join(storageDir, "fake-engine.json"),
    JSON.stringify({
      argv,
      envKeys: Object.keys(process.env).sort(),
      pid: process.pid,
      ...(child ? { childPid: child.pid } : {}),
    }),
  );
}

if (stderrBytes > 0) process.stderr.write("x".repeat(stderrBytes));

if (behavior === "exit-early") {
  process.stderr.write("fake engine failed: bad flag\n");
  process.exit(3);
}

if (behavior === "never-ready") {
  process.stderr.write("fake engine warming up\n");
  setInterval(() => {}, 1000);
} else {
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/json/version") {
        return Response.json({
          Browser: "FakeEngine/1.0",
          webSocketDebuggerUrl: `ws://${wsHost ?? "localhost"}:${port}/devtools/browser/fake`,
        });
      }
      if (server.upgrade(request)) return;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const command: unknown = JSON.parse(String(message));
        if (typeof command !== "object" || command === null) return;
        const { id, method } = command as { id?: number; method?: string };
        socket.send(
          JSON.stringify({ id, result: method === "Browser.getVersion" ? { product: "FakeEngine/1.0" } : {} }),
        );
        if (method === "Browser.close" && behavior === "ready") setTimeout(() => process.exit(0), 10);
      },
    },
  });
}
