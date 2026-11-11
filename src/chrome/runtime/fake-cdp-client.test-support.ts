import {
  CDP_SERVER_ERROR,
  type CdpClient,
  cdpErrorReply,
  type CdpEventListener,
  type CdpEventMessage,
  type CdpForwardedCommand,
  type CdpForwardReply,
  cdpRecord,
} from "./cdp-connection";

export type FakeCdpCommand = Readonly<{
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}>;

export class FakeCdpClient implements CdpClient {
  readonly commands: FakeCdpCommand[] = [];
  readonly endpoint: string;
  readonly forwardedSessions = new Set<string>();

  closed = false;
  command: (command: FakeCdpCommand) => Promise<unknown>;
  poisoned = false;

  #closedPromise: Promise<void>;
  #commandWaiters: { method: string; resolve: (command: FakeCdpCommand) => void }[] = [];
  #eventListeners = new Set<(message: CdpEventMessage) => void>();
  #listeners = new Map<string, Set<CdpEventListener>>();
  #resolveClosed: (() => void) | undefined;

  constructor(
    endpoint = "ws://127.0.0.1:9222/devtools/browser/fake",
    command: (command: FakeCdpCommand) => Promise<unknown> = async () => ({}),
  ) {
    this.endpoint = endpoint;
    this.command = command;
    this.#closedPromise = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#resolveClosed?.();
    this.#resolveClosed = undefined;
  }

  invalidate(): void {
    this.poison();
  }

  claimForwardedSession(sessionId: string): void {
    this.forwardedSessions.add(sessionId);
  }

  releaseForwardedSession(sessionId: string): void {
    this.forwardedSessions.delete(sessionId);
  }

  emit(method: string, params: unknown, sessionId?: string): void {
    for (const listener of this.#eventListeners) listener({ method, params, sessionId });
    if (sessionId !== undefined && this.forwardedSessions.has(sessionId)) return;
    for (const listener of this.#listeners.get(method) ?? []) listener(params, sessionId);
  }

  forward(command: CdpForwardedCommand, reply: CdpForwardReply): void {
    this.send(command.method, cdpRecord(command.params) ?? {}, command.sessionId).then(
      (result) => reply({ result, ...(command.sessionId ? { sessionId: command.sessionId } : {}) }),
      (error: unknown) =>
        reply({
          ...cdpErrorReply(CDP_SERVER_ERROR, error instanceof Error ? error.message : String(error)),
          ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        }),
    );
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

  poison(): void {
    this.poisoned = true;
    this.close();
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Fake CDP connection is closed"));
    const command = Object.freeze({ method, params, ...(sessionId ? { sessionId } : {}) });
    this.commands.push(command);
    const waiting = this.#commandWaiters.filter((waiter) => waiter.method === method);
    this.#commandWaiters = this.#commandWaiters.filter((waiter) => waiter.method !== method);
    for (const waiter of waiting) {
      waiter.resolve(command);
    }
    return this.command(command);
  }

  waitForCommand(method: string): Promise<FakeCdpCommand> {
    return new Promise((resolve) => {
      this.#commandWaiters.push({ method, resolve });
    });
  }

  waitForClose(): Promise<void> {
    return this.#closedPromise;
  }
}
