import { describe, expect, jest, spyOn, test } from "bun:test";
import { ok } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import type {
  BrokerBackend,
  BrokerBackendSelection,
  BrokerBackendSession,
  BrokerDownloadPublisher,
  BrokerOwnedDownload,
} from "./backend";
import {
  type ActiveDialog,
  type ActiveFileChooser,
  type BrowserCallAdmission,
  type BrowserJournalEvent,
  type BrowserMode,
  type BrowserOwnerCloseResource,
  type BrowserOwnerSnapshot,
  currentProcessStartIdentity,
  type EventCursor,
  type GenerationTargetId,
  isIsolatedMode,
  type JournalReadOptions,
  type JournalReadResult,
  OwnerAdmissionQueue,
  type PersistentMutationEntry,
  type PersistentMutationInput,
  type PersistentMutationKind,
  PersistentMutationRegistry,
} from "../runtime";
import { CdpCommandError } from "../runtime/cdp-connection";
import {
  type ReactBrowserOperation,
  reactBrowserOperationSchema,
  type ReactOperationResult,
} from "../runtime/react-inspection-protocol";
import { BrokerRuntime } from "../server/broker-runtime";
import { createBrokerChildEnvironment, resolveBrokerChildProcess } from "./child-environment";
import * as childEnvironment from "./child-environment";
import { createBrokerChildTermination } from "./child-shutdown";
import { brokerAdmissionRequestTimeoutMs, type ChromeBrokerClient, connectChromeBroker } from "./client";
import {
  BROKER_CHILD_EXECUTABLE_ENV,
  BROKER_CHILD_RUNTIME_ENV,
  BROKER_CHILD_WORKSPACE_ENV,
  BROKER_MAX_FRAME_BYTES,
  BROKER_PROTOCOL_VERSION,
  BROKER_SHUTDOWN_MAX_ATTEMPTS,
} from "./constants";
import { BrokerRpcError } from "./errors";
import { createBrokerFrameDecoder, encodeBrokerFrame } from "./framing";
import {
  type BrokerMetadata,
  type BrokerRuntimePaths,
  claimBrokerMetadata,
  ensureOwnerOnlyBrokerRoot,
  readBrokerMetadata,
  resolveBrokerRuntimePaths,
  tryAcquireBrokerStartupLock,
  writeBrokerMetadata,
} from "./paths";
import { type BrokerRequest, brokerResponseSchema, journalReadOptionsSchema } from "./protocol";
import { retireChromeBroker } from "./retirement";
import { type BrokerRpcServer, startBrokerRpcServer } from "./server";

type FakeOwner = {
  clients: number;
  generation: number;
  key: string;
  mode: BrowserMode;
  nativeDeviceScaleFactor?: number;
  queue: OwnerAdmissionQueue;
  target: GenerationTargetId;
};

class FakeBackendSession implements BrokerBackendSession {
  pwa: BrokerBackendSession["pwa"] = (input, signal) => this.#backend.pwa(input, signal);

  pageViewport() {
    return Promise.resolve(null);
  }

  readonly connectionId: string;
  readonly mode: BrowserMode;
  readonly ownerId: string;
  readonly #backend: FakeBackend;
  readonly #listeners = new Map<string, Set<(params: unknown, sessionId: string | undefined) => void>>();
  readonly #mutations = new PersistentMutationRegistry();
  readonly #owner: FakeOwner;
  #closed = false;
  #cursor = 0;
  #dialog: ActiveDialog | undefined;
  #fileChooser: ActiveFileChooser | undefined;

