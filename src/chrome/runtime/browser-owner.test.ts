import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DownloadFinishedInput } from "./target-observer";
import { type BrowserLauncher, HEADLESS_VIEWPORT, type LaunchChromeOptions } from "./browser-launcher";
import { BrowserOwner, ChromeBrowserBroker } from "./browser-owner";
import { FakeCdpClient } from "./fake-cdp-client.test-support";
import { writeBrowserOwnerMetadata } from "./owner-metadata";
import { createOwnerKey, resolveChromeRuntimePaths } from "./paths";
import { PersistentMutationRegistry } from "./persistent-mutations";
import { profilePathHash } from "./profile-lease";
import { PWA_INSTALL_RECEIPT_FILE } from "./pwa-controller";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

type TestPageTarget = { targetId: string; title: string; type: "page"; url: string };

const pageConnection = (
  endpoint: string,
  initialTargetId: string,
  browserPid = process.pid,
  onBrowserClose?: () => void,
  survivingTargets?: Map<string, TestPageTarget>,
): FakeCdpClient => {
  const targets = survivingTargets ?? new Map<string, TestPageTarget>();
  if (!targets.has(initialTargetId)) {
    targets.set(initialTargetId, {
      targetId: initialTargetId,
      title: "Initial",
      type: "page",
      url: "about:blank",
    });
  }
  let createdPages = 0;
  const connection = new FakeCdpClient(endpoint);
  connection.command = async ({ method, params }) => {
    if (method === "Target.getTargets") return { targetInfos: [...targets.values()] };
    if (method === "Target.attachToTarget") {
      const targetId = typeof params.targetId === "string" ? params.targetId : "unknown";
      return { sessionId: `session:${targetId}` };
    }
    if (method === "Target.createTarget") {
      createdPages++;
      const targetId = `blank-${createdPages}`;
      targets.set(targetId, { targetId, title: "", type: "page", url: "about:blank" });
      return { targetId };
    }
    if (method === "Target.getTargetInfo") {
      const targetId = typeof params.targetId === "string" ? params.targetId : "";
      return { targetInfo: targets.get(targetId) };
    }
    if (method === "Page.getFrameTree") {
      const targetId = connection.commands.at(-1)?.sessionId?.replace("session:", "") ?? initialTargetId;
      return { frameTree: { frame: { id: `frame:${targetId}` } } };
    }
    if (method === "Browser.getVersion") return { product: "Chrome/140.0.0.0" };
    if (method === "SystemInfo.getProcessInfo") return { processInfo: [{ id: browserPid, type: "browser" }] };
    if (method === "Browser.close") onBrowserClose?.();
    return {};
  };
  return connection;
};

const writingLauncher = (
  connections: FakeCdpClient[],
  config: Readonly<{
    failCloses?: boolean;
    failFirstDisconnectedClose?: boolean;
    failLaunches?: readonly number[];
  }> = {},
) => {
  let launches = 0;
  let closes = 0;
  const launcher: BrowserLauncher = {
    launch: async (options: LaunchChromeOptions) => {
      launches++;
      const launchNumber = launches;
      if (config.failLaunches?.includes(launchNumber)) {
        throw new Error(`Chrome launch ${launchNumber} failed`);
      }
      await writeFile(
        join(options.userDataDir, "DevToolsActivePort"),
        `9222\n/devtools/browser/${launches}\n`,
      );
      return {
        pageViewport: () => Promise.resolve(options.viewport),
        close: async () => {
          closes++;
          if (config.failCloses) throw new Error("injected browser close failure");
          if (config.failFirstDisconnectedClose && launchNumber === 1 && connections[0]?.closed) {
            throw new Error("Playwright already observed browser exit");
          }
        },
      };
    },
  };
  return {
    get closes() {
      return closes;
    },
    get launches() {
      return launches;
    },
    launcher,
    connector: async (endpoint: string) => {
      const connection = pageConnection(endpoint, `page-${connections.length + 1}`);
      connections.push(connection);
      return connection;
    },
  };
};

type MainMutationEffects = Readonly<{
  bindings: string[];
  pageBindingInstalled: boolean;
  routesEnabled: boolean;
  scripts: number;
}>;

const createMainShutdownCleanupFixture = async (
  options: Readonly<{
    replacementCleanupFailures?: number;
    replacementCloseFailures?: number;
  }> = {},
) => {
  const workspacePath = await temporaryDirectory("chrome-main-shutdown-workspace-");
  const runtimeRoot = await temporaryDirectory("chrome-main-shutdown-runtime-");
  const targets = new Map<string, TestPageTarget>();
  const connections: FakeCdpClient[] = [];
  const bindings = new Set<string>();
  const scripts = new Set<string>();
  let endpointGeneration = 0;
  let nextScript = 1;
  let pageBindingInstalled = false;
  let remainingCleanupFailures = options.replacementCleanupFailures ?? 0;
  let remainingCloseFailures = options.replacementCloseFailures ?? 0;
  let routesEnabled = false;
  const broker = await ChromeBrowserBroker.create({
    cdpConnector: async (endpoint) => {
      const connectionIndex = connections.length;
      const connection = pageConnection(endpoint, "page-a", process.pid, undefined, targets);
      const command = connection.command;
      connection.command = async (input) => {
        if (
          input.method === "Fetch.disable" &&
          (connectionIndex === 0 || (connectionIndex > 0 && remainingCleanupFailures > 0))
        ) {
          if (connectionIndex > 0) remainingCleanupFailures -= 1;
          throw new Error("injected persistent main cleanup failure");
        }
        if (input.method === "Fetch.enable") routesEnabled = true;
        if (input.method === "Fetch.disable") routesEnabled = false;
        if (input.method === "Page.addScriptToEvaluateOnNewDocument") {
          const identifier = `shutdown-script-${nextScript++}`;
          scripts.add(identifier);
          return { identifier };
        }
        if (
          input.method === "Page.removeScriptToEvaluateOnNewDocument" &&
          typeof input.params.identifier === "string"
        ) {
          scripts.delete(input.params.identifier);
        }
        if (input.method === "Runtime.addBinding" && typeof input.params.name === "string") {
          bindings.add(input.params.name);
        }
        if (input.method === "Runtime.removeBinding" && typeof input.params.name === "string") {
          bindings.delete(input.params.name);
        }
        if (
          input.method === "Runtime.evaluate" &&
          typeof input.params.expression === "string" &&
          input.params.expression.includes("__chromeMcpPersistentBindings")
        ) {
          pageBindingInstalled = !input.params.expression.includes("?.rejectAll(");
        }
        return command(input);
      };
      if (connectionIndex > 0) {
        const close = connection.close.bind(connection);
        connection.close = () => {
          close();
          if (remainingCloseFailures === 0) return;
          remainingCloseFailures -= 1;
          throw new Error("injected main shutdown owner close failure");
        };
      }
      connections.push(connection);
      return connection;
    },
    executablePath: process.execPath,
    mainEndpoint: async () => ({
      endpoint: `ws://127.0.0.1:9222/devtools/browser/main-${++endpointGeneration}`,
      userDataDir: "/unused",
    }),
    onError: () => undefined,
    pathOptions: { dataHome: runtimeRoot, runtimeRoot },
    workspacePath,
  });
  const session = await broker.acquire("client-a", "main");
  await session.addMutation({
    action: { type: "continue" },
    kind: "route",
    urlPattern: "https://shutdown.example.test/*",
  });
  await session.addMutation({ kind: "initScript", source: "globalThis.__shutdownInit = true" });
  await session.addMutation({ kind: "binding", name: "shutdownHostValue", source: "(value) => value" });
  let releaseFailure: unknown;
  try {
    await session.close();
  } catch (error: unknown) {
    releaseFailure = error;
  }
  const effects = (): MainMutationEffects => ({
    bindings: [...bindings],
    pageBindingInstalled,
    routesEnabled,
    scripts: scripts.size,
  });
  return { broker, connections, effects, releaseFailure, session };
};

