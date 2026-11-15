import { afterEach, describe, expect, test } from "bun:test";
import { fetchWebSocketDebuggerUrl, loopbackEndpoint, resolveRemoteCdpEndpoint } from "./devtools-endpoint";

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

describe("devtools endpoint", () => {
  test("maps an engine's advertised websocket host to the loopback port it was started on", () => {
    expect(loopbackEndpoint("ws://localhost:9333/devtools/browser/abc", 9333)).toBe(
      "ws://127.0.0.1:9333/devtools/browser/abc",
    );
    expect(loopbackEndpoint("ws://0.0.0.0:1/devtools/browser/x?y=1", 9333)).toBe(
      "ws://127.0.0.1:9333/devtools/browser/x?y=1",
    );
  });

  test("reads webSocketDebuggerUrl from /json/version and rejects a body without it", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === "/good") {
          return Response.json({ webSocketDebuggerUrl: "ws://localhost:1/devtools/browser/a" });
        }
        if (pathname === "/wrong-scheme") return Response.json({ webSocketDebuggerUrl: "http://localhost:1/a" });
        return Response.json({ Browser: "Fake/1.0" });
      },
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    expect(await fetchWebSocketDebuggerUrl(new URL(`${base}/good`), AbortSignal.timeout(2000))).toBe(
      "ws://localhost:1/devtools/browser/a",
    );
    const missing = new URL(`${base}/missing`);
    await expect(fetchWebSocketDebuggerUrl(missing, AbortSignal.timeout(2000))).rejects.toThrow(
      `${missing.href} did not return a webSocketDebuggerUrl`,
    );
    await expect(
      fetchWebSocketDebuggerUrl(new URL(`${base}/wrong-scheme`), AbortSignal.timeout(2000)),
    ).rejects.toThrow("did not return a webSocketDebuggerUrl");
  });

  test("returns a ws endpoint unchanged and resolves an http endpoint through /json/version under its path", async () => {
    expect(await resolveRemoteCdpEndpoint("ws://10.0.0.5:9222/devtools/browser/x")).toBe(
      "ws://10.0.0.5:9222/devtools/browser/x",
    );
    expect(await resolveRemoteCdpEndpoint("wss://example.test/devtools/browser/y")).toBe(
      "wss://example.test/devtools/browser/y",
    );
    const requested: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const { pathname, port } = new URL(request.url);
        requested.push(pathname);
        if (pathname === "/cdp/json/version") {
          return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/r` });
        }
        return Response.json({ Browser: "Fake/1.0" });
      },
    });
    servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;
    const expected = `ws://127.0.0.1:${server.port}/devtools/browser/r`;

    expect(await resolveRemoteCdpEndpoint(`${origin}/cdp`)).toBe(expected);
    expect(await resolveRemoteCdpEndpoint(`${origin}/cdp/`)).toBe(expected);
    expect(requested).toEqual(["/cdp/json/version", "/cdp/json/version"]);
  });

  test("reports CHROME_MCP_REMOTE_UNAVAILABLE when the endpoint publishes no webSocketDebuggerUrl", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ Browser: "Fake/1.0" }),
    });
    servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;

    await expect(resolveRemoteCdpEndpoint(origin)).rejects.toMatchObject({
      code: "CHROME_MCP_REMOTE_UNAVAILABLE",
      message: expect.stringContaining(`Could not read the browser's DevTools endpoint from ${origin}/json/version`),
    });
  });
});
