import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ExecutionWorkerRequest, SnapshotRootToken } from "./protocol";
import { ChromeMcpExecutionError } from "./errors";
import { connectExecutionBrowserSession, type PublicCdpTransport } from "./playwright-session";

const request = (): ExecutionWorkerRequest => ({
  args: null,
  browserMode: "main",
  callId: "call-1",
  capabilities: {},
  cdpEndpoint: "ws://127.0.0.1/devtools/browser/private",
  code: "return page.url();",
  connectTimeoutMs: 2500,
  dialog: null,
  fileChooser: null,
  selectedTargetId: "target-2",
  state: [],
});

const callPlaywrightMethod = async (value: unknown, methodName: string): Promise<unknown> => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new Error("Expected a Playwright resource");
  }
  const method = Reflect.get(value, methodName);
  if (typeof method !== "function") throw new Error(`Expected a ${methodName} function`);
  return Reflect.apply(method, value, []);
};

const closePlaywrightResource = async (value: unknown): Promise<void> => {
  await callPlaywrightMethod(value, "close");
};

const isObject = (value: unknown): value is object => {
  return (typeof value === "object" || typeof value === "function") && value !== null;
};

const sendCdpCommand = async (value: unknown, method: string): Promise<unknown> => {
  if (!isObject(value)) throw new Error("Expected a CDP session");
  const send = Reflect.get(value, "send");
  if (typeof send !== "function") throw new Error("Expected a CDP send function");
  return Reflect.apply(send, value, [method]);
};

