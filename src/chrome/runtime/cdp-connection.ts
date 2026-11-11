import { isRecord } from "../../platform/records";
import { ChromeRuntimeError } from "./errors";

export type CdpEventListener = (params: unknown, sessionId: string | undefined) => void;

export type CdpEventMessage = Readonly<{ method: string; params: unknown; sessionId: string | undefined }>;

export type CdpForwardedCommand = Readonly<{ method: string; params?: unknown; sessionId?: string }>;

export type CdpForwardReply = (message: Record<string, unknown>) => void;

export type CdpCommandTimeout = Readonly<{ milliseconds: number; onTimeout: "reject" }> | number;

export type CdpClient = Readonly<{
  closed: boolean;
  endpoint: string;
  poisoned?: boolean;
  claimForwardedSession: (sessionId: string) => void;
  close: () => void;
  forward: (command: CdpForwardedCommand, reply: CdpForwardReply, timeoutMs?: number | null) => void;
  invalidate: () => void;
  on: (method: string, listener: CdpEventListener) => () => void;
  onAnyEvent: (listener: (message: CdpEventMessage) => void) => () => void;
  releaseForwardedSession: (sessionId: string) => void;
  send: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeout?: CdpCommandTimeout,
  ) => Promise<unknown>;
  waitForClose: () => Promise<void>;
}>;

type PendingCommand =
  | {
      kind: "command";
      reject: (error: unknown) => void;
      resolve: (result: unknown) => void;
      sessionId: string | undefined;
      timer: ReturnType<typeof setTimeout>;
    }
  | {
      kind: "forward";
      reply: CdpForwardReply;
      sessionId: string | undefined;
      timer: ReturnType<typeof setTimeout> | undefined;
    };

export const CDP_SERVER_ERROR = -32_000;
const CDP_SESSION_NOT_FOUND = -32_001;
const FORWARD_TIMEOUT_MS = 120_000;
export const CDP_METHOD_NOT_FOUND = -32_601;

export class CdpCommandError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code: number | undefined) {
    super(message);
    this.name = "CdpCommandError";
    this.code = code;
  }
}

export const cdpErrorReply = (code: number, message: string): Record<string, unknown> => ({
  error: { code, message },
});

export const cdpSessionNotFoundReply = (sessionId: string): Record<string, unknown> => ({
  ...cdpErrorReply(CDP_SESSION_NOT_FOUND, "Session with given id not found."),
  sessionId,
});

const errorMessage = (value: unknown): string => {
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return "Unknown CDP command failure";
};

const errorCode = (value: unknown) => {
  if (isRecord(value) && typeof value.code === "number") {
    return value.code;
  }

  return undefined;
};

const settlePendingCommand = (
  pending: PendingCommand,
  error: Error,
  reply: Record<string, unknown>,
): void => {
  clearTimeout(pending.timer);
  if (pending.kind === "forward") {
    pending.reply(reply);
    return;
  }
  pending.reject(error);
};

export const cdpRecord = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

export class CdpConnection {
  readonly endpoint: string;

  #closed = false;
  #closedPromise: Promise<void>;
  #eventListeners = new Set<(message: CdpEventMessage) => void>();
  #forwardedSessions = new Set<string>();
  #listeners = new Map<string, Set<CdpEventListener>>();
  #nextCommandId = 1;
  #pending = new Map<number, PendingCommand>();
  #poisoned = false;
  #resolveClosed: (() => void) | undefined;
  #socket: WebSocket;

