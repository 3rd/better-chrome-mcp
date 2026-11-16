import { randomBytes } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";

import type { PageViewportState } from "./page-viewport";
import type { ChromeTargetRegistry } from "./target-registry";
import {
  CDP_METHOD_NOT_FOUND,
  CDP_SERVER_ERROR,
  type CdpClient,
  CdpCommandError,
  cdpErrorReply,
  type CdpEventMessage,
  cdpRecord,
  cdpSessionNotFoundReply,
} from "./cdp-connection";
import { ChromeRuntimeError } from "./errors";
import { normalPageTarget } from "./target-observer";

const CDP_INVALID_REQUEST = -32_600;
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
const KEEPALIVE_INTERVAL_MS = 30_000;
const IDLE_TIMEOUT_SECONDS = 960;
const OWNER_SCOPED_BROWSER_METHODS = new Set(["Browser.grantPermissions", "Browser.resetPermissions"]);
const EXECUTION_METHODS = new Set([
  "Runtime.awaitPromise",
  "Runtime.callFunctionOn",
  "Runtime.evaluate",
  "Runtime.runScript",
]);
const FETCH_RESOLUTION_METHODS = new Set([
  "Fetch.continueRequest",
  "Fetch.continueResponse",
  "Fetch.continueWithAuth",
  "Fetch.failRequest",
  "Fetch.fulfillRequest",
]);
const EXECUTION_CLEANUP_TIMEOUT_MS = 5000;

type RelayScope = {
  clients: Set<RelayClient>;
  isClosed: boolean;
};

type PausedFetchRequest = {
  isAuthChallenge: boolean;
};

type HeldRelayMessage = Readonly<{ message: Record<string, unknown>; ready: Promise<void> }>;

type RelayClient = {
  browserSessionId: string | undefined;
  closed: boolean;
  crashedSessions: Set<string>;
  excludedSessions: Set<string>;
  explicitAttachCountsByTargetId: Map<string, number>;
  explicitSessionIdsAwaitingEvent: Set<string>;
  explicitSessionIdsAwaitingReply: Set<string>;
  fetchSessions: Set<string>;
  heldMessages: HeldRelayMessage[];
  pausedRequests: Map<string, Map<string, PausedFetchRequest>>;
  pendingExecutions: Map<number, string>;
  queued: string[];
  scope: RelayScope | undefined;
  sessions: Set<string>;
  socket: ServerWebSocket<RelayClient> | undefined;
};

type CdpRelayOptions = Readonly<{
  defaultViewport?: NonNullable<PageViewportState>;
  unavailableTarget?: ChromeTargetRegistry["unavailableReason"];
}>;

const sendRelayReply = (client: RelayClient, message: Record<string, unknown>): void => {
  if (client.closed) {
    return;
  }
  client.socket?.send(JSON.stringify(message));
};

// The same metrics Playwright sends for a Chrome context viewport, so pages are sized alike on every engine.
const createDeviceMetricsOverride = (viewport: NonNullable<PageViewportState>) => ({
  deviceScaleFactor: 1,
  height: viewport.height,
  mobile: false,
  screenHeight: viewport.height,
  screenOrientation: { angle: 0, type: "landscapePrimary" },
  screenWidth: viewport.width,
  width: viewport.width,
});

export class CdpRelay {
  readonly endpoint: string;

  #clients = new Set<RelayClient>();
  #closed = false;
  #connection: CdpClient;
  #keepAlive: ReturnType<typeof setInterval>;
  #path: string;
  #server: Server<RelayClient>;
  #scopes = new Map<string, RelayScope>();
  #sessionOwners = new Map<string, RelayClient>();
  #stopEvents: () => void;
  private sizedViewport: NonNullable<PageViewportState> | undefined;
  private unavailableTarget: ChromeTargetRegistry["unavailableReason"] | undefined;

