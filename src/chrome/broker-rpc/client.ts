import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod/v4";
import type {
  ActiveDialog,
  ActiveFileChooser,
  BrowserCallAdmission,
  BrowserJournalEvent,
  BrowserMode,
  BrowserOwnerCloseResource,
  BrowserOwnerSnapshot,
  EventCursor,
  GenerationTargetId,
  JournalReadOptions,
  JournalReadResult,
  PersistentMutationEntry,
  PersistentMutationInput,
  PersistentMutationKind,
} from "../runtime";
import type { PageViewportRequest, PageViewportState } from "../runtime/page-viewport";
import type { PwaOperation, PwaResult } from "../runtime/pwa-controller";
import type { ReactBrowserOperation, ReactOperationResult } from "../runtime/react-inspection-protocol";
import { getMcpRuntimeDir } from "../../platform/runtime-paths";
import { isSupportedBunVersion, MINIMUM_BUN_VERSION_TEXT } from "../bun-version";
import { probeProcessIdentity } from "../runtime";
import { MAIN_CHROME_CONNECT_TIMEOUT_MS } from "../runtime/browser-launcher";
import { assertMatchingNativeDeviceScaleFactor, assertNativeDeviceScaleFactor } from "../runtime/modes";
import { resolveBrokerChildProcess } from "./child-environment";
import {
  BROKER_ADMISSION_RESPONSE_GRACE_MS,
  BROKER_CONNECT_BUDGET_MS,
  BROKER_MAX_QUEUED_WRITE_BYTES,
  BROKER_PROTOCOL_VERSION,
  BROKER_REQUEST_TIMEOUT_MS,
  type BrokerRequestMethod,
} from "./constants";
import { brokerError, BrokerRpcError, errorFromBrokerWire } from "./errors";
import { createBrokerFrameDecoder, encodeBrokerFrame } from "./framing";
import {
  type BrokerMetadata,
  type BrokerRuntimePaths,
  ensureOwnerOnlyBrokerRoot,
  readBrokerMetadata,
  removeBrokerRuntimeFiles,
  resolveBrokerRuntimePaths,
  tryAcquireBrokerStartupLock,
} from "./paths";
import {
  type BrokerNotification,
  brokerNotificationSchema,
  brokerParams,
  brokerResponseChunkSchema,
  brokerResponseSchema,
  brokerResults,
  downloadPublicationSchema,
  eventCursorSchema,
  journalEventSchema,
  journalReadResultSchema,
  ownerSnapshotSchema,
  type PreparedSelection,
  targetIdentitySchema,
} from "./protocol";
import { retireChromeBroker } from "./retirement";
import { type BrokerWriteQueue, createBrokerWriteQueue } from "./write-queue";

const BROKER_STARTUP_DIAGNOSTIC_BYTES = 4096;
const RETRY_DELAYS_MS = [25, 50, 100, 250] as const;

export const brokerAdmissionRequestTimeoutMs = (deadlineAt: number | undefined, now = Date.now()): number =>
  deadlineAt === undefined ? BROKER_REQUEST_TIMEOUT_MS : (
    Math.max(BROKER_REQUEST_TIMEOUT_MS, deadlineAt - now + BROKER_ADMISSION_RESPONSE_GRACE_MS)
  );

type PendingRequest = Readonly<{
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}>;

type ProgressListener = (
  notification: Extract<BrokerNotification, { notification: "admission.progress" }>,
) => void;
type CdpListener = (params: unknown, sessionId: string | undefined) => void;
type DownloadListener = (download: RemoteDownloadFinished) => Promise<RemoteDownloadPublication>;
type CdpChunkAssembly = {
  chunks: (string | undefined)[];
  eventMethod: string;
  retainedBytes: number;
  sessionId: string | undefined;
  subscriptionId: string;
};
type ResponseChunkAssembly = {
  chunks: (string | undefined)[];
  retainedBytes: number;
};

type StartedRequest = Readonly<{
  id: string;
  promise: Promise<unknown>;
}>;

class BrokerConnection {
  readonly #cdpChunkAssemblies = new Map<string, CdpChunkAssembly>();
  readonly #cdpListeners = new Map<string, CdpListener>();
  readonly #closeHandlers = new Set<() => void>();
  readonly #decoder = createBrokerFrameDecoder();
  #downloadListener: DownloadListener | undefined;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #progressListeners = new Map<string, ProgressListener>();
  readonly #responseChunkAssemblies = new Map<string, ResponseChunkAssembly>();
  readonly #writes: BrokerWriteQueue;

