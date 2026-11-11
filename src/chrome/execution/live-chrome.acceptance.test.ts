import { describe, expect, test } from "bun:test";
import { watch } from "node:fs/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionWorkerRequest } from "./protocol";
import { resolveChromeExecutable } from "../../platform/chrome-executable";
import { isRecord } from "../../platform/records";
import { chromeProcessEnvironment } from "../runtime/browser-launcher";
import { CdpConnection } from "../runtime/cdp-connection";
import { CdpRelay } from "../runtime/cdp-relay";
import { runExecutionWorker } from "./runner";

const LIVE_ACCEPTANCE = process.env.CHROME_MCP_LIVE_ACCEPTANCE === "1";

const readActivePort = async (profile: string, timeoutMs: number): Promise<string> => {
  const path = join(profile, "DevToolsActivePort");
  const cancellation = new AbortController();
  const timeout = setTimeout(() => cancellation.abort(), timeoutMs);
  const events = watch(profile, { signal: cancellation.signal });
  try {
    try {
      return await readFile(path, "utf8");
    } catch {
      for await (const event of events) {
        if (event.filename !== "DevToolsActivePort") continue;
        try {
          return await readFile(path, "utf8");
        } catch {
          continue;
        }
      }
    }
  } catch (error: unknown) {
    if (cancellation.signal.aborted) {
      throw new Error(`Chrome did not publish DevToolsActivePort within ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    cancellation.abort();
  }
  throw new Error("Chrome stopped publishing DevToolsActivePort events");
};

const selectedTargetId = async (browserEndpoint: string): Promise<string> => {
  const endpoint = new URL(browserEndpoint);
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  endpoint.pathname = "/json/list";
  endpoint.search = "";
  endpoint.hash = "";
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`Chrome target list returned HTTP ${response.status}`);
  const targets: unknown = await response.json();
  if (!Array.isArray(targets)) throw new Error("Chrome target list was not an array");
  const page = targets.find(
    (target) => isRecord(target) && target.type === "page" && typeof target.id === "string",
  );
  if (!isRecord(page) || typeof page.id !== "string") {
    throw new Error("Chrome did not expose an initial page target");
  }
  return page.id;
};

type LiveWorkerRequest = Pick<ExecutionWorkerRequest, "args" | "code">;

const withDisposableChrome = async <Result>(
  run: (chrome: Readonly<{ cdpEndpoint: string; exitCode: () => number | null }>) => Promise<Result>,
): Promise<Result> => {
  const chromeExecutable = await resolveChromeExecutable();

  const profile = await mkdtemp(join(tmpdir(), "chrome-mcp-acceptance-"));
  const chrome = Bun.spawn({
    cmd: [
      chromeExecutable,
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    env: chromeProcessEnvironment(),
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  });
  try {
    const activePort = readActivePort(profile, 10_000).then((value) => ({ state: "ready" as const, value }));
    const earlyExit = chrome.exited.then((exitCode) => ({ exitCode, state: "exited" as const }));
    const readiness = await Promise.race([activePort, earlyExit]);
    if (readiness.state === "exited") {
      throw new Error(`Chrome exited before CDP startup with code ${readiness.exitCode}`);
    }
    const [port, browserPath] = readiness.value.trim().split(/\r?\n/u);
    if (!port || !browserPath) throw new Error("Chrome DevToolsActivePort was malformed");
    return await run({ cdpEndpoint: `http://127.0.0.1:${port}`, exitCode: () => chrome.exitCode });
  } finally {
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    await chrome.exited;
    await rm(profile, { force: true, recursive: true });
  }
};

const runWithDisposableChrome = (request: LiveWorkerRequest) =>
  withDisposableChrome(async ({ cdpEndpoint, exitCode }) => {
    const result = await runExecutionWorker({
      adapter: { execute: async () => ({ value: null }) },
      request: {
        ...request,
        browserMode: "isolated-headless",
        callId: "live-chrome-acceptance",
        capabilities: { selectedTargetId: "pending" },
        cdpEndpoint,
        connectTimeoutMs: 5000,
        dialog: null,
        fileChooser: null,
        selectedTargetId: await selectedTargetId(cdpEndpoint),
        state: [],
      },
      timeoutMs: 15_000,
    });
    return { chromeExitCode: exitCode(), result };
  });

const browserWebSocketEndpoint = async (cdpEndpoint: string): Promise<string> => {
  const response = await fetch(new URL("/json/version", cdpEndpoint));
  if (!response.ok) throw new Error(`Chrome version endpoint returned HTTP ${response.status}`);
  const version: unknown = await response.json();
  if (!isRecord(version) || typeof version.webSocketDebuggerUrl !== "string") {
    throw new Error("Chrome did not expose a browser WebSocket endpoint");
  }
  return version.webSocketDebuggerUrl;
};

describe("live Chrome execution acceptance", () => {
  test.skipIf(!LIVE_ACCEPTANCE)(
    "runs one disposable Bun worker through public Playwright CDP transport",
    async () => {
      const responseServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return new Response("ok", { headers: { "set-cookie": "session=accepted; Path=/" } });
        },
      });
      try {
        const { chromeExitCode, result } = await runWithDisposableChrome({
          args: { requestUrl: `http://127.0.0.1:${responseServer.port}/cookie` },
          code: `
          await page.setContent("<title>Chrome MCP live acceptance</title><main>ready</main>");
          const response = await context.request.get(args.requestUrl, { maxRedirects: 0 });
          const cdp = await browser.newBrowserCDPSession();
          try {
            const version = await cdp.send("Browser.getVersion");
            chrome.setSessionStateValue("liveAcceptance", true);
            return {
              helperState: chrome.getSessionStateValue("liveAcceptance"),
              product: version.product,
              requestStatus: response.status(),
              requestUrl: response.url(),
              title: await page.title(),
              workerPid: process.pid,
            };
          } finally {
            await cdp.detach();
          }
        `,
        });

        expect(result.ok).toBeTrue();
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        expect(result.value).toMatchObject({
          helperState: true,
          product: expect.stringMatching(/^Chrome\/\d+(?:\.\d+){3}$/u),
          requestStatus: 200,
          requestUrl: `http://127.0.0.1:${responseServer.port}/cookie`,
          title: "Chrome MCP live acceptance",
        });
        expect(result.value).not.toMatchObject({ workerPid: process.pid });
        expect(chromeExitCode).toBeNull();
      } finally {
        await responseServer.stop(true);
      }
    },
  );

  test.skipIf(!LIVE_ACCEPTANCE || process.platform !== "linux")(
    "keeps one Chrome connection while successive workers attach through the broker relay",
    async () => {
      await withDisposableChrome(async ({ cdpEndpoint }) => {
        const browserEndpoint = await browserWebSocketEndpoint(cdpEndpoint);
        const targetId = await selectedTargetId(cdpEndpoint);
        const connection = await CdpConnection.connect(browserEndpoint);
        const relay = CdpRelay.listen(connection);
        const runCall = async (callId: string, endpoint: string) => {
          const result = await runExecutionWorker({
            adapter: { execute: async () => ({ value: null }) },
            request: {
              args: { port: new URL(cdpEndpoint).port },
              browserMode: "isolated-headless",
              callId,
              capabilities: { selectedTargetId: "pending" },
              cdpEndpoint: endpoint,
              code: `
              await page.setContent("<title>" + ${JSON.stringify(callId)} + "</title>");
              const listing = await new Response(Bun.spawn(["ss", "-tnH", "state", "established"], { stderr: "ignore" }).stdout).text();
              return {
                chromeSockets: listing.split("\\n").filter((line) => line.split(/\\s+/u)[3] === "127.0.0.1:" + args.port).length,
                pid: process.pid,
                title: await page.title(),
              };
            `,
              connectTimeoutMs: 5000,
              dialog: null,
              fileChooser: null,
              selectedTargetId: targetId,
              state: [],
            },
            timeoutMs: 15_000,
          });
          expect(result.ok).toBeTrue();
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
          if (!isRecord(result.value)) throw new Error("live relay worker did not return an object");
          expect(result.value.title).toBe(callId);
          return result.value;
        };

        try {
          const relayed = [
            await runCall("relay-call-1", relay.endpoint),
            await runCall("relay-call-2", relay.endpoint),
            await runCall("relay-call-3", relay.endpoint),
          ];
          const direct = await runCall("direct-call", browserEndpoint);

          expect(new Set(relayed.map((value) => value.pid)).size).toBe(3);
          if (typeof direct.chromeSockets !== "number") {
            throw new TypeError("direct worker did not count Chrome sockets");
          }
          expect(new Set(relayed.map((value) => value.chromeSockets))).toEqual(
            new Set([direct.chromeSockets - 1]),
          );
        } finally {
          relay.close();
          connection.close();
        }
      });
    },
    60_000,
  );

  test.skipIf(!LIVE_ACCEPTANCE)(
    "keeps permissions granted by one worker for later workers on the same relay",
    async () => {
      await withDisposableChrome(async ({ cdpEndpoint }) => {
        const browserEndpoint = await browserWebSocketEndpoint(cdpEndpoint);
        const targetId = await selectedTargetId(cdpEndpoint);
        const connection = await CdpConnection.connect(browserEndpoint);
        const relay = CdpRelay.listen(connection);
        const runCall = async (callId: string, endpoint: string, code: string) => {
          const result = await runExecutionWorker({
            adapter: { execute: async () => ({ value: null }) },
            request: {
              args: {},
              browserMode: "isolated-headless",
              callId,
              capabilities: { selectedTargetId: "pending" },
              cdpEndpoint: endpoint,
              code: `${code}
              return await page.evaluate(async () => (await navigator.permissions.query({ name: "clipboard-read" })).state);
            `,
              connectTimeoutMs: 5000,
              dialog: null,
              fileChooser: null,
              selectedTargetId: targetId,
              state: [],
            },
            timeoutMs: 15_000,
          });
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
          return result.value;
        };

        try {
          expect(
            await runCall(
              "relay-grant",
              relay.endpoint,
              'await context.grantPermissions(["clipboard-read"]);',
            ),
          ).toBe("granted");
          expect(await runCall("relay-query", relay.endpoint, "")).toBe("granted");
          expect(await runCall("relay-clear", relay.endpoint, "await context.clearPermissions();")).not.toBe(
            "granted",
          );
          expect(
            await runCall(
              "direct-grant",
              browserEndpoint,
              'await context.grantPermissions(["clipboard-read"]);',
            ),
          ).toBe("granted");
          expect(await runCall("direct-query", browserEndpoint, "")).not.toBe("granted");
        } finally {
          relay.close();
          connection.close();
        }
      });
    },
    60_000,
  );

  test.skipIf(!LIVE_ACCEPTANCE)(
    "returns the error thrown inside a route handler instead of a bare worker crash",
    async () => {
      const { result } = await runWithDisposableChrome({
        args: null,
        code: `
        await page.route("**/mocked-path", async () => {
          throw new Error("route handler rejected the response shape");
        });
        await page.goto("http://example.invalid/mocked-path", { timeout: 5000 });
        return "unreachable";
      `,
      });

      expect(result.ok).toBeFalse();
      if (result.ok) throw new Error("worker returned a success result");
      expect(result.error.message).toContain("route handler rejected the response shape");
    },
  );
});