  private constructor(endpoint: string, socket: WebSocket) {
    this.endpoint = endpoint;
    this.#socket = socket;
    this.#closedPromise = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    socket.addEventListener("message", (event) => this.#receive(event.data));
    socket.addEventListener("close", () => this.#handleClosed());
    socket.addEventListener("error", () => this.#handleClosed());
  }

  static connect(endpoint: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      const timeout = setTimeout(() => {
        cleanup();
        socket.close();
        reject(
          new ChromeRuntimeError("CHROME_MCP_BROWSER_DISCONNECTED", "Timed out connecting to Chrome CDP"),
        );
      }, timeoutMs);
      function cleanup() {
        clearTimeout(timeout);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      }

      function opened() {
        cleanup();
        resolve(new CdpConnection(endpoint, socket));
      }

      function failed() {
        cleanup();
        socket.close();
        reject(new ChromeRuntimeError("CHROME_MCP_BROWSER_DISCONNECTED", "Could not connect to Chrome CDP"));
      }

      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get poisoned(): boolean {
    return this.#poisoned;
  }

  on(method: string, listener: CdpEventListener): () => void {
    const listeners = this.#listeners.get(method) ?? new Set<CdpEventListener>();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(method);
    };
  }

  onAnyEvent(listener: (message: CdpEventMessage) => void): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  claimForwardedSession(sessionId: string): void {
    this.#forwardedSessions.add(sessionId);
  }

  releaseForwardedSession(sessionId: string): void {
    this.#forwardedSessions.delete(sessionId);

    for (const [id, pending] of this.#pending) {
      const isReleasedForward = pending.kind === "forward" && pending.sessionId === sessionId;
      if (!isReleasedForward) {
        continue;
      }

      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reply(cdpSessionNotFoundReply(sessionId));
    }
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeout: CdpCommandTimeout = 30_000,
  ): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(
        new ChromeRuntimeError("CHROME_MCP_BROWSER_DISCONNECTED", "Chrome CDP connection is closed"),
      );
    }
    const id = this.#nextCommandId++;
    const timeoutMs = typeof timeout === "number" ? timeout : timeout.milliseconds;
    const disconnectOnTimeout = typeof timeout === "number";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new ChromeRuntimeError(
            disconnectOnTimeout ? "CHROME_MCP_BROWSER_DISCONNECTED" : "CHROME_MCP_TIMEOUT",
            `CDP command ${method} timed out after ${timeoutMs} ms`,
          ),
        );
        if (disconnectOnTimeout) {
          this.#poisoned = true;
          this.close();
        }
      }, timeoutMs);
      this.#pending.set(id, { kind: "command", reject, resolve, sessionId, timer });
      try {
        this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error: unknown) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  forward(
    command: CdpForwardedCommand,
    reply: CdpForwardReply,
    timeoutMs: number | null = FORWARD_TIMEOUT_MS,
  ): void {
    if (this.#closed) {
      reply(cdpErrorReply(CDP_SERVER_ERROR, "Chrome CDP connection is closed"));
      return;
    }
    const id = this.#nextCommandId++;
    const timer =
      timeoutMs === null ? undefined : (
        setTimeout(() => {
          this.#pending.delete(id);
          reply(
            cdpErrorReply(CDP_SERVER_ERROR, `CDP command ${command.method} timed out after ${timeoutMs} ms`),
          );
        }, timeoutMs)
      );
    this.#pending.set(id, { kind: "forward", reply, sessionId: command.sessionId, timer });
    try {
      this.#socket.send(
        JSON.stringify({
          id,
          method: command.method,
          params: command.params ?? {},
          ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        }),
      );
    } catch (error: unknown) {
      clearTimeout(timer);
      this.#pending.delete(id);
      reply(cdpErrorReply(CDP_SERVER_ERROR, error instanceof Error ? error.message : String(error)));
    }
  }

  waitForClose(): Promise<void> {
    return this.#closedPromise;
  }

  close(): void {
    if (this.#closed) return;
    this.#socket.close();
    this.#handleClosed();
  }

  invalidate(): void {
    this.#poisoned = true;
    this.close();
  }

  #handleClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new ChromeRuntimeError("CHROME_MCP_BROWSER_DISCONNECTED", "Chrome CDP connection closed");
    for (const pending of this.#pending.values()) {
      settlePendingCommand(pending, error, cdpErrorReply(CDP_SERVER_ERROR, error.message));
    }
    this.#pending.clear();
    this.#listeners.clear();
    this.#eventListeners.clear();
    this.#forwardedSessions.clear();
    this.#resolveClosed?.();
    this.#resolveClosed = undefined;
  }

  #receive(data: unknown): void {
    if (typeof data !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (pending.kind === "forward") {
        const reply: Record<string, unknown> = { ...message };
        delete reply.id;
        pending.reply(reply);
        return;
      }
      if (message.error === undefined) {
        pending.resolve(message.result);
      } else {
        pending.reject(new CdpCommandError(errorMessage(message.error), errorCode(message.error)));
      }

      return;
    }
    if (typeof message.method !== "string") return;
    if (message.method === "Target.detachedFromTarget") {
      const detachedSessionId = cdpRecord(message.params)?.sessionId;
      if (typeof detachedSessionId === "string") {
        for (const [id, pending] of this.#pending) {
          if (pending.sessionId !== detachedSessionId) continue;
          this.#pending.delete(id);
          settlePendingCommand(
            pending,
            new ChromeRuntimeError(
              "CHROME_MCP_UNKNOWN_TARGET",
              `Chrome CDP session ${detachedSessionId} detached`,
            ),
            cdpSessionNotFoundReply(detachedSessionId),
          );
        }
      }
    }
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    for (const listener of this.#eventListeners) {
      listener({ method: message.method, params: message.params, sessionId });
    }
    if (sessionId !== undefined && this.#forwardedSessions.has(sessionId)) {
      return;
    }
    const listeners = this.#listeners.get(message.method);
    if (!listeners) return;
    for (const listener of listeners) listener(message.params, sessionId);
  }
}