test("preserves the isolated profile when PWA cleanup fails and removes it after confirmed cleanup", async () => {
  const root = await temporaryDirectory("chrome-pwa-owner-");
  const key = createOwnerKey("isolated-headless", "c".repeat(64), "pwa-client");
  const paths = resolveChromeRuntimePaths(key, { runtimeRoot: root });

  const connections: FakeCdpClient[] = [];
  const launched = writingLauncher(connections);
  const replies = new Map<string, () => Promise<unknown>>([
    ["PWA.uninstall", () => Promise.reject(new Error("Uninstall failed"))],
    ["PWA.getOsAppState", () => Promise.resolve({ badgeCount: 0, fileHandlers: [] })],
  ]);
  const owner = await BrowserOwner.create({
    cdpConnector: launched.connector,
    executablePath: process.execPath,
    key,
    paths,
    onError: () => undefined,
    launcher: {
      launch: async (options) => ({
        ...(await launched.launcher.launch(options)),
        sendPwaCommand: (method) => replies.get(method)?.() ?? Promise.resolve({}),
      }),
    },
  });

  const receiptPath = join(paths.profileRoot, PWA_INSTALL_RECEIPT_FILE);
  await owner.pwa.execute(
    { operation: "install", manifestId: "https://example.test/app", installUrl: "https://example.test/" },
    new AbortController().signal,
  );
  expect(owner.close()).rejects.toThrow("cleanup failed");
  expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(["https://example.test/app"]);

  replies.set("PWA.uninstall", () => Promise.resolve({}));
  await owner.close();
  expect(await Bun.file(receiptPath).exists()).toBe(false);
});