  constructor(backend: FakeBackend, owner: FakeOwner, connectionId: string) {
    this.#backend = backend;
    this.#owner = owner;
    this.connectionId = connectionId;
    this.mode = owner.mode;
    this.ownerId = owner.key;
    this.#dialog = Object.freeze({
      defaultValue: "default",
      dialogId: randomUUID(),
      dialogType: "prompt",
      message: "question",
      ownerGeneration: owner.generation,
      sessionId: "dialog-session",
      targetId: owner.target.targetId,
    });
    this.#fileChooser = Object.freeze({
      accept: ".txt",
      backendNodeId: 1,
      chooserId: randomUUID(),
      multiple: false,
      ownerGeneration: owner.generation,
      sessionId: "chooser-session",
      targetId: owner.target.targetId,
    });
  }

  get ownerGeneration(): number {
    return this.#owner.generation;
  }

  get pendingAdmissions(): number {
    return this.#owner.queue.pending + (this.#owner.queue.running ? 1 : 0);
  }

  activeDialog(): ActiveDialog | undefined {
    return this.#dialog;
  }

  activeFileChooser(): ActiveFileChooser | undefined {
    return this.#fileChooser;
  }

  addMutation(input: PersistentMutationInput, target: GenerationTargetId): Promise<PersistentMutationEntry> {
    if (
      target.targetId !== this.#owner.target.targetId ||
      target.ownerGeneration !== this.#owner.target.ownerGeneration
    ) {
      return Promise.reject(new Error("stale mutation target"));
    }
    return this.#mutations.add(input);
  }

  admit<Result>(operation: BrowserCallAdmission<Result>): Promise<Result> {
    return this.#owner.queue.admit(operation);
  }

  authorizeOwnerClose(resource: BrowserOwnerCloseResource): void {
    this.#backend.authorizedCloses.push(resource);
  }

  async beginSelection(): Promise<BrokerBackendSelection> {
    this.#backend.selectionBeginStarted?.();
    await this.#backend.selectionBeginDelay;
    if (this.#backend.selectionBeginFailure) throw this.#backend.selectionBeginFailure;
    const initialTarget = this.#owner.target;
    let selected = initialTarget;
    return Object.freeze({
      commit: async () => {
        if (this.#backend.selectionCommitFailure) throw this.#backend.selectionCommitFailure;
        this.#owner.target = selected;
        return selected;
      },
      initialTarget,
      prepare: () => Promise.resolve({ target: selected, hasBlockingDialog: false }),
      recordCreated: (target: GenerationTargetId) => {
        selected = target;
      },
      rollback: () => {
        this.#backend.selectionRollbacks++;
        if (this.#backend.selectionRollbackFailure) throw this.#backend.selectionRollbackFailure;
        return initialTarget;
      },
      select: async (target: GenerationTargetId) => {
        if (this.#backend.selectionSelectFailure) throw this.#backend.selectionSelectFailure;
        selected = target;
      },
    });
  }

  clearMutations(kind: PersistentMutationKind): Promise<number> {
    return Promise.resolve(this.#mutations.clear(kind).length);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#owner.clients -= 1;
    this.#backend.closedSessions += 1;
    this.#backend.sessionClosed?.();
  }

  currentEventCursor(): EventCursor {
    return Object.freeze({ ownerGeneration: this.ownerGeneration, sequence: this.#cursor });
  }

  currentTarget(): GenerationTargetId {
    return this.#owner.target;
  }

  async ensureTarget(): Promise<GenerationTargetId> {
    return this.#owner.target;
  }

  eventRange(_after: EventCursor, _targetId: string): BrowserJournalEvent[] {
    return [];
  }

  async handleDialog(dialogId: string, _accept: boolean, _promptText?: string): Promise<void> {
    if (this.#dialog?.dialogId !== dialogId) throw new Error("stale dialog");
    this.#dialog = undefined;
  }

  enableOwnedDownloads(): Promise<void> {
    return Promise.resolve();
  }

  invalidateOwner(): void {
    this.#backend.invalidatedOwners += 1;
  }

  journalCapabilities() {
    return Object.freeze({
      currentSequence: this.#cursor,
      eventCount: 0,
      firstRetainedSequence: this.#cursor + 1,
      retainedBytes: 0,
    });
  }

  listMutations(kind: PersistentMutationKind): PersistentMutationEntry[] {
    return this.#mutations.entries(kind);
  }

  markEvents(): EventCursor {
    return this.currentEventCursor();
  }

  onCdp(method: string, listener: (params: unknown, sessionId: string | undefined) => void): () => void {
    const listeners = this.#listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  readEvents(_options: JournalReadOptions & Readonly<{ advance?: boolean }> = {}): JournalReadResult {
    const cursor = this.currentEventCursor();
    return Object.freeze({ droppedBefore: null, events: [], nextCursor: cursor, ownerReset: false });
  }

  react(input: ReactBrowserOperation): Promise<ReactOperationResult> {
    return Promise.resolve({
      data: {
        operation: input.operation,
        ...(input.operation === "list" && input.search === "__large__" ?
          { payload: "x".repeat(17 * 1024 * 1024) }
        : {}),
      },
      documentId: randomUUID(),
      frameId: "fake-frame",
      instrumentationState: "attached",
      reloaded: false,
      rendererCapabilities: {
        canEditContext: false,
        canEditHooks: false,
        canEditProps: false,
        canEditState: false,
        canHighlight: true,
        canInspect: true,
        canProfile: false,
        domMapping: true,
        ownerMetadata: false,
        sourceMetadata: true,
      },
      targetId: this.#owner.target.targetId,
      url: "https://example.test",
      warnings: [],
    });
  }

  removeMutation(kind: PersistentMutationKind, id: string): Promise<boolean> {
    return Promise.resolve(this.#mutations.remove(kind, id) !== undefined);
  }

  requireNoBlockingModal(): void {
    if (this.#dialog || this.#fileChooser) throw new Error("blocking modal");
  }

  async sendCdp(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    _timeoutMs?: number,
  ): Promise<unknown> {
    if (method === "Test.emit") {
      for (const listener of this.#listeners.get("Test.event") ?? []) listener(params, sessionId);
    }
    if (method === "Test.emitLarge") {
      const payload = { value: "x".repeat(BROKER_MAX_FRAME_BYTES) };
      for (const listener of this.#listeners.get("Test.event") ?? []) listener(payload, sessionId);
    }
    if (method === "Test.largeResult") {
      return { value: "x".repeat(BROKER_MAX_FRAME_BYTES) };
    }
    if (method === "Test.largeRequest") {
      return { length: typeof params.value === "string" ? params.value.length : -1 };
    }
    if (method === "Test.invalidParams") {
      throw new CdpCommandError("Invalid parameters", -32_602);
    }
    return { method, params, sessionId: sessionId ?? null };
  }

  async setFileChooserFiles(chooserId: string, _files: readonly string[]): Promise<void> {
    if (this.#fileChooser?.chooserId !== chooserId) throw new Error("stale file chooser");
    this.#fileChooser = undefined;
  }

  snapshot(): BrowserOwnerSnapshot {
    return Object.freeze({
      browserConnected: true,
      chromeProduct: "FakeChrome/1",
      clients: this.#owner.clients,
      endpointAvailable: true,
      headless: this.mode.endsWith("headless"),
      ...(this.#owner.nativeDeviceScaleFactor === undefined ?
        {}
      : { nativeDeviceScaleFactor: this.#owner.nativeDeviceScaleFactor }),
      key: Object.freeze({
        id: this.ownerId,
        mode: this.mode,
        workspaceHash: "a".repeat(64),
      }),
      ownerGeneration: this.ownerGeneration,
      ownership: this.mode === "main" ? "attached" : "launched",
      selectedTargets: 1,
    });
  }

  targetRecord(targetId: string): Readonly<{ title?: string; url: string }> | undefined {
    return targetId === this.#owner.target.targetId ?
        Object.freeze({ title: "Fake", url: "about:blank" })
      : undefined;
  }

  workerConnection() {
    return Object.freeze({
      endpoint: "ws://127.0.0.1:9222/devtools/browser/private-token",
      executionEndpoint: "ws://127.0.0.1:9222/devtools/browser/execution-token",
      ownerGeneration: this.ownerGeneration,
      target: this.#owner.target,
    });
  }
}

class FakeBackend implements BrokerBackend {
  readonly authorizedCloses: BrowserOwnerCloseResource[] = [];
  readonly cleanupConnections: string[] = [];
  readonly cleanupDelays = new Map<string, Promise<void>>();
  readonly cleanupFailures = new Set<string>();
  readonly owners = new Map<string, FakeOwner>();
  readonly #cleanupWaiters = new Map<string, () => void>();
  #downloadPublisher: BrokerDownloadPublisher | undefined;
  acquiredSessions = 0;
  acquisitionDelay: Promise<void> | undefined;
  acquisitionStarted: (() => void) | undefined;
  closedSessions = 0;
  closeCalls = 0;
  closeFailure: Error | undefined;
  invalidatedOwners = 0;
  ownerLaunches = 0;
  selectionBeginDelay: Promise<void> | undefined;
  selectionBeginFailure: Error | undefined;
  selectionBeginStarted: (() => void) | undefined;
  selectionCommitFailure: Error | undefined;
  selectionRollbackFailure: Error | undefined;
  selectionRollbacks = 0;
  selectionSelectFailure: Error | undefined;
  sessionClosed: (() => void) | undefined;
  pwa: BrokerBackendSession["pwa"] = () => Promise.reject(new Error("PWA is not used in broker tests"));

  async acquire(
    connectionId: string,
    mode: BrowserMode,
    options?: Parameters<BrokerBackend["acquire"]>[2],
  ): Promise<BrokerBackendSession> {
    this.acquisitionStarted?.();
    await this.acquisitionDelay;
    const key = isIsolatedMode(mode) ? `${mode}:${connectionId}` : mode;
    let owner = this.owners.get(key);
    if (!owner) {
      owner = {
        clients: 0,
        generation: 1,
        key,
        mode,
        ...(options?.nativeDeviceScaleFactor === undefined ?
          {}
        : { nativeDeviceScaleFactor: options.nativeDeviceScaleFactor }),
        queue: new OwnerAdmissionQueue(),
        target: Object.freeze({ ownerGeneration: 1, targetId: `${key}:target-1` }),
      };
      this.owners.set(key, owner);
      this.ownerLaunches += 1;
    }
    owner.clients += 1;
    this.acquiredSessions += 1;
    return new FakeBackendSession(this, owner, connectionId);
  }

  async cleanupConnection(connectionId: string): Promise<void> {
    this.cleanupConnections.push(connectionId);
    this.#cleanupWaiters.get(connectionId)?.();
    this.#cleanupWaiters.delete(connectionId);
    await this.cleanupDelays.get(connectionId);
    if (this.cleanupFailures.has(connectionId)) throw new Error(`cleanup failed for ${connectionId}`);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    for (const owner of this.owners.values()) await owner.queue.shutdown(10);
    if (this.closeFailure) throw this.closeFailure;
  }

  publishDownload(download: BrokerOwnedDownload) {
    const publisher = this.#downloadPublisher;
    if (!publisher) throw new Error("broker test download publisher is unavailable");
    return publisher(download);
  }

  setDownloadPublisher(publisher: BrokerDownloadPublisher | undefined): void {
    this.#downloadPublisher = publisher;
  }

  waitForCleanup(connectionId: string): Promise<void> {
    if (this.cleanupConnections.includes(connectionId)) return Promise.resolve();

    return new Promise((resolve) => {
      this.#cleanupWaiters.set(connectionId, resolve);
    });
  }
}

type Harness = Readonly<{
  backend: FakeBackend;
  paths: BrokerRuntimePaths;
  server: BrokerRpcServer;
  stop: () => Promise<void>;
  workspace: string;
}>;

const createHarness = async (
  options: Readonly<{
    disconnectGraceMs?: number;
    initialIdleMs?: number;
    onIdle?: () => void;
  }> = {},
): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), "chrome-broker-rpc-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await Bun.write(join(workspace, ".keep"), "");
  const runtimeRoot = join(root, "runtime");
  const paths = await resolveBrokerRuntimePaths(workspace, runtimeRoot);
  await ensureOwnerOnlyBrokerRoot(paths);
  const backend = new FakeBackend();
  const processStartIdentity = await currentProcessStartIdentity();
  const brokerId = randomUUID();
  const server = await startBrokerRpcServer({
    backend,
    brokerId,
    ...(options.disconnectGraceMs === undefined ? {} : { disconnectGraceMs: options.disconnectGraceMs }),
    ...(options.initialIdleMs === undefined ? {} : { initialIdleMs: options.initialIdleMs }),
    ...(options.onIdle === undefined ? {} : { onIdle: options.onIdle }),
    paths,
    processStartIdentity,
  });
  await writeBrokerMetadata(paths.metadataPath, {
    brokerId,
    createdAt: new Date().toISOString(),
    pid: process.pid,
    protocolVersion: BROKER_PROTOCOL_VERSION,
    processStartIdentity,
    socketPath: paths.socketPath,
    workspaceHash: paths.workspaceHash,
  });
  return Object.freeze({
    backend,
    paths,
    server,
    stop: async () => {
      let failure: unknown;
      await server.shutdown("test complete").catch((error: unknown) => {
        failure = error;
      });
      await unlink(paths.metadataPath).catch(() => undefined);
      await rm(root, { force: true, recursive: true });
      if (failure !== undefined) throw failure;
    },
    workspace,
  });
};

const connectHarness = (harness: Harness, connectionId: string = randomUUID()): Promise<ChromeBrokerClient> =>
  connectChromeBroker({
    connectionId,
    executablePath: "/bin/true",
    runtimeRoot: join(harness.paths.root, "..", "..", ".."),
    workspacePath: harness.workspace,
  });

const rejectsWithin = async (promise: Promise<unknown>, milliseconds = 2000): Promise<unknown> => {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error("operation did not settle")), milliseconds);
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
};

describe("broker runtime paths", () => {
  test("keeps sockets short when the runtime and platform temporary directories are long", async () => {
    const previousEnvironment = process.env;
    process.env = { ...previousEnvironment, TMPDIR: `/var/folders/${"a".repeat(80)}/T` };

    try {
      const paths = await resolveBrokerRuntimePaths(process.cwd(), `/runtime/${"b".repeat(120)}`);
      expect(paths.socketRoot).toStartWith("/tmp/chrome-mcp-u");
      expect(Buffer.byteLength(paths.socketPath, "utf8")).toBeLessThanOrEqual(103);
      expect(paths.root).toStartWith(`/runtime/${"b".repeat(120)}`);
    } finally {
      process.env = previousEnvironment;
    }
  });
});

describe("broker framing", () => {
  test("round trips fragmented JSON frames and rejects invalid lengths", () => {
    const decoder = createBrokerFrameDecoder();
    const frame = encodeBrokerFrame({ hello: "world" });
    expect(decoder.push(frame.slice(0, 2))).toEqual([]);
    expect(decoder.push(frame.slice(2))).toEqual([{ hello: "world" }]);

    const oversized = new Uint8Array(4);
    new DataView(oversized.buffer).setUint32(0, BROKER_MAX_FRAME_BYTES + 1, false);
    expect(() => decoder.push(oversized)).toThrow(BrokerRpcError);
  });
});

describe("broker lifecycle and protocol", () => {
  test("validates native scale before returning a cached protocol session", async () => {
    const harness = await createHarness();
    const decoder = createBrokerFrameDecoder();
    let pending: ReturnType<typeof Promise.withResolvers<unknown>> | undefined;
    const socket = await Bun.connect({
      unix: harness.paths.socketPath,
      socket: {
        data: (_socket, data) => {
          for (const frame of decoder.push(data)) {
            ok(pending);
            pending.resolve(brokerResponseSchema.parse(frame));
          }
        },
      },
    });

    const request = async (method: BrokerRequest["method"], params: BrokerRequest["params"]) => {
      pending = Promise.withResolvers<unknown>();
      socket.write(
        encodeBrokerFrame({ id: randomUUID(), kind: "request", method, params } satisfies BrokerRequest),
      );
      return brokerResponseSchema.parse(await rejectsWithin(pending.promise));
    };

    try {
      expect(
        await request("broker.hello", {
          connectionId: "native-protocol",
          protocolVersion: BROKER_PROTOCOL_VERSION,
          workspaceHash: harness.paths.workspaceHash,
        }),
      ).toMatchObject({ ok: true });
      expect(await request("session.acquire", { mode: "isolated-headless" })).toMatchObject({ ok: true });
      expect(
        await request("session.acquire", { mode: "isolated-headless", nativeDeviceScaleFactor: 1 }),
      ).toMatchObject({
        ok: false,
        error: { code: "CHROME_MCP_INVALID_INPUT" },
      });

      const native = { mode: "isolated-virtual-display", nativeDeviceScaleFactor: 1.296_875 };
      const acquired = await request("session.acquire", native);
      ok(acquired.ok);

      const cached = await request("session.acquire", native);
      ok(cached.ok);
      expect(cached.result).toEqual(acquired.result);
      expect(await request("session.acquire", { ...native, nativeDeviceScaleFactor: 2 })).toMatchObject({
        ok: false,
        error: { code: "CHROME_MCP_INVALID_INPUT" },
      });
      expect(await request("session.acquire", { mode: native.mode })).toMatchObject({
        ok: false,
        error: { code: "CHROME_MCP_INVALID_INPUT" },
      });
    } finally {
      socket.end();
      await harness.stop();
    }
  });

  test("sends the configured profile folder only with a request for the user's own browser", async () => {
    const harness = await createHarness();
    const client = await connectChromeBroker({
      connectionId: "main-profile-client",
      executablePath: "/bin/true",
      mainUserDataDir: "/profiles/chromium",
      runtimeRoot: join(harness.paths.root, "..", "..", ".."),
      workspacePath: harness.workspace,
    });
    const backend: BrokerBackend = harness.backend;
    const acquisition = spyOn(backend, "acquire");

    try {
      await client.acquire("main");
      await client.acquire("isolated");
      expect(acquisition.mock.calls).toEqual([
        [
          client.connectionId,
          "main",
          { mainUserDataDir: "/profiles/chromium", nativeDeviceScaleFactor: undefined },
        ],
        [client.connectionId, "isolated", { mainUserDataDir: undefined, nativeDeviceScaleFactor: undefined }],
      ]);
    } finally {
      acquisition.mockRestore();
      await client.close();
      await harness.stop();
    }
  });

  test("launches a virtual-display browser at the requested native scale and rejects a different scale for it", async () => {
    const harness = await createHarness();
    const client = await connectHarness(harness, "native-scale-client");

    const backend: BrokerBackend = harness.backend;
    const acquisition = spyOn(backend, "acquire");

    try {
      await client.acquire("isolated");
      await client.acquire("isolated-virtual-display", 1.296_875);
      expect(acquisition.mock.calls).toEqual([
        [client.connectionId, "isolated", { nativeDeviceScaleFactor: undefined }],
        [client.connectionId, "isolated-virtual-display", { nativeDeviceScaleFactor: 1.296_875 }],
      ]);
      expect(client.acquire("isolated-virtual-display", 2)).rejects.toMatchObject({
        code: "CHROME_MCP_INVALID_INPUT",
      });
    } finally {
      acquisition.mockRestore();
      await client.close();
      await harness.stop();
    }
  });

  test("shares one child termination and recovers from transient cleanup failure", async () => {
    const firstAttempt = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<0 | 1>();
    const reasons: string[] = [];
    let attempts = 0;
    let exitCalls = 0;
    let metadataCleanup = 0;
    let retries = 0;
    const termination = createBrokerChildTermination({
      cleanupMetadata: async () => {
        metadataCleanup += 1;
      },
      cleanupServer: async (reason) => {
        attempts += 1;
        reasons.push(reason);
        if (attempts !== 1) return;
        await firstAttempt.promise;
        throw new Error("transient shutdown failure");
      },
      exit: (code) => {
        exitCalls += 1;
        exited.resolve(code);
      },
      onRetry: () => {
        retries += 1;
      },
      timeoutMs: 100,
      waitBeforeRetry: () => Promise.resolve(),
    });

    termination.request("SIGTERM", "graceful");
    termination.request("SIGINT", "graceful");
    firstAttempt.resolve();

    expect(await rejectsWithin(exited.promise, 100)).toBe(0);
    expect(attempts).toBe(2);
    expect(reasons).toEqual(["SIGTERM", "SIGTERM"]);
    expect(retries).toBe(1);
    expect(metadataCleanup).toBe(1);
    expect(exitCalls).toBe(1);
  });

  test("exits nonzero after bounded persistent cleanup failure", async () => {
    const exited = Promise.withResolvers<0 | 1>();
    let attempts = 0;
    let metadataCleanup = 0;
    let retries = 0;
    const termination = createBrokerChildTermination({
      cleanupMetadata: async () => {
        metadataCleanup += 1;
      },
      cleanupServer: () => {
        attempts += 1;
        return Promise.reject(new Error("persistent shutdown failure"));
      },
      exit: exited.resolve,
      onRetry: () => {
        retries += 1;
      },
      timeoutMs: 100,
      waitBeforeRetry: () => Promise.resolve(),
    });

    termination.request("SIGTERM", "graceful");
    expect(await rejectsWithin(exited.promise, 100)).toBe(1);
    expect(attempts).toBe(BROKER_SHUTDOWN_MAX_ATTEMPTS);
    expect(retries).toBe(BROKER_SHUTDOWN_MAX_ATTEMPTS - 1);
    expect(metadataCleanup).toBe(1);
  });

  test("upgrades a shared graceful termination to fatal", async () => {
    const cleanup = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<0 | 1>();
    let cleanupCalls = 0;
    let metadataCleanup = 0;
    const termination = createBrokerChildTermination({
      cleanupMetadata: async () => {
        metadataCleanup += 1;
      },
      cleanupServer: async () => {
        cleanupCalls += 1;
        await cleanup.promise;
      },
      exit: exited.resolve,
      onRetry: () => undefined,
      timeoutMs: 100,
      waitBeforeRetry: () => Promise.resolve(),
    });

    termination.request("SIGTERM", "graceful");
    termination.request("uncaughtException: injected failure", "fatal");
    cleanup.resolve();

    expect(await rejectsWithin(exited.promise, 100)).toBe(1);
    expect(cleanupCalls).toBe(1);
    expect(metadataCleanup).toBe(1);
  });

  test("exits a real signal-driven process when cleanup never settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-broker-shutdown-test-"));
    const cleanupMarker = join(root, "cleanup");
    const metadataMarker = join(root, "metadata");
    const moduleUrl = new URL("./child-shutdown.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
        const { createBrokerChildTermination } = await import(${JSON.stringify(moduleUrl)});
        const never = new Promise(() => undefined);
        let cleanupCalls = 0;
        const termination = createBrokerChildTermination({
          cleanupMetadata: async () => {
            await Bun.write(${JSON.stringify(metadataMarker)}, "attempted");
            await never;
          },
          cleanupServer: async () => {
            cleanupCalls += 1;
            await Bun.write(${JSON.stringify(cleanupMarker)}, String(cleanupCalls));
            await never;
          },
          exit: (code) => process.exit(code),
          onRetry: () => undefined,
          timeoutMs: 50,
          waitBeforeRetry: () => Promise.resolve(),
        });
        process.on("SIGTERM", () => termination.request("SIGTERM", "graceful"));
        console.log("ready");
        await never;
      `,
      ],
      {
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("ready");

      const startedAt = Date.now();
      child.kill("SIGTERM");
      child.kill("SIGTERM");
      expect(await rejectsWithin(child.exited, 500)).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(250);
      expect(await Bun.file(cleanupMarker).text()).toBe("1");
      expect(await Bun.file(metadataMarker).text()).toBe("attempted");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      await rm(root, { force: true, recursive: true });
    }
  });

  test("bounds in-process termination when cleanup never settles", async () => {
    const never = Promise.withResolvers<void>().promise;
    const exited = Promise.withResolvers<0 | 1>();
    let attempts = 0;
    let metadataCleanup = 0;
    const termination = createBrokerChildTermination({
      cleanupMetadata: () => {
        metadataCleanup += 1;
        return never;
      },
      cleanupServer: () => {
        attempts += 1;
        return never;
      },
      exit: exited.resolve,
      onRetry: () => undefined,
      timeoutMs: 30,
      waitBeforeRetry: () => Promise.resolve(),
    });

    termination.request("SIGTERM", "graceful");
    termination.request("SIGINT", "graceful");
    expect(await rejectsWithin(exited.promise, 100)).toBe(1);
    expect(attempts).toBe(1);
    expect(metadataCleanup).toBe(1);
  });

  test("allows admission queueing through the public 120 second deadline and rejects journal limits above 200", () => {
    const now = 1_000_000;
    expect(brokerAdmissionRequestTimeoutMs(undefined, now)).toBe(30_000);
    expect(brokerAdmissionRequestTimeoutMs(now + 120_000, now)).toBe(121_000);
    expect(journalReadOptionsSchema.parse({ limit: 200 })).toEqual({ limit: 200 });
    expect(() => journalReadOptionsSchema.parse({ limit: 201 })).toThrow();
  });

  test("accepts only internal prepare and staged-node React broker operations", () => {
    const key = "__chromeMcpReactNode_0123456789abcdef0123456789abcdef";
    expect(BROKER_PROTOCOL_VERSION).toBe(16);
    expect(reactBrowserOperationSchema.parse({ operation: "prepare" })).toEqual({ operation: "prepare" });
    expect(
      reactBrowserOperationSchema.parse({
        lookup: { key, type: "staged-node" },
        operation: "inspect",
      }),
    ).toEqual({ lookup: { key, type: "staged-node" }, operation: "inspect" });
    expect(() =>
      reactBrowserOperationSchema.parse({
        lookup: { key: "__chromeMcpReactNode_NOT_HEX", type: "staged-node" },
        operation: "inspect",
      }),
    ).toThrow();
    expect(() =>
      reactBrowserOperationSchema.parse({
        lookup: { ref: "s1e7", type: "snapshot-ref" },
        operation: "inspect",
      }),
    ).toThrow();
  });

  test("reports initial idle when a spawned broker receives no authenticated connection", async () => {
    const idle = Promise.withResolvers<void>();
    const harness = await createHarness({ initialIdleMs: 0, onIdle: idle.resolve });
    try {
      await rejectsWithin(idle.promise);
    } finally {
      await harness.stop();
    }
  });

  test("keeps credentials and preloaded libraries out of the broker child environment", () => {
    const environment = createBrokerChildEnvironment({
      executablePath: "/chrome",
      runtimeRoot: "/runtime",
      source: {
        LD_PRELOAD: "/tmp/preload.so",
        OPENAI_API_KEY: "secret",
        PATH: "/bin",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "wayland-1",
        XAUTHORITY: "/home/user/.Xauthority",
      },
      workspacePath: "/workspace",
    });

    expect(environment).toEqual({
      [BROKER_CHILD_EXECUTABLE_ENV]: "/chrome",
      [BROKER_CHILD_RUNTIME_ENV]: "/runtime",
      [BROKER_CHILD_WORKSPACE_ENV]: "/workspace",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      DISPLAY: ":0",
      NO_COLOR: "1",
      PATH: "/bin",
      WAYLAND_DISPLAY: "wayland-1",
      XAUTHORITY: "/home/user/.Xauthority",
    });
  });

  test("starts the broker in the workspace with a sanitized environment", () => {
    const options = {
      executablePath: "/chrome",
      runtimeRoot: "/runtime",
      source: {
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        DISPLAY: ":0",
        LD_PRELOAD: "/tmp/preload.so",
        PATH: "/bin",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      workspacePath: "/workspace",
    };
    const child = resolveBrokerChildProcess(options);

    expect(child.command).toBe(process.execPath);
    expect(child.cwd).toBe("/workspace");
    expect(child.env).toEqual({
      [BROKER_CHILD_EXECUTABLE_ENV]: "/chrome",
      [BROKER_CHILD_RUNTIME_ENV]: "/runtime",
      [BROKER_CHILD_WORKSPACE_ENV]: "/workspace",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      DISPLAY: ":0",
      NO_COLOR: "1",
      PATH: "/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
  });

  test("publishes one complete owner-only startup lock under contention", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-broker-startup-lock-test-"));
    const path = join(root, "startup.lock");
    const locks = await Promise.all(Array.from({ length: 64 }, () => tryAcquireBrokerStartupLock(path)));
    const acquired = locks.filter((lock) => lock !== undefined);
    try {
      expect(acquired).toHaveLength(1);
      const lockMetadata = await stat(path);
      expect(lockMetadata.mode & 0o777).toBe(0o600);
    } finally {
      await Promise.all(acquired.map((lock) => lock.release()));
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reclaims a stale startup owner once under concurrent contention", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-broker-stale-lock-test-"));
    const path = join(root, "startup.lock");
    await Bun.write(
      path,
      `${JSON.stringify({
        createdAt: new Date().toISOString(),
        pid: process.pid,
        processStartIdentity: "stale-process-start-identity",
      })}\n`,
    );
    const locks = await Promise.all(Array.from({ length: 64 }, () => tryAcquireBrokerStartupLock(path)));
    const acquired = locks.filter((lock) => lock !== undefined);
    try {
      expect(acquired).toHaveLength(1);
    } finally {
      await Promise.all(acquired.map((lock) => lock.release()));
      await rm(root, { force: true, recursive: true });
    }
  });

  test("recovers a stale reclamation mutex left by a crashed contender", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-broker-stale-reclamation-test-"));
    const path = join(root, "startup.lock");
    const staleOwner = `${JSON.stringify({
      createdAt: new Date().toISOString(),
      pid: process.pid,
      processStartIdentity: "stale-process-start-identity",
    })}\n`;
    await Promise.all([Bun.write(path, staleOwner), Bun.write(`${path}.reclaim`, staleOwner)]);
    const lock = await tryAcquireBrokerStartupLock(path);
    if (!lock) throw new Error("Failed to recover the stale reclamation mutex");
    try {
      expect(await stat(path)).toBeDefined();
    } finally {
      await lock.release();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("metadata readers observe only absence or a complete exclusive claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-broker-metadata-claim-test-"));
    const processStartIdentity = await currentProcessStartIdentity();
    try {
      const interleavings = await Promise.all(
        Array.from({ length: 64 }, async (_, index) => {
          const path = join(root, `broker-${index}.json`);
          const metadata: BrokerMetadata = {
            brokerId: randomUUID(),
            createdAt: new Date().toISOString(),
            pid: process.pid,
            processStartIdentity,
            socketPath: join(root, `broker-${index}.sock`),
            workspaceHash: index.toString(16).padStart(64, "0"),
          };
          const writer = claimBrokerMetadata(path, metadata);
          const observed = await readBrokerMetadata(path);
          await writer;
          return Object.freeze({ final: await readBrokerMetadata(path), metadata, observed, path });
        }),
      );

      for (const interleaving of interleavings) {
        if (interleaving.observed) expect(interleaving.observed).toEqual(interleaving.metadata);
        expect(interleaving.final).toEqual(interleaving.metadata);
      }
      const firstInterleaving = interleavings[0];
      if (!firstInterleaving) throw new Error("metadata interleaving test did not create a claim");
      const lockMetadata = await stat(firstInterleaving.path);
      expect(lockMetadata.mode & 0o777).toBe(0o600);
      expect(
        claimBrokerMetadata(firstInterleaving.path, {
          ...firstInterleaving.metadata,
          brokerId: randomUUID(),
        }),
      ).rejects.toThrow();
      expect(await readBrokerMetadata(firstInterleaving.path)).toEqual(firstInterleaving.metadata);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("concurrent transports share one broker and one shared owner", async () => {
    const harness = await createHarness();
    const [first, second] = await Promise.all([connectHarness(harness), connectHarness(harness)]);
    try {
      expect(first.brokerId).toBe(second.brokerId);
      const [firstSession, secondSession] = await Promise.all([
        first.acquire("shared"),
        second.acquire("shared"),
      ]);
      expect(firstSession.ownerId).toBe(secondSession.ownerId);
      expect(harness.backend.ownerLaunches).toBe(1);
      const brokerStatus = await first.status();
      expect(brokerStatus.connections).toBe(2);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await harness.stop();
    }
  });

  test("concurrent same-mode acquisition creates one socket session", async () => {
    const harness = await createHarness();
    const client = await connectHarness(harness);
    try {
      const sessions = await Promise.all(Array.from({ length: 32 }, () => client.acquire("shared")));
      const first = sessions[0];
      if (!first) throw new Error("concurrent acquisition did not return a session");
      expect(sessions.every((session) => session === first)).toBe(true);
      expect(harness.backend.acquiredSessions).toBe(1);
    } finally {
      await client.close();
      await harness.stop();
    }
  });

  test("releases a remote browser session exactly once", async () => {
    const harness = await createHarness();
    const client = await connectHarness(harness);
    try {
      const session = await client.acquire("isolated-headless");
      await Promise.all([session.close(), session.close()]);
      expect(harness.backend.closedSessions).toBe(1);
    } finally {
      await client.close();
      await harness.stop();
    }
  });

  test("closes a late session after its acquisition request is canceled by transport loss", async () => {
    const harness = await createHarness({ disconnectGraceMs: 0 });
    const connectionId = "canceled-acquisition";
    const client = await connectHarness(harness, connectionId);
    const acquisitionStarted = Promise.withResolvers<void>();
    const releaseAcquisition = Promise.withResolvers<void>();
    const sessionClosed = Promise.withResolvers<void>();
    harness.backend.acquisitionStarted = acquisitionStarted.resolve;
    harness.backend.acquisitionDelay = releaseAcquisition.promise;
    harness.backend.sessionClosed = sessionClosed.resolve;
    const acquisition = client.acquire("shared");
    const acquisitionFailure = acquisition.catch((error: unknown) => error);
    await acquisitionStarted.promise;

    client.disconnect();
    await rejectsWithin(harness.backend.waitForCleanup(connectionId));
    releaseAcquisition.resolve();

    expect(await rejectsWithin(acquisitionFailure)).toBeInstanceOf(Error);
    await rejectsWithin(sessionClosed.promise);
    expect(harness.backend.closedSessions).toBe(1);

    harness.backend.acquisitionDelay = undefined;
    const replacement = await connectHarness(harness, connectionId);
    try {
      await replacement.acquire("shared");
      expect(harness.backend.acquiredSessions).toBe(2);
    } finally {
      await replacement.close();
      await harness.stop();
    }
  });

  test("abrupt socket loss cleans only the matching MCP connection lease", async () => {
    const harness = await createHarness({ disconnectGraceMs: 25 });
    const firstConnectionId = "authenticated-mcp-connection-first";
    const secondConnectionId = "authenticated-mcp-connection-second";
    const [first, second] = await Promise.all([
      connectHarness(harness, firstConnectionId),
      connectHarness(harness, secondConnectionId),
    ]);
    await Promise.all([first.acquire("shared"), second.acquire("shared")]);
    expect(first.connectionId).toBe(firstConnectionId);
    expect(second.connectionId).toBe(secondConnectionId);
    first.disconnect();
    try {
      await rejectsWithin(harness.backend.waitForCleanup(firstConnectionId));
      expect(harness.backend.cleanupConnections).toEqual([firstConnectionId]);
      expect(harness.backend.closedSessions).toBe(1);
      const brokerStatus = await second.status();
      expect(brokerStatus.connections).toBe(1);
    } finally {
      await second.close();
      await harness.stop();
    }
  });

  test("closes both transports when connection cleanup fails and allows the connection ID to reconnect", async () => {
    const harness = await createHarness();
    const connectionId = "cleanup-failure-reconnect";
    const client = await connectHarness(harness, connectionId);
    await client.acquire("shared");
    const closed = Promise.withResolvers<void>();
    client.onClose(closed.resolve);
    harness.backend.cleanupFailures.add(connectionId);
    try {
      expect(client.close()).rejects.toThrow();
      await rejectsWithin(closed.promise);
      expect(client.closed).toBeTrue();

      harness.backend.cleanupFailures.delete(connectionId);
      const replacement = await connectHarness(harness, connectionId);
      try {
        expect(replacement.closed).toBeFalse();
        const brokerStatus = await replacement.status();
        expect(brokerStatus.connections).toBe(1);
      } finally {
        await replacement.close();
      }
    } finally {
      harness.backend.cleanupFailures.delete(connectionId);
      await harness.stop();
    }
  });

  test("shares one exhaustive shutdown when socket and backend cleanup fail", async () => {
    const harness = await createHarness();
    const firstConnectionId = "shutdown-failure-first";
    const secondConnectionId = "shutdown-failure-second";
    const [first, second] = await Promise.all([
      connectHarness(harness, firstConnectionId),
      connectHarness(harness, secondConnectionId),
    ]);
    await Promise.all([first.acquire("shared"), second.acquire("shared")]);
    const firstClosed = Promise.withResolvers<void>();
    const secondClosed = Promise.withResolvers<void>();
    first.onClose(firstClosed.resolve);
    second.onClose(secondClosed.resolve);
    harness.backend.cleanupFailures.add(firstConnectionId);
    harness.backend.closeFailure = new Error("backend close failed");

    const firstShutdown = harness.server.shutdown("injected cleanup failure");
    const secondShutdown = harness.server.shutdown("concurrent shutdown");
    expect(secondShutdown).toBe(firstShutdown);
    try {
      expect(firstShutdown).rejects.toThrow();
      await Promise.all([rejectsWithin(firstClosed.promise), rejectsWithin(secondClosed.promise)]);
      expect(harness.backend.cleanupConnections.toSorted()).toEqual([firstConnectionId, secondConnectionId]);
      expect(harness.backend.closedSessions).toBe(2);
      expect(harness.backend.closeCalls).toBe(1);
      expect(first.closed).toBeTrue();
      expect(second.closed).toBeTrue();
      expect(await Bun.file(harness.paths.socketPath).exists()).toBeFalse();

      harness.backend.cleanupFailures.clear();
      harness.backend.closeFailure = undefined;
      const retry = harness.server.shutdown("retry transient shutdown failure");
      expect(retry).not.toBe(firstShutdown);
      await retry;
      expect(harness.backend.closeCalls).toBe(2);
      expect(harness.backend.cleanupConnections.toSorted()).toEqual([
        firstConnectionId,
        firstConnectionId,
        secondConnectionId,
      ]);
      expect(await Bun.file(harness.paths.socketPath).exists()).toBeFalse();
    } finally {
      harness.backend.cleanupFailures.clear();
      harness.backend.closeFailure = undefined;
      await harness.stop().catch(() => undefined);
    }
  });

  test("stops accepting connections before awaiting shutdown cleanup", async () => {
    const harness = await createHarness();
    const connectionId = "shutdown-admission-gate";
    const client = await connectHarness(harness, connectionId);
    await client.acquire("shared");
    const cleanup = Promise.withResolvers<void>();
    harness.backend.cleanupDelays.set(connectionId, cleanup.promise);
    const shutdown = harness.server.shutdown("delayed shutdown cleanup");
    await harness.backend.waitForCleanup(connectionId);
    try {
      expect(
        Bun.connect({
          unix: harness.paths.socketPath,
          socket: { data: () => undefined },
        }),
      ).rejects.toThrow();
    } finally {
      cleanup.resolve();
      harness.backend.cleanupDelays.delete(connectionId);
      await shutdown;
      await harness.stop();
    }
  });

  test("reconnects one BrokerRuntime connection after its broker transport dies", async () => {
    const harness = await createHarness();
    const runtimeRoot = join(harness.paths.root, "..", "..", "..");
    const runtime = BrokerRuntime.create({
      executablePath: "/bin/true",
      runtimeRoot,
      workspacePath: harness.workspace,
    });
    const connectionId = "broker-runtime-reconnect";
    const firstSession = await runtime.acquire(connectionId, "shared");
    let replacementServer: BrokerRpcServer | undefined;
    try {
      await harness.server.shutdown("injected broker death");
      const disconnected = Promise.withResolvers<void>();
      const observer = setInterval(() => {
        if (firstSession.closed) disconnected.resolve();
      }, 1);
      try {
        await rejectsWithin(disconnected.promise);
      } finally {
        clearInterval(observer);
      }

      const replacementBackend = new FakeBackend();
      const brokerId = randomUUID();
      const processStartIdentity = await currentProcessStartIdentity();
      replacementServer = await startBrokerRpcServer({
        backend: replacementBackend,
        brokerId,
        paths: harness.paths,
        processStartIdentity,
      });
      await writeBrokerMetadata(harness.paths.metadataPath, {
        brokerId,
        createdAt: new Date().toISOString(),
        pid: process.pid,
        protocolVersion: BROKER_PROTOCOL_VERSION,
        processStartIdentity,
        socketPath: harness.paths.socketPath,
        workspaceHash: harness.paths.workspaceHash,
      });

      const replacementSession = await runtime.acquire(connectionId, "shared");
      expect(replacementSession).not.toBe(firstSession);
      expect(replacementSession.closed).toBeFalse();
      expect(replacementBackend.acquiredSessions).toBe(1);
    } finally {
      await runtime.close().catch(() => undefined);
      await replacementServer?.shutdown("test complete").catch(() => undefined);
      await harness.stop().catch(() => undefined);
    }
  });

  test("acquires distinct reusable owners for isolated-headless browser instance IDs", async () => {
    const harness = await createHarness();
    const runtimeRoot = join(harness.paths.root, "..", "..", "..");
    const runtime = BrokerRuntime.create({
      executablePath: "/bin/true",
      runtimeRoot,
      workspacePath: harness.workspace,
    });
    const connectionId = "broker-runtime-isolated-instance";
    const firstBrowserInstanceId = "reusable-first";
    const secondBrowserInstanceId = "reusable-second";
    let publishedConnectionId: string | undefined;
    runtime.setDownloadPublisher(async (download) => {
      publishedConnectionId = download.connectionId;
      return {};
    });
    const first = await runtime.acquire(connectionId, "isolated-headless", {
      browserInstanceId: firstBrowserInstanceId,
    });
    const second = await runtime.acquire(connectionId, "isolated-headless", {
      browserInstanceId: secondBrowserInstanceId,
    });
    try {
      expect(first.connectionId).toBe(connectionId);
      expect(second.connectionId).toBe(connectionId);
      expect(second.ownerId).not.toBe(first.ownerId);
      await harness.backend.publishDownload({
        browserMode: "isolated-headless",
        connectionId: `${connectionId}\0${secondBrowserInstanceId}`,
        downloadId: "isolated-instance-download",
        ownerGeneration: second.ownerGeneration,
        path: "/internal/isolated-instance-download",
        targetId: second.currentTarget().targetId,
      });
      expect(publishedConnectionId).toBe(connectionId);

      await second.close();
      expect(second.closed).toBeTrue();
      expect(first.closed).toBeFalse();
      const replacement = await runtime.acquire(connectionId, "isolated-headless", {
        browserInstanceId: secondBrowserInstanceId,
      });
      expect(replacement.connectionId).toBe(connectionId);
      expect(replacement.closed).toBeFalse();
      await replacement.close();
    } finally {
      await first.close().catch(() => undefined);
      await second.close().catch(() => undefined);
      await runtime.close().catch(() => undefined);
      await harness.stop().catch(() => undefined);
    }
  });

  test("publishes an owned download only to its exact MCP connection and returns its acknowledgment", async () => {
    const harness = await createHarness();
    const firstConnectionId = "download-owner-first";
    const secondConnectionId = "download-owner-second";
    const [first, second] = await Promise.all([
      connectHarness(harness, firstConnectionId),
      connectHarness(harness, secondConnectionId),
    ]);
    let secondCalls = 0;
    const removeFirst = first.onDownloadFinished(async (download) => {
      expect(download).toEqual({
        browserMode: "shared",
        connectionId: firstConnectionId,
        downloadId: "download-1",
        ownerGeneration: 1,
        path: "/internal/download-1",
        suggestedFilename: "download.txt",
        targetId: "shared-target",
      });
      return { artifactUri: "artifact://connection/download-1", byteCount: 42 };
    });
    const removeSecond = second.onDownloadFinished(async () => {
      secondCalls += 1;
      return {};
    });
    try {
      expect(
        await harness.backend.publishDownload({
          browserMode: "shared",
          connectionId: firstConnectionId,
          downloadId: "download-1",
          ownerGeneration: 1,
          path: "/internal/download-1",
          suggestedFilename: "download.txt",
          targetId: "shared-target",
        }),
      ).toEqual({ artifactUri: "artifact://connection/download-1", byteCount: 42 });
      expect(secondCalls).toBe(0);
      expect(
        harness.backend.publishDownload({
          browserMode: "shared",
          connectionId: "unowned-download",
          downloadId: "download-2",
          ownerGeneration: 1,
          path: "/internal/download-2",
          targetId: "shared-target",
        }),
      ).rejects.toThrow();
      expect(secondCalls).toBe(0);
    } finally {
      removeFirst();
      removeSecond();
      await Promise.all([first.close(), second.close()]);
      await harness.stop();
    }
  });

  test("rejects a live socket without owner metadata instead of replacing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-broker-stale-socket-test-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const runtimeRoot = join(root, "runtime");
    const paths = await resolveBrokerRuntimePaths(workspace, runtimeRoot);
    await ensureOwnerOnlyBrokerRoot(paths);
    const listener = Bun.listen({
      unix: paths.socketPath,
      socket: {
        data: () => undefined,
      },
    });
    try {
      expect(
        connectChromeBroker({
          connectionId: randomUUID(),
          connectBudgetMs: 200,
          executablePath: "/bin/true",
          runtimeRoot,
          workspacePath: workspace,
        }),
      ).rejects.toThrow();
      expect(await Bun.file(paths.metadataPath).exists()).toBe(false);
    } finally {
      listener.stop(true);
      await unlink(paths.socketPath).catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("broker owner admission and runtime proxy", () => {
  test("cancels a pending PWA operation before waiting for admission cleanup", async () => {
    const harness = await createHarness();
    const client = await connectHarness(harness);
    const session = await client.acquire("isolated-headless");
    const started = Promise.withResolvers<void>();
    const canceled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    harness.backend.pwa = async (input, signal) => {
      ok(input.operation === "launch");

      const handleAbort = () => {
        canceled.resolve();
        release.reject(signal.reason);
      };

      signal.addEventListener("abort", handleAbort, { once: true });
      started.resolve();

      try {
        await release.promise;
        return { operation: "launch", targetId: "page-a" };
      } finally {
        signal.removeEventListener("abort", handleAbort);
      }
    };
    const controller = new AbortController();
    const operation = session.admit({
      run: () => session.pwa({ operation: "launch", manifestId: "https://example.test/app" }),
      signal: controller.signal,
    });
    const outcome = operation.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    try {
      await started.promise;
      controller.abort();
      await rejectsWithin(canceled.promise);
      expect(await outcome).toMatchObject({ error: { code: "CHROME_MCP_BROKER_CANCELED" } });
      expect(await session.admit({ run: () => Promise.resolve("next admission") })).toBe("next admission");
    } finally {
      controller.abort();
      release.resolve();
      await outcome;

      try {
        await client.close();
      } finally {
        await harness.stop();
      }
    }
  });

  test("rolls back an unpublished async selection and preserves cancellation code", async () => {
    const harness = await createHarness();
    const client = await connectHarness(harness);
    const session = await client.acquire("isolated-headless");
    const selectionStarted = Promise.withResolvers<void>();
    const releaseSelection = Promise.withResolvers<void>();
    harness.backend.selectionBeginStarted = selectionStarted.resolve;
    harness.backend.selectionBeginDelay = releaseSelection.promise;
    harness.backend.selectionRollbackFailure = new Error("injected unpublished selection rollback failure");
    const controller = new AbortController();
    try {
      const operation = session.admit({
        run: async () => session.beginSelection(),
        signal: controller.signal,
      });
      await selectionStarted.promise;
      controller.abort();
      const brokerStatus = await client.status();
      expect(brokerStatus.activeAdmissions).toBe(0);
      releaseSelection.resolve();

      expect(rejectsWithin(operation)).rejects.toMatchObject({
        code: "CHROME_MCP_BROKER_CANCELED",
      });
      expect(harness.backend.selectionRollbacks).toBe(1);
    } finally {
      harness.backend.selectionRollbackFailure = undefined;
      releaseSelection.resolve();
      await client.close();
      await harness.stop();
    }
  });

  test("preserves cancellation when async selection creation rejects before materializing", async () => {
    const harness = await createHarness();
    const client = await connectHarness(harness);
    const session = await client.acquire("isolated-headless");
    const selectionStarted = Promise.withResolvers<void>();
    const releaseSelection = Promise.withResolvers<void>();
    harness.backend.selectionBeginStarted = selectionStarted.resolve;
    harness.backend.selectionBeginDelay = releaseSelection.promise;
    harness.backend.selectionBeginFailure = new Error("injected selection begin rejection");
    const controller = new AbortController();
    try {
      const operation = session.admit({
        run: async () => session.beginSelection(),
        signal: controller.signal,
      });
      await selectionStarted.promise;
      controller.abort();
      const brokerStatus = await client.status();
      expect(brokerStatus.activeAdmissions).toBe(0);
      releaseSelection.resolve();

      expect(rejectsWithin(operation)).rejects.toMatchObject({ code: "CHROME_MCP_BROKER_CANCELED" });
      expect(harness.backend.selectionRollbacks).toBe(0);
    } finally {
      releaseSelection.resolve();
      await client.close();
      await harness.stop();
    }
  });

  test("rolls back an unpublished async selection and preserves deadline code", async () => {
    const harness = await createHarness();
    const client = await connectHarness(harness);
    const session = await client.acquire("isolated-headless");
    const selectionStarted = Promise.withResolvers<void>();
    const releaseSelection = Promise.withResolvers<void>();
    harness.backend.selectionBeginStarted = selectionStarted.resolve;
    harness.backend.selectionBeginDelay = releaseSelection.promise;
    jest.useFakeTimers();
    try {
      const operation = session.admit({
        deadlineAt: Date.now() + 100,
        run: async () => session.beginSelection(),
      });
      await selectionStarted.promise;
      jest.advanceTimersByTime(100);
      const brokerStatus = await client.status();
      expect(brokerStatus.activeAdmissions).toBe(0);
      releaseSelection.resolve();

      expect(rejectsWithin(operation)).rejects.toMatchObject({ code: "CHROME_MCP_BROKER_DEADLINE" });
      expect(harness.backend.selectionRollbacks).toBe(1);
    } finally {
      releaseSelection.resolve();
      jest.useRealTimers();
      await client.close();
      await harness.stop();
    }
  });

  test("preserves deadline when async selection creation rejects before materializing", async () => {
    const harness = await createHarness();
    const client = await connectHarness(harness);
    const session = await client.acquire("isolated-headless");
    const selectionStarted = Promise.withResolvers<void>();
    const releaseSelection = Promise.withResolvers<void>();
    harness.backend.selectionBeginStarted = selectionStarted.resolve;
    harness.backend.selectionBeginDelay = releaseSelection.promise;
    harness.backend.selectionBeginFailure = new Error("injected selection begin rejection");
    jest.useFakeTimers();
    try {
      const operation = session.admit({
        deadlineAt: Date.now() + 100,
        run: async () => session.beginSelection(),
      });
      await selectionStarted.promise;
      jest.advanceTimersByTime(100);
      const brokerStatus = await client.status();
      expect(brokerStatus.activeAdmissions).toBe(0);
      releaseSelection.resolve();

      expect(rejectsWithin(operation)).rejects.toMatchObject({ code: "CHROME_MCP_BROKER_DEADLINE" });
      expect(harness.backend.selectionRollbacks).toBe(0);
    } finally {
      releaseSelection.resolve();
      jest.useRealTimers();
      await client.close();
      await harness.stop();
    }
  });

  test("rolls back an unpublished async selection and preserves session-close code", async () => {
    const harness = await createHarness();
    const client = await connectHarness(harness);
    const session = await client.acquire("isolated-headless");
    const selectionStarted = Promise.withResolvers<void>();
    const releaseSelection = Promise.withResolvers<void>();
    harness.backend.selectionBeginStarted = selectionStarted.resolve;
    harness.backend.selectionBeginDelay = releaseSelection.promise;
    try {
      const operation = session.admit({ run: async () => session.beginSelection() });
      await selectionStarted.promise;
      const closing = session.close();
      const brokerStatus = await client.status();
      expect(brokerStatus.activeAdmissions).toBe(0);
      releaseSelection.resolve();

      expect(rejectsWithin(operation)).rejects.toMatchObject({ code: "CHROME_MCP_BROKER_CLOSED" });
      await closing;
      expect(harness.backend.selectionRollbacks).toBe(1);
    } finally {
      releaseSelection.resolve();
      await client.close();
      await harness.stop();
    }
  });

  test("preserves session-close code when async selection creation rejects before materializing", async () => {
    const harness = await createHarness();
    const client = await connectHarness(harness);
    const session = await client.acquire("isolated-headless");
    const selectionStarted = Promise.withResolvers<void>();
    const releaseSelection = Promise.withResolvers<void>();
    harness.backend.selectionBeginStarted = selectionStarted.resolve;
    harness.backend.selectionBeginDelay = releaseSelection.promise;
    harness.backend.selectionBeginFailure = new Error("injected selection begin rejection");
    try {
      const operation = session.admit({ run: async () => session.beginSelection() });
      await selectionStarted.promise;
      const closing = session.close();
      const brokerStatus = await client.status();
      expect(brokerStatus.activeAdmissions).toBe(0);
      releaseSelection.resolve();

      expect(rejectsWithin(operation)).rejects.toMatchObject({ code: "CHROME_MCP_BROKER_CLOSED" });
      await closing;
      expect(harness.backend.selectionRollbacks).toBe(0);
    } finally {
      releaseSelection.resolve();
      await client.close();
      await harness.stop();
    }
  });

  test("preserves an async selection creation failure while admission remains active", async () => {
    const harness = await createHarness();
    const client = await connectHarness(harness);
    const session = await client.acquire("isolated-headless");
    harness.backend.selectionBeginFailure = new Error("injected active selection begin rejection");
    try {
      expect(session.admit({ run: async () => session.beginSelection() })).rejects.toThrow();
      expect(harness.backend.selectionRollbacks).toBe(0);
    } finally {
      await client.close();
      await harness.stop();
    }
  });

  test("rolls back an unpublished async selection after transport loss", async () => {
    const harness = await createHarness({ disconnectGraceMs: 0 });
    const connectionId = "async-selection-transport-loss";
    const client = await connectHarness(harness, connectionId);
    const session = await client.acquire("isolated-headless");
    const selectionStarted = Promise.withResolvers<void>();
    const releaseSelection = Promise.withResolvers<void>();
    harness.backend.selectionBeginStarted = selectionStarted.resolve;
    harness.backend.selectionBeginDelay = releaseSelection.promise;
    try {
      const operation = session.admit({ run: async () => session.beginSelection() });
      await selectionStarted.promise;
      client.disconnect();
      releaseSelection.resolve();

      expect(rejectsWithin(operation)).rejects.toMatchObject({ code: "CHROME_MCP_BROKER_CLOSED" });
      await rejectsWithin(harness.backend.waitForCleanup(connectionId));
      expect(harness.backend.selectionRollbacks).toBe(1);
    } finally {
      releaseSelection.resolve();
      await harness.stop();
    }
  });

  test("preserves FIFO, removes canceled queued work, and runs another owner concurrently", async () => {
    const harness = await createHarness();
    const [firstClient, secondClient, thirdClient] = await Promise.all([
      connectHarness(harness),
      connectHarness(harness),
      connectHarness(harness),
    ]);
    const [first, second, third, independent] = await Promise.all([
      firstClient.acquire("shared"),
      secondClient.acquire("shared"),
      thirdClient.acquire("shared"),
      thirdClient.acquire("shared-headless"),
    ]);
    const order: string[] = [];
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const firstRun = first.admit({
      run: async () => {
        order.push("first");
        firstStarted.resolve();
        await releaseFirst.promise;
      },
    });
    await firstStarted.promise;

    const canceled = new AbortController();
    const secondRun = second.admit({
      run: async () => {
        order.push("canceled");
      },
      signal: canceled.signal,
    });
    const thirdRun = third.admit({
      run: async () => {
        order.push("third");
      },
    });
    const independentRun = independent.admit({
      run: async () => {
        order.push("independent");
      },
    });
    await independentRun;
    canceled.abort(new Error("queued call canceled"));
    expect(rejectsWithin(secondRun)).rejects.toThrow();
    releaseFirst.resolve();
    await Promise.all([firstRun, thirdRun]);
    expect(order).toEqual(["first", "independent", "third"]);

    await Promise.all([firstClient.close(), secondClient.close(), thirdClient.close()]);
    await harness.stop();
  });

  test("proxies selection, modal, journal, CDP event, and private worker endpoint operations", async () => {
    const harness = await createHarness();
    const client = await connectHarness(harness);
    const session = await client.acquire("isolated-headless");
    try {
      await session.admit({
        run: async () => {
          expect(session.activeDialog()?.message).toBe("question");
          expect(session.activeFileChooser()?.accept).toBe(".txt");
          const selection = await session.beginSelection();
          const next = Object.freeze({ ownerGeneration: session.ownerGeneration, targetId: "new-target" });
          await selection.select(next);
          expect(await selection.commit()).toEqual(next);
          expect(session.currentTarget()).toEqual(next);

          const event = Promise.withResolvers<unknown>();
          const largeEvent = Promise.withResolvers<unknown>();
          const remove = session.onCdp("Test.event", (payload) => {
            const parsed = z.object({ value: z.union([z.number(), z.string()]) }).parse(payload);
            if (typeof parsed.value === "string") largeEvent.resolve(parsed);
            else event.resolve(parsed);
          });
          await session.sendCdp("Test.emit", { value: 42 }, "target-session");
          expect(await event.promise).toEqual({ value: 42 });
          await session.sendCdp("Test.emitLarge");
          expect(z.object({ value: z.string() }).parse(await largeEvent.promise).value.length).toBe(
            BROKER_MAX_FRAME_BYTES,
          );
          remove();

          const largeResult = z
            .object({ value: z.string() })
            .parse(await session.sendCdp("Test.largeResult"));
          expect(largeResult.value.length).toBe(BROKER_MAX_FRAME_BYTES);
          const invalidParams = await session.sendCdp("Test.invalidParams").catch((error: unknown) => error);
          expect(invalidParams instanceof CdpCommandError ? invalidParams.code : undefined).toBe(-32_602);
          expect(invalidParams instanceof Error ? invalidParams.message : undefined).toBe(
            "Invalid parameters",
          );

          const reactResult = await session.react({ limit: 100, operation: "list" });
          expect(reactResult.data.operation).toBe("list");
          const reactPrepareResult = await session.react({ operation: "prepare" });
          expect(reactPrepareResult.data.operation).toBe("prepare");
          const reactStagedNodeResult = await session.react({
            lookup: {
              key: "__chromeMcpReactNode_0123456789abcdef0123456789abcdef",
              type: "staged-node",
            },
            operation: "inspect",
          });
          expect(reactStagedNodeResult.data.operation).toBe("inspect");
          const largeReactResult = await session.react({
            limit: 100,
            operation: "list",
            search: "__large__",
          });
          expect(typeof largeReactResult.data.payload).toBe("string");
          expect(
            typeof largeReactResult.data.payload === "string" ? largeReactResult.data.payload.length : 0,
          ).toBe(17 * 1024 * 1024);

          const largeRequest = z.object({ length: z.number() }).parse(
            await session.sendCdp("Test.largeRequest", {
              value: "x".repeat(7 * 1024 * 1024),
            }),
          );
          expect(largeRequest.length).toBe(7 * 1024 * 1024);

          expect(await session.markEvents()).toEqual({ ownerGeneration: 1, sequence: 0 });
          const journal = await session.readEvents();
          expect(journal.events).toEqual([]);
          await session.authorizeOwnerClose("browser");
          expect(harness.backend.authorizedCloses).toEqual(["browser"]);
          const worker = await session.workerConnection();
          expect(worker.endpoint.value).toContain("private-token");
          expect(worker.executionEndpoint.value).toContain("execution-token");

          const route = await session.addMutation(
            {
              action: { type: "continue" },
              kind: "route",
              urlPattern: "https://api.example.test/*",
            },
            session.currentTarget(),
          );
          expect(await session.listMutations("route")).toEqual([route]);
          expect(await session.removeMutation("route", route.id)).toBe(true);
          expect(await session.removeMutation("route", route.id)).toBe(false);
          await session.addMutation(
            { kind: "initScript", source: "globalThis.__brokerMutation = true" },
            session.currentTarget(),
          );
          expect(await session.clearMutations("initScript")).toBe(1);

          const dialogId = session.activeDialog()?.dialogId;
          if (!dialogId) throw new Error("missing fake dialog");
          await session.handleDialog(dialogId, true, "");
          const chooserId = session.activeFileChooser()?.chooserId;
          if (!chooserId) throw new Error("missing fake file chooser");
          await session.setFileChooserFiles(chooserId, ["/tmp/file.txt"]);
        },
      });
    } finally {
      await client.close();
      await harness.stop();
    }
  }, 15_000);

  test.each([
    { name: "successful rollback", rollbackFailure: undefined, suffix: "" },
    {
      name: "identical rollback failure",
      rollbackFailure: new BrokerRpcError(
        "CHROME_MCP_UNKNOWN_TARGET",
        "The selected Chrome target closed before commit",
      ),
      suffix: "",
    },
    {
      name: "distinct rollback failure",
      rollbackFailure: new BrokerRpcError("CHROME_MCP_BROKER_CLOSED", "Chrome broker closed during rollback"),
      suffix: "; Chrome selection rollback also failed",
    },
  ])("preserves a failed selection commit with $name", async ({ rollbackFailure, suffix }) => {
    const harness = await createHarness();
    const client = await connectHarness(harness);
    const session = await client.acquire("isolated-headless");
    harness.backend.selectionCommitFailure = new BrokerRpcError(
      "CHROME_MCP_UNKNOWN_TARGET",
      "The selected Chrome target closed before commit",
    );
    harness.backend.selectionRollbackFailure = rollbackFailure;
    try {
      expect(
        session.admit({
          run: async () => {
            const selection = await session.beginSelection();
            return selection.commit();
          },
        }),
      ).rejects.toMatchObject({
        code: "CHROME_MCP_UNKNOWN_TARGET",
        message: `The selected Chrome target closed before commit${suffix}`,
      });
    } finally {
      await session.close();
      await harness.stop();
    }
  });
});

describe("selection.select", () => {
  test("rejects an unselectable target while the call is still running and leaves the selection unchanged", async () => {
    const harness = await createHarness();
    const client = await connectHarness(harness);
    const session = await client.acquire("isolated-headless");
    harness.backend.selectionSelectFailure = new BrokerRpcError(
      "CHROME_MCP_UNKNOWN_TARGET",
      "Unknown Chrome target gone",
    );
    try {
      await session.admit({
        run: async () => {
          const selection = await session.beginSelection();
          const initial = selection.current();
          expect(
            selection.select({ ownerGeneration: session.ownerGeneration, targetId: "gone" }),
          ).rejects.toMatchObject({
            code: "CHROME_MCP_UNKNOWN_TARGET",
            message: "Unknown Chrome target gone",
          });
          expect(selection.current()).toEqual(initial);
          expect(await selection.commit()).toEqual(initial);
        },
      });
    } finally {
      await session.close();
      await harness.stop();
    }
  });
});

describe("real child startup convergence", () => {
  test("resolves relative runtime and saved socket paths across working directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-broker-relative-runtime-"));
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    const paths = await resolveBrokerRuntimePaths(workspacePath, join(root, "mcp"));
    const childRelativePaths = await resolveBrokerRuntimePaths(workspacePath, join(workspacePath, "mcp"));

    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
        import { relative } from "node:path";
        import { connectChromeBroker } from ${JSON.stringify(new URL("./client.ts", import.meta.url).href)};
        import { readBrokerMetadata, writeBrokerMetadata } from ${JSON.stringify(new URL("./paths.ts", import.meta.url).href)};
        const options = {
          executablePath: "/bin/true", workspacePath: ${JSON.stringify(workspacePath)},
        };
        const client = await connectChromeBroker({ ...options, connectionId: "relative-runtime" });
        try {
          const metadataPath = ${JSON.stringify(paths.metadataPath)};
          const metadata = await readBrokerMetadata(metadataPath);
          if (!metadata) {
            throw new Error("Expected broker metadata in the caller's runtime directory");
          }

          await writeBrokerMetadata(metadataPath, {
            ...metadata, socketPath: relative(options.workspacePath, metadata.socketPath),
          });
          const reused = await connectChromeBroker({ ...options, connectionId: "relative-runtime-reuse" });
          try {
            console.log(JSON.stringify({ ...metadata, hasReusedBroker: reused.brokerId === client.brokerId }));
          } finally {
            await reused.close();
          }
        } finally {
          await client.close();
        }
      `,
        ],
        {
          cwd: root,
          env: { ...process.env, CHROME_MCP_RUNTIME_DIR: "mcp" },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        hasReusedBroker: true,
        socketPath: paths.socketPath,
        workspaceHash: paths.workspaceHash,
      });
    } finally {
      for (const candidate of [paths, childRelativePaths]) {
        const metadata = await readBrokerMetadata(candidate.metadataPath);
        if (metadata) {
          await retireChromeBroker(metadata);
        }
      }

      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  test.each(["environment", "explicit"] as const)(
    "starts the broker in the %s runtime directory",
    async (source) => {
      const root = await mkdtemp(join(tmpdir(), "chrome-broker-runtime-directory-"));
      const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
      const priorMcpRuntimeDirectory = process.env.CHROME_MCP_RUNTIME_DIR;
      const environmentRoot = join(root, "mcp");
      const runtimeRoot = source === "explicit" ? join(root, "explicit") : environmentRoot;
      const paths = await resolveBrokerRuntimePaths(root, runtimeRoot);
      const fallbackPaths = await resolveBrokerRuntimePaths(
        root,
        join(root, "runtime", `chrome-mcp-u${process.getuid?.()}`),
      );

      process.env.XDG_RUNTIME_DIR = join(root, "runtime");
      process.env.CHROME_MCP_RUNTIME_DIR = environmentRoot;

      let client: ChromeBrokerClient | undefined;

      try {
        client = await connectChromeBroker({
          connectionId: `runtime-${source}`,
          executablePath: "/bin/true",
          ...(source === "explicit" ? { runtimeRoot } : {}),
          workspacePath: root,
        });
        expect(await readBrokerMetadata(paths.metadataPath)).toMatchObject({
          brokerId: client.brokerId,
          pid: client.brokerPid,
          socketPath: paths.socketPath,
        });
        expect(await Bun.file(fallbackPaths.metadataPath).exists()).toBe(false);
      } finally {
        try {
          await client?.close();

          for (const candidate of [paths, fallbackPaths]) {
            const metadata = await readBrokerMetadata(candidate.metadataPath);
            if (metadata) {
              await retireChromeBroker(metadata);
            }
          }
        } finally {
          if (priorRuntimeDirectory === undefined) {
            delete process.env.XDG_RUNTIME_DIR;
          } else {
            process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
          }

          if (priorMcpRuntimeDirectory === undefined) {
            delete process.env.CHROME_MCP_RUNTIME_DIR;
          } else {
            process.env.CHROME_MCP_RUNTIME_DIR = priorMcpRuntimeDirectory;
          }

          await rm(root, { force: true, recursive: true });
        }
      }
    },
    20_000,
  );

  test.each([
    { name: "excludes previous attempts from a short diagnostic", output: "synthetic-startup-failure" },
    { name: "bounds an oversized diagnostic", output: `${"x".repeat(5000)}\nsynthetic-startup-failure` },
  ])("reports a startup child exit, releases its lock, and $name", async ({ output }) => {
    const root = await mkdtemp(join(tmpdir(), "chrome-broker-startup-failure-"));
    const paths = await resolveBrokerRuntimePaths(root, join(root, "runtime"));
    await ensureOwnerOnlyBrokerRoot(paths);
    await Bun.write(paths.logPath, "previous-startup-diagnostic\n");
    const resolveChild = resolveBrokerChildProcess;
    const launch = spyOn(childEnvironment, "resolveBrokerChildProcess").mockImplementation((options) => ({
      ...resolveChild(options),
      args: ["--eval", `console.error(${JSON.stringify(output)}); process.exit(23);`],
    }));

    try {
      const failure: unknown = await connectChromeBroker({
        connectionId: "startup-failure",
        connectBudgetMs: 1000,
        executablePath: "/bin/true",
        runtimeRoot: join(root, "runtime"),
        workspacePath: root,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(BrokerRpcError);
      if (!(failure instanceof BrokerRpcError)) {
        throw new TypeError("Broker startup did not reject with its failure");
      }

      expect(failure.code).toBe("CHROME_MCP_BROKER_UNAVAILABLE");
      expect(failure.message).toContain("exited with code 23");
      expect(failure.message).toContain("synthetic-startup-failure");
      expect(failure.message).not.toContain("previous-startup-diagnostic");
      expect(failure.message.length).toBeLessThan(4500);
      expect(failure.message).toContain(paths.logPath);
      expect(await Bun.file(paths.startupLockPath).exists()).toBe(false);
    } finally {
      launch.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("asks for a session restart when the spawned broker is newer than the client", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-broker-newer-child-"));
    const paths = await resolveBrokerRuntimePaths(root, join(root, "runtime"));
    await ensureOwnerOnlyBrokerRoot(paths);
    const metadata = {
      brokerId: randomUUID(),
      createdAt: new Date().toISOString(),
      processStartIdentity: "synthetic-newer-broker",
      protocolVersion: BROKER_PROTOCOL_VERSION + 1,
      socketPath: paths.socketPath,
      workspaceHash: paths.workspaceHash,
    };
    const childScript = `const { existsSync, renameSync, writeFileSync } = require("node:fs");
const path = ${JSON.stringify(paths.metadataPath)};
writeFileSync(path + ".tmp", JSON.stringify({ ...${JSON.stringify(metadata)}, pid: process.pid }), { mode: 0o600 });
renameSync(path + ".tmp", path);
setInterval(() => { if (!existsSync(path)) process.exit(0); }, 100);`;
    const resolveChild = resolveBrokerChildProcess;
    const launch = spyOn(childEnvironment, "resolveBrokerChildProcess").mockImplementation((options) => ({
      ...resolveChild(options),
      args: ["--eval", childScript],
    }));

    try {
      expect(
        connectChromeBroker({
          connectionId: "newer-spawned-broker",
          connectBudgetMs: 2000,
          executablePath: "/bin/true",
          runtimeRoot: join(root, "runtime"),
          workspacePath: root,
        }),
      ).rejects.toMatchObject({
        code: "CHROME_MCP_BROKER_UNAVAILABLE",
        message: `Chrome broker protocol ${BROKER_PROTOCOL_VERSION + 1} is newer than this client's ${BROKER_PROTOCOL_VERSION}; restart this session to load current code`,
      });
      expect(await Bun.file(paths.startupLockPath).exists()).toBe(false);
    } finally {
      launch.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces a deployed legacy broker and rejects one newer than the client", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-broker-version-test-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await Bun.write(join(workspace, ".keep"), "");
    const runtimeRoot = join(root, "runtime");
    const paths = await resolveBrokerRuntimePaths(workspace, runtimeRoot);
    await ensureOwnerOnlyBrokerRoot(paths);
    const legacy = Bun.spawn(["sleep", "30"], { stderr: "ignore", stdout: "ignore" });
    await writeBrokerMetadata(paths.metadataPath, {
      brokerId: randomUUID(),
      createdAt: new Date().toISOString(),
      pid: legacy.pid,
      processStartIdentity: await currentProcessStartIdentity(legacy.pid),
      protocolVersion: BROKER_PROTOCOL_VERSION - 1,
      socketPath: paths.socketPath,
      workspaceHash: paths.workspaceHash,
    });
    const options = { executablePath: "/bin/true", runtimeRoot, workspacePath: workspace };
    let replacement: ChromeBrokerClient | undefined;
    try {
      replacement = await connectChromeBroker({ ...options, connectionId: "legacy-replacement" });
      expect(replacement.brokerPid).not.toBe(legacy.pid);
      expect(await legacy.exited).not.toBe(0);
      expect(await readBrokerMetadata(paths.metadataPath)).toMatchObject({
        protocolVersion: BROKER_PROTOCOL_VERSION,
      });
      await replacement.close();
      replacement = undefined;

      const newerWorkspace = join(root, "newer-workspace");
      await mkdir(newerWorkspace);
      await Bun.write(join(newerWorkspace, ".keep"), "");
      const newerPaths = await resolveBrokerRuntimePaths(newerWorkspace, runtimeRoot);
      await ensureOwnerOnlyBrokerRoot(newerPaths);
      await writeBrokerMetadata(newerPaths.metadataPath, {
        brokerId: randomUUID(),
        createdAt: new Date().toISOString(),
        pid: process.pid,
        processStartIdentity: await currentProcessStartIdentity(),
        protocolVersion: BROKER_PROTOCOL_VERSION + 1,
        socketPath: newerPaths.socketPath,
        workspaceHash: newerPaths.workspaceHash,
      });
      expect(
        connectChromeBroker({
          connectionId: "newer-broker-refusal",
          executablePath: options.executablePath,
          runtimeRoot,
          workspacePath: newerWorkspace,
        }),
      ).rejects.toThrow();
    } finally {
      await replacement?.close().catch(() => undefined);
      legacy.kill();
      await legacy.exited;
      await rm(root, { force: true, recursive: true });
    }
  });

  test("two starters converge on one child and final close reaps it", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-broker-child-test-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await Bun.write(join(workspace, ".keep"), "");
    const runtimeRoot = join(root, "runtime");
    const paths = await resolveBrokerRuntimePaths(workspace, runtimeRoot);
    const options = { executablePath: "/bin/true", runtimeRoot, workspacePath: workspace };
    const [first, second] = await Promise.all([
      connectChromeBroker({ ...options, connectionId: "real-child-first" }),
      connectChromeBroker({ ...options, connectionId: "real-child-second" }),
    ]);
    const pid = first.brokerPid;
    try {
      expect(first.brokerId).toBe(second.brokerId);
      expect(first.brokerPid).toBe(second.brokerPid);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
    const exited = Promise.withResolvers<void>();
    const check = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        exited.resolve();
      }
    }, 5);
    try {
      await rejectsWithin(exited.promise, 5000);
      expect(await Bun.file(paths.metadataPath).exists()).toBeFalse();
      expect(await Bun.file(paths.socketPath).exists()).toBeFalse();
    } finally {
      clearInterval(check);
      await rm(root, { force: true, recursive: true });
    }
  });
});