  private constructor(connection: CdpClient, options: CdpRelayOptions) {
    this.#connection = connection;
    this.sizedViewport = options.defaultViewport;
    this.unavailableTarget = options.unavailableTarget;
    this.#path = `/cdp/${randomBytes(24).toString("hex")}`;

    this.#server = Bun.serve<RelayClient>({
      fetch: (request, server) => this.#fetch(request, server),
      hostname: "127.0.0.1",
      port: 0,
      websocket: {
        backpressureLimit: MAX_MESSAGE_BYTES,
        close: (socket) => this.#clientClosed(socket.data),
        idleTimeout: IDLE_TIMEOUT_SECONDS,
        maxPayloadLength: MAX_MESSAGE_BYTES,
        message: (socket, data) => this.#clientMessage(socket.data, data),
        open: (socket) => this.#clientOpened(socket),
        perMessageDeflate: false,
      },
    });
    this.endpoint = `ws://127.0.0.1:${this.#server.port}${this.#path}`;
    this.#stopEvents = connection.onAnyEvent((message) => this.#upstreamEvent(message));
    this.#keepAlive = setInterval(() => {
      for (const client of this.#clients) {
        client.socket?.ping();
      }
    }, KEEPALIVE_INTERVAL_MS);
    connection.waitForClose().then(() => this.close());
  }

  static listen(connection: CdpClient, options: CdpRelayOptions = {}): CdpRelay {
    return new CdpRelay(connection, options);
  }

  // Undefined when the relay sizes no pages: for Chrome, or for an engine that rejected the size command as unknown.
  get defaultViewport() {
    return this.sizedViewport;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  createScope() {
    const path = `${this.#path}/${randomBytes(24).toString("hex")}`;
    const scope: RelayScope = { clients: new Set(), isClosed: false };
    this.#scopes.set(path, scope);
    let cleanup: Promise<void> | undefined;

    return {
      endpoint: `ws://127.0.0.1:${this.#server.port}${path}`,
      close: () => {
        cleanup ??= this.#closeScope(path, scope);
        return cleanup;
      },
    };
  }

  async #closeScope(path: string, scope: RelayScope) {
    scope.isClosed = true;

    for (const client of scope.clients) {
      client.socket?.close(1001, "Chrome call completed");
      this.#clientClosed(client);
    }

    const deadline = Date.now() + EXECUTION_CLEANUP_TIMEOUT_MS;
    const failures: unknown[] = [];
    const requestFailures: unknown[] = [];
    const retainedClients = new Set<RelayClient>();

    try {
      for (const client of scope.clients) {
        const sessions = new Set(client.pendingExecutions.values());

        for (const sessionId of sessions) {
          const canTerminateExecution =
            !this.#connection.closed &&
            client.sessions.has(sessionId) &&
            !client.crashedSessions.has(sessionId);
          if (!canTerminateExecution) {
            continue;
          }

          if (![...client.pendingExecutions.values()].includes(sessionId)) {
            continue;
          }

          try {
            await this.#terminateExecution(sessionId, deadline);
          } catch (error: unknown) {
            failures.push(error);
          }
        }

        try {
          await this.#abortPausedRequests(client, deadline);
        } catch (error: unknown) {
          requestFailures.push(error);
          retainedClients.add(client);
        }
      }

      if (requestFailures.length > 0) {
        throw new ChromeRuntimeError(
          "CHROME_MCP_TIMEOUT",
          "Chrome intercepted-request cleanup could not be confirmed; affected CDP sessions remain attached to avoid releasing paused requests. Browser state may be partially changed",
          { cause: new AggregateError([...requestFailures, ...failures], "Chrome request cleanup failed") },
        );
      }

      if (failures.length > 0) {
        throw new ChromeRuntimeError(
          "CHROME_MCP_TIMEOUT",
          "Chrome page-execution cleanup could not be confirmed; browser-side JavaScript may still be running and page state may be partially changed. For isolated-headless, a different browserInstanceId opens a fresh browser without the prior page state",
          { cause: new AggregateError(failures, "Chrome execution cleanup failed") },
        );
      }
    } finally {
      for (const client of scope.clients) {
        if (!retainedClients.has(client)) {
          this.#releaseClient(client);
          scope.clients.delete(client);
        }
      }

      if (scope.clients.size === 0) {
        this.#scopes.delete(path);
      }
    }
  }

  async #abortPausedRequests(client: RelayClient, deadline: number) {
    const send = (method: string, params: Record<string, unknown>, sessionId: string) => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error("Chrome request cleanup deadline expired");
      }

      return this.#connection.send(method, params, sessionId, {
        milliseconds: remainingMs,
        onTimeout: "reject",
      });
    };

    for (const sessionId of client.fetchSessions) {
      await send("Fetch.enable", { patterns: [], handleAuthRequests: false }, sessionId);
    }

    for (const [sessionId, requests] of client.pausedRequests) {
      for (const [requestId, request] of requests) {
        try {
          if (request.isAuthChallenge) {
            await send(
              "Fetch.continueWithAuth",
              { requestId, authChallengeResponse: { response: "CancelAuth" } },
              sessionId,
            );
          } else {
            await send("Fetch.failRequest", { requestId, errorReason: "Aborted" }, sessionId);
          }
        } catch (error: unknown) {
          const hasAlreadyFinished =
            error instanceof CdpCommandError && error.message === "Invalid InterceptionId.";
          if (!hasAlreadyFinished) {
            throw error;
          }
        }

        requests.delete(requestId);
      }
    }
  }

  async #terminateExecution(sessionId: string, deadline: number) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Chrome execution cleanup deadline expired");
    }

    const timeout = { milliseconds: remainingMs, onTimeout: "reject" } as const;
    const termination = this.#connection.send("Runtime.terminateExecution", {}, sessionId, timeout);
    const drain = this.#connection.send(
      "Runtime.evaluate",
      { expression: "0", returnByValue: true },
      sessionId,
      timeout,
    );
    const [terminated, drained] = await Promise.allSettled([termination, drain]);
    if (terminated.status === "rejected") {
      throw terminated.reason;
    }

    if (drained.status === "rejected") {
      const wasDrainTerminated =
        drained.reason instanceof CdpCommandError && drained.reason.message === "Execution was terminated";
      if (!wasDrainTerminated) {
        throw drained.reason;
      }
    }

    const checked = await this.#connection.send(
      "Runtime.evaluate",
      { expression: "0", returnByValue: true },
      sessionId,
      {
        milliseconds: Math.max(1, deadline - Date.now()),
        onTimeout: "reject",
      },
    );
    if (cdpRecord(cdpRecord(checked)?.result)?.value !== 0) {
      throw new Error("Chrome execution cleanup did not restore JavaScript evaluation");
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    clearInterval(this.#keepAlive);
    this.#stopEvents();
    for (const client of this.#clients) {
      client.socket?.close(1001, "Chrome CDP relay closed");
      this.#clientClosed(client);
    }

    for (const scope of this.#scopes.values()) {
      scope.isClosed = true;

      for (const client of scope.clients) {
        this.#releaseClient(client);
      }

      scope.clients.clear();
    }

    this.#scopes.clear();
    this.#server.stop(true);
  }

  #fetch(request: Request, server: Server<RelayClient>): Response | undefined {
    const url = new URL(request.url);
    const scope = this.#scopes.get(url.pathname);
    const isUnavailableScope = scope?.isClosed || (url.pathname !== this.#path && !scope);
    if (isUnavailableScope) {
      return new Response("Not found", { status: 404 });
    }

    const client: RelayClient = {
      browserSessionId: undefined,
      closed: false,
      crashedSessions: new Set(),
      excludedSessions: new Set(),
      explicitAttachCountsByTargetId: new Map(),
      explicitSessionIdsAwaitingEvent: new Set(),
      explicitSessionIdsAwaitingReply: new Set(),
      pendingExecutions: new Map(),
      fetchSessions: new Set(),
      heldMessages: [],
      pausedRequests: new Map(),
      queued: [],
      scope,
      sessions: new Set(),
      socket: undefined,
    };
    if (server.upgrade(request, { data: client })) {
      return undefined;
    }
    return new Response("WebSocket upgrade required", { status: 426 });
  }

  #clientOpened(socket: ServerWebSocket<RelayClient>): void {
    const client = socket.data;
    client.socket = socket;
    if (this.#closed || client.scope?.isClosed) {
      socket.close(1001, "Chrome CDP relay closed");
      return;
    }
    this.#clients.add(client);
    client.scope?.clients.add(client);
    this.#connection.forward({ method: "Target.attachToBrowserTarget" }, (reply) => {
      const sessionId = cdpRecord(reply.result)?.sessionId;
      if (client.closed) {
        if (typeof sessionId === "string") {
          this.#detachBrowserSession(sessionId);
        }
        return;
      }
      if (typeof sessionId !== "string") {
        const message = cdpRecord(reply.error)?.message;
        socket.close(1011, typeof message === "string" ? message : "Chrome refused a browser session");
        return;
      }
      client.browserSessionId = sessionId;
      this.#ownSession(client, sessionId);
      const queued = client.queued.splice(0);
      for (const data of queued) {
        this.#forwardClientMessage(client, data);
      }
    });
  }

  #clientMessage(client: RelayClient, data: Buffer | string): void {
    const text = typeof data === "string" ? data : data.toString("utf8");
    if (client.browserSessionId === undefined) {
      client.queued.push(text);
      return;
    }
    this.#forwardClientMessage(client, text);
  }

  #forwardClientMessage(client: RelayClient, text: string): void {
    const browserSessionId = client.browserSessionId;
    if (client.closed || browserSessionId === undefined) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const message = cdpRecord(parsed);
    if (message === undefined || typeof message.id !== "number") {
      return;
    }
    const id = message.id;
    if (typeof message.method !== "string") {
      this.deliverToClient(client, {
        id,
        ...cdpErrorReply(CDP_INVALID_REQUEST, "Message must have string 'method' property"),
      });
      return;
    }
    const method = message.method;
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    if (sessionId !== undefined && !client.sessions.has(sessionId)) {
      this.deliverToClient(client, { id, ...cdpSessionNotFoundReply(sessionId) });
      return;
    }

    if (method === "Target.attachToTarget") {
      const targetId = cdpRecord(message.params)?.targetId;
      const unavailable = typeof targetId === "string" ? this.unavailableTarget?.(targetId) : undefined;
      if (unavailable) {
        this.deliverToClient(client, {
          id,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...cdpErrorReply(CDP_SERVER_ERROR, `Chrome target ${targetId} is unavailable: ${unavailable}`),
        });
        return;
      }
    }

    const explicitAttachTargetId = method === "Target.attachToTarget" ? cdpRecord(message.params)?.targetId : undefined;
    const tracksExplicitAttach = this.sizedViewport !== undefined && typeof explicitAttachTargetId === "string";
    if (tracksExplicitAttach) {
      const count = client.explicitAttachCountsByTargetId.get(explicitAttachTargetId) ?? 0;
      client.explicitAttachCountsByTargetId.set(explicitAttachTargetId, count + 1);
    }

    const upstreamSessionId =
      sessionId ?? (OWNER_SCOPED_BROWSER_METHODS.has(method) ? undefined : browserSessionId);
    const isScopedFetchEnable =
      client.scope !== undefined && method === "Fetch.enable" && upstreamSessionId !== undefined;
    if (isScopedFetchEnable) {
      client.fetchSessions.add(upstreamSessionId);
    }

    const requestId = cdpRecord(message.params)?.requestId;
    const requests =
      upstreamSessionId === undefined ? undefined : client.pausedRequests.get(upstreamSessionId);
    const pausedRequest =
      typeof requestId === "string" && FETCH_RESOLUTION_METHODS.has(method) ?
        requests?.get(requestId)
      : undefined;

    const isScopedExecution =
      client.scope !== undefined && sessionId !== undefined && EXECUTION_METHODS.has(method);
    if (isScopedExecution) {
      client.pendingExecutions.set(id, sessionId);
    }

    this.#connection.forward(
      { method, params: message.params, sessionId: upstreamSessionId },
      (reply) => {
        client.pendingExecutions.delete(id);

        if (reply.error === undefined) {
          const hasResolvedCurrentPause =
            pausedRequest !== undefined &&
            typeof requestId === "string" &&
            requests?.get(requestId) === pausedRequest;
          if (hasResolvedCurrentPause) {
            requests.delete(requestId);
          }

          const hasDisabledFetch = method === "Fetch.disable" && upstreamSessionId !== undefined;
          if (hasDisabledFetch) {
            client.fetchSessions.delete(upstreamSessionId);
            client.pausedRequests.delete(upstreamSessionId);
          }
        }

        if (client.closed) {
          return;
        }
        if (method === "Target.attachToTarget" || method === "Target.attachToBrowserTarget") {
          const attachedSessionId = cdpRecord(reply.result)?.sessionId;
          if (typeof attachedSessionId === "string") {
            this.#ownSession(client, attachedSessionId);
          }
        }

        if (tracksExplicitAttach) {
          this.settleExplicitAttachReply(client, explicitAttachTargetId, cdpRecord(reply.result)?.sessionId);
        }
        if (method === "Target.detachFromTarget" && reply.error === undefined) {
          const detachedSessionId = cdpRecord(message.params)?.sessionId;
          if (typeof detachedSessionId === "string") {
            this.#releaseSession(client, detachedSessionId);
          }
        }
        const response: Record<string, unknown> = { ...reply, id };
        if (sessionId === undefined) {
          delete response.sessionId;
        }
        this.deliverToClient(client, response);
      },
      isScopedExecution ? null : undefined,
    );
  }

  #upstreamEvent(message: CdpEventMessage): void {
    const envelope = message.sessionId;
    if (envelope === undefined) {
      if (message.method !== "Target.detachedFromTarget") {
        return;
      }
      const detachedSessionId = cdpRecord(message.params)?.sessionId;
      if (typeof detachedSessionId !== "string") {
        return;
      }
      const owner = this.#sessionOwners.get(detachedSessionId);
      if (owner?.browserSessionId === detachedSessionId) {
        owner.socket?.close(1001, "Chrome detached the browser session");
      }
      return;
    }
    const client = this.#sessionOwners.get(envelope);
    if (!client) {
      return;
    }

    const isFetchPause = message.method === "Fetch.requestPaused" || message.method === "Fetch.authRequired";
    if (client.scope && isFetchPause) {
      const requestId = cdpRecord(message.params)?.requestId;
      if (typeof requestId === "string") {
        const requests = client.pausedRequests.get(envelope) ?? new Map<string, PausedFetchRequest>();
        requests.set(requestId, { isAuthChallenge: message.method === "Fetch.authRequired" });
        client.pausedRequests.set(envelope, requests);
        client.fetchSessions.add(envelope);
      }
    }

    if (message.method === "Inspector.targetCrashed") {
      client.crashedSessions.add(envelope);
    } else if (message.method === "Inspector.targetReloadedAfterCrash") {
      client.crashedSessions.delete(envelope);
    }

    let pageSized: Promise<void> | undefined;
    const childSessionId = cdpRecord(message.params)?.sessionId;
    if (message.method === "Target.attachedToTarget" && typeof childSessionId === "string") {
      const targetInfo = cdpRecord(cdpRecord(message.params)?.targetInfo);
      const targetId = targetInfo?.targetId;
      const isExplicitAttach = this.matchExplicitAttachEvent(client, childSessionId, targetId);
      const unsupportedPage =
        targetInfo?.type === "page" &&
        typeof targetInfo.url === "string" &&
        !normalPageTarget({ type: targetInfo.type, url: targetInfo.url });
      const unavailable = typeof targetId === "string" && this.unavailableTarget?.(targetId);
      if (unsupportedPage || unavailable) {
        client.excludedSessions.add(childSessionId);
        this.#connection.forward(
          { method: "Target.detachFromTarget", params: { sessionId: childSessionId }, sessionId: envelope },
          (reply) => {
            if (reply.error !== undefined) {
              client.socket?.close(1011, "Could not detach an excluded Chrome target");
            }
          },
        );
        return;
      }

      this.#ownSession(client, childSessionId);

      const sizedViewport = this.sizedViewport;
      const needsDefaultViewport = sizedViewport !== undefined && targetInfo?.type === "page" && !isExplicitAttach;
      if (needsDefaultViewport) {
        pageSized = this.sizeAttachedPage(childSessionId, sizedViewport);
      }
    }
    if (message.method === "Target.detachedFromTarget" && typeof childSessionId === "string") {
      if (client.excludedSessions.delete(childSessionId)) return;
      this.#releaseSession(client, childSessionId);
    }
    const event: Record<string, unknown> = { method: message.method, params: message.params };
    if (envelope !== client.browserSessionId) {
      event.sessionId = envelope;
    }
    this.deliverToClient(client, event, pageSized);
  }

  // A client cannot use a page before this attach event reaches it (Playwright's newPage() and pages() wait for it,
  // and a new page stays paused because Playwright attaches with waitForDebuggerOnStart), so sizing the page first
  // means a script never sees it at the engine's own size. The attach goes through whatever the reply; an engine
  // that does not know the command keeps its own size, and the relay stops sizing and reporting a default, because
  // a worker that applied the reported default through Playwright would fail on the same command.
  private sizeAttachedPage(sessionId: string, viewport: NonNullable<PageViewportState>) {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#connection.forward(
      { method: "Emulation.setDeviceMetricsOverride", params: createDeviceMetricsOverride(viewport), sessionId },
      (reply) => {
        if (cdpRecord(reply.error)?.code === CDP_METHOD_NOT_FOUND) {
          this.sizedViewport = undefined;
        }

        resolve();
      },
    );

    return promise;
  }

  // Sessions a client opens with Target.attachToTarget, such as a raw newCDPSession() or a target lookup, keep the
  // page's current size: sizing them would replace a size a script set. Chrome sends the attach event before the
  // command's reply, and other engines may not, so whichever of the two arrives first takes the attach's count and
  // leaves its session ID for the other. A count cannot tell an explicit attach from an auto-attach of the same target
  // that is still in flight; Playwright attaches explicitly only to pages it already has.
  private matchExplicitAttachEvent(client: RelayClient, sessionId: string, targetId: unknown) {
    if (client.explicitSessionIdsAwaitingEvent.delete(sessionId)) return true;
    if (typeof targetId !== "string") return false;
    if (!this.consumeExplicitAttach(client, targetId)) return false;

    client.explicitSessionIdsAwaitingReply.add(sessionId);

    return true;
  }

  private settleExplicitAttachReply(client: RelayClient, targetId: string, sessionId: unknown) {
    const hasMatchedEvent = typeof sessionId === "string" && client.explicitSessionIdsAwaitingReply.delete(sessionId);
    if (hasMatchedEvent) return;

    this.consumeExplicitAttach(client, targetId);

    if (typeof sessionId !== "string") return;

    client.explicitSessionIdsAwaitingEvent.add(sessionId);
  }

  private consumeExplicitAttach(client: RelayClient, targetId: string) {
    const count = client.explicitAttachCountsByTargetId.get(targetId);
    if (count === undefined) return false;

    if (count === 1) {
      client.explicitAttachCountsByTargetId.delete(targetId);
    } else {
      client.explicitAttachCountsByTargetId.set(targetId, count - 1);
    }

    return true;
  }

  // Once one message waits for a relay-issued command, every later message to that client waits behind it: a reply
  // or event that overtook an attach would show the client a session it does not know yet.
  private deliverToClient(client: RelayClient, message: Record<string, unknown>, ready?: Promise<void>) {
    const canSendNow = ready === undefined && client.heldMessages.length === 0;
    if (canSendNow) {
      sendRelayReply(client, message);

      return;
    }

    client.heldMessages.push({ message, ready: ready ?? Promise.resolve() });

    const isReleaseRunning = client.heldMessages.length > 1;
    if (isReleaseRunning) return;

    this.releaseHeldMessages(client);
  }

  private async releaseHeldMessages(client: RelayClient) {
    for (let held = client.heldMessages[0]; held; held = client.heldMessages[0]) {
      await held.ready;
      client.heldMessages.shift();
      sendRelayReply(client, held.message);
    }
  }

  #ownSession(client: RelayClient, sessionId: string): void {
    client.sessions.add(sessionId);
    this.#sessionOwners.set(sessionId, client);
    this.#connection.claimForwardedSession(sessionId);
  }

  #releaseSession(client: RelayClient, sessionId: string): void {
    client.sessions.delete(sessionId);
    client.crashedSessions.delete(sessionId);
    client.explicitSessionIdsAwaitingEvent.delete(sessionId);
    client.fetchSessions.delete(sessionId);
    client.pausedRequests.delete(sessionId);
    if (this.#sessionOwners.get(sessionId) === client) {
      this.#sessionOwners.delete(sessionId);
    }
    this.#connection.releaseForwardedSession(sessionId);
  }

  #clientClosed(client: RelayClient): void {
    if (client.closed) {
      return;
    }
    client.closed = true;
    client.queued.length = 0;
    client.heldMessages.length = 0;
    this.#clients.delete(client);

    if (!client.scope) {
      this.#releaseClient(client);
    }
  }

  #releaseClient(client: RelayClient): void {
    for (const sessionId of client.sessions) {
      this.#releaseSession(client, sessionId);
    }

    client.sessions.clear();
    client.crashedSessions.clear();
    client.excludedSessions.clear();
    client.explicitAttachCountsByTargetId.clear();
    client.explicitSessionIdsAwaitingEvent.clear();
    client.explicitSessionIdsAwaitingReply.clear();
    client.pendingExecutions.clear();

    if (client.browserSessionId !== undefined) {
      this.#detachBrowserSession(client.browserSessionId);
    }
  }

  #detachBrowserSession(sessionId: string): void {
    if (this.#connection.closed) {
      return;
    }
    this.#connection.forward({ method: "Target.detachFromTarget", params: { sessionId } }, () => undefined);
  }
}