const fakePlaywright = () => {
  let closeCount = 0;
  let contextCloseCount = 0;
  let detachCount = 0;
  let extraContextCloseCount = 0;
  let pageCloseCount = 0;
  const connectCalls: unknown[] = [];
  const openCalls: unknown[] = [];
  const transportMessages: object[] = [];
  const workerReplies = new Map<string, unknown>();
  const workerEvaluationRequested = Promise.withResolvers<void>();
  const browserEvents = new EventEmitter();
  const contextEvents = new EventEmitter();
  const browserSessionCallbacks = new Map<
    number,
    {
      reject: (error: Error) => void;
      resolve: (value: unknown) => void;
    }
  >();
  let browserSessionRequestId = 6;
  let closeOnDownloadBehavior = false;
  const transport: PublicCdpTransport = {
    close: () => undefined,
    send: (message: object) => {
      transportMessages.push(message);
      if (Reflect.get(message, "id") === -9999 && Reflect.get(message, "method") === "Browser.close") {
        transport.onclose?.("browser closed");
      } else if (
        Reflect.get(message, "method") === "Browser.setDownloadBehavior" &&
        closeOnDownloadBehavior
      ) {
        queueMicrotask(() => transport.onclose?.("chrome exited"));
      } else if (Reflect.get(message, "method") === "Browser.setDownloadBehavior") {
        queueMicrotask(() => transport.onmessage?.({ id: Reflect.get(message, "id"), result: {} }));
      } else if (Reflect.get(message, "method") === "Browser.close") {
        queueMicrotask(() =>
          transport.onmessage?.({
            id: Reflect.get(message, "id"),
            result: {},
            sessionId: Reflect.get(message, "sessionId"),
          }),
        );
      } else {
        const method = Reflect.get(message, "method");
        if (method === "Runtime.evaluate") {
          workerEvaluationRequested.resolve();
        }

        const reply = workerReplies.get(method);
        if (reply === undefined) return;

        queueMicrotask(() => {
          if (method === "Target.attachToTarget") {
            transport.onmessage?.({
              method: "Target.attachedToTarget",
              params: { sessionId: "worker-session", targetInfo: { targetId: "worker", type: "worker" } },
            });
          }

          transport.onmessage?.({ id: Reflect.get(message, "id"), result: reply });
        });
      }
    },
  };
  transport.onmessage = (message) => {
    const id = Reflect.get(message, "id");
    if (typeof id !== "number") return;
    const callback = browserSessionCallbacks.get(id);
    if (!callback) return;
    browserSessionCallbacks.delete(id);
    const error = Reflect.get(message, "error");
    if (isObject(error) && typeof Reflect.get(error, "message") === "string") {
      callback.reject(new Error(Reflect.get(error, "message")));
      return;
    }
    callback.resolve(Reflect.get(message, "result"));
  };
  const context = {
    on: contextEvents.on.bind(contextEvents),
    off: contextEvents.off.bind(contextEvents),
    close: () => {
      contextCloseCount += 1;
      return Promise.resolve();
    },
    newCDPSession: async (page: unknown) => ({
      detach: async () => {
        detachCount += 1;
      },
      send: async (method: string) => {
        if (method !== "Target.getTargetInfo") throw new Error(`Unexpected method: ${method}`);
        if (page === page1) return { targetInfo: { targetId: "target-1" } };
        if (page === page2) return { targetInfo: { targetId: "target-2" } };
        throw new Error("Unknown page");
      },
    }),
    pages: () => [page1, page2],
  };
  const nestedLocator = { genuine: "nested-locator" };
  const innerFrame = {
    frameLocator: (selector: string) => ({ unexpectedFrame: selector }),
    locator: (selector: string) =>
      selector === "button.submit" ? nestedLocator : { innerSelector: selector },
  };
  const outerFrame = {
    frameLocator: (selector: string) =>
      selector === "iframe.inner" ? innerFrame : { unexpectedFrame: selector },
    locator: (selector: string) => ({ outerSelector: selector }),
  };
  const page1 = {
    context: () => context,
    frameLocator: (selector: string) =>
      selector === "iframe.outer" ? outerFrame : { unexpectedFrame: selector },
    isClosed: () => false,
    locator: (selector: string) => ({ page: 1, selector }),
    setViewportSize: () => Promise.resolve(),
    viewportSize: () => ({ width: 1280, height: 720 }),
  };
  const page2 = {
    close: () => {
      pageCloseCount += 1;
      return Promise.resolve();
    },
    context: () => context,
    frameLocator: (selector: string) => ({ page: 2, frameSelector: selector }),
    isClosed: () => false,
    locator: (selector: string) => ({ page: 2, selector }),
    setViewportSize: () => Promise.resolve(),
    viewportSize: () => ({ width: 1280, height: 720 }),
  };
  const contexts: unknown[] = [context];
  const browser = {
    on: browserEvents.on.bind(browserEvents),
    off: browserEvents.off.bind(browserEvents),
    close: async () => {
      closeCount += 1;
    },
    contexts: () => [...contexts],
    newBrowserCDPSession: async () => ({
      detach: async () => undefined,
      send: (method: string, params: object = {}) => {
        const id = ++browserSessionRequestId;
        transport.send({ id, method, params, sessionId: "browser-session" });
        return new Promise<unknown>((resolve, reject) => {
          browserSessionCallbacks.set(id, { reject, resolve });
        });
      },
    }),
    newContext: () =>
      Promise.resolve({
        close: () => {
          extraContextCloseCount += 1;
          return Promise.resolve();
        },
      }),
  };
  const module = {
    chromium: {
      connectOverCDP: async (endpoint: unknown, options: unknown) => {
        connectCalls.push({ endpoint, options });
        return browser;
      },
    },
  };
  return {
    browser,
    browserEvents,
    connectCalls,
    context,
    contextEvents,
    contexts,
    closeTransportOnDownloadBehavior: () => {
      closeOnDownloadBehavior = true;
    },
    counts: () => ({ closeCount, contextCloseCount, detachCount, extraContextCloseCount, pageCloseCount }),
    module,
    openCalls,
    nestedLocator,
    openTransport: async (endpoint: string, timeoutMs: number) => {
      openCalls.push({ endpoint, timeoutMs });
      return transport;
    },
    page1,
    page2,
    transport,
    transportMessages,
    workerEvaluationRequested,
    workerReplies,
  };
};

