import { afterEach, describe, expect, mock, test } from "bun:test";
import { CdpCommandError, cdpRecord } from "./cdp-connection";
import { CdpRelay } from "./cdp-relay";
import { FakeCdpClient, type FakeCdpCommand } from "./fake-cdp-client.test-support";

type RelayHarness = {
  connection: FakeCdpClient;
  relay: CdpRelay;
};

type RelaySocket = {
  messages: Record<string, unknown>[];
  next: () => Promise<Record<string, unknown>>;
  send: (message: Record<string, unknown>) => void;
  socket: WebSocket;
  waitForClose: () => Promise<CloseEvent>;
};

const harnesses: RelayHarness[] = [];
const sockets: WebSocket[] = [];

const connectClient = async (relay: Pick<CdpRelay, "endpoint">): Promise<RelaySocket> => {
  const socket = new WebSocket(relay.endpoint);
  sockets.push(socket);
  const messages: Record<string, unknown>[] = [];
  const waiters: ((message: Record<string, unknown>) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const message = cdpRecord(JSON.parse(String(event.data)));
    if (message === undefined) {
      throw new Error("relay sent a non-object message");
    }
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("relay socket failed")), { once: true });
  });
  return {
    messages,
    next: () => {
      const queued = messages.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    send: (message) => socket.send(JSON.stringify(message)),
    socket,
    waitForClose: () => closed,
  };
};

const createRelay = (command?: (command: FakeCdpCommand) => Promise<unknown>): RelayHarness => {
  let nextSession = 1;
  const connection = new FakeCdpClient(undefined, async (request) => {
    if (command) return command(request);
    if (request.method === "Target.attachToBrowserTarget") return { sessionId: `browser-${nextSession++}` };
    if (request.method === "Target.attachToTarget") return { sessionId: `page-${nextSession++}` };
    return { echoed: request.method };
  });
  const harness = { connection, relay: CdpRelay.listen(connection) };
  harnesses.push(harness);
  return harness;
};

test("excludes unavailable and unsupported tabs without blocking healthy worker sessions", async () => {
  const connection = new FakeCdpClient(undefined, async ({ method }) => {
    if (method === "Target.attachToBrowserTarget") return { sessionId: "browser" };
    return {};
  });
  const relay = CdpRelay.listen(connection, (targetId) =>
    targetId === "stalled" ? "Runtime.enable timed out" : undefined,
  );
  harnesses.push({ connection, relay });
  const client = await connectClient(relay);
  client.send({ id: 1, method: "Browser.getVersion" });
  expect(await client.next()).toEqual({ id: 1, result: {} });

  connection.emit(
    "Target.attachedToTarget",
    { sessionId: "stalled-session", targetInfo: { targetId: "stalled", type: "page" } },
    "browser",
  );
  connection.emit(
    "Target.detachedFromTarget",
    { sessionId: "stalled-session", targetId: "stalled" },
    "browser",
  );
  connection.emit(
    "Target.attachedToTarget",
    {
      sessionId: "extension-session",
      targetInfo: { targetId: "extension", type: "page", url: "chrome-extension://example/panel.html" },
    },
    "browser",
  );
  connection.emit(
    "Target.detachedFromTarget",
    { sessionId: "extension-session", targetId: "extension" },
    "browser",
  );
  connection.emit(
    "Target.attachedToTarget",
    { sessionId: "healthy-session", targetInfo: { targetId: "healthy", type: "page" } },
    "browser",
  );

  expect(await client.next()).toMatchObject({
    method: "Target.attachedToTarget",
    params: { sessionId: "healthy-session" },
  });
  expect(connection.commands).toContainEqual({
    method: "Target.detachFromTarget",
    params: { sessionId: "stalled-session" },
    sessionId: "browser",
  });
  expect(connection.commands).toContainEqual({
    method: "Target.detachFromTarget",
    params: { sessionId: "extension-session" },
    sessionId: "browser",
  });

  client.send({ id: 2, method: "Target.attachToTarget", params: { targetId: "stalled", flatten: true } });
  expect(await client.next()).toMatchObject({
    id: 2,
    error: { message: "Chrome target stalled is unavailable: Runtime.enable timed out" },
  });

  client.send({ id: 3, method: "Page.getFrameTree", sessionId: "healthy-session" });
  expect(await client.next()).toEqual({ id: 3, result: {}, sessionId: "healthy-session" });

  client.send({
    id: 4,
    method: "Target.attachToTarget",
    params: { targetId: "stalled" },
    sessionId: "foreign",
  });
  expect(await client.next()).toMatchObject({
    id: 4,
    error: { message: "Session with given id not found." },
  });

  client.send({
    id: 5,
    method: "Target.attachToTarget",
    params: { targetId: "stalled", flatten: true },
    sessionId: "healthy-session",
  });
  expect(await client.next()).toMatchObject({
    id: 5,
    sessionId: "healthy-session",
    error: { message: "Chrome target stalled is unavailable: Runtime.enable timed out" },
  });
  expect(connection.closed).toBe(false);
});