describe("ChromeBrowserBroker recovery", () => {
  test("preserves native scale through reuse and disconnected-owner recovery", async () => {
    const workspacePath = await temporaryDirectory("chrome-native-scale-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-native-scale-runtime-");
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections);
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: launched.connector,
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      workspacePath,
    });

    try {
      const session = await broker.acquire("desktop", "isolated-virtual-display", {
        nativeDeviceScaleFactor: 1.296_875,
      });
      const same = await broker.acquire("desktop", "isolated-virtual-display", {
        nativeDeviceScaleFactor: 1.296_875,
      });
      expect(same).toBe(session);
      expect(
        broker.acquire("desktop", "isolated-virtual-display", { nativeDeviceScaleFactor: 2 }),
      ).rejects.toMatchObject({ code: "CHROME_MCP_INVALID_INPUT" });
      expect(launched.launches).toBe(1);

      session.owner.connection.close();
      const recovered = await broker.acquire("desktop", "isolated-virtual-display", {
        nativeDeviceScaleFactor: 1.296_875,
      });
      expect(recovered.owner.nativeDeviceScaleFactor).toBe(1.296_875);
      expect(recovered.owner.snapshot()).toMatchObject({
        headless: false,
        nativeDeviceScaleFactor: 1.296_875,
      });
      expect(launched.launches).toBe(2);
    } finally {
      await broker.close();
    }

    expect(launched.closes).toBe(2);
  });

  test("keeps persistent endpoints while revoking each completed execution admission", async () => {
    const workspacePath = await temporaryDirectory("chrome-endpoint-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-endpoint-runtime-");
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections);
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: launched.connector,
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      workspacePath,
    });

    try {
      const session = await broker.acquire("client", "isolated-headless");
      const first = await session.admit({ run: async () => session.workerConnection() });
      const second = await session.admit({ run: async () => session.workerConnection() });

      expect(second.endpoint).toBe(first.endpoint);
      expect(second.executionEndpoint).not.toBe(first.executionEndpoint);
      const ownerResponse = await fetch(first.endpoint.replace("ws:", "http:"));
      expect(ownerResponse.status).toBe(426);
      const firstExecutionResponse = await fetch(first.executionEndpoint.replace("ws:", "http:"));
      expect(firstExecutionResponse.status).toBe(404);
      const secondExecutionResponse = await fetch(second.executionEndpoint.replace("ws:", "http:"));
      expect(secondExecutionResponse.status).toBe(404);
    } finally {
      await broker.close();
    }
  });

  test("reuses ready viewport targets and discovers new targets without weakening closure or cancellation", async () => {
    const workspacePath = await temporaryDirectory("chrome-viewport-readiness-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-viewport-readiness-runtime-");
    const targets = new Map<string, TestPageTarget>();
    const connection = pageConnection(
      "ws://127.0.0.1:9222/devtools/browser/viewport",
      "page-a",
      process.pid,
      undefined,
      targets,
    );
    const launched = writingLauncher([]);
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: async () => connection,
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      workspacePath,
    });

    try {
      const session = await broker.acquire("client-a", "isolated-headless");
      const signal = new AbortController().signal;
      const initialQueries = connection.commands.filter(
        ({ method }) => method === "Target.getTargets",
      ).length;
      expect(await session.owner.pageViewport({ operation: "read", targetId: "page-a" }, signal)).toEqual(
        HEADLESS_VIEWPORT,
      );
      expect(await session.owner.pageViewport({ operation: "read", targetId: "page-a" }, signal)).toEqual(
        HEADLESS_VIEWPORT,
      );
      expect(connection.commands.filter(({ method }) => method === "Target.getTargets")).toHaveLength(
        initialQueries,
      );

      await connection.send("Target.createTarget", { url: "about:blank" });
      expect(await session.owner.pageViewport({ operation: "read", targetId: "blank-1" }, signal)).toEqual(
        HEADLESS_VIEWPORT,
      );
      expect(connection.commands.filter(({ method }) => method === "Target.getTargets")).toHaveLength(
        initialQueries + 1,
      );

      const cancelled = AbortSignal.abort(new Error("Viewport request cancelled"));
      expect(session.owner.pageViewport({ operation: "read", targetId: "blank-1" }, cancelled)).rejects.toBe(
        cancelled.reason,
      );
      expect(connection.commands.filter(({ method }) => method === "Target.getTargets")).toHaveLength(
        initialQueries + 1,
      );

      targets.delete("blank-1");
      connection.emit("Target.targetDestroyed", { targetId: "blank-1" });
      expect(
        session.owner.pageViewport({ operation: "read", targetId: "blank-1" }, signal),
      ).rejects.toMatchObject({
        code: "CHROME_MCP_UNKNOWN_TARGET",
      });
    } finally {
      await broker.close();
    }
  });

  test("replaces a target lost before selection but not one lost after the transaction begins", async () => {
    const workspacePath = await temporaryDirectory("chrome-selection-readiness-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-selection-readiness-runtime-");
    const targets = new Map<string, TestPageTarget>();
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher([]);
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: async (endpoint) => {
        const connection = pageConnection(endpoint, "page-a", process.pid, undefined, targets);
        connections.push(connection);
        return connection;
      },
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      workspacePath,
    });
    const session = await broker.acquire("client-a", "isolated-headless");
    const connection = connections[0];
    if (!connection) throw new Error("Chrome connection was not created");

    const replacement = await session.admit({
      run: async () => {
        targets.delete("page-a");
        connection.emit("Target.targetDestroyed", { targetId: "page-a" });
        const selection = await session.beginSelection();
        expect(selection.initialTarget.targetId).toBe("blank-1");
        return session.rollbackSelection(selection);
      },
    });
    expect(replacement.targetId).toBe("blank-1");

    let userWorkRuns = 0;
    expect(
      session.admit({
        run: async () => {
          userWorkRuns++;
          const selection = await session.beginSelection();
          targets.delete(selection.initialTarget.targetId);
          connection.emit("Target.targetDestroyed", { targetId: selection.initialTarget.targetId });
          return session.commitSelection(selection);
        },
      }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_UNKNOWN_TARGET" });
    expect(userWorkRuns).toBe(1);

    const recovered = await session.admit({ run: async () => session.selectedTarget() });
    expect(recovered.targetId).toBe("blank-2");
    await session.close();
  });

  test("relaunches a disconnected isolated owner, increments generation, and recreates a blank page before the next call", async () => {
    const workspacePath = await temporaryDirectory("chrome-owner-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-owner-runtime-");
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections, { failFirstDisconnectedClose: true });
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: launched.connector,
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      processExitWaitMs: 0,
      processIdentity: async () => "absent",
      processStartIdentity: async () => "chrome-process",
      workspacePath,
    });
    const session = await broker.acquire("client-a", "isolated-headless");
    expect(session.owner.ownerGeneration).toBe(1);
    expect(Bun.file(session.owner.paths.crashMarkerPath).exists()).resolves.toBe(true);
    const route = await session.admit({
      run: () =>
        session.addMutation({
          action: { type: "continue" },
          kind: "route",
          urlPattern: "https://recovery.example.test/*",
        }),
    });
    const disconnectedTarget = session.selectedTarget();
    connections[0]?.emit("Target.targetDestroyed", { targetId: disconnectedTarget.targetId });
    connections[0]?.close();

    const recovered = await session.admit({
      run: () => {
        session.authorizeOwnerClose("browser");
        return Promise.resolve(session.workerConnection());
      },
    });
    expect(recovered.ownerGeneration).toBe(2);
    expect(launched.launches).toBe(2);
    const currentConnection = connections[1];
    if (!currentConnection) throw new Error("Recovered Chrome connection was not created");
    expect(session.listMutations("route")).toEqual([route]);
    expect(currentConnection.commands).toContainEqual(expect.objectContaining({ method: "Fetch.enable" }));
    const selected = session.selectedTarget();
    currentConnection.emit("Target.targetDestroyed", { targetId: selected.targetId });
    const blank = await session.admit({ run: async () => session.selectedTarget() });
    expect(blank).toEqual({ ownerGeneration: 2, targetId: "blank-1" });
    await session.close();
    expect(launched.closes).toBe(2);
    expect(Bun.file(session.owner.paths.crashMarkerPath).exists()).resolves.toBe(false);
  });

  test("retries isolated recovery after a replacement launch fails", async () => {
    const workspacePath = await temporaryDirectory("chrome-owner-retry-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-owner-retry-runtime-");
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections, { failLaunches: [2] });
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: launched.connector,
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      processIdentity: async () => "absent",
      processStartIdentity: async () => "chrome-process",
      workspacePath,
    });
    const session = await broker.acquire("client-a", "isolated-headless");
    connections[0]?.close();

    expect(session.admit({ run: async () => session.workerConnection() })).rejects.toThrow();
    expect(session.owner.ownerGeneration).toBe(1);
    const recovered = await session.admit({ run: async () => session.workerConnection() });
    expect(recovered.ownerGeneration).toBe(2);
    expect(launched.launches).toBe(3);
    await session.close();
    expect(launched.closes).toBe(2);
  });

  test("reattaches main without launching or closing Chrome and increments generation", async () => {
    const workspacePath = await temporaryDirectory("chrome-main-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-main-runtime-");
    const connections: FakeCdpClient[] = [];
    let endpointGeneration = 0;
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: async (endpoint) => {
        const connection = pageConnection(endpoint, `main-page-${connections.length + 1}`);
        connections.push(connection);
        return connection;
      },
      executablePath: process.execPath,
      mainEndpoint: async () => {
        endpointGeneration++;
        return {
          endpoint: `ws://127.0.0.1:9222/devtools/browser/main-${endpointGeneration}`,
          userDataDir: "/unused",
        };
      },
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      workspacePath,
    });
    const first = await broker.acquire("client-a", "main");
    expect(first.owner.ownerGeneration).toBe(1);
    expect(connections[0]?.commands.some((command) => command.method === "Browser.setDownloadBehavior")).toBe(
      false,
    );
    connections[0]?.close();
    const sameSession = await broker.acquire("client-a", "main");
    expect(sameSession).toBe(first);
    expect(sameSession.owner.ownerGeneration).toBe(2);
    expect(endpointGeneration).toBe(2);
    expect(
      sameSession.admit({
        run: () => {
          sameSession.authorizeOwnerClose("browser");
          return Promise.resolve();
        },
      }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN" });
    await sameSession.close();
    expect(
      connections
        .flatMap((connection) => connection.commands)
        .some((command) => command.method === "Browser.close"),
    ).toBe(false);
  });

  test("drains failed final-client mutation cleanup before admitting a new main client", async () => {
    const workspacePath = await temporaryDirectory("chrome-main-cleanup-tombstone-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-main-cleanup-tombstone-runtime-");
    const targets = new Map<string, TestPageTarget>();
    const connections: FakeCdpClient[] = [];
    const bindings = new Set<string>();
    const scripts = new Set<string>();
    let endpointGeneration = 0;
    let nextScript = 1;
    let pageBindingInstalled = false;
    let routesEnabled = false;
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: async (endpoint) => {
        const connectionIndex = connections.length;
        const connection = pageConnection(endpoint, "page-a", process.pid, undefined, targets);
        const command = connection.command;
        connection.command = async (input) => {
          if (connectionIndex <= 1 && input.method === "Fetch.disable") {
            throw new Error("injected persistent main cleanup failure");
          }
          if (input.method === "Fetch.enable") routesEnabled = true;
          if (input.method === "Fetch.disable") routesEnabled = false;
          if (input.method === "Page.addScriptToEvaluateOnNewDocument") {
            const identifier = `persistent-script-${nextScript++}`;
            scripts.add(identifier);
            return { identifier };
          }
          if (
            input.method === "Page.removeScriptToEvaluateOnNewDocument" &&
            typeof input.params.identifier === "string"
          ) {
            scripts.delete(input.params.identifier);
          }
          if (input.method === "Runtime.addBinding" && typeof input.params.name === "string") {
            bindings.add(input.params.name);
          }
          if (input.method === "Runtime.removeBinding" && typeof input.params.name === "string") {
            bindings.delete(input.params.name);
          }
          if (
            input.method === "Runtime.evaluate" &&
            typeof input.params.expression === "string" &&
            input.params.expression.includes("__chromeMcpPersistentBindings")
          ) {
            pageBindingInstalled = !input.params.expression.includes("?.rejectAll(");
          }
          return command(input);
        };
        connections.push(connection);
        return connection;
      },
      executablePath: process.execPath,
      mainEndpoint: async () => ({
        endpoint: `ws://127.0.0.1:9222/devtools/browser/main-${++endpointGeneration}`,
        userDataDir: "/unused",
      }),
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      workspacePath,
    });
    const failedSession = await broker.acquire("client-a", "main");
    await failedSession.addMutation({
      action: { type: "continue" },
      kind: "route",
      urlPattern: "https://api.example.test/*",
    });
    await failedSession.addMutation({ kind: "initScript", source: "globalThis.__persistentInit = true" });
    await failedSession.addMutation({
      kind: "binding",
      name: "persistentHostValue",
      source: "(value) => value",
    });
    expect({ bindings: [...bindings], pageBindingInstalled, routesEnabled, scripts: scripts.size }).toEqual({
      bindings: ["persistentHostValue"],
      pageBindingInstalled: true,
      routesEnabled: true,
      scripts: 2,
    });

    let closeFailure: unknown;
    try {
      await failedSession.close();
    } catch (error: unknown) {
      closeFailure = error;
    }
    expect(closeFailure).toBeInstanceOf(AggregateError);
    if (!(closeFailure instanceof AggregateError)) throw new Error("expected aggregate cleanup failure");
    expect(closeFailure.errors).toHaveLength(2);
    expect(failedSession.mutationRegistry.empty).toBe(false);
    expect({ bindings: [...bindings], pageBindingInstalled, routesEnabled, scripts: scripts.size }).toEqual({
      bindings: ["persistentHostValue"],
      pageBindingInstalled: true,
      routesEnabled: true,
      scripts: 2,
    });

    expect(broker.acquire("client-b", "main")).rejects.toThrow();
    expect({ bindings: [...bindings], pageBindingInstalled, routesEnabled, scripts: scripts.size }).toEqual({
      bindings: [],
      pageBindingInstalled: false,
      routesEnabled: true,
      scripts: 0,
    });

    const cleanSession = await broker.acquire("client-b", "main");
    expect(cleanSession.owner.ownerGeneration).toBe(3);
    expect(cleanSession.listMutations("route")).toEqual([]);
    expect(cleanSession.listMutations("initScript")).toEqual([]);
    expect(cleanSession.listMutations("binding")).toEqual([]);
    expect({ bindings: [...bindings], pageBindingInstalled, routesEnabled, scripts: scripts.size }).toEqual({
      bindings: [],
      pageBindingInstalled: false,
      routesEnabled: false,
      scripts: 0,
    });
    const cleanupMethods = connections
      .slice(1)
      .flatMap((connection) => connection.commands.map((command) => command.method));
    expect(cleanupMethods).toContain("Fetch.disable");
    expect(cleanupMethods).toContain("Page.removeScriptToEvaluateOnNewDocument");
    expect(cleanupMethods).toContain("Runtime.removeBinding");
    await cleanSession.addMutation({
      action: { type: "continue" },
      kind: "route",
      urlPattern: "https://clean.example.test/*",
    });
    expect(cleanSession.listMutations("route")).toHaveLength(1);
    await cleanSession.close();
  });

  test("drains final-client main mutation tombstones before broker shutdown completes", async () => {
    const { broker, connections, effects, releaseFailure, session } =
      await createMainShutdownCleanupFixture();
    expect(releaseFailure).toBeInstanceOf(AggregateError);
    expect(effects()).toEqual({
      bindings: ["shutdownHostValue"],
      pageBindingInstalled: true,
      routesEnabled: true,
      scripts: 2,
    });

    const firstClose = broker.close();
    const concurrentClose = broker.close();
    expect(concurrentClose).toBe(firstClose);
    await firstClose;

    expect(connections).toHaveLength(2);
    expect(effects()).toEqual({
      bindings: [],
      pageBindingInstalled: false,
      routesEnabled: false,
      scripts: 0,
    });
    const cleanupMethods = connections[1]?.commands.map((command) => command.method) ?? [];
    expect(cleanupMethods).toContain("Fetch.disable");
    expect(cleanupMethods).toContain("Page.removeScriptToEvaluateOnNewDocument");
    expect(cleanupMethods).toContain("Runtime.removeBinding");
    expect(broker.acquire("client-b", "main")).rejects.toMatchObject({
      code: "CHROME_MCP_OWNER_CLOSED",
    });
    expect(session.admit({ run: async () => "unexpected" })).rejects.toMatchObject({
      code: "CHROME_MCP_OWNER_CLOSED",
    });
  });

  test("retains shutdown tombstones and aggregates drain and owner-close failures until retry succeeds", async () => {
    const { broker, connections, effects, releaseFailure } = await createMainShutdownCleanupFixture({
      replacementCleanupFailures: 1,
      replacementCloseFailures: 1,
    });
    expect(releaseFailure).toBeInstanceOf(AggregateError);

    let shutdownFailure: unknown;
    try {
      await broker.close();
    } catch (error: unknown) {
      shutdownFailure = error;
    }
    expect(shutdownFailure).toBeInstanceOf(AggregateError);
    expect(effects()).toEqual({
      bindings: [],
      pageBindingInstalled: false,
      routesEnabled: true,
      scripts: 0,
    });
    expect(broker.acquire("client-b", "main")).rejects.toMatchObject({
      code: "CHROME_MCP_OWNER_CLOSED",
    });

    await broker.close();
    expect(connections).toHaveLength(3);
    expect(effects()).toEqual({
      bindings: [],
      pageBindingInstalled: false,
      routesEnabled: false,
      scripts: 0,
    });
    await broker.close();
  });

  test("reports an unaccepted main connection when the published endpoint is listening", async () => {
    const workspacePath = await temporaryDirectory("chrome-main-unavailable-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-main-unavailable-runtime-");
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => undefined } });
    let connectTimeoutMs: number | undefined;
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: (_endpoint, timeoutMs) => {
        connectTimeoutMs = timeoutMs;
        return Promise.reject(new Error("connection rejected"));
      },
      executablePath: process.execPath,
      mainEndpoint: () =>
        Promise.resolve({
          endpoint: `ws://127.0.0.1:${listener.port}/devtools/browser/pending`,
          userDataDir: "/unused",
        }),
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      workspacePath,
    });

    try {
      expect(broker.acquire("client-a", "main")).rejects.toMatchObject({
        code: "CHROME_MCP_MAIN_UNAVAILABLE",
        message: expect.stringContaining("Approval was not observed"),
      });
      expect(connectTimeoutMs).toBe(60_000);
    } finally {
      await broker.close();
      listener.stop(true);
    }
  });

  test("reports a stale main endpoint when nothing listens on the published port", async () => {
    const workspacePath = await temporaryDirectory("chrome-main-stale-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-main-stale-runtime-");
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => undefined } });
    const closedPort = listener.port;
    listener.stop(true);
    const broker = await ChromeBrowserBroker.create({
      executablePath: process.execPath,
      mainEndpoint: () =>
        Promise.resolve({
          endpoint: `ws://127.0.0.1:${closedPort}/devtools/browser/stale`,
          userDataDir: "/unused",
        }),
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      workspacePath,
    });

    try {
      expect(broker.acquire("client-a", "main")).rejects.toMatchObject({
        code: "CHROME_MCP_MAIN_UNAVAILABLE",
        message: expect.stringMatching(/nothing is listening there.*chrome:\/\/inspect\/#remote-debugging/),
      });
    } finally {
      await broker.close();
    }
  });

  test("attaches to the user's own browser in the profile folder the session asks for", async () => {
    const workspacePath = await temporaryDirectory("chrome-main-profile-folder-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-main-profile-folder-runtime-");
    const mainUserDataDir = await temporaryDirectory("chrome-main-profile-folder-profile-");
    await writeFile(
      join(mainUserDataDir, "DevToolsActivePort"),
      "9333\n/devtools/browser/own-browser\n",
      "utf8",
    );
    const endpoints: string[] = [];
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: async (endpoint) => {
        endpoints.push(endpoint);

        return pageConnection(endpoint, "page-a");
      },
      executablePath: process.execPath,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      workspacePath,
    });

    try {
      const session = await broker.acquire("client-a", "main", { mainUserDataDir });
      expect(endpoints).toEqual(["ws://127.0.0.1:9333/devtools/browser/own-browser"]);

      await session.close();
    } finally {
      await broker.close();
    }
  });

  test("refuses the user's own browser for a session configured with another profile folder while one is attached", async () => {
    const workspacePath = await temporaryDirectory("chrome-main-profile-mismatch-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-main-profile-mismatch-runtime-");
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: async (endpoint) => pageConnection(endpoint, "page-a"),
      executablePath: process.execPath,
      mainEndpoint: async () => ({
        endpoint: "ws://127.0.0.1:9222/devtools/browser/main",
        userDataDir: "/unused",
      }),
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      workspacePath,
    });

    try {
      const session = await broker.acquire("client-a", "main", { mainUserDataDir: "/profiles/chromium" });
      expect(
        broker.acquire("client-b", "main", { mainUserDataDir: "/profiles/chrome-beta" }),
      ).rejects.toMatchObject({
        code: "CHROME_MCP_MAIN_UNAVAILABLE",
      });

      await session.close();
    } finally {
      await broker.close();
    }
  });

  test("reports an accepted main connection separately from failed session initialization", async () => {
    const workspacePath = await temporaryDirectory("chrome-main-initialization-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-main-initialization-runtime-");
    const connection = new FakeCdpClient(undefined, async () => {
      throw new Error("Target discovery failed");
    });
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: async () => connection,
      executablePath: process.execPath,
      mainEndpoint: async () => ({ endpoint: connection.endpoint, userDataDir: "/unused" }),
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      workspacePath,
    });
    try {
      expect(broker.acquire("client-a", "main")).rejects.toMatchObject({
        code: "CHROME_MCP_MAIN_UNAVAILABLE",
        message:
          "Chrome accepted the main debugging connection, but session initialization failed: Target discovery failed",
      });
      expect(connection.closed).toBe(true);
    } finally {
      await broker.close();
    }
  });

  test("restores the selected target and every claimed target when main Chrome remains available after recovery", async () => {
    const workspacePath = await temporaryDirectory("chrome-main-target-recovery-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-main-target-recovery-runtime-");
    const targets = new Map<string, TestPageTarget>();
    const connections: FakeCdpClient[] = [];
    let endpointGeneration = 0;
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: async (endpoint) => {
        const connection = pageConnection(endpoint, "page-a", process.pid, undefined, targets);
        connections.push(connection);
        return connection;
      },
      executablePath: process.execPath,
      mainEndpoint: async () => ({
        endpoint: `ws://127.0.0.1:9222/devtools/browser/main-${++endpointGeneration}`,
        userDataDir: "/unused",
      }),
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      workspacePath,
    });
    const session = await broker.acquire("client-a", "main");
    await session.addMutation({
      action: { type: "continue" },
      kind: "route",
      urlPattern: "https://api.example.test/*",
    });
    await session.owner.connection.send("Target.createTarget", { url: "about:blank" });
    await session.owner.observer.synchronizeTargets();
    const selection = await session.beginSelection();
    selection.select(session.owner.registry.identity("blank-1"));
    await session.commitSelection(selection);
    expect(session.owner.mutations.claimedTargetIds("client-a")).toEqual(["page-a", "blank-1"]);

    connections[0]?.close();
    await broker.acquire("client-a", "main");
    expect(session.selectedTarget()).toEqual({ ownerGeneration: 2, targetId: "blank-1" });
    expect(session.owner.mutations.claimedTargetIds("client-a")).toEqual(["page-a", "blank-1"]);
    const recoveredSessions = connections[1]?.commands
      .filter((command) => command.method === "Fetch.enable")
      .map((command) => command.sessionId);
    expect(recoveredSessions).toContainAllValues(["session:page-a", "session:blank-1"]);
    await session.close();
  });

  test("preserves every session registry when replacement reconciliation fails", async () => {
    const workspacePath = await temporaryDirectory("chrome-main-reconcile-retry-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-main-reconcile-retry-runtime-");
    const targets = new Map<string, TestPageTarget>();
    const connections: FakeCdpClient[] = [];
    let endpointGeneration = 0;
    let failSecondClient = true;
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: async (endpoint) => {
        const connectionIndex = connections.length;
        const connection = pageConnection(endpoint, "page-a", process.pid, undefined, targets);
        const command = connection.command;
        connection.command = async (input) => {
          if (
            connectionIndex === 1 &&
            failSecondClient &&
            input.method === "Fetch.enable" &&
            input.sessionId === "session:blank-1"
          ) {
            failSecondClient = false;
            throw new Error("injected replacement reconciliation failure");
          }
          return command(input);
        };
        connections.push(connection);
        return connection;
      },
      executablePath: process.execPath,
      mainEndpoint: async () => ({
        endpoint: `ws://127.0.0.1:9222/devtools/browser/main-${++endpointGeneration}`,
        userDataDir: "/unused",
      }),
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      workspacePath,
    });
    const first = await broker.acquire("client-a", "main");
    await first.owner.connection.send("Target.createTarget", { url: "about:blank" });
    await first.owner.observer.synchronizeTargets();
    const second = await broker.acquire("client-b", "main");
    const secondSelection = await second.beginSelection();
    secondSelection.select(second.owner.registry.identity("blank-1"));
    await second.commitSelection(secondSelection);
    await first.addMutation({
      action: { type: "continue" },
      kind: "route",
      urlPattern: "https://a.example.test/*",
    });
    await second.addMutation({
      action: { type: "continue" },
      kind: "route",
      urlPattern: "https://b.example.test/*",
    });
    connections[0]?.close();

    expect(first.admit({ run: async () => first.workerConnection() })).rejects.toMatchObject({
      code: "CHROME_MCP_MUTATION_FAILED",
    });
    expect(first.listMutations("route")).toHaveLength(1);
    expect(second.listMutations("route")).toHaveLength(1);

    const recovered = await first.admit({ run: async () => first.workerConnection() });
    expect(recovered.ownerGeneration).toBe(3);
    expect(first.selectedTarget().targetId).toBe("page-a");
    expect(second.selectedTarget().targetId).toBe("blank-1");
    await first.close();
    await second.close();
  });

  test("hands a shared lease to a new generation and re-adopts Chrome after only the broker connection disconnects", async () => {
    const workspacePath = await temporaryDirectory("chrome-shared-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-shared-runtime-");
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections);
    let chromeAlive = true;
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: async (endpoint) => {
        const connection = pageConnection(
          endpoint,
          `shared-page-${connections.length + 1}`,
          process.pid,
          () => {
            chromeAlive = false;
          },
        );
        connections.push(connection);
        return connection;
      },
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      processIdentity: async () => (chromeAlive ? "same" : "absent"),
      processStartIdentity: async () => "shared-chrome",
      workspacePath,
    });
    const session = await broker.acquire("client-a", "shared-headless");
    expect(session.owner.ownerGeneration).toBe(1);
    connections[0]?.close();
    const recovered = await session.admit({ run: async () => session.workerConnection() });
    expect(recovered.ownerGeneration).toBe(2);
    expect(launched.launches).toBe(1);
    expect(Bun.file(session.owner.paths.leasePath).exists()).resolves.toBe(true);
    await session.close();
    expect(chromeAlive).toBe(false);
    expect(Bun.file(session.owner.paths.leasePath).exists()).resolves.toBe(false);
  });

  test("restores the selected target and every claimed target when shared Chrome remains available after recovery", async () => {
    const workspacePath = await temporaryDirectory("chrome-shared-target-recovery-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-shared-target-recovery-runtime-");
    const targets = new Map<string, TestPageTarget>();
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections);
    let chromeAlive = true;
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: async (endpoint) => {
        const connection = pageConnection(
          endpoint,
          "page-a",
          process.pid,
          () => {
            chromeAlive = false;
          },
          targets,
        );
        connections.push(connection);
        return connection;
      },
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      processIdentity: async () => (chromeAlive ? "same" : "absent"),
      processStartIdentity: async () => "shared-chrome",
      workspacePath,
    });
    const session = await broker.acquire("client-a", "shared-headless");
    await session.addMutation({
      action: { type: "continue" },
      kind: "route",
      urlPattern: "https://api.example.test/*",
    });
    await session.owner.connection.send("Target.createTarget", { url: "about:blank" });
    await session.owner.observer.synchronizeTargets();
    const selection = await session.beginSelection();
    selection.select(session.owner.registry.identity("blank-1"));
    await session.commitSelection(selection);

    connections[0]?.close();
    await session.admit({ run: async () => session.workerConnection() });
    expect(session.selectedTarget()).toEqual({ ownerGeneration: 2, targetId: "blank-1" });
    expect(session.owner.mutations.claimedTargetIds("client-a")).toEqual(["page-a", "blank-1"]);
    const recoveredSessions = connections[1]?.commands
      .filter((command) => command.method === "Fetch.enable")
      .map((command) => command.sessionId);
    expect(recoveredSessions).toContainAllValues(["session:page-a", "session:blank-1"]);
    expect(launched.launches).toBe(1);
    await session.close();
  });

  test("retains the same shared lease and retries after replacement adoption fails", async () => {
    const workspacePath = await temporaryDirectory("chrome-shared-retry-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-shared-retry-runtime-");
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections);
    let chromeAlive = true;
    let connectionAttempts = 0;
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: async (endpoint) => {
        connectionAttempts++;
        if (connectionAttempts === 2) throw new Error("transient adoption failure");
        const connection = pageConnection(
          endpoint,
          `shared-page-${connections.length + 1}`,
          process.pid,
          () => {
            chromeAlive = false;
          },
        );
        connections.push(connection);
        return connection;
      },
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      processIdentity: async () => (chromeAlive ? "same" : "absent"),
      processStartIdentity: async () => "shared-chrome",
      workspacePath,
    });
    const session = await broker.acquire("client-a", "shared-headless");
    const leasePath = session.owner.paths.leasePath;
    const leaseBefore = JSON.parse(await readFile(leasePath, "utf8"));
    connections[0]?.close();

    expect(session.admit({ run: async () => session.workerConnection() })).rejects.toThrow();
    expect(JSON.parse(await readFile(leasePath, "utf8"))).toMatchObject({ brokerId: leaseBefore.brokerId });
    const recovered = await session.admit({ run: async () => session.workerConnection() });
    expect(recovered.ownerGeneration).toBe(2);
    expect(launched.launches).toBe(1);
    expect(JSON.parse(await readFile(leasePath, "utf8"))).toMatchObject({ brokerId: leaseBefore.brokerId });
    await session.close();
    expect(chromeAlive).toBe(false);
    expect(Bun.file(leasePath).exists()).resolves.toBe(false);
  });

  test("keeps shared recovery retriable when closing the old owner fails", async () => {
    const workspacePath = await temporaryDirectory("chrome-shared-close-retry-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-shared-close-retry-runtime-");
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections, { failFirstDisconnectedClose: true });
    let chromeAlive = true;
    let connectionAttempts = 0;
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: async (endpoint) => {
        connectionAttempts++;
        if (connectionAttempts === 2) throw new Error("transient adoption failure");
        const connection = pageConnection(
          endpoint,
          `shared-page-${connections.length + 1}`,
          process.pid,
          () => {
            chromeAlive = false;
          },
        );
        connections.push(connection);
        return connection;
      },
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      processExitWaitMs: 0,
      processIdentity: async () => (chromeAlive ? "same" : "absent"),
      processStartIdentity: async () => "shared-chrome",
      workspacePath,
    });
    const session = await broker.acquire("client-a", "shared-headless");
    const leasePath = session.owner.paths.leasePath;
    connections[0]?.close();
    expect(session.admit({ run: async () => session.workerConnection() })).rejects.toThrow();

    expect(session.close()).rejects.toThrow();
    expect(Bun.file(leasePath).exists()).resolves.toBe(true);
    const replacementSession = await broker.acquire("client-b", "shared-headless");
    expect(replacementSession.owner.ownerGeneration).toBe(2);
    expect(launched.launches).toBe(1);
    await replacementSession.close();
    expect(chromeAlive).toBe(false);
    expect(Bun.file(leasePath).exists()).resolves.toBe(false);
  });

  test("relaunches a shared browser after the client invalidates its owner", async () => {
    const workspacePath = await temporaryDirectory("chrome-shared-poisoned-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-shared-poisoned-runtime-");
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections);
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: launched.connector,
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      processIdentity: async () => "absent",
      processStartIdentity: async () => "shared-chrome",
      workspacePath,
    });
    const session = await broker.acquire("client-a", "shared-headless");
    session.invalidateOwner();

    const recovered = await session.admit({ run: async () => session.workerConnection() });
    expect(recovered.ownerGeneration).toBe(2);
    expect(launched.launches).toBe(2);
    expect(launched.closes).toBe(1);
    await session.close();
    expect(launched.closes).toBe(2);
  });
});