  #closed = false;
  #retainedChunkBytes = 0;
  #socket: Readonly<{ end: () => void; terminate: () => void; write: (data: Uint8Array) => number }> = {
    end: () => undefined,
    terminate: () => undefined,
    write: () => 0,
  };

  private constructor() {
    this.#writes = createBrokerWriteQueue({ write: (data) => this.#socket.write(data) }, () =>
      this.#socket.terminate(),
    );
  }

  static async open(socketPath: string): Promise<BrokerConnection> {
    const connection = new BrokerConnection();
    const socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data: (_socket, chunk) => connection.#receive(chunk),
        close: () =>
          connection.#fail(new BrokerRpcError("CHROME_MCP_BROKER_CLOSED", "Chrome broker connection closed")),
        drain: () => connection.#writes.flush(),
        error: (_socket, error) =>
          connection.#fail(new BrokerRpcError("CHROME_MCP_BROKER_UNAVAILABLE", error.message)),
      },
    });
    connection.#socket = Object.freeze({
      end: () => socket.end(),
      terminate: () => socket.terminate(),
      write: (data: Uint8Array) => socket.write(data),
    });
    return connection;
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    this.#socket.end();
    this.#fail(new BrokerRpcError("CHROME_MCP_BROKER_CLOSED", "Chrome broker connection closed"));
  }

  onClose(handler: () => void): () => void {
    if (this.#closed) {
      handler();
      return () => undefined;
    }
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  request(
    method: BrokerRequestMethod,
    params: unknown,
    options: Readonly<{ cancelOnTimeout?: boolean; signal?: AbortSignal; timeoutMs?: number }> = {},
  ): Promise<unknown> {
    return this.startRequest(method, params, options).promise;
  }

  startRequest(
    method: BrokerRequestMethod,
    params: unknown,
    options: Readonly<{ cancelOnTimeout?: boolean; signal?: AbortSignal; timeoutMs?: number }> = {},
  ): StartedRequest {
    if (this.#closed) {
      return Object.freeze({
        id: randomUUID(),
        promise: Promise.reject(
          new BrokerRpcError("CHROME_MCP_BROKER_CLOSED", "Chrome broker connection is closed"),
        ),
      });
    }
    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? BROKER_REQUEST_TIMEOUT_MS;
    let removeAbortListener: (() => void) | undefined;
    const promise = new Promise<unknown>((resolveResponse, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        this.#deleteResponseChunkAssembly(id);
        if (options.cancelOnTimeout !== false) this.cancel(id);
        reject(new BrokerRpcError("CHROME_MCP_BROKER_DEADLINE", `Chrome broker request ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { reject, resolve: resolveResponse, timer: timeout });
      const aborted = () => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        this.#deleteResponseChunkAssembly(id);
        this.cancel(id);
        reject(
          options.signal?.reason instanceof Error ?
            options.signal.reason
          : new BrokerRpcError("CHROME_MCP_BROKER_CANCELED", `Chrome broker request ${method} was canceled`),
        );
      };
      if (options.signal) {
        if (options.signal.aborted) {
          aborted();
          return;
        }
        options.signal.addEventListener("abort", aborted, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", aborted);
      }
      try {
        this.#send({
          id,
          kind: "request",
          method,
          params,
        });
      } catch (error: unknown) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(brokerError(error));
      }
    });
    promise.finally(() => removeAbortListener?.()).catch(() => undefined);
    return Object.freeze({ id, promise });
  }

  #send(value: unknown): void {
    if (this.#closed) {
      throw new BrokerRpcError("CHROME_MCP_BROKER_CLOSED", "Chrome broker connection is closed");
    }
    if (this.#writes.send(encodeBrokerFrame(value))) return;
    const error = new BrokerRpcError(
      "CHROME_MCP_BROKER_CLOSED",
      `Chrome broker write queue exceeded ${BROKER_MAX_QUEUED_WRITE_BYTES} bytes`,
    );
    this.#fail(error);
    throw error;
  }

  cancel(requestId: string): void {
    if (this.#closed) return;
    this.request("request.cancel", { requestId }, { cancelOnTimeout: false, timeoutMs: 5000 }).catch(
      () => undefined,
    );
  }

  setProgressListener(requestId: string, listener: ProgressListener): () => void {
    this.#progressListeners.set(requestId, listener);
    return () => this.#progressListeners.delete(requestId);
  }

  setCdpListener(subscriptionId: string, listener: CdpListener): () => void {
    this.#cdpListeners.set(subscriptionId, listener);
    return () => {
      this.#cdpListeners.delete(subscriptionId);
      for (const [transmissionId, assembly] of this.#cdpChunkAssemblies) {
        if (assembly.subscriptionId === subscriptionId) this.#deleteCdpChunkAssembly(transmissionId);
      }
    };
  }

  setDownloadListener(listener: DownloadListener): () => void {
    if (this.#downloadListener) {
      throw new BrokerRpcError(
        "CHROME_MCP_BROKER_INVALID_REQUEST",
        "Chrome broker download publication already has a subscriber",
      );
    }
    this.#downloadListener = listener;
    return () => {
      if (this.#downloadListener === listener) this.#downloadListener = undefined;
    };
  }

  #receive(frameBytes: Uint8Array): void {
    let values: unknown[];
    try {
      values = this.#decoder.push(frameBytes);
    } catch (error: unknown) {
      this.#socket.end();
      this.#fail(brokerError(error, "CHROME_MCP_BROKER_INVALID_REQUEST"));
      return;
    }
    for (const value of values) {
      if (!this.tryReceiveValue(value)) return;
    }
  }

  private tryReceiveValue(value: unknown) {
    const response = brokerResponseSchema.safeParse(value);
    if (response.success) {
      const pending = this.#pending.get(response.data.id);
      if (!pending) return true;
      clearTimeout(pending.timer);
      this.#pending.delete(response.data.id);
      this.#deleteResponseChunkAssembly(response.data.id);
      if (!response.data.ok) {
        pending.reject(errorFromBrokerWire(response.data.error));

        return true;
      }

      pending.resolve(response.data.result);

      return true;
    }
    const responseChunk = brokerResponseChunkSchema.safeParse(value);
    if (responseChunk.success) {
      const chunk = responseChunk.data;
      const pending = this.#pending.get(chunk.id);
      if (!pending) return true;
      let assembly = this.#responseChunkAssemblies.get(chunk.id);
      if (!assembly) {
        assembly = {
          chunks: Array.from({ length: chunk.chunkCount }, () => undefined),
          retainedBytes: 0,
        };
        this.#responseChunkAssemblies.set(chunk.id, assembly);
      }
      if (assembly.chunks.length !== chunk.chunkCount || assembly.chunks[chunk.chunkIndex] !== undefined) {
        this.#socket.end();
        this.#fail(
          new BrokerRpcError(
            "CHROME_MCP_BROKER_INVALID_REQUEST",
            "Chrome broker sent inconsistent response chunks",
          ),
        );

        return false;
      }
      if (!this.#reserveChunkBytes(assembly, chunk.chunk)) return false;
      assembly.chunks[chunk.chunkIndex] = chunk.chunk;
      if (assembly.chunks.every((part) => part !== undefined)) {
        let result: unknown;
        try {
          result = z.json().parse(JSON.parse(assembly.chunks.join("")));
        } catch {
          this.#socket.end();
          this.#fail(
            new BrokerRpcError(
              "CHROME_MCP_BROKER_INVALID_REQUEST",
              "Chrome broker sent invalid chunked response JSON",
            ),
          );

          return false;
        }
        this.#deleteResponseChunkAssembly(chunk.id);
        clearTimeout(pending.timer);
        this.#pending.delete(chunk.id);
        pending.resolve(result);
      }

      return true;
    }
    const notification = brokerNotificationSchema.safeParse(value);
    if (!notification.success) {
      this.#socket.end();
      this.#fail(
        new BrokerRpcError("CHROME_MCP_BROKER_INVALID_REQUEST", "Chrome broker sent an invalid frame"),
      );

      return false;
    }
    if (notification.data.notification === "admission.progress") {
      this.#progressListeners.get(notification.data.admissionRequestId)?.(notification.data);
    } else if (notification.data.notification === "cdp.event") {
      this.#cdpListeners.get(notification.data.subscriptionId)?.(
        notification.data.params,
        notification.data.sessionId ?? undefined,
      );
    } else if (notification.data.notification === "cdp.event.chunk") {
      const chunk = notification.data;
      let assembly = this.#cdpChunkAssemblies.get(chunk.transmissionId);
      if (!assembly) {
        assembly = {
          chunks: Array.from({ length: chunk.chunkCount }, () => undefined),
          eventMethod: chunk.eventMethod,
          retainedBytes: 0,
          sessionId: chunk.sessionId ?? undefined,
          subscriptionId: chunk.subscriptionId,
        };
        this.#cdpChunkAssemblies.set(chunk.transmissionId, assembly);
      }
      if (
        assembly.chunks.length !== chunk.chunkCount ||
        assembly.eventMethod !== chunk.eventMethod ||
        assembly.sessionId !== (chunk.sessionId ?? undefined) ||
        assembly.subscriptionId !== chunk.subscriptionId ||
        assembly.chunks[chunk.chunkIndex] !== undefined
      ) {
        this.#socket.end();
        this.#fail(
          new BrokerRpcError(
            "CHROME_MCP_BROKER_INVALID_REQUEST",
            "Chrome broker sent inconsistent CDP chunks",
          ),
        );

        return false;
      }
      if (!this.#reserveChunkBytes(assembly, chunk.chunk)) return false;
      assembly.chunks[chunk.chunkIndex] = chunk.chunk;
      if (assembly.chunks.every((part) => part !== undefined)) {
        this.#deleteCdpChunkAssembly(chunk.transmissionId);
        let params: unknown;
        try {
          params = z.json().parse(JSON.parse(assembly.chunks.join("")));
        } catch {
          this.#socket.end();
          this.#fail(
            new BrokerRpcError(
              "CHROME_MCP_BROKER_INVALID_REQUEST",
              "Chrome broker sent invalid chunked CDP JSON",
            ),
          );

          return false;
        }
        this.#cdpListeners.get(assembly.subscriptionId)?.(params, assembly.sessionId);
      }
    } else {
      this.#publishDownload(notification.data).catch(() => undefined);
    }

    return true;
  }

  #deleteCdpChunkAssembly(transmissionId: string): void {
    const assembly = this.#cdpChunkAssemblies.get(transmissionId);
    if (!assembly) return;
    this.#cdpChunkAssemblies.delete(transmissionId);
    this.#retainedChunkBytes -= assembly.retainedBytes;
  }

  #deleteResponseChunkAssembly(requestId: string): void {
    const assembly = this.#responseChunkAssemblies.get(requestId);
    if (!assembly) return;
    this.#responseChunkAssemblies.delete(requestId);
    this.#retainedChunkBytes -= assembly.retainedBytes;
  }

  #reserveChunkBytes(assembly: { retainedBytes: number }, chunk: string): boolean {
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (this.#retainedChunkBytes + chunkBytes > BROKER_MAX_QUEUED_WRITE_BYTES) {
      this.#socket.end();
      this.#fail(
        new BrokerRpcError(
          "CHROME_MCP_BROKER_INVALID_REQUEST",
          `Chrome broker incomplete chunk data exceeded ${BROKER_MAX_QUEUED_WRITE_BYTES} bytes`,
        ),
      );
      return false;
    }
    assembly.retainedBytes += chunkBytes;
    this.#retainedChunkBytes += chunkBytes;
    return true;
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#responseChunkAssemblies.clear();
    this.#retainedChunkBytes = 0;
    this.#writes.close();
    this.#progressListeners.clear();
    this.#cdpChunkAssemblies.clear();
    this.#cdpListeners.clear();
    this.#downloadListener = undefined;
    for (const handler of this.#closeHandlers) handler();
    this.#closeHandlers.clear();
  }

  async #publishDownload(
    notification: Extract<BrokerNotification, { notification: "download.finished" }>,
  ): Promise<void> {
    let outcome: z.infer<typeof brokerParams.downloadAck>["outcome"];
    try {
      const listener = this.#downloadListener;
      if (!listener) throw new Error("No download publisher is registered");
      const publication = downloadPublicationSchema.parse(
        await listener(
          Object.freeze({
            browserMode: notification.browserMode,
            connectionId: notification.connectionId,
            downloadId: notification.downloadId,
            ownerGeneration: notification.ownerGeneration,
            path: notification.path,
            ...(notification.suggestedFilename === undefined ?
              {}
            : { suggestedFilename: notification.suggestedFilename }),
            targetId: notification.targetId,
          }),
        ),
      );
      outcome = { publication, status: "published" };
    } catch {
      outcome = { status: "failed" };
    }
    await this.request("download.ack", {
      outcome,
      publicationId: notification.publicationId,
    }).catch(() => undefined);
  }
}

export type BrokerAdmissionProgress = Readonly<{
  phase: "admitted" | "canceled" | "completed" | "queued";
  position?: number;
}>;

export type RemoteAdmissionOperation<Result> = BrowserCallAdmission<Result> &
  Readonly<{
    deadlineAt?: number;
    onProgress?: (progress: BrokerAdmissionProgress) => void;
  }>;

export type PrivateChromeEndpoint = Readonly<{
  value: string;
}>;

export type RemoteWorkerConnection = Readonly<{
  downloadsPath?: string;
  endpoint: PrivateChromeEndpoint;
  executionEndpoint: PrivateChromeEndpoint;
  ownerGeneration: number;
  target: GenerationTargetId;
}>;

export type RemoteDownloadFinished = Readonly<{
  browserMode: BrowserMode;
  connectionId: string;
  downloadId: string;
  ownerGeneration: number;
  path: string;
  suggestedFilename?: string;
  targetId: string;
}>;

export type RemoteDownloadPublication = z.infer<typeof downloadPublicationSchema>;

export interface RemoteSelectionTransaction {
  readonly initialTarget: GenerationTargetId;
  commit: () => Promise<GenerationTargetId>;
  current: () => GenerationTargetId;
  readonly prepare: () => Promise<PreparedSelection>;
  recordCreated: (target: GenerationTargetId) => void;
  rollback: () => Promise<GenerationTargetId>;
  select: (target: GenerationTargetId) => Promise<void>;
}

export interface RemoteBrowserSession {
  readonly browserMode: BrowserMode;
  readonly closed: boolean;
  readonly connectionId: string;
  readonly ownerGeneration: number;
  readonly ownerId: string;
  activeDialog: () => ActiveDialog | undefined;
  activeFileChooser: () => ActiveFileChooser | undefined;
  addMutation: (
    input: PersistentMutationInput,
    target: GenerationTargetId,
  ) => Promise<PersistentMutationEntry>;
  admit: <Result>(operation: RemoteAdmissionOperation<Result>) => Promise<Result>;
  authorizeOwnerClose: (resource: BrowserOwnerCloseResource) => Promise<void>;
  beginSelection: () => Promise<RemoteSelectionTransaction>;
  capabilities: () => Promise<BrowserOwnerSnapshot>;
  clearMutations: (kind: PersistentMutationKind) => Promise<number>;
  close: () => Promise<void>;
  currentEventCursor: () => Promise<EventCursor>;
  currentTarget: () => GenerationTargetId;
  enableOwnedDownloads: () => Promise<void>;
  ensureTarget: () => Promise<GenerationTargetId>;
  eventRange: (after: EventCursor, targetId: string) => Promise<BrowserJournalEvent[]>;
  handleDialog: (dialogId: string, accept: boolean, promptText?: string) => Promise<void>;
  invalidateOwner: () => Promise<void>;
  journalCapabilities: () => Promise<
    Readonly<{
      currentSequence: number;
      eventCount: number;
      firstRetainedSequence: number;
      retainedBytes: number;
    }>
  >;
  listMutations: (kind: PersistentMutationKind) => Promise<PersistentMutationEntry[]>;
  markEvents: () => Promise<EventCursor>;
  onCdp: (method: string, listener: CdpListener) => () => void;
  readonly readActiveDialog: () => Promise<ActiveDialog | undefined>;
  readEvents: (options?: JournalReadOptions & Readonly<{ advance?: boolean }>) => Promise<JournalReadResult>;
  react: (input: ReactBrowserOperation) => Promise<ReactOperationResult>;
  removeMutation: (kind: PersistentMutationKind, id: string) => Promise<boolean>;
  requireNoBlockingModal: () => Promise<void>;
  sendCdp: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;
  pageViewport: (request: PageViewportRequest) => Promise<PageViewportState>;
  readonly pwa: (input: PwaOperation) => Promise<PwaResult>;
  setFileChooserFiles: (chooserId: string, files: readonly string[]) => Promise<void>;
  targetRecord: (targetId: string) => Promise<Readonly<{ title?: string; url: string }> | undefined>;
  workerConnection: () => Promise<RemoteWorkerConnection>;
}

class BrokerRemoteSession implements RemoteBrowserSession {
  readonly browserMode: BrowserMode;
  readonly connectionId: string;
  readonly ownerId: string;

  readonly #connection: BrokerConnection;
  readonly #pendingSubscriptions = new Set<Promise<unknown>>();
  readonly #sessionId: string;
  readonly #onClose: () => void;
  #activeAdmissionToken: string | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #dialog: ActiveDialog | undefined;
  #fileChooser: ActiveFileChooser | undefined;
  #ownerGeneration: number;
  #target: GenerationTargetId;

  constructor(
    options: Readonly<{
      connection: BrokerConnection;
      connectionId: string;
      mode: BrowserMode;
      ownerGeneration: number;
      ownerId: string;
      onClose: () => void;
      sessionId: string;
      target: GenerationTargetId;
    }>,
  ) {
    this.#connection = options.connection;
    this.connectionId = options.connectionId;
    this.browserMode = options.mode;
    this.#ownerGeneration = options.ownerGeneration;
    this.ownerId = options.ownerId;
    this.#onClose = options.onClose;
    this.#sessionId = options.sessionId;
    this.#target = options.target;
  }

  get ownerGeneration(): number {
    return this.#ownerGeneration;
  }

  get closed(): boolean {
    return this.#closed || this.#connection.closed;
  }

  activeDialog(): ActiveDialog | undefined {
    return this.#dialog;
  }

  activeFileChooser(): ActiveFileChooser | undefined {
    return this.#fileChooser;
  }

  async addMutation(
    input: PersistentMutationInput,
    target: GenerationTargetId,
  ): Promise<PersistentMutationEntry> {
    return brokerResults.mutationEntry.parse(
      await this.#connection.request("mutation.add", {
        admissionToken: this.#requireAdmission(),
        input,
        sessionId: this.#sessionId,
        target,
      }),
    );
  }

  async admit<Result>(operation: RemoteAdmissionOperation<Result>): Promise<Result> {
    this.#requireOpen();
    if (this.#activeAdmissionToken) {
      throw new BrokerRpcError(
        "CHROME_MCP_BROKER_INVALID_REQUEST",
        "Nested Chrome broker admission is not supported",
      );
    }
    const started = this.#connection.startRequest(
      "admission.open",
      {
        ...(operation.deadlineAt === undefined ? {} : { deadlineAt: operation.deadlineAt }),
        modalPolicy: operation.modalPolicy ?? "allow",
        sessionId: this.#sessionId,
      },
      { signal: operation.signal, timeoutMs: brokerAdmissionRequestTimeoutMs(operation.deadlineAt) },
    );
    const local = new AbortController();
    const removeProgress = this.#connection.setProgressListener(started.id, (notification) => {
      operation.onProgress?.({
        phase: notification.phase,
        ...(notification.position === undefined ? {} : { position: notification.position }),
      });
      if (notification.phase === "canceled" && !local.signal.aborted) {
        local.abort(
          new BrokerRpcError(
            "CHROME_MCP_BROKER_CANCELED",
            "Chrome broker canceled the active owner admission",
          ),
        );
      }
    });
    const abort = () => {
      local.abort(operation.signal?.reason);
      this.#connection.cancel(started.id);
    };
    if (operation.signal) {
      if (operation.signal.aborted) abort();
      else operation.signal.addEventListener("abort", abort, { once: true });
    }
    let outcome: Readonly<{ error: unknown; ok: false }> | Readonly<{ ok: true; value: Result }>;
    try {
      const opened = brokerResults.admission.parse(await started.promise);
      this.#activeAdmissionToken = opened.admissionToken;
      this.#dialog = opened.dialog ?? undefined;
      this.#fileChooser = opened.fileChooser ?? undefined;
      this.#ownerGeneration = opened.ownerGeneration;
      this.#target = opened.target;
      outcome = { ok: true, value: await operation.run(local.signal) };
    } catch (error: unknown) {
      outcome = { error, ok: false };
    }
    let closeError: unknown;
    try {
      if (operation.signal) operation.signal.removeEventListener("abort", abort);
      const token = this.#activeAdmissionToken;
      this.#activeAdmissionToken = undefined;
      removeProgress();
      if (token && !this.#connection.closed) {
        await this.#connection.request("admission.close", {
          admissionToken: token,
          sessionId: this.#sessionId,
        });
      }
    } catch (error: unknown) {
      const normalized = brokerError(error);
      if (
        normalized.code !== "CHROME_MCP_BROKER_CANCELED" &&
        normalized.code !== "CHROME_MCP_BROKER_CLOSED"
      ) {
        closeError = normalized;
      }
    }
    if (!outcome.ok) {
      if (closeError !== undefined) {
        throw new AggregateError(
          [outcome.error, closeError],
          "Chrome call and admission cleanup both failed",
        );
      }
      throw outcome.error;
    }
    if (closeError !== undefined) throw closeError;
    return outcome.value;
  }

  async authorizeOwnerClose(resource: BrowserOwnerCloseResource): Promise<void> {
    brokerResults.ok.parse(
      await this.#connection.request("owner.close.authorize", {
        admissionToken: this.#requireAdmission(),
        resource,
        sessionId: this.#sessionId,
      }),
    );
  }

  async beginSelection(): Promise<RemoteSelectionTransaction> {
    const token = this.#requireAdmission();
    const result = brokerResults.selection.parse(
      await this.#connection.request("selection.begin", {
        admissionToken: token,
        sessionId: this.#sessionId,
      }),
    );
    let current = result.initialTarget;
    const createdTargets: GenerationTargetId[] = [];
    let finished = false;
    const requireActive = () => {
      if (finished) {
        throw new BrokerRpcError(
          "CHROME_MCP_BROKER_INVALID_REQUEST",
          "Chrome selection transaction has finished",
        );
      }
    };
    return Object.freeze({
      commit: async () => {
        requireActive();
        finished = true;
        const selected = targetIdentitySchema.parse(
          await this.#connection.request("selection.commit", {
            admissionToken: token,
            createdTargets,
            sessionId: this.#sessionId,
            transactionId: result.transactionId,
          }),
        );
        this.#target = selected;
        current = selected;
        return selected;
      },
      current: () => current,
      initialTarget: result.initialTarget,
      prepare: async () => {
        requireActive();
        const prepared = brokerResults.selectionPreparation.parse(
          await this.#connection.request("selection.prepare", {
            admissionToken: token,
            createdTargets,
            sessionId: this.#sessionId,
            transactionId: result.transactionId,
          }),
        );
        current = prepared.target;
        return prepared;
      },
      recordCreated: (target: GenerationTargetId) => {
        requireActive();
        createdTargets.push(targetIdentitySchema.parse(target));
      },
      rollback: async () => {
        requireActive();
        finished = true;
        const selected = targetIdentitySchema.parse(
          await this.#connection.request("selection.rollback", {
            admissionToken: token,
            sessionId: this.#sessionId,
            transactionId: result.transactionId,
          }),
        );
        this.#target = selected;
        current = selected;
        return selected;
      },
      select: async (target: GenerationTargetId) => {
        requireActive();
        const explicitTarget = targetIdentitySchema.parse(target);
        await this.#connection.request("selection.select", {
          admissionToken: token,
          sessionId: this.#sessionId,
          target: explicitTarget,
          transactionId: result.transactionId,
        });
        current = explicitTarget;
      },
    });
  }

  async capabilities(): Promise<BrowserOwnerSnapshot> {
    const snapshot = ownerSnapshotSchema.parse(
      await this.#connection.request("session.snapshot", { sessionId: this.#sessionId }),
    );
    this.#ownerGeneration = snapshot.ownerGeneration;
    return snapshot;
  }

  async clearMutations(kind: PersistentMutationKind): Promise<number> {
    return z
      .number()
      .int()
      .nonnegative()
      .parse(
        await this.#connection.request("mutation.clear", {
          admissionToken: this.#requireAdmission(),
          kind,
          sessionId: this.#sessionId,
        }),
      );
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = (async () => {
      try {
        await this.#connection.request("session.release", { sessionId: this.#sessionId });
      } finally {
        this.#closed = true;
        this.#onClose();
      }
    })();
    return this.#closePromise;
  }

  async currentEventCursor(): Promise<EventCursor> {
    return eventCursorSchema.parse(
      await this.#connection.request("journal.current", { sessionId: this.#sessionId }),
    );
  }

  currentTarget(): GenerationTargetId {
    return this.#target;
  }

  async enableOwnedDownloads(): Promise<void> {
    brokerResults.ok.parse(
      await this.#connection.request("download.enable", {
        admissionToken: this.#requireAdmission(),
        sessionId: this.#sessionId,
      }),
    );
  }

  async ensureTarget(): Promise<GenerationTargetId> {
    const target = targetIdentitySchema.parse(
      await this.#connection.request("target.ensure", {
        admissionToken: this.#requireAdmission(),
        sessionId: this.#sessionId,
      }),
    );
    this.#target = target;
    return target;
  }

  async eventRange(after: EventCursor, targetId: string): Promise<BrowserJournalEvent[]> {
    return z.array(journalEventSchema).parse(
      await this.#connection.request("journal.range", {
        after,
        sessionId: this.#sessionId,
        targetId,
      }),
    );
  }

  async handleDialog(dialogId: string, accept: boolean, promptText?: string): Promise<void> {
    await this.#connection.request("modal.handleDialog", {
      accept,
      admissionToken: this.#requireAdmission(),
      dialogId,
      ...(promptText === undefined ? {} : { promptText }),
      sessionId: this.#sessionId,
    });
    this.#dialog = undefined;
  }

  async invalidateOwner(): Promise<void> {
    brokerResults.ok.parse(
      await this.#connection.request("owner.invalidate", {
        admissionToken: this.#requireAdmission(),
        sessionId: this.#sessionId,
      }),
    );
  }

  async journalCapabilities() {
    return brokerResults.journalCapabilities.parse(
      await this.#connection.request("journal.capabilities", {
        sessionId: this.#sessionId,
      }),
    );
  }

  async listMutations(kind: PersistentMutationKind): Promise<PersistentMutationEntry[]> {
    return brokerResults.mutationEntries.parse(
      await this.#connection.request("mutation.list", {
        admissionToken: this.#requireAdmission(),
        kind,
        sessionId: this.#sessionId,
      }),
    );
  }

  async markEvents(): Promise<EventCursor> {
    return eventCursorSchema.parse(
      await this.#connection.request("journal.mark", { sessionId: this.#sessionId }),
    );
  }

  onCdp(method: string, listener: CdpListener): () => void {
    this.#requireOpen();
    const subscriptionId = randomUUID();
    const removeLocal = this.#connection.setCdpListener(subscriptionId, listener);
    const ready = this.#connection.request("cdp.subscribe", {
      eventMethod: method,
      sessionId: this.#sessionId,
      subscriptionId,
    });
    this.#pendingSubscriptions.add(ready);
    ready.finally(() => this.#pendingSubscriptions.delete(ready)).catch(removeLocal);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      removeLocal();
      ready
        .then(() => this.#connection.request("cdp.unsubscribe", { subscriptionId }))
        .catch(() => undefined);
    };
  }

  async readActiveDialog() {
    const result = await this.#connection.request("modal.dialog", { sessionId: this.#sessionId });
    return brokerResults.dialog.parse(result) ?? undefined;
  }

  async readEvents(
    options: JournalReadOptions & Readonly<{ advance?: boolean }> = {},
  ): Promise<JournalReadResult> {
    return journalReadResultSchema.parse(
      await this.#connection.request("journal.read", {
        options,
        sessionId: this.#sessionId,
      }),
    );
  }

  async react(input: ReactBrowserOperation): Promise<ReactOperationResult> {
    return brokerResults.reactOperation.parse(
      await this.#connection.request("react.execute", {
        admissionToken: this.#requireAdmission(),
        input,
        sessionId: this.#sessionId,
      }),
    );
  }

  async removeMutation(kind: PersistentMutationKind, id: string): Promise<boolean> {
    return z.boolean().parse(
      await this.#connection.request("mutation.remove", {
        admissionToken: this.#requireAdmission(),
        id,
        kind,
        sessionId: this.#sessionId,
      }),
    );
  }

  async requireNoBlockingModal(): Promise<void> {
    await this.#connection.request("modal.requireNone", {
      admissionToken: this.#requireAdmission(),
      sessionId: this.#sessionId,
    });
  }

  async sendCdp(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    await Promise.all(this.#pendingSubscriptions);
    return this.#connection.request("cdp.send", {
      admissionToken: this.#requireAdmission(),
      method,
      ...(params === undefined ? {} : { params }),
      sessionId: this.#sessionId,
      ...(sessionId === undefined ? {} : { targetSessionId: sessionId }),
    });
  }

  async pageViewport(request: PageViewportRequest) {
    return brokerResults.pageViewport.parse(
      await this.#connection.request("page.viewport", {
        admissionToken: this.#requireAdmission(),
        request,
        sessionId: this.#sessionId,
      }),
    );
  }

  async pwa(input: PwaOperation) {
    return brokerResults.pwaExecute.parse(
      await this.#connection.request("pwa.execute", {
        admissionToken: this.#requireAdmission(),
        input,
        sessionId: this.#sessionId,
      }),
    );
  }

  async setFileChooserFiles(chooserId: string, files: readonly string[]): Promise<void> {
    await this.#connection.request("modal.setFileChooserFiles", {
      admissionToken: this.#requireAdmission(),
      chooserId,
      files: [...files],
      sessionId: this.#sessionId,
    });
    this.#fileChooser = undefined;
  }

  async targetRecord(targetId: string): Promise<Readonly<{ title?: string; url: string }> | undefined> {
    const record = brokerResults.targetRecord.parse(
      await this.#connection.request("target.record", {
        sessionId: this.#sessionId,
        targetId,
      }),
    );
    return record ?? undefined;
  }

  async workerConnection(): Promise<RemoteWorkerConnection> {
    const result = brokerResults.workerConnection.parse(
      await this.#connection.request("worker.connection", {
        admissionToken: this.#requireAdmission(),
        sessionId: this.#sessionId,
      }),
    );
    this.#ownerGeneration = result.ownerGeneration;
    this.#target = result.target;
    return Object.freeze({
      ...(result.downloadsPath === undefined ? {} : { downloadsPath: result.downloadsPath }),
      endpoint: Object.freeze({ value: result.endpoint }),
      executionEndpoint: Object.freeze({ value: result.executionEndpoint }),
      ownerGeneration: result.ownerGeneration,
      target: result.target,
    });
  }

  #requireAdmission(): string {
    this.#requireOpen();
    const token = this.#activeAdmissionToken;
    if (!token) {
      throw new BrokerRpcError(
        "CHROME_MCP_BROKER_INVALID_REQUEST",
        "Chrome browser mutation must run inside RemoteBrowserSession.admit",
      );
    }
    return token;
  }

  #requireOpen(): void {
    if (this.closed) throw new BrokerRpcError("CHROME_MCP_BROKER_CLOSED", "Chrome browser session is closed");
  }
}

export type ChromeBrokerClientOptions = Readonly<{
  connectionId: string;
  connectBudgetMs?: number;
  executablePath: string;
  mainUserDataDir?: string;
  runtimeRoot?: string;
  workspacePath: string;
}>;

export interface ChromeBrokerClient {
  readonly brokerId: string;
  readonly brokerPid: number;
  readonly closed: boolean;
  readonly connectionId: string;
  acquire: (mode: BrowserMode, nativeDeviceScaleFactor?: number) => Promise<RemoteBrowserSession>;
  close: () => Promise<void>;
  disconnect: () => void;
  onClose: (handler: () => void) => () => void;
  onDownloadFinished: (listener: DownloadListener) => () => void;
  status: () => Promise<z.infer<typeof brokerResults.status>>;
}

const sleep = (milliseconds: number): Promise<void> => {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
};

const handshake = async (
  connection: BrokerConnection,
  metadata: BrokerMetadata,
  connectionId: string,
  paths: BrokerRuntimePaths,
  timeoutMs: number,
): Promise<z.infer<typeof brokerResults.hello>> => {
  const result = brokerResults.hello.parse(
    await connection.request(
      "broker.hello",
      {
        connectionId,
        protocolVersion: BROKER_PROTOCOL_VERSION,
        workspaceHash: paths.workspaceHash,
      },
      { timeoutMs },
    ),
  );
  if (
    result.brokerId !== metadata.brokerId ||
    result.brokerPid !== metadata.pid ||
    result.processStartIdentity !== metadata.processStartIdentity ||
    result.protocolVersion !== BROKER_PROTOCOL_VERSION ||
    result.workspaceHash !== metadata.workspaceHash
  ) {
    connection.close();
    throw new BrokerRpcError(
      "CHROME_MCP_BROKER_UNAVAILABLE",
      "Chrome broker socket identity does not match its owner metadata",
    );
  }
  return result;
};

const brokerMetadataVersion = (metadata: BrokerMetadata): number => metadata.protocolVersion ?? 0;

const assertBrokerIsNotNewer = (metadata: BrokerMetadata): void => {
  const version = brokerMetadataVersion(metadata);
  if (version <= BROKER_PROTOCOL_VERSION) return;
  throw new BrokerRpcError(
    "CHROME_MCP_BROKER_UNAVAILABLE",
    `Chrome broker protocol ${version} is newer than this client's ${BROKER_PROTOCOL_VERSION}; restart this session to load current code`,
  );
};

const connectMetadata = async (
  metadata: BrokerMetadata,
  connectionId: string,
  paths: BrokerRuntimePaths,
  timeoutMs: number,
): Promise<Readonly<{ connection: BrokerConnection; hello: z.infer<typeof brokerResults.hello> }>> => {
  const hasMismatchedBrokerLocation =
    resolve(paths.canonicalWorkspace, metadata.socketPath) !== paths.socketPath ||
    metadata.workspaceHash !== paths.workspaceHash;
  if (hasMismatchedBrokerLocation) {
    throw new BrokerRpcError(
      "CHROME_MCP_BROKER_UNAVAILABLE",
      "Chrome broker metadata belongs to another socket or workspace",
    );
  }

  const connection = await BrokerConnection.open(paths.socketPath);
  try {
    return Object.freeze({
      connection,
      hello: await handshake(connection, metadata, connectionId, paths, timeoutMs),
    });
  } catch (error: unknown) {
    connection.close();
    throw error;
  }
};

const socketAcceptsConnections = async (socketPath: string): Promise<boolean> => {
  try {
    const connection = await BrokerConnection.open(socketPath);
    connection.close();
    return true;
  } catch {
    return false;
  }
};

const spawnBrokerChild = async (options: ChromeBrokerClientOptions, paths: BrokerRuntimePaths) => {
  const log = await open(paths.logPath, "a", 0o600);
  try {
    const logMetadata = await log.stat();
    const logOffset = logMetadata.size;
    const source = resolveBrokerChildProcess({
      executablePath: options.executablePath,
      runtimeRoot: options.runtimeRoot,
      workspacePath: paths.canonicalWorkspace,
    });
    const child = Bun.spawn({
      cmd: [source.command, ...source.args],
      cwd: source.cwd,
      detached: process.platform === "win32",
      env: source.env,
      stderr: log.fd,
      stdin: "ignore",
      stdout: log.fd,
      windowsHide: true,
    });
    child.unref();
    return { child, logOffset };
  } finally {
    await log.close();
  }
};

const assertBrokerStartupRunning = async (
  startup: Awaited<ReturnType<typeof spawnBrokerChild>>,
  paths: BrokerRuntimePaths,
) => {
  const { exitCode, signalCode } = startup.child;
  if (exitCode === null && signalCode === null) {
    return;
  }

  const log = await open(paths.logPath, "r");
  let diagnostic: string;
  try {
    const logMetadata = await log.stat();
    const end = logMetadata.size;
    const start = Math.max(startup.logOffset, end - BROKER_STARTUP_DIAGNOSTIC_BYTES);
    const buffer = Buffer.alloc(Math.max(0, end - start));
    const { bytesRead } = await log.read(buffer, 0, buffer.length, start);
    diagnostic = buffer.subarray(0, bytesRead).toString("utf8").trim();
  } finally {
    await log.close();
  }

  const status = signalCode ? `received ${signalCode}` : `exited with code ${exitCode}`;
  const diagnosticText = diagnostic ? `\n${diagnostic}` : "";
  throw new BrokerRpcError(
    "CHROME_MCP_BROKER_UNAVAILABLE",
    `Chrome broker startup process ${status} before becoming ready.${diagnosticText}\nBroker log: ${paths.logPath}`,
  );
};

const isBrokerProcessPossiblyRunning = async (metadata: BrokerMetadata) => {
  const identity = await probeProcessIdentity(metadata.pid, metadata.processStartIdentity);

  return identity === "same" || identity === "unknown";
};

const connectOrRetireLockedBroker = async (
  paths: BrokerRuntimePaths,
  connectionId: string,
  deadline: number,
) => {
  const current = await readBrokerMetadata(paths.metadataPath);
  if (current) {
    assertBrokerIsNotNewer(current);
    if (brokerMetadataVersion(current) === BROKER_PROTOCOL_VERSION) {
      try {
        const connected = await connectMetadata(
          current,
          connectionId,
          paths,
          Math.max(1, deadline - Date.now()),
        );
        return Object.freeze({ ...connected, paths });
      } catch (error: unknown) {
        if (await isBrokerProcessPossiblyRunning(current)) throw error;
      }
    } else {
      await retireChromeBroker(current, { timeoutMs: Math.max(1, deadline - Date.now()) });
    }
  } else if (await socketAcceptsConnections(paths.socketPath)) {
    throw new BrokerRpcError(
      "CHROME_MCP_BROKER_UNAVAILABLE",
      "Chrome broker socket is live but has no matching owner metadata; it will not be replaced",
    );
  }
};

const connectOrSpawn = async (
  options: ChromeBrokerClientOptions,
  connectionId: string,
): Promise<
  Readonly<{
    connection: BrokerConnection;
    hello: z.infer<typeof brokerResults.hello>;
    paths: BrokerRuntimePaths;
  }>
> => {
  const runtimeRoot = resolve(options.runtimeRoot ?? getMcpRuntimeDir());
  const paths = await resolveBrokerRuntimePaths(options.workspacePath, runtimeRoot);
  await ensureOwnerOnlyBrokerRoot(paths);
  const deadline = Date.now() + (options.connectBudgetMs ?? BROKER_CONNECT_BUDGET_MS);
  let attempt = 0;
  let lastError: Error = new BrokerRpcError("CHROME_MCP_BROKER_UNAVAILABLE", "Chrome broker did not start");

  while (Date.now() < deadline) {
    const metadata = await readBrokerMetadata(paths.metadataPath);
    if (metadata) {
      assertBrokerIsNotNewer(metadata);
      if (brokerMetadataVersion(metadata) === BROKER_PROTOCOL_VERSION) {
        try {
          const connected = await connectMetadata(
            metadata,
            connectionId,
            paths,
            Math.max(1, deadline - Date.now()),
          );
          return Object.freeze({ ...connected, paths });
        } catch (error: unknown) {
          lastError = brokerError(error);

          if (await isBrokerProcessPossiblyRunning(metadata)) {
            await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 250);
            attempt += 1;
            continue;
          }
        }
      } else {
        lastError = new BrokerRpcError(
          "CHROME_MCP_BROKER_UNAVAILABLE",
          `Replacing Chrome broker protocol ${brokerMetadataVersion(metadata)} with ${BROKER_PROTOCOL_VERSION}`,
        );
      }
    }

    const lock = await tryAcquireBrokerStartupLock(paths.startupLockPath);
    if (!lock) {
      await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 250);
      attempt += 1;
      continue;
    }
    try {
      const connected = await connectOrRetireLockedBroker(paths, connectionId, deadline);
      if (connected) return connected;
      await removeBrokerRuntimeFiles(paths);
      const startup = await spawnBrokerChild({ ...options, runtimeRoot }, paths);
      while (Date.now() < deadline) {
        await assertBrokerStartupRunning(startup, paths);
        const started = await readBrokerMetadata(paths.metadataPath);
        if (started) {
          assertBrokerIsNotNewer(started);

          try {
            const startedConnection = await connectMetadata(
              started,
              connectionId,
              paths,
              Math.max(1, deadline - Date.now()),
            );
            return Object.freeze({ ...startedConnection, paths });
          } catch (error: unknown) {
            lastError = brokerError(error);
          }
        }
        await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 250);
        attempt += 1;
      }
      await assertBrokerStartupRunning(startup, paths);
    } finally {
      await lock.release();
    }
  }
  throw lastError;
};

export const connectChromeBroker = async (
  options: ChromeBrokerClientOptions,
): Promise<ChromeBrokerClient> => {
  if (!isSupportedBunVersion(Bun.version)) {
    throw new BrokerRpcError(
      "CHROME_MCP_BROKER_UNAVAILABLE",
      `Chrome MCP requires Bun ${MINIMUM_BUN_VERSION_TEXT} or newer; current Bun is ${Bun.version}`,
    );
  }
  if (!options.executablePath.trim()) {
    throw new BrokerRpcError("CHROME_MCP_BROKER_UNAVAILABLE", "Chrome executable path must be nonblank");
  }
  const parsedConnectionId = brokerParams.hello.shape.connectionId.safeParse(options.connectionId);
  if (!parsedConnectionId.success) {
    throw new BrokerRpcError(
      "CHROME_MCP_BROKER_INVALID_REQUEST",
      "Chrome broker connection ID must be a nonblank identifier of at most 256 characters without outer whitespace",
    );
  }
  const connectionId = parsedConnectionId.data;
  const connected = await connectOrSpawn(options, connectionId);
  const acquisitions = new Map<BrowserMode, Promise<RemoteBrowserSession>>();
  const sessions = new Map<BrowserMode, RemoteBrowserSession>();
  const nativeScales = new Map<BrowserMode, number | undefined>();
  let closed = false;
  const client: ChromeBrokerClient = {
    brokerId: connected.hello.brokerId,
    brokerPid: connected.hello.brokerPid,
    get closed() {
      return closed || connected.connection.closed;
    },
    connectionId,
    acquire: async (mode, nativeDeviceScaleFactor) => {
      if (closed) throw new BrokerRpcError("CHROME_MCP_BROKER_CLOSED", "Chrome broker client is closed");

      assertNativeDeviceScaleFactor(mode, nativeDeviceScaleFactor);

      if (nativeScales.has(mode)) {
        assertMatchingNativeDeviceScaleFactor(nativeScales.get(mode), nativeDeviceScaleFactor);
      }

      const existing = sessions.get(mode);
      if (existing) return existing;
      const pending = acquisitions.get(mode);
      if (pending) return pending;

      nativeScales.set(mode, nativeDeviceScaleFactor);
      const acquisition = (async () => {
        const timeoutMs =
          mode === "main" ?
            MAIN_CHROME_CONNECT_TIMEOUT_MS + BROKER_REQUEST_TIMEOUT_MS + BROKER_ADMISSION_RESPONSE_GRACE_MS
          : BROKER_REQUEST_TIMEOUT_MS;
        const mainUserDataDir = mode === "main" ? options.mainUserDataDir : undefined;
        const result = brokerResults.acquired.parse(
          await connected.connection.request(
            "session.acquire",
            {
              mode,
              ...(mainUserDataDir === undefined ? {} : { mainUserDataDir }),
              ...(nativeDeviceScaleFactor === undefined ? {} : { nativeDeviceScaleFactor }),
            },
            { timeoutMs },
          ),
        );
        const session = new BrokerRemoteSession({
          connection: connected.connection,
          connectionId,
          mode: result.mode,
          ownerGeneration: result.ownerGeneration,
          ownerId: result.ownerId,
          onClose: () => {
            sessions.delete(mode);
            nativeScales.delete(mode);
          },
          sessionId: result.sessionId,
          target: result.target,
        });
        sessions.set(mode, session);
        return session;
      })();
      acquisitions.set(mode, acquisition);
      try {
        return await acquisition;
      } catch (error: unknown) {
        nativeScales.delete(mode);
        throw error;
      } finally {
        if (acquisitions.get(mode) === acquisition) acquisitions.delete(mode);
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await connected.connection
          .request("connection.close", {}, { timeoutMs: BROKER_REQUEST_TIMEOUT_MS })
          .catch((error: unknown) => {
            if (!connected.connection.closed) throw error;
          });
      } finally {
        connected.connection.close();
        acquisitions.clear();
        sessions.clear();
        nativeScales.clear();
      }
    },
    disconnect: () => {
      if (closed) return;
      closed = true;
      connected.connection.close();
      acquisitions.clear();
      sessions.clear();
      nativeScales.clear();
    },
    onClose: (handler) => connected.connection.onClose(handler),
    onDownloadFinished: (listener) => connected.connection.setDownloadListener(listener),
    status: async () => brokerResults.status.parse(await connected.connection.request("broker.status", {})),
  };
  connected.connection.onClose(() => {
    closed = true;
    acquisitions.clear();
    sessions.clear();
    nativeScales.clear();
  });
  return Object.freeze(client);
};