const attachedCommands = (connection: FakeCdpClient) =>
  connection.commands.filter((command) => command.method === "Target.attachToBrowserTarget").length;

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const harness of harnesses.splice(0)) {
    harness.relay.close();
    harness.connection.close();
  }
});

describe("CdpRelay", () => {
  test("quiesces native interception and aborts every paused request before detaching a worker", async () => {
    const quiesced = Promise.withResolvers<unknown>();
    const { connection, relay } = createRelay(async ({ method, params }) => {
      if (method === "Target.attachToBrowserTarget") return { sessionId: crypto.randomUUID() };
      if (method === "Target.attachToTarget") return { sessionId: String(params.targetId) };

      const isQuiescing =
        method === "Fetch.enable" && Array.isArray(params.patterns) && params.patterns.length === 0;
      if (isQuiescing) return quiesced.promise;

      return {};
    });
    const scope = relay.createScope();
    const worker = await connectClient(scope);
    const unrelated = await connectClient(relay);
    worker.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "page" } });
    unrelated.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "unrelated" } });
    await Promise.all([worker.next(), unrelated.next()]);

    connection.emit(
      "Target.attachedToTarget",
      { sessionId: "frame", targetInfo: { type: "iframe" } },
      "page",
    );
    await worker.next();
    connection.emit("Fetch.requestPaused", { requestId: "same-id" }, "page");
    connection.emit("Fetch.requestPaused", { requestId: "same-id" }, "frame");
    connection.emit("Fetch.requestPaused", { requestId: "unrelated" }, "unrelated");
    await Promise.all([worker.next(), worker.next(), unrelated.next()]);
    worker.socket.close();
    await worker.waitForClose();

    const stopping = connection.waitForCommand("Fetch.enable");
    const cleanup = scope.close();
    expect(await stopping).toMatchObject({ params: { patterns: [], handleAuthRequests: false } });
    expect(connection.commands.some(({ method }) => method === "Target.detachFromTarget")).toBe(false);
    connection.emit("Fetch.requestPaused", { requestId: "late" }, "page");
    quiesced.resolve({});
    await cleanup;

    const aborted = connection.commands.filter(({ method }) => method === "Fetch.failRequest");
    expect(aborted).toHaveLength(3);
    expect(aborted).toEqual(
      expect.arrayContaining([
        {
          method: "Fetch.failRequest",
          params: { requestId: "same-id", errorReason: "Aborted" },
          sessionId: "page",
        },
        {
          method: "Fetch.failRequest",
          params: { requestId: "late", errorReason: "Aborted" },
          sessionId: "page",
        },
        {
          method: "Fetch.failRequest",
          params: { requestId: "same-id", errorReason: "Aborted" },
          sessionId: "frame",
        },
      ]),
    );
    expect(connection.commands.at(-1)?.method).toBe("Target.detachFromTarget");
    expect(connection.forwardedSessions.has("page")).toBe(false);
    expect(connection.forwardedSessions.has("unrelated")).toBe(true);
  });

  test.each([
    ["Fetch.continueRequest", 0],
    ["Fetch.continueResponse", 0],
    ["Fetch.fulfillRequest", 0],
    ["Fetch.failRequest", 1],
  ] as const)(
    "preserves an explicit %s completed after the worker disconnects",
    async (method, abortCount) => {
      const resolved = Promise.withResolvers<unknown>();
      const { connection, relay } = createRelay(async ({ method: operation }) => {
        if (operation === "Target.attachToBrowserTarget") return { sessionId: "browser" };
        if (operation === "Target.attachToTarget") return { sessionId: "page" };
        if (operation === method) return resolved.promise;

        return {};
      });
      const scope = relay.createScope();
      const worker = await connectClient(scope);
      worker.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "page" } });
      await worker.next();
      connection.emit("Fetch.requestPaused", { requestId: "resolved" }, "page");
      await worker.next();

      const resolving = connection.waitForCommand(method);
      worker.send({ id: 2, method, params: { requestId: "resolved" }, sessionId: "page" });
      await resolving;
      worker.socket.close();
      await worker.waitForClose();
      resolved.resolve({});
      await scope.close();

      expect(
        connection.commands.filter(({ method: operation }) => operation === "Fetch.failRequest"),
      ).toHaveLength(abortCount);
      expect(connection.forwardedSessions.size).toBe(0);
    },
  );

  test.each(["Fetch.enable", "Fetch.failRequest"])(
    "retains paused sessions when cleanup %s fails",
    async (failedMethod) => {
      const { connection, relay } = createRelay(async ({ method }) => {
        if (method === "Target.attachToBrowserTarget") return { sessionId: "browser" };
        if (method === "Target.attachToTarget") return { sessionId: "page" };
        if (method === failedMethod) {
          throw new Error("cleanup refused");
        }

        return {};
      });
      const scope = relay.createScope();
      const worker = await connectClient(scope);
      worker.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "page" } });
      await worker.next();
      connection.emit("Fetch.requestPaused", { requestId: "held" }, "page");
      await worker.next();

      expect(scope.close()).rejects.toMatchObject({
        code: "CHROME_MCP_TIMEOUT",
        message: expect.stringContaining("request cleanup"),
      });
      expect(connection.commands.some(({ method }) => method === "Target.detachFromTarget")).toBe(false);
      expect(connection.forwardedSessions.has("page")).toBe(true);
      expect(connection.closed).toBe(false);
    },
  );

  test("keeps a later pause with the same request ID when an earlier continuation completes", async () => {
    const continued = Promise.withResolvers<unknown>();
    const { connection, relay } = createRelay(async ({ method }) => {
      if (method === "Target.attachToBrowserTarget") return { sessionId: "browser" };
      if (method === "Target.attachToTarget") return { sessionId: "page" };
      if (method === "Fetch.continueRequest") return continued.promise;

      return {};
    });
    const scope = relay.createScope();
    const worker = await connectClient(scope);
    worker.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "page" } });
    await worker.next();
    connection.emit("Fetch.requestPaused", { requestId: "redirected" }, "page");
    await worker.next();

    const continuing = connection.waitForCommand("Fetch.continueRequest");
    worker.send({
      id: 2,
      method: "Fetch.continueRequest",
      params: { requestId: "redirected" },
      sessionId: "page",
    });
    await continuing;
    connection.emit("Fetch.requestPaused", { requestId: "redirected" }, "page");
    await worker.next();
    continued.resolve({});
    await worker.next();
    await scope.close();

    expect(connection.commands).toContainEqual({
      method: "Fetch.failRequest",
      params: { requestId: "redirected", errorReason: "Aborted" },
      sessionId: "page",
    });
  });

  test("accepts a request already cancelled by Chrome and cancels a paused authentication challenge", async () => {
    const { connection, relay } = createRelay(async ({ method }) => {
      if (method === "Target.attachToBrowserTarget") return { sessionId: "browser" };
      if (method === "Target.attachToTarget") return { sessionId: "page" };
      if (method === "Fetch.failRequest") {
        throw new CdpCommandError("Invalid InterceptionId.", -32_602);
      }

      return {};
    });
    const scope = relay.createScope();
    const worker = await connectClient(scope);
    worker.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "page" } });
    await worker.next();
    connection.emit("Fetch.requestPaused", { requestId: "cancelled" }, "page");
    connection.emit("Fetch.authRequired", { requestId: "authentication" }, "page");
    await worker.next();
    await worker.next();
    await scope.close();

    expect(connection.commands).toContainEqual({
      method: "Fetch.continueWithAuth",
      params: { requestId: "authentication", authChallengeResponse: { response: "CancelAuth" } },
      sessionId: "page",
    });
    expect(connection.forwardedSessions.size).toBe(0);
  });

  test("interrupts pending scoped evaluations after crash recovery before releasing a disconnected worker", async () => {
    const pending = Promise.withResolvers<unknown>();
    const termination = Promise.withResolvers<unknown>();
    const { connection, relay } = createRelay(async ({ method, params }) => {
      if (method === "Target.attachToBrowserTarget") return { sessionId: crypto.randomUUID() };
      if (method === "Target.attachToTarget") return { sessionId: String(params.targetId) };
      if (method === "Runtime.callFunctionOn") return pending.promise;
      if (method === "Runtime.terminateExecution") return termination.promise;
      if (method === "Runtime.evaluate") return { result: { value: 0 } };

      return {};
    });
    const scope = relay.createScope();
    const worker = await connectClient(scope);
    const unrelated = await connectClient(relay);
    worker.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "busy" } });
    unrelated.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "unrelated" } });
    await Promise.all([worker.next(), unrelated.next()]);

    connection.emit("Inspector.targetCrashed", {}, "busy");
    connection.emit("Inspector.targetReloadedAfterCrash", {}, "busy");
    await worker.next();
    await worker.next();

    const evaluating = connection.waitForCommand("Runtime.callFunctionOn");
    worker.send({ id: 2, method: "Runtime.callFunctionOn", sessionId: "busy" });
    await evaluating;

    worker.socket.close();
    await worker.waitForClose();

    const terminating = connection.waitForCommand("Runtime.terminateExecution");
    let hasFinished = false;
    const cleanup = scope.close().then(() => {
      hasFinished = true;
    });
    expect(await terminating).toEqual({
      method: "Runtime.terminateExecution",
      params: {},
      sessionId: "busy",
    });
    expect(hasFinished).toBe(false);
    expect(connection.forwardedSessions.has("busy")).toBe(true);

    termination.resolve({});
    pending.resolve({});
    await cleanup;
    expect(connection.forwardedSessions.has("busy")).toBe(false);
    expect(connection.forwardedSessions.has("unrelated")).toBe(true);
    expect(connection.commands.filter(({ method }) => method === "Runtime.terminateExecution")).toHaveLength(
      1,
    );
    expect(connection.closed).toBe(false);
    const response = await fetch(scope.endpoint.replace("ws:", "http:"));
    expect(response.status).toBe(404);
  });

  test("leaves completed evaluations and host-only waits alone", async () => {
    const { connection, relay } = createRelay();
    const scope = relay.createScope();
    const client = await connectClient(scope);
    client.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "page" } });
    expect(await client.next()).toMatchObject({ result: { sessionId: "page-2" } });

    client.send({ id: 2, method: "Runtime.evaluate", sessionId: "page-2", params: { expression: "4" } });
    await client.next();

    await scope.close();

    expect(connection.commands.some(({ method }) => method === "Runtime.terminateExecution")).toBe(false);
    expect(connection.forwardedSessions.size).toBe(0);
  });

  test("reports failed execution cleanup without claiming the browser was reset", async () => {
    const terminate = mock(() => Promise.resolve({})).mockRejectedValueOnce(
      new Error("termination rejected"),
    );
    const { connection, relay } = createRelay(async ({ method, params }) => {
      if (method === "Target.attachToBrowserTarget") return { sessionId: "browser" };
      if (method === "Target.attachToTarget") return { sessionId: String(params.targetId) };
      if (method === "Runtime.callFunctionOn") return new Promise(() => {});
      if (method === "Runtime.terminateExecution") return terminate();

      return { result: { value: 0 } };
    });
    const scope = relay.createScope();
    const client = await connectClient(scope);
    client.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "failed" } });
    await client.next();

    const evaluating = connection.waitForCommand("Runtime.callFunctionOn");
    client.send({ id: 2, method: "Runtime.callFunctionOn", sessionId: "failed" });
    await evaluating;

    client.send({ id: 3, method: "Target.attachToTarget", params: { targetId: "healthy" } });
    await client.next();

    const nextEvaluation = connection.waitForCommand("Runtime.callFunctionOn");
    client.send({ id: 4, method: "Runtime.callFunctionOn", sessionId: "healthy" });
    await nextEvaluation;

    expect(scope.close()).rejects.toMatchObject({
      code: "CHROME_MCP_TIMEOUT",
      message: expect.stringContaining("browser-side JavaScript may still be running"),
    });
    expect(
      connection.commands
        .filter(({ method }) => method === "Runtime.terminateExecution")
        .map(({ sessionId }) => sessionId),
    ).toEqual(["failed", "healthy"]);
    expect(connection.closed).toBe(false);
    expect(connection.forwardedSessions.size).toBe(0);
  });

  test("does not replace a renderer crash with an execution cleanup timeout", async () => {
    const { connection, relay } = createRelay(async ({ method }) => {
      if (method === "Target.attachToBrowserTarget") return { sessionId: "browser" };
      if (method === "Target.attachToTarget") return { sessionId: "page" };
      if (method === "Runtime.callFunctionOn") return new Promise(() => {});

      return {};
    });
    const scope = relay.createScope();
    const client = await connectClient(scope);
    client.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "page" } });
    await client.next();

    const evaluating = connection.waitForCommand("Runtime.callFunctionOn");
    client.send({ id: 2, method: "Runtime.callFunctionOn", sessionId: "page" });
    await evaluating;
    client.socket.close();
    await client.waitForClose();
    connection.emit("Inspector.targetCrashed", {}, "page");

    await scope.close();

    expect(connection.commands.some(({ method }) => method === "Runtime.terminateExecution")).toBe(false);
    expect(connection.forwardedSessions.size).toBe(0);
  });

  test("serves each client through its own browser session on the single upstream connection", async () => {
    const { connection, relay } = createRelay();
    const first = await connectClient(relay);
    const second = await connectClient(relay);

    first.send({ id: 1, method: "Browser.getVersion" });
    second.send({ id: 7, method: "Target.getTargets", params: { filter: [] } });
    const firstReply = await first.next();
    const secondReply = await second.next();

    expect(attachedCommands(connection)).toBe(2);
    expect(firstReply).toEqual({ id: 1, result: { echoed: "Browser.getVersion" } });
    expect(secondReply).toEqual({ id: 7, result: { echoed: "Target.getTargets" } });
    const forwarded = connection.commands.filter(
      (command) => command.method !== "Target.attachToBrowserTarget",
    );
    expect(forwarded).toEqual([
      { method: "Browser.getVersion", params: {}, sessionId: "browser-1" },
      { method: "Target.getTargets", params: { filter: [] }, sessionId: "browser-2" },
    ]);
  });

  test("routes events by session ownership and hides the browser session envelope", async () => {
    const { connection, relay } = createRelay();
    const first = await connectClient(relay);
    const second = await connectClient(relay);
    first.send({ id: 1, method: "Target.attachToTarget", params: { flatten: true, targetId: "page" } });
    expect(await first.next()).toEqual({ id: 1, result: { sessionId: "page-3" } });

    connection.emit("Target.targetCreated", { targetInfo: { targetId: "root-only" } });
    connection.emit(
      "Target.attachedToTarget",
      { sessionId: "auto-4", targetInfo: { targetId: "page" } },
      "browser-1",
    );
    connection.emit("Runtime.consoleAPICalled", { type: "log" }, "page-3");
    connection.emit("Runtime.consoleAPICalled", { type: "warning" }, "auto-4");
    connection.emit("Target.targetCreated", { targetInfo: { targetId: "for-second" } }, "browser-2");

    expect(await first.next()).toEqual({
      method: "Target.attachedToTarget",
      params: { sessionId: "auto-4", targetInfo: { targetId: "page" } },
    });
    expect(await first.next()).toEqual({
      method: "Runtime.consoleAPICalled",
      params: { type: "log" },
      sessionId: "page-3",
    });
    expect(await first.next()).toEqual({
      method: "Runtime.consoleAPICalled",
      params: { type: "warning" },
      sessionId: "auto-4",
    });
    expect(await second.next()).toEqual({
      method: "Target.targetCreated",
      params: { targetInfo: { targetId: "for-second" } },
    });
    expect(first.messages).toEqual([]);
    expect(second.messages).toEqual([]);
  });

  test("refuses commands for sessions the client does not own", async () => {
    const { connection, relay } = createRelay();
    const first = await connectClient(relay);
    const second = await connectClient(relay);
    first.send({ id: 1, method: "Target.attachToTarget", params: { flatten: true, targetId: "page" } });
    expect(await first.next()).toEqual({ id: 1, result: { sessionId: "page-3" } });

    second.send({ id: 2, method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "page-3" });
    first.send({ id: 3, method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "page-3" });

    expect(await second.next()).toEqual({
      error: { code: -32_001, message: "Session with given id not found." },
      id: 2,
      sessionId: "page-3",
    });
    expect(await first.next()).toEqual({
      id: 3,
      result: { echoed: "Runtime.evaluate" },
      sessionId: "page-3",
    });
    expect(connection.commands.filter((command) => command.method === "Runtime.evaluate")).toHaveLength(1);
  });

  test("forwards permission grants and resets on the owner's root session so they outlive the client", async () => {
    const { connection, relay } = createRelay();
    const client = await connectClient(relay);
    client.send({
      id: 1,
      method: "Browser.grantPermissions",
      params: { permissions: ["clipboardReadWrite"] },
    });
    client.send({ id: 2, method: "Browser.resetPermissions", params: {} });
    client.send({ id: 3, method: "Browser.getVersion" });

    expect(await client.next()).toEqual({ id: 1, result: { echoed: "Browser.grantPermissions" } });
    expect(await client.next()).toEqual({ id: 2, result: { echoed: "Browser.resetPermissions" } });
    expect(await client.next()).toEqual({ id: 3, result: { echoed: "Browser.getVersion" } });
    const forwarded = connection.commands.filter(
      (command) => command.method !== "Target.attachToBrowserTarget",
    );
    expect(forwarded).toEqual([
      {
        method: "Browser.grantPermissions",
        params: { permissions: ["clipboardReadWrite"] },
        sessionId: undefined,
      },
      { method: "Browser.resetPermissions", params: {}, sessionId: undefined },
      { method: "Browser.getVersion", params: {}, sessionId: "browser-1" },
    ]);
  });

  test("queues commands until the browser session exists and detaches it when the client leaves", async () => {
    const attach = Promise.withResolvers<unknown>();
    const { connection, relay } = createRelay((command) => {
      if (command.method === "Target.attachToBrowserTarget") return attach.promise;
      return Promise.resolve({});
    });
    const attaching = connection.waitForCommand("Target.attachToBrowserTarget");
    const client = await connectClient(relay);
    client.send({ id: 1, method: "Browser.getVersion" });
    await attaching;
    expect(connection.commands.map((command) => command.method)).toEqual(["Target.attachToBrowserTarget"]);

    attach.resolve({ sessionId: "browser-late" });
    expect(await client.next()).toEqual({ id: 1, result: {} });
    expect(connection.commands.at(-1)).toEqual({
      method: "Browser.getVersion",
      params: {},
      sessionId: "browser-late",
    });

    const detaching = connection.waitForCommand("Target.detachFromTarget");
    client.socket.close();
    expect(await detaching).toEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "browser-late" },
    });
    expect(relay.clientCount).toBe(0);
  });

  test("detaches a browser session that Chrome grants after its client is gone", async () => {
    const attach = Promise.withResolvers<unknown>();
    const { connection, relay } = createRelay((command) => {
      if (command.method === "Target.attachToBrowserTarget") return attach.promise;
      return Promise.resolve({});
    });
    const attaching = connection.waitForCommand("Target.attachToBrowserTarget");
    const client = await connectClient(relay);
    await attaching;

    relay.close();
    await client.waitForClose();
    expect(relay.clientCount).toBe(0);
    const detaching = connection.waitForCommand("Target.detachFromTarget");
    attach.resolve({ sessionId: "browser-orphan" });

    expect(await detaching).toEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "browser-orphan" },
    });
    expect(connection.forwardedSessions.size).toBe(0);
  });

  test("claims every client session so broker listeners ignore forwarded traffic", async () => {
    const { connection, relay } = createRelay();
    const client = await connectClient(relay);
    client.send({ id: 1, method: "Target.attachToTarget", params: { flatten: true, targetId: "page" } });
    await client.next();
    connection.emit(
      "Target.attachedToTarget",
      { sessionId: "auto-4", targetInfo: { targetId: "worker" } },
      "browser-1",
    );
    await client.next();

    expect(connection.forwardedSessions).toEqual(new Set(["auto-4", "browser-1", "page-2"]));

    client.send({
      id: 2,
      method: "Target.detachFromTarget",
      params: { sessionId: "page-2" },
      sessionId: "page-2",
    });
    await client.next();
    expect(connection.forwardedSessions).toEqual(new Set(["auto-4", "browser-1"]));

    const detaching = connection.waitForCommand("Target.detachFromTarget");
    client.socket.close();
    await detaching;
    expect(connection.forwardedSessions.size).toBe(0);
  });

  test("closes clients when the upstream connection closes", async () => {
    const { connection, relay } = createRelay();
    const client = await connectClient(relay);
    client.send({ id: 1, method: "Browser.getVersion" });
    await client.next();

    connection.close();
    const closed = await client.waitForClose();

    expect(closed.code).toBe(1001);
    expect(relay.closed).toBe(true);
  });
});