describe("public Playwright CDP session adapter", () => {
  test("rejects a worker without a script URL before attaching or evaluating", async () => {
    const fake = fakePlaywright();
    fake.workerReplies.set("Target.getTargetInfo", {
      targetInfo: { targetId: "worker", type: "worker", url: "" },
    });
    fake.workerReplies.set("Target.attachToTarget", { sessionId: "worker-session" });
    fake.workerReplies.set("Runtime.evaluate", { result: { type: "number", value: 7 } });
    fake.workerReplies.set("Target.detachFromTarget", {});

    const session = await connectExecutionBrowserSession(request(), {
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });

    try {
      expect(
        session.evaluateWorker(
          { targetId: "worker", expression: "self.count" },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: "CHROME_MCP_EXECUTION_FAILED",
        message: expect.stringContaining('Worker target "worker" has an empty URL'),
      });
      expect(
        fake.transportMessages.some((message) => Reflect.get(message, "method") === "Target.attachToTarget"),
      ).toBe(false);
      expect(
        fake.transportMessages.some((message) => Reflect.get(message, "method") === "Runtime.evaluate"),
      ).toBe(false);
    } finally {
      await session.disconnect();
    }
  });

  test("evaluates workers alongside Playwright CDP requests without mixing their replies", async () => {
    const fake = fakePlaywright();
    fake.workerReplies.set("Target.getTargetInfo", {
      targetInfo: { targetId: "worker", type: "worker", url: "https://example.test/worker.js" },
    });
    fake.workerReplies.set("Target.attachToTarget", { sessionId: "worker-session" });
    fake.workerReplies.set("Runtime.evaluate", { result: { type: "object", objectId: "worker-value" } });
    fake.workerReplies.set("Runtime.callFunctionOn", {
      result: {
        deepSerializedValue: {
          type: "object",
          value: [
            ["isValid", { type: "boolean", value: true }],
            ["value", { type: "object", value: [["count", { type: "number", value: 2 }]] }],
          ],
        },
      },
    });
    fake.workerReplies.set("Target.detachFromTarget", {});

    const session = await connectExecutionBrowserSession(request(), {
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });

    const browserSession = await callPlaywrightMethod(session.browser, "newBrowserCDPSession");
    const [first, second, browserReply] = await Promise.all([
      session.evaluateWorker({ targetId: "worker", expression: "self.count" }, new AbortController().signal),
      session.evaluateWorker(
        { targetId: "worker", expression: "Promise.resolve(self.count)" },
        new AbortController().signal,
      ),
      sendCdpCommand(browserSession, "Browser.close"),
    ]);
    expect(first).toEqual({ count: 2 });
    expect(second).toEqual({ count: 2 });
    expect(browserReply).toEqual({});

    expect(
      fake.transportMessages.filter(
        (message) => Reflect.get(message, "method") === "Target.detachFromTarget",
      ),
    ).toHaveLength(2);
    expect(
      fake.transportMessages.filter((message) => Reflect.get(message, "method") === "Runtime.evaluate"),
    ).toMatchObject([{ params: { awaitPromise: true } }, { params: { awaitPromise: true } }]);
    expect(
      fake.transportMessages.filter((message) => Reflect.get(message, "method") === "Runtime.callFunctionOn"),
    ).toMatchObject([
      { params: { objectId: "worker-value", serializationOptions: { serialization: "deep" } } },
      { params: { objectId: "worker-value", serializationOptions: { serialization: "deep" } } },
    ]);

    await session.disconnect();
  });

  test("retains a cancelled worker attachment for the broker's scoped cleanup", async () => {
    const fake = fakePlaywright();
    const controller = new AbortController();
    fake.workerReplies.set("Target.getTargetInfo", {
      targetInfo: { targetId: "worker", type: "worker", url: "https://example.test/worker.js" },
    });
    fake.workerReplies.set("Target.attachToTarget", { sessionId: "worker-session" });

    const session = await connectExecutionBrowserSession(request(), {
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });

    const evaluation = session.evaluateWorker(
      { targetId: "worker", expression: "while (true) {}" },
      controller.signal,
    );
    await fake.workerEvaluationRequested.promise;
    controller.abort();
    expect(evaluation).rejects.toMatchObject({ code: "CHROME_MCP_CANCELLED" });
    expect(
      fake.transportMessages.some((message) => Reflect.get(message, "method") === "Target.detachFromTarget"),
    ).toBe(false);

    await session.disconnect();
  });

  test("preserves a finite negative zero encoded by Chrome's remote value", async () => {
    const fake = fakePlaywright();
    fake.workerReplies.set("Target.getTargetInfo", {
      targetInfo: { targetId: "worker", type: "worker", url: "https://example.test/worker.js" },
    });
    fake.workerReplies.set("Target.attachToTarget", { sessionId: "worker-session" });
    fake.workerReplies.set("Runtime.evaluate", { result: { type: "number", unserializableValue: "-0" } });
    fake.workerReplies.set("Target.detachFromTarget", {});

    const session = await connectExecutionBrowserSession(request(), {
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });
    const value = await session.evaluateWorker(
      { targetId: "worker", expression: "-0" },
      new AbortController().signal,
    );
    expect(Object.is(value, -0)).toBe(true);

    await session.disconnect();
  });

  test("rejects a worker result when cancellation arrives before its continuation", async () => {
    const fake = fakePlaywright();
    const controller = new AbortController();
    fake.workerReplies.set("Target.getTargetInfo", {
      targetInfo: { targetId: "worker", type: "worker", url: "https://example.test/worker.js" },
    });
    fake.workerReplies.set("Target.attachToTarget", { sessionId: "worker-session" });

    const session = await connectExecutionBrowserSession(request(), {
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });
    const evaluation = session.evaluateWorker(
      { targetId: "worker", expression: "self.count" },
      controller.signal,
    );
    await fake.workerEvaluationRequested.promise;

    const command = fake.transportMessages.find(
      (message) => Reflect.get(message, "method") === "Runtime.evaluate",
    );
    assert(command, "Worker evaluation command missing");

    fake.transport.onmessage?.({
      id: Reflect.get(command, "id"),
      result: { result: { type: "number", value: 7 } },
    });
    controller.abort();
    expect(evaluation).rejects.toMatchObject({ code: "CHROME_MCP_CANCELLED" });

    await session.disconnect();
  });

  test("rejects an evaluation when its dedicated worker detaches", async () => {
    const fake = fakePlaywright();
    fake.workerReplies.set("Target.getTargetInfo", {
      targetInfo: { targetId: "worker", type: "worker", url: "https://example.test/worker.js" },
    });
    fake.workerReplies.set("Target.attachToTarget", { sessionId: "worker-session" });

    const session = await connectExecutionBrowserSession(request(), {
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });

    const evaluation = session.evaluateWorker(
      { targetId: "worker", expression: "new Promise(() => {})" },
      new AbortController().signal,
    );
    await fake.workerEvaluationRequested.promise;
    fake.transport.onmessage?.({
      method: "Target.detachedFromTarget",
      params: { sessionId: "worker-session" },
    });
    expect(evaluation).rejects.toMatchObject({
      code: "CHROME_MCP_EXECUTION_FAILED",
      message: "Worker target detached during evaluation",
    });
    expect(
      fake.transportMessages.some((message) => Reflect.get(message, "method") === "Target.detachFromTarget"),
    ).toBe(false);

    await session.disconnect();
  });

  test("attaches with public options and resolves the selected target through CDP", async () => {
    const fake = fakePlaywright();
    const session = await connectExecutionBrowserSession(request(), {
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });

    expect(fake.connectCalls).toEqual([
      {
        endpoint: fake.transport,
        options: { isLocal: true, noDefaults: true, timeout: expect.any(Number) },
      },
    ]);
    expect(fake.openCalls).toEqual([
      { endpoint: "ws://127.0.0.1/devtools/browser/private", timeoutMs: 2500 },
    ]);
    expect(session.browser).toBe(fake.browser);
    expect(session.context).toBe(fake.context);
    expect(session.page).toBe(fake.page2);
    expect(await session.targetIdForPage(fake.page1)).toBe("target-1");
    expect(
      await session.locatorFromRecipe({ frameChain: [], selector: "#submit", targetId: "target-1" }),
    ).toEqual({
      page: 1,
      selector: "#submit",
    });
    await session.disconnect();
    expect(fake.counts()).toEqual({
      closeCount: 1,
      contextCloseCount: 0,
      detachCount: 4,
      extraContextCloseCount: 0,
      pageCloseCount: 0,
    });
  });

  test("enables download events on Playwright's own session for an owned browser and keeps the reply from Playwright", async () => {
    const fake = fakePlaywright();
    const playwrightMessages: object[] = [];
    fake.transport.onmessage = (message) => playwrightMessages.push(message);
    const session = await connectExecutionBrowserSession(
      { ...request(), browserMode: "isolated", downloadsPath: "/tmp/chrome-mcp/downloads" },
      { loadPlaywright: async () => fake.module, openTransport: fake.openTransport },
    );
    try {
      expect(fake.connectCalls).toEqual([
        {
          endpoint: fake.transport,
          options: {
            artifactsDir: "/tmp/chrome-mcp/downloads",
            isLocal: true,
            noDefaults: true,
            timeout: expect.any(Number),
          },
        },
      ]);
      expect(fake.transportMessages).toEqual([
        {
          id: -9998,
          method: "Browser.setDownloadBehavior",
          params: {
            behavior: "allowAndName",
            downloadPath: "/tmp/chrome-mcp/downloads",
            eventsEnabled: true,
          },
        },
      ]);
      expect(playwrightMessages).toEqual([]);
      fake.transport.onmessage?.({ method: "Browser.downloadWillBegin", params: { guid: "download-1" } });
      expect(playwrightMessages).toEqual([
        { method: "Browser.downloadWillBegin", params: { guid: "download-1" } },
      ]);
    } finally {
      await session.disconnect();
    }
  });

  test("fails the connection when Chrome closes the transport before answering the download request", async () => {
    const fake = fakePlaywright();
    const closeReasons: (string | undefined)[] = [];
    fake.transport.onclose = (reason) => {
      closeReasons.push(reason);
    };
    fake.closeTransportOnDownloadBehavior();
    expect(
      connectExecutionBrowserSession(
        { ...request(), browserMode: "isolated", downloadsPath: "/tmp/chrome-mcp/downloads" },
        { loadPlaywright: async () => fake.module, openTransport: fake.openTransport },
      ),
    ).rejects.toMatchObject({
      code: "CHROME_MCP_BROWSER_DISCONNECTED",
      message: "Chrome CDP connection closed: chrome exited",
    });
    expect(closeReasons).toEqual(["chrome exited"]);
    expect(fake.counts().closeCount).toBe(1);
  });

  test("leaves the user's main browser download policy alone", async () => {
    const fake = fakePlaywright();
    const session = await connectExecutionBrowserSession(request(), {
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });
    try {
      expect(fake.transportMessages).toEqual([]);
    } finally {
      await session.disconnect();
    }
  });

  test("keeps the selected page available when another page closes during viewport restoration", async () => {
    const fake = fakePlaywright();
    const session = await connectExecutionBrowserSession(request(), {
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
      pageViewport: async ({ targetId }) => {
        if (targetId === "target-1") {
          fake.page1.isClosed = () => true;
          throw new Error("Viewport target closed");
        }
        return null;
      },
    });

    try {
      expect(session.page).toBe(fake.page2);
      expect(await session.targetIdForPage(session.page)).toBe("target-2");
    } finally {
      await session.disconnect();
    }
    expect(fake.counts().closeCount).toBe(1);
  });

  test("rejects a selected page that closes while restoring its viewport", async () => {
    const fake = fakePlaywright();
    const failure = new Error("Selected page closed");
    fake.page2.setViewportSize = () => {
      fake.page2.isClosed = () => true;
      return Promise.reject(failure);
    };

    expect(
      connectExecutionBrowserSession(request(), {
        loadPlaywright: async () => fake.module,
        openTransport: fake.openTransport,
        pageViewport: () => Promise.resolve({ width: 960, height: 640 }),
      }),
    ).rejects.toBe(failure);
    expect(fake.counts().closeCount).toBe(1);
  });

  test("preserves viewport failures from another page that remains open", async () => {
    const fake = fakePlaywright();
    const failure = new Error("Viewport read failed");

    expect(
      connectExecutionBrowserSession(request(), {
        loadPlaywright: async () => fake.module,
        openTransport: fake.openTransport,
        pageViewport: async ({ targetId }) => {
          if (targetId === "target-1") {
            throw failure;
          }
          return null;
        },
      }),
    ).rejects.toBe(failure);
    expect(fake.counts().closeCount).toBe(1);
  });

  test.each([
    { name: "fractional", width: 800.5 },
    { name: "negative", width: -1 },
    { name: "too-large", width: 2 ** 31 },
    { name: "non-finite", width: Infinity },
  ])(
    "rejects invalid $name native viewport dimensions without changing the retained size",
    async ({ width }) => {
      const fake = fakePlaywright();
      const session = await connectExecutionBrowserSession(
        { ...request(), browserMode: "isolated-virtual-display" },
        {
          loadPlaywright: async () => fake.module,
          openTransport: fake.openTransport,
          pageViewport: async () => ({ width: 960, height: 640 }),
        },
      );

      try {
        expect(
          Reflect.apply(fake.page2.setViewportSize, fake.page2, [{ width, height: 600 }]),
        ).rejects.toMatchObject({ code: "CHROME_MCP_INVALID_INPUT" });
        expect(fake.page2.viewportSize()).toEqual({ width: 960, height: 640 });
      } finally {
        await session.disconnect();
      }
    },
  );

  test.each(["during", "after"])(
    "waits for a live target registered %s the initial retained-page scan",
    async (timing) => {
      const fake = fakePlaywright();
      const session = await connectExecutionBrowserSession(request(), {
        loadPlaywright: async () => fake.module,
        openTransport: fake.openTransport,
      });
      const scanned = Promise.withResolvers<void>();
      fake.context.pages = () => {
        if (timing === "during") fake.contextEvents.emit("page", fake.page1);
        scanned.resolve();
        return [fake.page2];
      };
      try {
        const lookup = session.pageForTarget("target-1", new AbortController().signal);
        await scanned.promise;
        if (timing === "after") fake.contextEvents.emit("page", fake.page1);
        expect(await lookup).toBe(fake.page1);
      } finally {
        await session.disconnect();
      }
    },
  );

  test.each(["cancellation", "disconnect"])("stops waiting for page registration on %s", async (event) => {
    const fake = fakePlaywright();
    const session = await connectExecutionBrowserSession(request(), {
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });
    const cancellation = new AbortController();
    const scanned = Promise.withResolvers<void>();
    fake.context.pages = () => {
      scanned.resolve();
      return [fake.page2];
    };
    try {
      const lookup = session.pageForTarget("target-1", cancellation.signal);
      await scanned.promise;
      if (event === "disconnect") {
        fake.browserEvents.emit("disconnected");
        expect(lookup).rejects.toMatchObject({ code: "CHROME_MCP_BROWSER_DISCONNECTED" });
      } else {
        cancellation.abort(new ChromeMcpExecutionError("CHROME_MCP_CANCELLED", event));
        expect(lookup).rejects.toBe(cancellation.signal.reason);
      }
    } finally {
      await session.disconnect();
    }
  });

  test("rejects closing a shared owner while leaving page close available", async () => {
    const fake = fakePlaywright();
    const authorizations: string[] = [];
    const session = await connectExecutionBrowserSession(request(), {
      authorizeOwnerClose: (resource) => {
        authorizations.push(resource);
        return Promise.reject(
          new ChromeMcpExecutionError("CHROME_MCP_BROWSER_CLOSE_FORBIDDEN", "shared owner"),
        );
      },
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });

    expect(closePlaywrightResource(session.browser)).rejects.toMatchObject({
      code: "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
    });
    expect(closePlaywrightResource(session.context)).rejects.toMatchObject({
      code: "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
    });
    await closePlaywrightResource(session.page);
    await closePlaywrightResource(await callPlaywrightMethod(session.browser, "newContext"));
    const cdp = await callPlaywrightMethod(session.browser, "newBrowserCDPSession");
    expect(sendCdpCommand(cdp, "Browser.close")).rejects.toMatchObject({
      code: "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
    });
    expect(authorizations).toEqual(["browser", "default-context", "browser"]);
    expect(fake.transportMessages).toEqual([]);
    expect(fake.counts()).toEqual({
      closeCount: 0,
      contextCloseCount: 0,
      detachCount: 2,
      extraContextCloseCount: 1,
      pageCloseCount: 1,
    });
    await session.disconnect();
    expect(fake.counts().closeCount).toBe(1);
  });

  test("allows an exclusive owner to close its browser and default context", async () => {
    const fake = fakePlaywright();
    const authorizations: string[] = [];
    const session = await connectExecutionBrowserSession(request(), {
      authorizeOwnerClose: (resource) => {
        authorizations.push(resource);
        return Promise.resolve();
      },
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });

    await closePlaywrightResource(session.context);
    await closePlaywrightResource(session.browser);

    expect(authorizations).toEqual(["default-context"]);
    expect(fake.transportMessages).toEqual([{ id: -9999, method: "Browser.close", params: {} }]);
    expect(fake.counts()).toEqual({
      closeCount: 0,
      contextCloseCount: 0,
      detachCount: 2,
      extraContextCloseCount: 0,
      pageCloseCount: 0,
    });
    await session.disconnect();
  });

  test("allows raw CDP to close an exclusive owner after authorization", async () => {
    const fake = fakePlaywright();
    const authorizations: string[] = [];
    const session = await connectExecutionBrowserSession(request(), {
      authorizeOwnerClose: (resource) => {
        authorizations.push(resource);
        return Promise.resolve();
      },
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });

    const cdp = await callPlaywrightMethod(session.browser, "newBrowserCDPSession");
    await sendCdpCommand(cdp, "Browser.close");

    expect(authorizations).toEqual(["browser"]);
    expect(fake.transportMessages).toEqual([
      {
        id: 7,
        method: "Browser.close",
        params: {},
        sessionId: "browser-session",
      },
    ]);
    await session.disconnect();
  });

  test("reconstructs a nested-frame recipe as the genuine public Playwright Locator", async () => {
    const fake = fakePlaywright();
    const session = await connectExecutionBrowserSession(request(), {
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });

    const locator = await session.locatorFromRecipe({
      frameChain: ["iframe.outer", "iframe.inner"],
      selector: "button.submit",
      targetId: "target-1",
    });

    expect(locator).toBe(fake.nestedLocator);
    await session.disconnect();
  });

  test("rejects a page that is outside the attached browser", async () => {
    const fake = fakePlaywright();
    const session = await connectExecutionBrowserSession(request(), {
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });
    expect(session.targetIdForPage({ foreign: true })).rejects.toMatchObject({
      code: "CHROME_MCP_FOREIGN_PAGE",
    });
    await session.disconnect();
  });

  test("rejects a page from a context the call created, before reading its target", async () => {
    const fake = fakePlaywright();
    const session = await connectExecutionBrowserSession(request(), {
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });
    const callContext = {
      newCDPSession: async () => {
        throw new Error("target of a call-created page must not be read");
      },
      pages: () => [callPage],
    };
    const callPage = {
      context: () => callContext,
      frameLocator: () => undefined,
      isClosed: () => false,
      locator: () => undefined,
    };
    fake.contexts.push(callContext);

    expect(session.targetIdForPage(callPage)).rejects.toMatchObject({
      code: "CHROME_MCP_FOREIGN_PAGE",
      message: expect.stringContaining("context created by this call"),
    });
    expect(await session.targetIdForPage(fake.page2)).toBe("target-2");
    await session.disconnect();
  });

  test("marks and restores a snapshot root without leaving a persistent attribute", async () => {
    const fake = fakePlaywright();
    const session = await connectExecutionBrowserSession(request(), {
      loadPlaywright: async () => fake.module,
      openTransport: fake.openTransport,
    });
    const attributes = new Map<string, string>([["data-chrome-mcp-snapshot-root", "original"]]);
    const element = {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      hasAttribute: (name: string) => attributes.has(name),
      removeAttribute: (name: string) => {
        attributes.delete(name);
      },
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value);
      },
    };
    const locator = {
      evaluate: async (
        callback: (node: typeof element, argument: Record<string, unknown>) => unknown,
        argument: Record<string, unknown>,
      ) => callback(element, argument),
    };
    const token: SnapshotRootToken = {
      attributeName: "data-chrome-mcp-snapshot-root",
      attributeValue: "temporary",
      kind: "temporary-attribute",
    };

    const restore = await session.markSnapshotRoot(locator, token);
    expect(attributes.get(token.attributeName)).toBe("temporary");
    await restore();
    expect(attributes.get(token.attributeName)).toBe("original");
    await session.disconnect();
  });

  test("fails explicitly when playwright-core lacks the public Chromium API", async () => {
    const fake = fakePlaywright();
    expect(
      connectExecutionBrowserSession(request(), {
        loadPlaywright: async () => ({}),
        openTransport: fake.openTransport,
      }),
    ).rejects.toMatchObject({
      code: "CHROME_MCP_WORKER_CRASH",
    });
  });

  test("reports a stale selected target without choosing a URL or title fallback", async () => {
    const fake = fakePlaywright();
    const stale = request();
    stale.selectedTargetId = "missing-target";
    expect(
      connectExecutionBrowserSession(stale, {
        loadPlaywright: async () => fake.module,
        openTransport: fake.openTransport,
      }),
    ).rejects.toMatchObject({
      code: "CHROME_MCP_PAGE_CLOSED",
    });
    expect(fake.counts().closeCount).toBe(1);
  });
});
