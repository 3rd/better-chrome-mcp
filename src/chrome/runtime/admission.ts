import { ChromeRuntimeError } from "./errors";

export const OWNER_SHUTDOWN_GRACE_MS = 5000;

export type AdmissionOperation<Result> = Readonly<{
  force?: () => void;
  run: (signal: AbortSignal) => Promise<Result>;
  signal?: AbortSignal;
}>;

type QueueEntry = {
  abort?: () => void;
  controller: AbortController;
  execute: () => Promise<void>;
  force?: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
};

const ownerClosedError = (): ChromeRuntimeError =>
  new ChromeRuntimeError("CHROME_MCP_OWNER_CLOSED", "Browser owner closed");

export class OwnerAdmissionQueue {
  #active: QueueEntry | undefined;
  #closed = false;
  #entries: QueueEntry[] = [];
  #idleResolvers: (() => void)[] = [];

  get pending(): number {
    return this.#entries.length;
  }

  get running(): boolean {
    return this.#active !== undefined;
  }

  admit<Result>(operation: AdmissionOperation<Result>): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(
        new ChromeRuntimeError("CHROME_MCP_OWNER_CLOSED", "Browser owner admission is closed"),
      );
    }
    if (operation.signal?.aborted) {
      return Promise.reject(operation.signal.reason ?? new DOMException("Aborted", "AbortError"));
    }

    return new Promise<Result>((resolve, reject) => {
      const controller = new AbortController();
      const entry: QueueEntry = {
        controller,
        execute: async () => {
          try {
            resolve(await operation.run(controller.signal));
          } catch (error: unknown) {
            reject(error);
          }
        },
        force: operation.force,
        reject,
        signal: operation.signal,
      };
      if (operation.signal) {
        entry.abort = () => {
          const index = this.#entries.indexOf(entry);
          if (index >= 0) {
            this.#entries.splice(index, 1);
            reject(operation.signal?.reason ?? new DOMException("Aborted", "AbortError"));
            this.#resolveIdle();
            return;
          }
          if (this.#active === entry) controller.abort(operation.signal?.reason);
        };
        operation.signal.addEventListener("abort", entry.abort, { once: true });
      }
      this.#entries.push(entry);
      this.#drain();
    });
  }

  close(reason: unknown = ownerClosedError()): void {
    if (this.#closed) return;
    this.#closed = true;
    const queued = this.#entries.splice(0);
    for (const entry of queued) {
      if (entry.abort && entry.signal) entry.signal.removeEventListener("abort", entry.abort);
      entry.reject(reason);
    }
    this.#resolveIdle();
  }

  async shutdown(graceMs = OWNER_SHUTDOWN_GRACE_MS): Promise<void> {
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      throw new Error("Shutdown grace must be a non-negative duration");
    }
    this.close();
    const active = this.#active;
    if (!active) return;
    active.controller.abort(ownerClosedError());
    const completed = await this.#waitForIdle(graceMs);
    if (!completed && this.#active === active) active.force?.();
  }

  idle(): Promise<void> {
    if (!this.#active && this.#entries.length === 0) return Promise.resolve();

    return new Promise((resolve) => {
      this.#idleResolvers.push(resolve);
    });
  }

  #drain(): void {
    if (this.#active) return;
    const entry = this.#entries.shift();
    if (!entry) return;
    this.#active = entry;
    entry.execute().finally(() => {
      if (entry.abort && entry.signal) entry.signal.removeEventListener("abort", entry.abort);
      if (this.#active === entry) this.#active = undefined;
      this.#drain();
      this.#resolveIdle();
    });
  }

  #resolveIdle(): void {
    if (this.#active || this.#entries.length > 0) return;
    for (const resolve of this.#idleResolvers.splice(0)) resolve();
  }

  #waitForIdle(graceMs: number): Promise<boolean> {
    if (!this.#active) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), graceMs);
      this.idle().then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
