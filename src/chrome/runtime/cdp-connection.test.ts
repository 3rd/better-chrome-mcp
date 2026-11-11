import { afterEach, describe, expect, test } from "bun:test";
import { CDP_METHOD_NOT_FOUND, CdpCommandError, CdpConnection, cdpRecord } from "./cdp-connection";

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

describe("CdpConnection", () => {
  test("correlates command results and routes session-scoped events", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, upgradeServer) {
        if (upgradeServer.upgrade(request)) return;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(socket, message) {
          const parsed: unknown = JSON.parse(String(message));
          const command = cdpRecord(parsed);
          if (command?.method !== "Browser.getVersion" || typeof command.id !== "number") return;
          socket.send(JSON.stringify({ id: command.id, result: { product: "Chrome/144.0" } }));
          socket.send(
            JSON.stringify({
              method: "Runtime.consoleAPICalled",
              params: { type: "log" },
              sessionId: "session-a",
            }),
          );
        },
      },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}`);
    const event = new Promise<{ params: unknown; sessionId: string | undefined }>((resolve) => {
      connection.on("Runtime.consoleAPICalled", (params, sessionId) => resolve({ params, sessionId }));
    });
    expect(await connection.send("Browser.getVersion")).toEqual({ product: "Chrome/144.0" });
    expect(await event).toEqual({ params: { type: "log" }, sessionId: "session-a" });
    connection.close();
    await connection.waitForClose();
  });

  test("rejects pending commands when the local CDP socket closes", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, upgradeServer) {
        if (upgradeServer.upgrade(request)) return;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: { message() {} },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}`);
    const pending = connection.send("Target.getTargets");
    connection.close();
    expect(pending).rejects.toMatchObject({ code: "CHROME_MCP_BROWSER_DISCONNECTED" });
  });

  test("rejects detached-session commands without disconnecting the browser or another session", async () => {
    let survivingCommandId: number | undefined;
    const server = Bun.serve({
      port: 0,
      fetch(request, upgradeServer) {
        if (upgradeServer.upgrade(request)) return;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(socket, message) {
          const command = cdpRecord(JSON.parse(String(message)));
          if (command?.sessionId === "surviving-session" && typeof command.id === "number") {
            survivingCommandId = command.id;
          }
          if (command?.method !== "Browser.getVersion") return;
          if (survivingCommandId === undefined) throw new Error("Surviving command was not sent");
          socket.send(
            JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "closed-session" } }),
          );
          socket.send(
            JSON.stringify({
              id: survivingCommandId,
              result: { alive: true },
              sessionId: "surviving-session",
            }),
          );
          socket.send(JSON.stringify({ id: command.id, result: { product: "Chrome/144.0" } }));
        },
      },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}`);
    try {
      const closed = connection.send("Page.getFrameTree", {}, "closed-session");
      const surviving = connection.send("Page.getFrameTree", {}, "surviving-session");
      const browser = connection.send("Browser.getVersion");
      expect(closed).rejects.toMatchObject({ code: "CHROME_MCP_UNKNOWN_TARGET" });
      expect(await surviving).toEqual({ alive: true });
      expect(await browser).toEqual({ product: "Chrome/144.0" });
      expect(connection.closed).toBe(false);
      expect(connection.poisoned).toBe(false);
    } finally {
      connection.close();
    }
  });

  test("withholds claimed session events from method listeners while still publishing them to event listeners", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, upgradeServer) {
        if (upgradeServer.upgrade(request)) return;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(socket, message) {
          const command = cdpRecord(JSON.parse(String(message)));
          if (command?.method !== "Browser.getVersion" || typeof command.id !== "number") return;
          socket.send(JSON.stringify({ method: "Browser.downloadWillBegin", params: { guid: "broker" } }));
          socket.send(
            JSON.stringify({
              method: "Browser.downloadWillBegin",
              params: { guid: "worker" },
              sessionId: "worker",
            }),
          );
          socket.send(JSON.stringify({ id: command.id, result: {} }));
        },
      },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}`);
    try {
      const observed: (string | undefined)[] = [];
      const published: (string | undefined)[] = [];
      connection.on("Browser.downloadWillBegin", (_params, sessionId) => observed.push(sessionId));
      connection.onAnyEvent(({ sessionId }) => published.push(sessionId));

      connection.claimForwardedSession("worker");
      await connection.send("Browser.getVersion");
      expect(observed).toEqual([undefined]);
      expect(published).toEqual([undefined, "worker"]);

      connection.releaseForwardedSession("worker");
      await connection.send("Browser.getVersion");
      expect(observed).toEqual([undefined, undefined, "worker"]);
    } finally {
      connection.close();
    }
  });

  test("returns forwarded replies without the upstream command id and fails them when the session detaches", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, upgradeServer) {
        if (upgradeServer.upgrade(request)) return;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(socket, message) {
          const command = cdpRecord(JSON.parse(String(message)));
          if (command?.method === "Browser.getVersion" && typeof command.id === "number") {
            socket.send(
              JSON.stringify({ id: command.id, result: { product: "Chrome/144.0" }, sessionId: "worker" }),
            );
          }
          if (command?.method === "Page.getFrameTree") {
            socket.send(
              JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "worker" } }),
            );
          }
        },
      },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}`);
    try {
      const version = await new Promise<Record<string, unknown>>((resolve) => {
        connection.forward({ method: "Browser.getVersion", sessionId: "worker" }, resolve);
      });
      expect(version).toEqual({ result: { product: "Chrome/144.0" }, sessionId: "worker" });

      const detached = await new Promise<Record<string, unknown>>((resolve) => {
        connection.forward({ method: "Page.getFrameTree", sessionId: "worker" }, resolve);
      });
      expect(detached).toEqual({
        error: { code: -32_001, message: "Session with given id not found." },
        sessionId: "worker",
      });

      const released = new Promise<Record<string, unknown>>((resolve) => {
        connection.forward({ method: "Runtime.awaitPromise", sessionId: "worker" }, resolve, null);
      });
      connection.releaseForwardedSession("worker");
      expect(await released).toEqual({
        error: { code: -32_001, message: "Session with given id not found." },
        sessionId: "worker",
      });
      expect(connection.closed).toBe(false);
    } finally {
      connection.close();
    }
  });

  test("rejects a failed command with the protocol error code so callers can tell an unknown method apart", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, upgradeServer) {
        if (upgradeServer.upgrade(request)) {
          return;
        }

        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(socket, message) {
          const command = cdpRecord(JSON.parse(String(message)));
          if (typeof command?.id !== "number") {
            return;
          }

          const error =
            command.method === "Nonexistent.method" ?
              { code: CDP_METHOD_NOT_FOUND, message: "'Nonexistent.method' wasn't found" }
            : { code: -32_602, message: "Invalid parameters" };
          socket.send(JSON.stringify({ id: command.id, error }));
        },
      },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}`);

    try {
      const missing = await connection.send("Nonexistent.method").catch((error: unknown) => error);
      const invalid = await connection.send("Page.captureScreenshot").catch((error: unknown) => error);

      expect(missing instanceof CdpCommandError ? missing.code : undefined).toBe(CDP_METHOD_NOT_FOUND);
      expect(invalid instanceof CdpCommandError ? invalid.code : undefined).toBe(-32_602);
      expect(connection.closed).toBe(false);
    } finally {
      connection.close();
    }
  });

  test("times out an unanswered forward without closing the connection and replies only once for an answered one", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, upgradeServer) {
        if (upgradeServer.upgrade(request)) {
          return;
        }

        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(socket, message) {
          const command = cdpRecord(JSON.parse(String(message)));
          if (command?.method !== "Browser.getVersion" || typeof command.id !== "number") {
            return;
          }

          socket.send(JSON.stringify({ id: command.id, result: {} }));
        },
      },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}`);
    const answered: Record<string, unknown>[] = [];
    const unanswered: Record<string, unknown>[] = [];

    try {
      const timedOut = Promise.withResolvers<void>();
      connection.forward({ method: "Browser.getVersion" }, (reply) => answered.push(reply), 5);
      connection.forward(
        { method: "Never.answered" },
        (reply) => {
          unanswered.push(reply);
          timedOut.resolve();
        },
        5,
      );
      await timedOut.promise;

      expect(answered).toEqual([{ result: {} }]);
      expect(unanswered).toHaveLength(1);
      expect(unanswered[0]).toMatchObject({ error: { code: -32_000 } });
      expect(connection.closed).toBe(false);
      expect(connection.poisoned).toBe(false);
    } finally {
      connection.close();
    }
  });

  test("poisons and closes a CDP connection when a command times out", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, upgradeServer) {
        if (upgradeServer.upgrade(request)) return;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: { message() {} },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}`);

    expect(connection.send("Accessibility.getFullAXTree", {}, undefined, 1)).rejects.toMatchObject({
      code: "CHROME_MCP_BROWSER_DISCONNECTED",
    });
    await connection.waitForClose();
    expect(connection.poisoned).toBe(true);
    expect(connection.closed).toBe(true);
  });

  test("lets target initialization expire without disconnecting healthy targets", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, upgradeServer) {
        if (upgradeServer.upgrade(request)) return;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(socket, message) {
          const command = cdpRecord(JSON.parse(String(message)));
          if (command?.sessionId === "healthy") {
            socket.send(JSON.stringify({ id: command.id, result: { enabled: true }, sessionId: "healthy" }));
          }
        },
      },
    });
    servers.push(server);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.port}`);
    try {
      expect(
        connection.send("Runtime.enable", {}, "unresponsive", {
          milliseconds: 1,
          onTimeout: "reject",
        }),
      ).rejects.toMatchObject({ code: "CHROME_MCP_TIMEOUT" });
      expect(await connection.send("Runtime.enable", {}, "healthy")).toEqual({ enabled: true });
      expect(connection.poisoned).toBe(false);
      expect(connection.closed).toBe(false);
    } finally {
      connection.close();
    }
  });
});