describe("BrowserOwner shutdown and modal contracts", () => {
  test("releases local client ownership when React connection cleanup fails", async () => {
    const workspacePath = await temporaryDirectory("chrome-owner-react-cleanup-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-owner-react-cleanup-runtime-");
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections);
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: launched.connector,
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      processStartIdentity: async () => "chrome-process",
      workspacePath,
    });
    const session = await broker.acquire("client-a", "shared-headless");
    await session.owner.addClient("client-b", new PersistentMutationRegistry());
    const closeConnection = session.owner.react.closeConnection.bind(session.owner.react);
    Object.defineProperty(session.owner.react, "closeConnection", {
      configurable: true,
      value: () => Promise.reject(new Error("injected React cleanup failure")),
    });

    expect(session.owner.removeClient("client-b")).rejects.toThrow("injected React cleanup failure");
    expect(session.owner.clientCount).toBe(1);

    Object.defineProperty(session.owner.react, "closeConnection", {
      configurable: true,
      value: closeConnection,
    });
    await session.close();
  });

  test("force terminates a launched browser when its context close does not settle", async () => {
    const workspacePath = await temporaryDirectory("chrome-owner-hung-close-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-owner-hung-close-runtime-");
    const signals: NodeJS.Signals[] = [];
    let browserAlive = true;
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: async (endpoint) => pageConnection(endpoint, "page-a", 555),
      env: {},
      executablePath: process.execPath,
      launcher: {
        launch: async (options) => {
          await writeFile(
            join(options.userDataDir, "DevToolsActivePort"),
            "9222\n/devtools/browser/hung-close\n",
          );
          return {
            close: () => Promise.withResolvers<void>().promise,
            pageViewport: () => Promise.resolve(options.viewport),
          };
        },
      },
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      processExitWaitMs: 10,
      processIdentity: async () => (browserAlive ? "same" : "absent"),
      processStartIdentity: async () => "chrome-process",
      signalProcess: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") browserAlive = false;
      },
      workspacePath,
    });
    const session = await broker.acquire("client-a", "isolated-headless");

    await session.close();

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(browserAlive).toBe(false);
  });

  test("authorizes owner close only while the admitted client has exclusive ownership", async () => {
    const workspacePath = await temporaryDirectory("chrome-owner-close-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-owner-close-runtime-");
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections);
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: launched.connector,
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      processStartIdentity: () => Promise.resolve("chrome-process"),
      workspacePath,
    });
    const session = await broker.acquire("client-a", "shared-headless");

    const result = await session.admit({
      run: () => {
        session.authorizeOwnerClose("browser");
        const queuedClient = session.owner.addClient("client-b", new PersistentMutationRegistry());
        expect(session.owner.admission.pending).toBe(1);
        let failure: unknown;
        try {
          session.authorizeOwnerClose("browser");
        } catch (error: unknown) {
          failure = error;
        }
        return Promise.resolve({ failure, queuedClient });
      },
    });
    expect(result.failure).toMatchObject({ code: "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN" });
    await result.queuedClient;

    await session.admit({
      run: () => {
        expect(() => session.authorizeOwnerClose("default-context")).toThrow();
        return Promise.resolve();
      },
    });
    await session.owner.removeClient("client-b");
    await session.admit({
      run: () => {
        let failure: unknown;
        try {
          session.authorizeOwnerClose("browser");
        } catch (error: unknown) {
          failure = error;
        }
        expect(failure).toMatchObject({
          code: "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
        });
        return Promise.resolve();
      },
    });
    await session.close();
  });

  test.each([
    ["isolated", {}],
    ["isolated-headless", {}],
    ["isolated-virtual-display", { nativeDeviceScaleFactor: 1 }],
  ] as const)(
    "closes a reused %s owner only while its client is exclusive and nothing is queued",
    async (mode, launch) => {
      const workspacePath = await temporaryDirectory("chrome-owner-reused-close-workspace-");
      const runtimeRoot = await temporaryDirectory("chrome-owner-reused-close-runtime-");
      const connections: FakeCdpClient[] = [];
      const launched = writingLauncher(connections);
      const broker = await ChromeBrowserBroker.create({
        cdpConnector: launched.connector,
        env: {},
        executablePath: process.execPath,
        launcher: launched.launcher,
        onError: () => undefined,
        pathOptions: { dataHome: runtimeRoot, runtimeRoot },
        processStartIdentity: () => Promise.resolve("chrome-process"),
        workspacePath,
      });

      const session = await broker.acquire("client-a", mode, launch);
      await session.admit({ run: () => Promise.resolve() });

      const admission = await session.admit({
        run: () => {
          session.authorizeOwnerClose("browser");
          session.authorizeOwnerClose("default-context");

          const queuedClient = session.owner.addClient("client-b", new PersistentMutationRegistry());
          expect(() => session.authorizeOwnerClose("browser")).toThrow();
          return Promise.resolve({ queuedClient });
        },
      });
      await admission.queuedClient;

      expect(
        session.admit({
          run: () => {
            session.authorizeOwnerClose("default-context");
            return Promise.resolve();
          },
        }),
      ).rejects.toMatchObject({ code: "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN" });

      await session.owner.removeClient("client-b");

      expect(
        session.admit({
          run: () => {
            session.authorizeOwnerClose("browser");
            return Promise.resolve();
          },
        }),
      ).resolves.toBeUndefined();

      await session.close();
    },
  );

  test("closes a zero-session owner and aggregates mutation cleanup with browser close failures", async () => {
    const workspacePath = await temporaryDirectory("chrome-owner-aggregate-cleanup-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-owner-aggregate-cleanup-runtime-");
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections, { failCloses: true });
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: launched.connector,
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      processStartIdentity: async () => "chrome-process",
      workspacePath,
    });
    const session = await broker.acquire("client-a", "isolated-headless");
    await session.addMutation({
      action: { type: "continue" },
      kind: "route",
      urlPattern: "https://api.example.test/*",
    });
    const connection = connections[0];
    if (!connection) throw new Error("Chrome connection was not created");
    const command = connection.command;
    connection.command = (input) =>
      input.method === "Fetch.disable" ?
        Promise.reject(new Error("injected mutation cleanup failure"))
      : command(input);

    let failure: unknown;
    try {
      await session.close();
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("expected aggregate cleanup failure");
    expect(failure.errors).toHaveLength(2);
    expect(launched.closes).toBe(1);
    expect(session.mutationRegistry.entries("route")).toHaveLength(1);
    expect(session.owner.mutations.claimedTargetIds("client-a")).toEqual([session.selectedTarget().targetId]);
  });

  test("keeps crash metadata and the profile lease when adopted Chrome exit cannot be proved", async () => {
    const root = await temporaryDirectory("chrome-adopted-owner-");
    const workspaceHash = "a".repeat(64);
    const key = createOwnerKey("shared-headless", workspaceHash, "client-a");
    const paths = resolveChromeRuntimePaths(key, {
      dataHome: join(root, "data"),
      runtimeRoot: join(root, "runtime"),
    });
    await writeBrowserOwnerMetadata(paths.ownerMetadataPath, {
      browserPid: 333,
      cleanShutdown: false,
      endpoint: "ws://127.0.0.1:9222/devtools/browser/adopted",
      mode: "shared-headless",
      ownerGeneration: 1,
      processStartIdentity: "chrome-start",
      profilePathHash: profilePathHash(paths.userDataDir),
      updatedAt: new Date().toISOString(),
    });
    const connection = pageConnection("ws://127.0.0.1:9222/devtools/browser/adopted", "page-a", 333);
    const owner = await BrowserOwner.create({
      cdpConnector: async () => connection,
      executablePath: process.execPath,
      key,
      onError: () => undefined,
      paths,
      processExitWaitMs: 0,
      processIdentity: async () => "same",
      processStartIdentity: async () => "chrome-start",
    });
    await owner.addClient("client-a", new PersistentMutationRegistry());
    expect(
      owner.admit("client-a", {
        run: () => {
          owner.authorizeClose("client-a", "browser");
          return Promise.resolve();
        },
      }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN" });
    await owner.removeClient("client-a");
    expect(Bun.file(paths.crashMarkerPath).exists()).resolves.toBe(true);
    expect(owner.close()).rejects.toThrow();
    expect(JSON.parse(await readFile(paths.ownerMetadataPath, "utf8"))).toMatchObject({
      cleanShutdown: false,
    });
    expect(Bun.file(paths.leasePath).exists()).resolves.toBe(true);
    expect(Bun.file(paths.crashMarkerPath).exists()).resolves.toBe(true);
  });

  test("marks an adopted owner clean and releases its lease only after exact process exit", async () => {
    const root = await temporaryDirectory("chrome-adopted-clean-");
    const workspaceHash = "b".repeat(64);
    const key = createOwnerKey("shared-headless", workspaceHash, "client-a");
    const paths = resolveChromeRuntimePaths(key, {
      dataHome: join(root, "data"),
      runtimeRoot: join(root, "runtime"),
    });
    await writeBrowserOwnerMetadata(paths.ownerMetadataPath, {
      browserPid: 444,
      cleanShutdown: false,
      endpoint: "ws://127.0.0.1:9222/devtools/browser/adopted-clean",
      mode: "shared-headless",
      ownerGeneration: 1,
      processStartIdentity: "chrome-start",
      profilePathHash: profilePathHash(paths.userDataDir),
      updatedAt: new Date().toISOString(),
    });
    let chromeAlive = true;
    const connection = pageConnection(
      "ws://127.0.0.1:9222/devtools/browser/adopted-clean",
      "page-a",
      444,
      () => {
        chromeAlive = false;
      },
    );
    const owner = await BrowserOwner.create({
      cdpConnector: async () => connection,
      executablePath: process.execPath,
      key,
      onError: () => undefined,
      paths,
      processIdentity: async () => (chromeAlive ? "same" : "absent"),
      processStartIdentity: async () => "chrome-start",
    });
    await owner.close();
    expect(JSON.parse(await readFile(paths.ownerMetadataPath, "utf8"))).toMatchObject({
      cleanShutdown: true,
    });
    expect(Bun.file(paths.leasePath).exists()).resolves.toBe(false);
    expect(Bun.file(paths.crashMarkerPath).exists()).resolves.toBe(false);
  });

  test("rejects diagnostic admission while the selected target has a blocking modal", async () => {
    const workspacePath = await temporaryDirectory("chrome-modal-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-modal-runtime-");
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections);
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: launched.connector,
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      processStartIdentity: async () => "chrome-process",
      workspacePath,
    });
    const session = await broker.acquire("client-a", "isolated-headless");
    const target = session.selectedTarget();
    connections[0]?.emit(
      "Page.javascriptDialogOpening",
      { defaultPrompt: "", message: "Blocked", type: "alert" },
      `session:${target.targetId}`,
    );
    let ran = false;
    expect(
      session.admit({
        modalPolicy: "reject",
        run: async () => {
          ran = true;
        },
      }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_BLOCKING_MODAL" });
    expect(ran).toBe(false);
    await session.handleDialog(session.activeDialog()?.dialogId ?? "missing", false);
    await session.close();
  });
});

describe("BrowserOwner download attribution", () => {
  test("keeps the admitted connection after its call returns and publishes delayed completion with full context", async () => {
    const workspacePath = await temporaryDirectory("chrome-download-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-download-runtime-");
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections);
    const published = Promise.withResolvers<DownloadFinishedInput>();
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: launched.connector,
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onDownloadFinished: async (input) => {
        published.resolve(input);
        return { artifactUri: "artifact://connection-a/download", byteCount: 12 };
      },
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      processStartIdentity: async () => "chrome-process",
      workspacePath,
    });
    const session = await broker.acquire("connection-a", "shared-headless");
    const connection = connections[0];
    if (!connection) throw new Error("Chrome connection was not created");
    const target = session.selectedTarget();
    const downloadId = "delayed-download";
    const path = join(session.owner.paths.downloadsPath, downloadId);
    await writeFile(path, "download data");

    await session.admit({
      run: async () => {
        connection.emit("Browser.downloadWillBegin", {
          frameId: `frame:${target.targetId}`,
          guid: downloadId,
          suggestedFilename: "report.txt",
          url: "https://example.test/report.txt",
        });
      },
    });
    connection.emit("Browser.downloadProgress", { guid: downloadId, state: "completed" });

    expect(await published.promise).toEqual({
      browserMode: "shared-headless",
      connectionId: "connection-a",
      downloadId,
      ownerGeneration: 1,
      path,
      suggestedFilename: "report.txt",
      targetId: target.targetId,
    });
    await session.close();
  });

  test("does not cross-publish downloads started by two queued shared clients", async () => {
    const workspacePath = await temporaryDirectory("chrome-download-clients-workspace-");
    const runtimeRoot = await temporaryDirectory("chrome-download-clients-runtime-");
    const connections: FakeCdpClient[] = [];
    const launched = writingLauncher(connections);
    const publications: DownloadFinishedInput[] = [];
    const allPublished = Promise.withResolvers<void>();
    const broker = await ChromeBrowserBroker.create({
      cdpConnector: launched.connector,
      env: {},
      executablePath: process.execPath,
      launcher: launched.launcher,
      onDownloadFinished: async (input) => {
        publications.push(input);
        if (publications.length === 2) allPublished.resolve();
        return {};
      },
      onError: () => undefined,
      pathOptions: { dataHome: runtimeRoot, runtimeRoot },
      processStartIdentity: async () => "chrome-process",
      workspacePath,
    });
    const first = await broker.acquire("connection-a", "shared-headless");
    const second = await broker.acquire("connection-b", "shared-headless");
    const connection = connections[0];
    if (!connection) throw new Error("Chrome connection was not created");
    const targetId = first.selectedTarget().targetId;
    await Promise.all([
      writeFile(join(first.owner.paths.downloadsPath, "download-a"), "a"),
      writeFile(join(first.owner.paths.downloadsPath, "download-b"), "bb"),
    ]);
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const firstAdmission = first.admit({
      run: async () => {
        connection.emit("Browser.downloadWillBegin", {
          frameId: `frame:${targetId}`,
          guid: "download-a",
          suggestedFilename: "a.txt",
          url: "https://example.test/a.txt",
        });
        firstStarted.resolve();
        await releaseFirst.promise;
      },
    });
    await firstStarted.promise;
    const secondAdmission = second.admit({
      run: async () => {
        connection.emit("Browser.downloadWillBegin", {
          frameId: `frame:${targetId}`,
          guid: "download-b",
          suggestedFilename: "b.txt",
          url: "https://example.test/b.txt",
        });
      },
    });
    releaseFirst.resolve();
    await Promise.all([firstAdmission, secondAdmission]);

    connection.emit("Browser.downloadProgress", { guid: "download-b", state: "completed" });
    connection.emit("Browser.downloadProgress", { guid: "download-a", state: "completed" });
    await allPublished.promise;

    expect(
      publications.map(({ connectionId, downloadId }) => ({ connectionId, downloadId })),
    ).toContainAllValues([
      { connectionId: "connection-a", downloadId: "download-a" },
      { connectionId: "connection-b", downloadId: "download-b" },
    ]);
    await first.close();
    await second.close();
  });
});
