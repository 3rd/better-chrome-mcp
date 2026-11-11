import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ContentResult } from "#fastmcp";
import type { ToolSessionContext } from "../../mcp/session-context";
import type { BrowserInstanceOptions, BrowserSelection } from "../browser-modes";
import type { FfmpegProcessFactory, PlaywrightTracingResolver } from "../captures";
import type { ChromeToolContext } from "./register-tools";
import type { ChromeServiceRuntime, ChromeServiceRuntimeSession } from "./service-runtime";
import { isRecord } from "../../platform/records";
import { type ArtifactDescriptor, ArtifactStore, type ArtifactStoreLimits } from "../artifacts";
import { BrokerRpcError } from "../broker-rpc/errors";
import { SubprocessLighthouseRunner } from "../diagnostics/subprocess";
import {
  ChromeMcpExecutionError,
  copyJsonObject,
  copyJsonValue,
  type ExecutionKernelFailure,
  type ExecutionKernelSuccess,
  INLINE_IMAGE_MAX_TOTAL_BYTES,
  type JsonValue,
  type RunExecutionWorkerOptions,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_DEPTH,
  SNAPSHOT_MIN_BYTES,
  SNAPSHOT_MIN_DEPTH,
  SNAPSHOT_RETAINED_COUNT,
  type StateSnapshot,
} from "../execution";
import {
  REACT_ANALYSIS_RESULT_MAX_BYTES,
  type ReactBrowserOperation,
  type ReactOperationResult,
} from "../runtime/react-inspection-protocol";
import {
  type ActiveDialog,
  type ActiveFileChooser,
  BoundedEventJournal,
  boundedText,
  type BrowserCallAdmission,
  type BrowserJournalInput,
  type BrowserMode,
  type BrowserOwnerCloseResource,
  type BrowserOwnerSnapshot,
  type EventCursor,
  type GenerationTargetId,
  type JournalReadOptions,
  type JournalReadResult,
  PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS,
  PERSISTENT_BINDING_MAX_PAYLOAD_BYTES,
  PERSISTENT_BINDING_WORKER_TIMEOUT_MS,
  PERSISTENT_MUTATION_MAX_COUNT_PER_KIND,
  PERSISTENT_MUTATION_MAX_ENTRY_BYTES,
  PERSISTENT_MUTATION_MAX_TOTAL_BYTES,
  type PersistentMutationEntry,
  type PersistentMutationInput,
  type PersistentMutationKind,
  PersistentMutationRegistry,
} from "../runtime";
import { CDP_METHOD_NOT_FOUND, CdpCommandError } from "../runtime/cdp-connection";
import { PWA_CDP_METHODS, pwaResultSchema } from "../runtime/pwa-controller";
import { CHROME_CAPABILITY_CDP_METHODS, CHROME_CAPABILITY_LIMIT_FIELDS } from "./contracts";
import { createChromeMcpServer } from "./create-server";
import { type ChromeExecutionKernel, type ChromeServiceOptions, createChromeService } from "./service";

const roots: string[] = [];

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const toolSession = (name: string, baseCwd = process.cwd()): ToolSessionContext => ({
  connectionId: name,
  pathContext: { baseCwd },
  recording: { mode: "off" },
});

const toolContext = (session: ToolSessionContext): ChromeToolContext => ({
  client: { version: undefined },
  elicit: () => Promise.reject(new Error("Elicitation is not used in service tests")),
  log: {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  },
  reportProgress: () => Promise.resolve(),
  session,
  streamContent: () => Promise.resolve(),
});

class FakeOwnerQueue {
  readonly order: string[] = [];
  readonly #admissionMode: "queue" | "reject-overlap";
  #activeAdmissions = 0;
  #tail = Promise.resolve();

  constructor(admissionMode: "queue" | "reject-overlap" = "queue") {
    this.#admissionMode = admissionMode;
  }

  admit<Result>(operation: BrowserCallAdmission<Result>): Promise<Result> {
    if (this.#admissionMode === "reject-overlap") {
      if (this.#activeAdmissions > 0) {
        return Promise.reject(new Error("Nested Chrome broker admission is not supported"));
      }
      this.#activeAdmissions += 1;
      return Promise.resolve()
        .then(() => operation.run(new AbortController().signal))
        .finally(() => {
          this.#activeAdmissions -= 1;
        });
    }
    const start = this.#tail.then(() => operation.run(new AbortController().signal));
    this.#tail = start.then(
      () => undefined,
      () => undefined,
    );
    return start;
  }
}

class FakeRuntimeSession implements ChromeServiceRuntimeSession {
  pwa: ChromeServiceRuntimeSession["pwa"] = (input) => {
    if (input.operation !== "capabilities") {
      return Promise.reject(new Error("PWA is not used in service tests"));
    }
    return Promise.resolve(
      pwaResultSchema.parse({
        operation: "capabilities",
        cdp: Object.fromEntries(PWA_CDP_METHODS.map((method) => [method, false])),
      }),
    );
  };

  pageViewport() {
    return Promise.resolve(null);
  }

  readonly browserMode: BrowserMode;
  readonly cdpCalls: string[] = [];
  readonly connectionId: string;
  readonly navigationUrls: string[] = [];
  readonly ownerGeneration = 1;
  readonly ownerId: string;
  readonly #queue: FakeOwnerQueue;
  readonly #cdpListeners = new Map<string, Set<(params: unknown, sessionId: string | undefined) => void>>();
  readonly #networkParents = new Map<string, string>();
  readonly #networkTargets = new Map<string, string>();
  readonly #mutations = new PersistentMutationRegistry();
  readonly #targets = new Map<string, { title: string; url: string }>();
  readonly #attachedTargets = new Map<string, string>();
  readonly supportedMethods = new Set(["Network.getResponseBody"]);
  activeDiagnosticAttachments = 0;
  browserClients = 1;
  nativeDeviceScaleFactor: number | undefined;
  cdpMethods: (() => Promise<ReadonlySet<string>>) | undefined = () =>
    Promise.resolve(new Set(this.supportedMethods));
  cdpProbeResponses: ReadonlyMap<string, () => Promise<unknown>> | undefined;
  closeGate: Promise<void> | undefined;
  invalidatedOwners = 0;
  lastFileChooserRequest: Readonly<{ chooserId: string; files: readonly string[] }> | undefined;
  lastModalPolicy: "allow" | "reject" | undefined;
  lastReadOptions: (JournalReadOptions & Readonly<{ advance?: boolean }>) | undefined;
  lastMutationTarget: GenerationTargetId | undefined;
  reactResultData: Readonly<Record<string, unknown>> = {};
  reactFailure: Error | undefined;
  reactInspectFailure: Error | undefined;
  reactEvents: string[] | undefined;
  readonly reactCalls: ReactBrowserOperation[] = [];
  admissionCalls = 0;
  admissionCloseFailure: Error | undefined;
  pendingAdmissions = 0;
  selectionCommitFailure: Error | undefined;
  selectionRollbackFailure: Error | undefined;
  selectionRollbackCalls = 0;
  tracingStartFailures = 0;
  #attachmentsReleased: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  #attachmentSequence = 0;
  #closed = false;
  #eventSequence = 0;
  #networkBodyRead: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  #selected: GenerationTargetId;

  constructor(connectionId: string, mode: BrowserMode, ownerId: string, queue: FakeOwnerQueue) {
    this.connectionId = connectionId;
    this.browserMode = mode;
    this.ownerId = ownerId;
    this.#queue = queue;
    this.#selected = { ownerGeneration: 1, targetId: `${mode}-initial` };
    this.#targets.set(this.#selected.targetId, { title: mode, url: `https://${mode}.test/` });
    this.#targets.set(`${mode}-next`, { title: `${mode} next`, url: `https://${mode}.test/next` });
    this.#targets.set(`${mode}-failed`, { title: `${mode} failed`, url: `https://${mode}.test/failed` });
  }

  activeDialog(): ActiveDialog | undefined {
    return undefined;
  }

  get closed(): boolean {
    return this.#closed;
  }

  activeFileChooser(): ActiveFileChooser | undefined {
    return undefined;
  }

  addMutation(input: PersistentMutationInput, target: GenerationTargetId): Promise<PersistentMutationEntry> {
    this.lastMutationTarget = target;
    return this.#mutations.add(input);
  }

  async admit<Result>(operation: BrowserCallAdmission<Result>): Promise<Result> {
    this.admissionCalls += 1;
    this.lastModalPolicy = operation.modalPolicy;

    const result = await this.#queue.admit(operation);

    if (this.admissionCloseFailure) {
      throw this.admissionCloseFailure;
    }

    return result;
  }

  authorizeOwnerClose(resource: BrowserOwnerCloseResource): Promise<void> {
    if (this.browserMode === "main" || this.browserClients > 1 || this.pendingAdmissions > 0) {
      const resourceName = resource === "browser" ? "browser" : "broker-owned default context";
      return Promise.reject(
        new ChromeMcpExecutionError(
          "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
          `Cannot close the ${resourceName}: this fake browser owner is not exclusive`,
        ),
      );
    }
    return Promise.resolve();
  }

  beginSelection() {
    const initial = this.#selected;
    let staged: GenerationTargetId | undefined;
    let finished = false;
    return Promise.resolve({
      commit: async () => {
        if (finished) throw new Error("Selection transaction already finished");
        finished = true;
        if (this.selectionCommitFailure) throw this.selectionCommitFailure;
        if (staged) this.#selected = staged;
        return this.#selected;
      },
      current: () => staged ?? initial,
      prepare: () => Promise.resolve({ target: staged ?? initial, hasBlockingDialog: false }),
      rollback: () => {
        if (finished) throw new Error("Selection transaction already finished");
        finished = true;
        this.selectionRollbackCalls++;
        if (this.selectionRollbackFailure) return Promise.reject(this.selectionRollbackFailure);
        this.#selected = initial;
        return Promise.resolve(this.#selected);
      },
      select: async (targetId: string) => {
        if (!this.#targets.has(targetId)) throw new Error(`Unknown fake target ${targetId}`);
        staged = { ownerGeneration: 1, targetId };
      },
    });
  }

  capabilities(): Promise<BrowserOwnerSnapshot> {
    return Promise.resolve({
      browserConnected: !this.#closed,
      chromeProduct: "Fake Chrome/1",
      clients: this.browserClients,
      endpointAvailable: true,
      headless: this.browserMode.endsWith("headless"),
      ...(this.nativeDeviceScaleFactor === undefined ?
        {}
      : { nativeDeviceScaleFactor: this.nativeDeviceScaleFactor }),
      key: { id: this.ownerId, mode: this.browserMode, workspaceHash: "workspace" },
      ownerGeneration: 1,
      ownership: this.browserMode === "main" ? "attached" : "launched",
      selectedTargets: this.#targets.size,
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    return this.closeGate ?? Promise.resolve();
  }

  clearMutations(kind: PersistentMutationKind): Promise<number> {
    return Promise.resolve(this.#mutations.clear(kind).length);
  }

  disconnect(): void {
    this.#closed = true;
  }

  listMutations(kind: PersistentMutationKind): Promise<PersistentMutationEntry[]> {
    return Promise.resolve(this.#mutations.entries(kind));
  }

  removeMutation(kind: PersistentMutationKind, id: string): Promise<boolean> {
    return Promise.resolve(this.#mutations.remove(kind, id) !== undefined);
  }

  currentEventCursor(): Promise<EventCursor> {
    return Promise.resolve({ ownerGeneration: 1, sequence: this.#eventSequence });
  }

  currentTarget(): GenerationTargetId {
    return this.#selected;
  }

  handleDialog(_dialogId: string, _accept: boolean, _promptText?: string): Promise<void> {
    return Promise.resolve();
  }

  enableOwnedDownloads(): Promise<void> {
    return Promise.resolve();
  }

  invalidateOwner(): Promise<void> {
    this.invalidatedOwners += 1;
    return Promise.resolve();
  }

  journalCapabilities() {
    return Promise.resolve({ currentSequence: 0, eventCount: 0, firstRetainedSequence: 1, retainedBytes: 0 });
  }

  markEvents(): Promise<EventCursor> {
    return this.currentEventCursor();
  }

  onCdp(method: string, listener: (params: unknown, sessionId: string | undefined) => void): () => void {
    const listeners = this.#cdpListeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#cdpListeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#cdpListeners.delete(method);
    };
  }

  readEvents(options: JournalReadOptions & Readonly<{ advance?: boolean }> = {}): Promise<JournalReadResult> {
    this.lastReadOptions = options;
    return this.currentEventCursor().then((nextCursor) => ({
      droppedBefore: null,
      events: [],
      nextCursor,
      ownerReset: false,
    }));
  }

  react(input: ReactBrowserOperation): Promise<ReactOperationResult> {
    this.reactCalls.push(input);
    this.reactEvents?.push(
      input.operation === "inspect" ? `react:${input.lookup.type}` : `react:${input.operation}`,
    );
    if (this.reactFailure) return Promise.reject(this.reactFailure);
    if (input.operation === "inspect" && this.reactInspectFailure) {
      return Promise.reject(this.reactInspectFailure);
    }
    return Promise.resolve({
      data: { operation: input.operation, ...this.reactResultData },
      documentId: "00000000-0000-4000-8000-000000000000",
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
      targetId: this.#selected.targetId,
      url: this.#targets.get(this.#selected.targetId)?.url ?? "about:blank",
      warnings: [],
    });
  }

  sendCdp(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    this.cdpCalls.push(method);
    const probeResponse = this.cdpProbeResponses?.get(method);
    if (probeResponse) {
      return probeResponse();
    }
    if (method === "Browser.getVersion") return Promise.resolve({ protocolVersion: "1.3" });
    if (method === "Target.attachToTarget") {
      if (typeof params.targetId !== "string") return Promise.reject(new Error("Target ID is required"));
      const attachedSessionId = `fake-attached-session-${++this.#attachmentSequence}`;
      if (this.activeDiagnosticAttachments === 0) this.#attachmentsReleased = Promise.withResolvers<void>();
      this.activeDiagnosticAttachments += 1;
      this.#attachedTargets.set(attachedSessionId, params.targetId);
      return Promise.resolve({ sessionId: attachedSessionId });
    }
    if (method === "Target.getTargetInfo") {
      let targetId = this.#selected.targetId;

      if (typeof params.targetId === "string") {
        targetId = params.targetId;
      } else if (sessionId !== undefined) {
        targetId = this.#networkTargets.get(sessionId) ?? targetId;
      }

      const parentId = this.#networkParents.get(targetId);
      return Promise.resolve({ targetInfo: { targetId, ...(parentId === undefined ? {} : { parentId }) } });
    }
    if (method === "Runtime.evaluate") {
      if (params.expression === "window.devicePixelRatio") {
        return Promise.resolve({ result: { value: this.nativeDeviceScaleFactor } });
      }

      return Promise.resolve({ result: { value: { height: 720, width: 1280 } } });
    }

    if (method === "Page.getLayoutMetrics") {
      return Promise.resolve({
        cssVisualViewport: { clientWidth: 1280, clientHeight: 720, scale: 1, zoom: 1 },
      });
    }

    if (method === "Network.getResponseBody") {
      this.#networkBodyRead?.resolve();
      return Promise.resolve({ base64Encoded: false, body: "captured body" });
    }
    if (method === "Page.enable") return Promise.resolve({});
    if (method === "Page.navigate") {
      if (typeof params.url !== "string" || !sessionId) {
        return Promise.reject(new Error("Navigation target is required"));
      }
      const targetId = this.#attachedTargets.get(sessionId);
      if (!targetId) return Promise.reject(new Error("Diagnostic target is detached"));
      const target = this.#targets.get(targetId);
      if (target) this.#targets.set(targetId, { ...target, url: params.url });
      this.navigationUrls.push(params.url);
      queueMicrotask(() => this.emitCdp("Page.loadEventFired", {}, sessionId));
      return Promise.resolve({ frameId: "fake-frame" });
    }
    if (method === "Tracing.start") {
      if (this.tracingStartFailures > 0) {
        this.tracingStartFailures -= 1;
        return Promise.reject(new Error("Scripted tracing start failure"));
      }
      return Promise.resolve({});
    }
    if (method === "Tracing.end") {
      if (!sessionId) return Promise.reject(new Error("Tracing session is required"));
      queueMicrotask(() =>
        this.emitCdp(
          "Tracing.tracingComplete",
          { dataLossOccurred: false, stream: `trace-stream-${sessionId}` },
          sessionId,
        ),
      );
      return Promise.resolve({});
    }
    if (method === "IO.read") return Promise.resolve({ data: '{"traceEvents":[]}', eof: true });
    if (method === "IO.close") return Promise.resolve({});
    if (method === "Target.detachFromTarget") {
      if (typeof params.sessionId === "string" && this.#attachedTargets.delete(params.sessionId)) {
        this.activeDiagnosticAttachments -= 1;
        if (this.activeDiagnosticAttachments === 0) this.#attachmentsReleased?.resolve();
      }
      return Promise.resolve({});
    }
    if (method === "Page.startScreencast" || method === "Page.stopScreencast") {
      return Promise.resolve({});
    }
    return Promise.reject(new Error("CDP is not used in service tests"));
  }

  emitCdp(method: string, payload: unknown, sessionId = "fake-network-session"): void {
    this.#eventSequence += 1;
    for (const listener of this.#cdpListeners.get(method) ?? []) listener(payload, sessionId);
  }

  addTarget(targetId: string, url: string): void {
    this.#targets.set(targetId, { title: targetId, url });
  }

  destroyTarget(targetId: string): void {
    this.#targets.delete(targetId);
    this.emitCdp("Target.targetDestroyed", { targetId });
  }

  async emitNetworkExchange(sessionId = "fake-network-session"): Promise<void> {
    this.#networkBodyRead = Promise.withResolvers<void>();
    this.emitCdp(
      "Network.requestWillBeSent",
      {
        requestId: "request-1",
        request: { headers: { accept: "text/plain" }, method: "GET", url: "https://network.test/body" },
        timestamp: 1,
        wallTime: 1_786_752_000,
      },
      sessionId,
    );
    this.emitCdp(
      "Network.responseReceived",
      {
        requestId: "request-1",
        response: {
          encodedDataLength: 13,
          headers: { "content-type": "text/plain" },
          mimeType: "text/plain",
          protocol: "h2",
          status: 200,
          statusText: "OK",
        },
        timestamp: 2,
      },
      sessionId,
    );
    this.emitCdp(
      "Network.loadingFinished",
      { encodedDataLength: 13, requestId: "request-1", timestamp: 3 },
      sessionId,
    );
    await this.#networkBodyRead.promise;
    this.#networkBodyRead = undefined;
  }

  setNetworkTarget(sessionId: string, targetId: string, parentId: string): void {
    this.#networkTargets.set(sessionId, targetId);
    this.#networkParents.set(targetId, parentId);
  }

  setTargetUrl(targetId: string, url: string): void {
    const target = this.#targets.get(targetId);
    if (!target) throw new Error(`Unknown fake target ${targetId}`);
    this.#targets.set(targetId, { ...target, url });
  }

  setFileChooserFiles(chooserId: string, files: readonly string[]): Promise<void> {
    this.lastFileChooserRequest = Object.freeze({ chooserId, files: Object.freeze([...files]) });
    return Promise.resolve();
  }

  targetRecord(targetId: string) {
    return Promise.resolve(this.#targets.get(targetId));
  }

  waitForNoDiagnosticAttachments(): Promise<void> {
    if (this.activeDiagnosticAttachments === 0) return Promise.resolve();
    return this.#attachmentsReleased?.promise ?? Promise.resolve();
  }

  workerConnection() {
    return Promise.resolve({
      endpoint: `ws://127.0.0.1:9/devtools/browser/${this.ownerId}`,
      executionEndpoint: `ws://127.0.0.1:9/devtools/browser/${this.ownerId}/execution`,
      ownerGeneration: 1,
      target: this.#selected,
    });
  }
}

class FakeRuntime implements ChromeServiceRuntime {
  readonly acquireCalls: BrowserMode[] = [];
  readonly acquireInstanceCalls: Readonly<{
    browserInstanceId?: string;
    connectionId: string;
    mode: BrowserMode;
  }>[] = [];
  readonly owners = new Map<string, FakeOwnerQueue>();
  readonly sessions = new Map<string, FakeRuntimeSession>();
  readonly supportedMethods = new Set(["Network.getResponseBody"]);
  cdpProbeResponses: ReadonlyMap<string, () => Promise<unknown>> | undefined;
  downloadPublisher: Parameters<ChromeServiceRuntime["setDownloadPublisher"]>[0];
  rejectOverlappingAdmissions = false;
  reactEvents: string[] | undefined;
  reactResultData: Readonly<Record<string, unknown>> = {};

  acquire(connectionId: string, mode: BrowserMode, options: BrowserInstanceOptions = {}) {
    const { browserInstanceId, nativeDeviceScaleFactor } = options;
    this.acquireCalls.push(mode);
    this.acquireInstanceCalls.push({
      ...(browserInstanceId === undefined ? {} : { browserInstanceId }),
      connectionId,
      mode,
    });
    const ownerConnectionId = browserInstanceId ?? connectionId;
    const ownerId =
      mode === "shared" || mode === "shared-headless" || mode === "main" ?
        `owner-${mode}`
      : `owner-${mode}-${ownerConnectionId}`;
    const queue =
      this.owners.get(ownerId) ??
      new FakeOwnerQueue(this.rejectOverlappingAdmissions ? "reject-overlap" : "queue");
    this.owners.set(ownerId, queue);
    const key =
      browserInstanceId === undefined ?
        `${connectionId}\0${mode}`
      : `${connectionId}\0${mode}\0${browserInstanceId}`;
    let session = this.sessions.get(key);
    if (!session || session.closed) {
      session = new FakeRuntimeSession(connectionId, mode, ownerId, queue);
      session.nativeDeviceScaleFactor = nativeDeviceScaleFactor;
      session.reactEvents = this.reactEvents;
      session.reactResultData = this.reactResultData;
      session.supportedMethods.clear();
      for (const method of this.supportedMethods) session.supportedMethods.add(method);
      if (this.cdpProbeResponses) {
        session.cdpMethods = undefined;
        session.cdpProbeResponses = this.cdpProbeResponses;
      }
      this.sessions.set(key, session);
    }
    return Promise.resolve(session);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  closeConnection(connectionId: string): Promise<void> {
    for (const key of this.sessions.keys()) {
      if (key.startsWith(`${connectionId}\0`)) this.sessions.delete(key);
    }
    return Promise.resolve();
  }

  disconnectConnection(connectionId: string): void {
    for (const [key, session] of this.sessions) {
      if (key.startsWith(`${connectionId}\0`)) session.disconnect();
    }
  }

  setDownloadPublisher(publisher: Parameters<ChromeServiceRuntime["setDownloadPublisher"]>[0]): void {
    this.downloadPublisher = publisher;
  }
}

const requestAction = (options: RunExecutionWorkerOptions) => {
  if (!isRecord(options.request.args)) throw new Error("Fake kernel requires object args");
  return options.request.args;
};

const success = (
  options: RunExecutionWorkerOptions,
  state: StateSnapshot,
  value?: JsonValue,
): ExecutionKernelSuccess => ({
  artifacts: [],
  content: [],
  emittedCount: 0,
  ok: true,
  selectedTargetId: options.request.selectedTargetId,
  state,
  ...(value === undefined ? {} : { value }),
});

const failure = (
  options: RunExecutionWorkerOptions,
  artifacts: ArtifactDescriptor[] = [],
): ExecutionKernelFailure => ({
  artifacts,
  error: {
    code: "CHROME_MCP_INVALID_INPUT",
    message: "scripted failure",
    name: "ChromeMcpExecutionError",
  },
  ok: false,
  selectedTargetId: options.request.selectedTargetId,
});

const rpcContext = () => ({
  callId: "call",
  rpcId: "rpc",
  signal: new AbortController().signal,
});

type FixtureOptions = Readonly<{
  artifactLimits?: Partial<ArtifactStoreLimits>;
  capture?: ChromeServiceOptions["capture"];
  configureRuntime?: (runtime: FakeRuntime) => void;
  idleShutdownMs?: number;
  scheduleIdleShutdown?: ChromeServiceOptions["scheduleIdleShutdown"];
  snapshotConnector?: ChromeServiceOptions["snapshotConnector"];
}>;

const createFixture = async (executionKernel: ChromeExecutionKernel, options: FixtureOptions = {}) => {
  const root = await mkdtemp(join(tmpdir(), "chrome-service-test-"));
  roots.push(root);
  const artifactStore = new ArtifactStore({
    root,
    ...(options.artifactLimits ? { limits: options.artifactLimits } : {}),
  });
  const runtime = new FakeRuntime();
  options.configureRuntime?.(runtime);
  const service = await createChromeService({
    artifactStore,
    ...(options.capture === undefined ? {} : { capture: options.capture }),
    executionKernel,
    ...(options.idleShutdownMs === undefined ? {} : { idleShutdownMs: options.idleShutdownMs }),
    playwrightVersion: "test",
    runtime,
    ...(options.scheduleIdleShutdown === undefined ?
      {}
    : { scheduleIdleShutdown: options.scheduleIdleShutdown }),
    ...(options.snapshotConnector === undefined ? {} : { snapshotConnector: options.snapshotConnector }),
  });
  return { root, runtime, service };
};

test("queries a saved heap relative to the session directory without acquiring a browser", async () => {
  const fixture = await createFixture(() => Promise.reject(new Error("Unexpected browser execution")));
  const context = toolContext(toolSession("saved-heap", fixture.root));
  await writeFile(
    join(fixture.root, "saved.heapsnapshot"),
    JSON.stringify({
      snapshot: {
        node_count: 2,
        edge_count: 1,
        meta: {
          node_fields: ["type", "name", "id", "self_size", "edge_count"],
          node_types: [["synthetic", "object"], "string", "number", "number", "number"],
          edge_fields: ["type", "name_or_index", "to_node"],
          edge_types: [["property"], "string", "node"],
        },
      },
      nodes: [0, 0, 1, 0, 1, 1, 1, 3, 16, 0],
      edges: [0, 2, 5],
      strings: ["(root)", "Fixture", "fixture"],
    }),
  );

  try {
    const result = await fixture.service.handlers.analyzeHeapSnapshot(
      {
        filePath: "saved.heapsnapshot",
        query: { kind: "objects", className: "fixture", sort: "retainedSize" },
        limit: 1,
      },
      context,
    );
    expect(result.structuredContent).toMatchObject({
      kind: "objects",
      rows: [{ id: 3, name: "Fixture", type: "object", selfSize: 16, retainedSize: 16 }],
      totalMatches: 1,
      nextCursor: null,
    });
    expect(fixture.runtime.acquireCalls).toEqual([]);
  } finally {
    await fixture.service.closeConnection(context);
    await fixture.service.close();
  }
});

test("keeps Lighthouse on the persistent endpoint rather than the worker execution scope", async () => {
  const fixture = await createFixture(async (options) => failure(options), {
    configureRuntime: (configuredRuntime) => {
      configuredRuntime.cdpProbeResponses = new Map(
        [
          "Emulation.clearDeviceMetricsOverride",
          "Emulation.setCPUThrottlingRate",
          "Emulation.setTouchEmulationEnabled",
          "Network.emulateNetworkConditions",
        ].map((method) => [method, () => Promise.resolve({})]),
      );
    },
  });
  const context = toolContext(toolSession("lighthouse-endpoint"));
  const runtime = await fixture.runtime.acquire("lighthouse-endpoint", "isolated");
  let executionEndpoint = "ws://127.0.0.1:9/first-call";
  runtime.workerConnection = () =>
    Promise.resolve({
      endpoint: "ws://127.0.0.1:9/persistent",
      executionEndpoint,
      ownerGeneration: 1,
      target: runtime.currentTarget(),
    });

  const endpoints: unknown[] = [];
  const runner = spyOn(SubprocessLighthouseRunner.prototype, "run").mockImplementation(async (input) => {
    endpoints.push(input.engineTarget.browserWSEndpoint);
    return {
      audits: [],
      categories: [],
      mainDocumentUrl: "https://example.test/",
      reports: { html: "<html></html>", json: "{}" },
      totalTiming: 1,
    };
  });

  try {
    const input = { browser: "isolated", device: "desktop", mode: "snapshot" } as const;
    await fixture.service.handlers.lighthouseAudit(input, context);
    executionEndpoint = "ws://127.0.0.1:9/second-call";
    await fixture.service.handlers.lighthouseAudit(input, context);

    expect(endpoints).toEqual(["ws://127.0.0.1:9/persistent", "ws://127.0.0.1:9/persistent"]);
  } finally {
    runner.mockRestore();
    await fixture.service.close();
  }
});

const createReactSnapshotPageAdapter = (
  options: Readonly<{
    events: string[];
    releaseFailure?: Error;
  }>,
) => {
  const stagedKeys: string[] = [];
  const connector: NonNullable<ChromeServiceOptions["snapshotConnector"]> = () =>
    Promise.resolve({
      capture: () =>
        Promise.resolve({
          refs: new Map([
            [
              "e1",
              {
                dispose: () => Promise.resolve(),
                identity: "snapshot-react-node",
                locatorProbe: () =>
                  Promise.resolve({
                    recipe: {
                      frameChain: [],
                      frameChainSegments: [],
                      selector: "css=#snapshot-react-node",
                      selectorSegments: ["#snapshot-react-node"],
                    },
                    state: "available",
                  }),
                releaseStaged: async (): Promise<"released"> => {
                  options.events.push("release");
                  if (options.releaseFailure) throw options.releaseFailure;
                  return "released";
                },
                stage: async (key): Promise<"staged"> => {
                  stagedKeys.push(key);
                  options.events.push("stage");
                  return "staged";
                },
              },
            ],
          ]),
          text: '- button "Snapshot React node" [ref=e1]',
        }),
      disconnect: () => Promise.resolve(),
    });
  return { connector, stagedKeys };
};

const snapshotRefCaptureKernel =
  (capture: { ref?: string }): ChromeExecutionKernel =>
  async (options) => {
    const result = await options.adapter.execute(
      { operation: "snapshot", payload: { options: {} } },
      rpcContext(),
    );
    const tree =
      isRecord(result.value) && typeof result.value.tree === "string" ? result.value.tree : undefined;
    const ref = tree ? /(?:^|\s)ref=([^\s]+)(?:\s|$)/mu.exec(tree)?.[1] : undefined;
    if (!ref) throw new Error("Snapshot service test did not capture a retained ref");
    capture.ref = ref;
    return success(options, [], result.value);
  };

const oversizedSnapshotConnector: NonNullable<ChromeServiceOptions["snapshotConnector"]> = () =>
  Promise.resolve({
    capture: () =>
      Promise.resolve({
        text: Array.from({ length: 1000 }, (_, index) => `- button "Action ${index}" [ref=e${index}]`).join(
          "\n",
        ),
        refs: new Map(
          Array.from({ length: 1000 }, (_, index) => [
            `e${index}`,
            {
              identity: `node-${index}`,
              dispose: () => Promise.resolve(),
              locatorProbe: () =>
                Promise.resolve({
                  state: "available" as const,
                  recipe: {
                    frameChain: [],
                    frameChainSegments: [],
                    selector: `css=#action-${index}`,
                    selectorSegments: [`#action-${index}`],
                  },
                }),
              stage: () => Promise.resolve("staged" as const),
              releaseStaged: () => Promise.resolve("absent" as const),
            },
          ]),
        ),
      }),
    disconnect: () => Promise.resolve(),
  });

const snapshotKernel: ChromeExecutionKernel = async (options) => {
  const response = await options.adapter.execute(
    { operation: "snapshot", payload: { options: copyJsonObject(options.request.args) } },
    rpcContext(),
  );
  return { ...success(options, [], response.value), artifacts: response.artifacts ?? [] };
};

type ScheduledIdleShutdown = { canceled: boolean; delayMs: number; fire: () => void };

const createIdleShutdownScheduler = () => {
  const scheduled: ScheduledIdleShutdown[] = [];
  const schedule: NonNullable<ChromeServiceOptions["scheduleIdleShutdown"]> = (delayMs, fire) => {
    const entry: ScheduledIdleShutdown = { canceled: false, delayMs, fire };
    scheduled.push(entry);
    return () => {
      entry.canceled = true;
    };
  };
  return {
    armed: () => scheduled.filter((entry) => !entry.canceled),
    schedule,
    scheduled,
  };
};

const structured = (result: ContentResult) => {
  if (!isRecord(result.structuredContent)) throw new Error("Expected structured content");
  return result.structuredContent;
};

describe("Chrome public service", () => {
  test.each(["direct", "chunked"])(
    "publishes complete %s snapshot artifacts with bounded previews",
    async (kind) => {
      const chunked = kind === "chunked";
      const { service } = await createFixture(snapshotKernel, {
        snapshotConnector: oversizedSnapshotConnector,
        ...(chunked ? { artifactLimits: { directContentBytes: 1024, chunkBytes: 32 * 1024 } } : {}),
      });
      const context = toolContext(toolSession(`snapshot-artifacts-${chunked}`));
      const server = createChromeMcpServer(service);
      const client = new Client({ name: "snapshot-artifacts-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const [connection] = await Promise.all([
        server.connect(serverTransport, context.session),
        client.connect(clientTransport),
      ]);
      try {
        const result = await client.callTool({
          name: "run_playwright",
          arguments: {
            browser: "isolated",
            args: {},
            code: "return await chrome.captureAccessibilitySnapshot();",
            timeoutMs: 1000,
          },
        });
        const output = result.structuredContent;
        if (!isRecord(output) || !isRecord(output.value)) throw new Error("Snapshot result is missing");
        const preview = output.value;
        expect(output.ok).toBeTrue();
        expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(16 * 1024);
        expect(preview.omissionReason).toBe("maxBytes");
        expect(preview.totals).toMatchObject({ refs: 1000, treeLines: 1000 });
        if (!isRecord(preview.refs) || !isRecord(preview.omitted)) {
          throw new Error("Snapshot counts are missing");
        }
        const shownRefs = Object.keys(preview.refs);
        expect(shownRefs.length).toBeGreaterThan(0);
        expect(preview.omitted.refs).toBe(1000 - shownRefs.length);
        expect(output.artifacts).toHaveLength(2);
        const contents: string[] = [];
        for (const descriptor of [preview.artifact, preview.dataArtifact]) {
          if (!isRecord(descriptor) || typeof descriptor.uri !== "string") {
            throw new Error("Snapshot artifact is missing");
          }
          const read = await client.readResource({ uri: descriptor.uri });
          const resource = read.contents[0];
          if (!resource || !("text" in resource)) throw new Error("Snapshot artifact content is missing");
          let bytes: Buffer;
          if (chunked) {
            const manifest: unknown = JSON.parse(resource.text);
            if (!isRecord(manifest) || !Array.isArray(manifest.chunks)) {
              throw new Error("Snapshot manifest is missing");
            }
            const chunks: Buffer[] = [];
            for (const chunk of manifest.chunks) {
              if (!isRecord(chunk) || typeof chunk.uri !== "string") {
                throw new Error("Snapshot chunk URI is missing");
              }
              const part = await client.readResource({ uri: chunk.uri });
              const content = part.contents[0];
              if (!content || !("blob" in content)) throw new Error("Snapshot chunk content is missing");
              const chunkBytes = Buffer.from(content.blob, "base64");
              expect(chunk.sha256).toBe(createHash("sha256").update(chunkBytes).digest("hex"));
              chunks.push(chunkBytes);
            }
            bytes = Buffer.concat(chunks);
          } else {
            bytes = Buffer.from(resource.text);
          }
          expect(descriptor.size).toBe(bytes.byteLength);
          expect(descriptor.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
          contents.push(bytes.toString("utf8"));
        }
        const json = contents[1];
        if (json === undefined) throw new Error("Complete snapshot JSON is missing");
        const complete: unknown = JSON.parse(json);
        if (!isRecord(complete) || !isRecord(complete.refs)) {
          throw new Error("Complete snapshot refs are missing");
        }
        expect(complete.snapshotId).toBe(preview.snapshotId);
        expect(Object.keys(complete.refs)).toHaveLength(1000);
        expect(complete.tree).toBe(contents[0]);
        expect(complete).not.toHaveProperty("byIdentity");
        for (const ref of shownRefs) expect(complete.refs[ref]).toEqual(preview.refs[ref]);
        if (
          !isRecord(preview.dataArtifact) ||
          typeof preview.dataArtifact.artifactId !== "string" ||
          typeof preview.dataArtifact.uri !== "string"
        ) {
          throw new Error("Complete artifact descriptor is missing");
        }
        await service.artifactStore.deleteArtifact(
          service.artifactOwner(context.session, undefined),
          preview.dataArtifact.artifactId,
        );
        expect(client.readResource({ uri: preview.dataArtifact.uri })).rejects.toThrow();
      } finally {
        await client.close();
        await connection.close();
        await service.close();
      }
    },
  );

  test("fails a bounded snapshot when its complete-data artifact cannot be published", async () => {
    const { service } = await createFixture(snapshotKernel, {
      snapshotConnector: oversizedSnapshotConnector,
      artifactLimits: { ordinaryCallArtifacts: 1 },
    });
    try {
      const result = await service.handlers.runPlaywright(
        {
          browser: "isolated",
          args: {},
          code: "return await chrome.captureAccessibilitySnapshot();",
          timeoutMs: 1000,
        },
        toolContext(toolSession("snapshot-quota")),
      );
      expect(result.isError).toBeTrue();
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "CHROME_MCP_ARTIFACT_QUOTA" },
      });
      expect(structured(result).artifacts).toHaveLength(1);
      expect(structured(result)).not.toHaveProperty("value");
    } finally {
      await service.close();
    }
  });

  test("keeps direct React inspection on one browser operation", async () => {
    const { runtime, service } = await createFixture(async (options) => success(options, []));
    const result = await service.handlers.reactInspectComponent(
      {
        browser: "isolated",
        lookup: { selector: "#react-counter", type: "selector" },
      },
      toolContext(toolSession("direct-react-inspection")),
    );
    const session = [...runtime.sessions.values()][0];
    if (!session) throw new Error("Expected a React runtime session");

    expect(structured(result).ok).toBeTrue();
    expect(session.admissionCalls).toBe(1);
    expect(session.reactCalls).toEqual([
      {
        lookup: { selector: "#react-counter", type: "selector" },
        operation: "inspect",
      },
    ]);
    await service.close();
  });

  test("prepares, stages, inspects, and releases a snapshot ref inside one admission", async () => {
    const events: string[] = [];
    const page = createReactSnapshotPageAdapter({ events });
    const capture: { ref?: string } = {};
    const { runtime, service } = await createFixture(snapshotRefCaptureKernel(capture), {
      configureRuntime: (configuredRuntime) => {
        configuredRuntime.reactEvents = events;
        configuredRuntime.rejectOverlappingAdmissions = true;
      },
      snapshotConnector: page.connector,
    });
    const context = toolContext(toolSession("snapshot-react-inspection"));
    expect(
      structured(
        await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated",
            code: "return await chrome.snapshot();",
            timeoutMs: 1000,
          },
          context,
        ),
      ).ok,
    ).toBeTrue();
    if (!capture.ref) throw new Error("Expected a retained snapshot ref");
    const session = [...runtime.sessions.values()][0];
    if (!session) throw new Error("Expected a React runtime session");
    session.admissionCalls = 0;

    const inspected = await service.handlers.reactInspectComponent(
      {
        browser: "isolated",
        lookup: { ref: capture.ref, type: "snapshot-ref" },
      },
      context,
    );
    const stagedKey = page.stagedKeys[0];
    if (!stagedKey) throw new Error("Expected a React staged-node key");

    expect(structured(inspected).ok).toBeTrue();
    expect(session.admissionCalls).toBe(1);
    expect(session.lastModalPolicy).toBe("reject");
    expect(events).toEqual(["react:prepare", "stage", "react:staged-node", "release"]);
    expect(session.reactCalls).toEqual([
      { operation: "prepare" },
      {
        lookup: { key: stagedKey, type: "staged-node" },
        operation: "inspect",
      },
    ]);
    expect(stagedKey).toMatch(/^__chromeMcpReactNode_[0-9a-f]{32}$/u);
    await service.close();
  });

  test("releases a staged snapshot node when React inspection and cleanup fail", async () => {
    const events: string[] = [];
    const page = createReactSnapshotPageAdapter({
      events,
      releaseFailure: new Error("injected staging cleanup failure"),
    });
    const capture: { ref?: string } = {};
    const { runtime, service } = await createFixture(snapshotRefCaptureKernel(capture), {
      configureRuntime: (configuredRuntime) => {
        configuredRuntime.reactEvents = events;
      },
      snapshotConnector: page.connector,
    });
    const context = toolContext(toolSession("snapshot-react-cleanup-failure"));
    await service.handlers.runPlaywright(
      {
        args: {},
        browser: "isolated",
        code: "return await chrome.snapshot();",
        timeoutMs: 1000,
      },
      context,
    );
    if (!capture.ref) throw new Error("Expected a retained snapshot ref");
    const session = [...runtime.sessions.values()][0];
    if (!session) throw new Error("Expected a React runtime session");
    session.reactInspectFailure = new BrokerRpcError(
      "CHROME_MCP_REACT_STALE_COMPONENT",
      "injected React inspection failure",
    );

    const inspected = await service.handlers.reactInspectComponent(
      {
        browser: "isolated",
        lookup: { ref: capture.ref, type: "snapshot-ref" },
      },
      context,
    );
    const output = structured(inspected);

    expect(output.error).toMatchObject({ code: "CHROME_MCP_REACT_STALE_COMPONENT" });
    expect(isRecord(output.error) ? output.error.message : "").toContain("injected React inspection failure");
    expect(isRecord(output.error) ? output.error.message : "").toContain("staging cleanup also failed");
    expect(events).toEqual(["react:prepare", "stage", "react:staged-node", "release"]);
    await service.close();
  });

  test("forgets a profile after its React target expires", async () => {
    const { runtime, service } = await createFixture(async (options) => success(options, []), {
      configureRuntime: (configuredRuntime) => {
        configuredRuntime.reactResultData = {
          profileId: "expired-profile",
          startedAt: "2026-08-31T00:00:00.000Z",
        };
      },
    });
    const context = toolContext(toolSession("expired-react-profile"));
    const started = await service.handlers.reactProfileStart({ browser: "isolated" }, context);
    expect(structured(started).ok).toBeTrue();
    const session = [...runtime.sessions.values()][0];
    if (!session) throw new Error("Expected a React runtime session");
    session.reactFailure = new ChromeMcpExecutionError(
      "CHROME_MCP_REACT_PROFILE_EXPIRED",
      "React profile target expired",
    );
    const stopped = await service.handlers.reactProfileStop({ profileId: "expired-profile" }, context);
    expect(structured(stopped).error).toMatchObject({ code: "CHROME_MCP_REACT_PROFILE_EXPIRED" });

    session.reactFailure = undefined;
    const restarted = await service.handlers.reactProfileStart({ browser: "isolated" }, context);
    expect(structured(restarted).ok).toBeTrue();
    await service.close();
  });

  test("analyzes only complete connection-owned React profiles with opaque component metrics", async () => {
    const { runtime, service } = await createFixture(async (options) => success(options, []), {
      configureRuntime: (configuredRuntime) => {
        configuredRuntime.reactResultData = {
          profileId: "react-profile",
          startedAt: "2026-08-31T00:00:00.000Z",
        };
      },
    });
    const context = toolContext(toolSession("react-profile-analysis"));
    const started = await service.handlers.reactProfileStart({ browser: "isolated" }, context);
    expect(structured(started).ok).toBeTrue();
    const session = [...runtime.sessions.values()][0];
    if (!session) throw new Error("Expected a React runtime session");
    session.reactResultData = {
      profile: {
        dataForRoots: [
          {
            displayNames: [["opaque-component", "Counter"]],
            commitData: [
              {
                changeDescriptions: [["opaque-component", { props: ["count"] }]],
                duration: 9,
                effectDuration: 2,
                fiberActualDurations: [["opaque-component", 4]],
                fiberSelfDurations: [["opaque-component", 3]],
              },
            ],
          },
        ],
      },
      profileId: "react-profile",
      status: "complete",
    };
    const stopped = await service.handlers.reactProfileStop({ profileId: "react-profile" }, context);
    expect(structured(stopped).ok).toBeTrue();
    const analyzed = await service.handlers.reactProfileAnalyze(
      {
        limit: 25,
        metrics: ["commit-participation"],
        profileId: "react-profile",
      },
      context,
    );
    const output = structured(analyzed);

    expect(output.ok).toBeTrue();
    if (!Array.isArray(output.results) || !isRecord(output.results[0])) {
      throw new Error(`Expected a React analysis row: ${JSON.stringify(output)}`);
    }
    expect(output.results[0]).toEqual(
      expect.objectContaining({
        changeSummary: { context: 0, hooks: 0, mounts: 0, props: 1, records: 1, state: 0 },
        commitCount: 1,
        componentId: "opaque-component",
        displayName: "Counter",
        effectDuration: 2,
        slowestCommit: 9,
        slowestCommitIndex: 0,
        totalInclusiveDuration: 4,
        totalSelfDuration: 3,
      }),
    );
    expect(output.results[0]).not.toHaveProperty("changeDescriptions");
    await service.close();
  });

  test("ranks commit metrics numerically and reuses one analysis continuation per profile", async () => {
    const { runtime, service } = await createFixture(async (options) => success(options, []), {
      configureRuntime: (configuredRuntime) => {
        configuredRuntime.reactResultData = {
          profileId: "ranked-profile",
          startedAt: "2026-08-31T00:00:00.000Z",
        };
      },
    });
    const context = toolContext(toolSession("ranked-react-profile"));
    const started = await service.handlers.reactProfileStart({ browser: "isolated" }, context);
    expect(structured(started).ok).toBeTrue();
    const session = [...runtime.sessions.values()][0];
    if (!session) throw new Error("Expected a React runtime session");
    session.reactResultData = {
      profile: {
        dataForRoots: [
          {
            commitData: [
              {
                duration: 30,
                effectDuration: 2,
                fiberActualDurations: [["component-b", 2]],
                fiberSelfDurations: [["component-b", 1]],
              },
              {
                changeDescriptions: [
                  [
                    "component-c",
                    { context: null, didHooksChange: false, isFirstMount: false, props: [], state: null },
                  ],
                ],
                duration: 10,
                effectDuration: 8,
                fiberActualDurations: [
                  ["component-a", 4],
                  ["component-c", 8],
                ],
                fiberSelfDurations: [
                  ["component-a", 3],
                  ["component-c", 7],
                ],
              },
            ],
          },
        ],
      },
      profileId: "ranked-profile",
      status: "complete",
    };
    expect(
      structured(await service.handlers.reactProfileStop({ profileId: "ranked-profile" }, context)).ok,
    ).toBeTrue();

    const slowest = structured(
      await service.handlers.reactProfileAnalyze(
        {
          limit: 1,
          metrics: ["slowest-commit"],
          profileId: "ranked-profile",
        },
        context,
      ),
    );
    expect(
      Array.isArray(slowest.results) && isRecord(slowest.results[0]) ? slowest.results[0].componentId : null,
    ).toBe("component-b");
    expect(
      Array.isArray(slowest.results) && isRecord(slowest.results[0]) ?
        slowest.results[0].slowestCommit
      : null,
    ).toBe(30);
    expect(Array.isArray(slowest.results) ? slowest.results[0] : null).toMatchObject({
      changeSummary: null,
      displayName: null,
    });
    if (typeof slowest.nextCursor !== "string") throw new Error("Expected a slowest-commit continuation");

    const repeated = structured(
      await service.handlers.reactProfileAnalyze(
        {
          limit: 1,
          metrics: ["slowest-commit"],
          profileId: "ranked-profile",
        },
        context,
      ),
    );
    expect(repeated.nextCursor).toBe(slowest.nextCursor);

    const effects = structured(
      await service.handlers.reactProfileAnalyze(
        {
          limit: 1,
          metrics: ["effect-duration"],
          profileId: "ranked-profile",
        },
        context,
      ),
    );
    expect(
      Array.isArray(effects.results) && isRecord(effects.results[0]) ? effects.results[0].componentId : null,
    ).toBe("component-a");
    expect(
      Array.isArray(effects.results) && isRecord(effects.results[0]) ?
        effects.results[0].effectDuration
      : null,
    ).toBe(8);
    if (typeof effects.nextCursor !== "string") throw new Error("Expected an effect-duration continuation");

    const replaced = structured(
      await service.handlers.reactProfileAnalyze(
        {
          cursor: slowest.nextCursor,
          limit: 1,
          metrics: ["slowest-commit"],
          profileId: "ranked-profile",
        },
        context,
      ),
    );
    expect(replaced.error).toMatchObject({ code: "CHROME_MCP_REACT_STALE_CURSOR" });

    const nextEffect = structured(
      await service.handlers.reactProfileAnalyze(
        {
          cursor: effects.nextCursor,
          limit: 1,
          metrics: ["effect-duration"],
          profileId: "ranked-profile",
        },
        context,
      ),
    );
    expect(
      Array.isArray(nextEffect.results) && isRecord(nextEffect.results[0]) ?
        nextEffect.results[0].componentId
      : null,
    ).toBe("component-c");
    expect(Array.isArray(nextEffect.results) ? nextEffect.results[0] : null).toMatchObject({
      changeSummary: { context: 0, hooks: 0, mounts: 0, props: 0, records: 1, state: 0 },
    });
    if (typeof nextEffect.nextCursor !== "string") {
      throw new TypeError("Expected a third effect-duration page");
    }

    const restarted = structured(
      await service.handlers.reactProfileAnalyze(
        {
          limit: 1,
          metrics: ["effect-duration"],
          profileId: "ranked-profile",
        },
        context,
      ),
    );
    expect(restarted.nextCursor).not.toBe(nextEffect.nextCursor);
    const rebound = structured(
      await service.handlers.reactProfileAnalyze(
        {
          cursor: nextEffect.nextCursor,
          limit: 1,
          metrics: ["effect-duration"],
          profileId: "ranked-profile",
        },
        context,
      ),
    );
    expect(rebound.error).toMatchObject({ code: "CHROME_MCP_REACT_STALE_CURSOR" });
    await service.close();
  });

  test("keeps long-profile rankings compact and publishes complete opt-in history for each page", async () => {
    const { runtime, service } = await createFixture(async (options) => success(options, []), {
      configureRuntime: (configuredRuntime) => {
        configuredRuntime.reactResultData = {
          profileId: "long-profile",
          startedAt: "2026-08-31T00:00:00.000Z",
        };
      },
    });
    const context = toolContext(toolSession("long-react-profile"));
    expect(
      structured(await service.handlers.reactProfileStart({ browser: "isolated" }, context)).ok,
    ).toBeTrue();
    const session = [...runtime.sessions.values()][0];
    if (!session) throw new Error("Expected a React runtime session");
    const componentIds = Array.from(
      { length: 12 },
      (_, index) => `component-${String(index).padStart(2, "0")}`,
    );
    const descriptions = Array.from({ length: 70 }, (_, commitIndex) => ({
      context: commitIndex > 0,
      didHooksChange: commitIndex > 0,
      hooks: commitIndex > 0 ? [1, 2] : null,
      isFirstMount: commitIndex === 0,
      props: commitIndex > 0 ? ["value", "label".repeat(40)] : null,
      state: commitIndex > 0 ? ["expanded"] : null,
    }));
    session.reactResultData = {
      profile: {
        dataForRoots: [
          {
            commitData: descriptions.map((description) => ({
              changeDescriptions: componentIds.map((id) => [id, description]),
              duration: 20,
              fiberActualDurations: componentIds.map((id) => [id, 2]),
              fiberSelfDurations: componentIds.map((id) => [id, 1]),
            })),
            displayNames: componentIds.map((id) => [id, "Counter"]),
          },
        ],
      },
      profileId: "long-profile",
      status: "complete",
    };
    expect(
      structured(await service.handlers.reactProfileStop({ profileId: "long-profile" }, context)).ok,
    ).toBeTrue();

    const compact = await service.handlers.reactProfileAnalyze(
      { limit: 12, profileId: "long-profile" },
      context,
    );
    const compactOutput = structured(compact);
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(20 * 1024);
    expect(compactOutput.artifacts).toEqual([]);
    expect(compactOutput.results).toHaveLength(12);
    expect(compactOutput.nextCursor).toBeNull();
    if (!Array.isArray(compactOutput.results)) throw new Error("Expected compact React analysis rows");
    for (const row of compactOutput.results) {
      expect(row).not.toHaveProperty("changeDescriptions");
      expect(row).toMatchObject({
        changeSummary: { context: 69, hooks: 69, mounts: 1, props: 69, records: 70, state: 69 },
        displayName: "Counter",
        renderCount: 70,
        totalInclusiveDuration: 140,
        totalSelfDuration: 70,
      });
    }

    const detailed = await service.handlers.reactProfileAnalyze(
      {
        includeChangeDescriptions: true,
        limit: 6,
        profileId: "long-profile",
      },
      context,
    );
    const detailedOutput = structured(detailed);
    expect(Buffer.byteLength(JSON.stringify(detailed))).toBeLessThanOrEqual(REACT_ANALYSIS_RESULT_MAX_BYTES);
    expect(detailedOutput.results).toEqual(compactOutput.results.slice(0, 6));
    expect(detailedOutput.artifacts).toHaveLength(1);
    const artifact = detailedOutput.changeDescriptionsArtifact;
    if (!isRecord(artifact) || typeof artifact.uri !== "string") {
      throw new Error("Expected a React history artifact");
    }
    const resource = await service.artifactStore.readResource(
      service.artifactConnection(context),
      artifact.uri,
    );
    if (typeof resource.text !== "string") throw new Error("Expected complete JSON history");
    const history: unknown = JSON.parse(resource.text);
    expect(history).toEqual({
      profileId: "long-profile",
      results: componentIds.slice(0, 6).map((componentId) => ({
        changeDescriptions: descriptions.map((description, commitIndex) => ({ ...description, commitIndex })),
        componentId,
      })),
    });
    if (typeof detailedOutput.nextCursor !== "string") {
      throw new TypeError("Expected a React history continuation");
    }
    const wrongOption = structured(
      await service.handlers.reactProfileAnalyze(
        {
          cursor: detailedOutput.nextCursor,
          limit: 6,
          profileId: "long-profile",
        },
        context,
      ),
    );
    expect(wrongOption.error).toMatchObject({ code: "CHROME_MCP_REACT_STALE_CURSOR" });
    const continued = structured(
      await service.handlers.reactProfileAnalyze(
        {
          cursor: detailedOutput.nextCursor,
          includeChangeDescriptions: true,
          limit: 6,
          profileId: "long-profile",
        },
        context,
      ),
    );
    expect(continued.results).toEqual(compactOutput.results.slice(6));
    expect(continued.nextCursor).toBeNull();
    await service.close();
  });

  test("bounds the full analysis envelope without skipping rows or truncating oversized names", async () => {
    const { runtime, service } = await createFixture(async (options) => success(options, []), {
      configureRuntime: (configuredRuntime) => {
        configuredRuntime.reactResultData = {
          profileId: "wide-profile",
          startedAt: "2026-08-31T00:00:00.000Z",
        };
      },
    });
    const context = toolContext(toolSession("wide-react-profile"));
    expect(
      structured(await service.handlers.reactProfileStart({ browser: "isolated" }, context)).ok,
    ).toBeTrue();
    const session = [...runtime.sessions.values()][0];
    if (!session) throw new Error("Expected a React runtime session");
    const components = ["a", "b", "c", "d"];
    const names = ['界"'.repeat(2000), "\\".repeat(8000), "Name".repeat(2000), "Huge".repeat(20_000)];
    session.reactResultData = {
      profile: {
        dataForRoots: [
          {
            commitData: [
              {
                duration: 20,
                fiberActualDurations: components.map((id) => [id, 2]),
                fiberSelfDurations: components.map((id) => [id, 1]),
              },
            ],
            displayNames: components.map((id, index) => [id, names[index]]),
          },
        ],
      },
      profileId: "wide-profile",
      status: "complete",
    };
    expect(
      structured(await service.handlers.reactProfileStop({ profileId: "wide-profile" }, context)).ok,
    ).toBeTrue();
    const received: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await service.handlers.reactProfileAnalyze(
        {
          ...(cursor === undefined ? {} : { cursor }),
          includeChangeDescriptions: true,
          limit: 4,
          profileId: "wide-profile",
        },
        context,
      );
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(
        REACT_ANALYSIS_RESULT_MAX_BYTES,
      );
      const output = structured(response);
      expect(output.ok).toBeTrue();
      if (!Array.isArray(output.results)) throw new Error("Expected a complete React analysis page");
      received.push(...output.results);
      if (isRecord(output.resultsArtifact) && typeof output.resultsArtifact.uri === "string") {
        const resource = await service.artifactStore.readResource(
          service.artifactConnection(context),
          output.resultsArtifact.uri,
        );
        if (typeof resource.text !== "string") throw new Error("Expected a complete oversized row artifact");
        const archived: unknown = JSON.parse(resource.text);
        if (!isRecord(archived) || !Array.isArray(archived.results)) {
          throw new Error("Expected archived React rows");
        }
        received.push(...archived.results);
      }
      cursor = typeof output.nextCursor === "string" ? output.nextCursor : undefined;
      pages += 1;
      if (pages > components.length) throw new Error("React analysis pagination did not advance");
    } while (cursor !== undefined);
    expect(pages).toBeGreaterThan(1);
    expect(received).toEqual(
      components.map((componentId, index) =>
        expect.objectContaining({ componentId, displayName: names[index] }),
      ),
    );
    await service.close();
  });

  test("publishes React results larger than the inline contract as connection-owned artifacts", async () => {
    const { service } = await createFixture(async (options) => success(options, []), {
      configureRuntime: (runtime) => {
        runtime.reactResultData = { payload: "x".repeat(300_000) };
      },
    });
    const result = await service.handlers.reactListComponents(
      { browser: "isolated", limit: 100 },
      toolContext(toolSession("react-result-artifact")),
    );
    const output = structured(result);

    expect(output.ok).toBeTrue();
    expect(Array.isArray(output.artifacts) ? output.artifacts : []).toHaveLength(1);
    expect(isRecord(output.data) ? output.data.inlineTruncated : false).toBeTrue();
    expect(
      isRecord(output.data) && isRecord(output.data.artifact) ? output.data.artifact.complete : false,
    ).toBeTrue();
    expect(JSON.stringify(output).length).toBeLessThan(256 * 1024);
    await service.close();
  });

  test("reports snapshot, persistent mutation, and binding limits from their owning constants", async () => {
    let reportedLimits: JsonValue | undefined;
    const { service } = await createFixture(async (options) => {
      reportedLimits = options.request.capabilities.limits;
      return success(options, []);
    });

    await service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
      toolContext(toolSession("capability-limits")),
    );

    if (!isRecord(reportedLimits)) throw new Error("Expected capability limits");
    expect(Object.keys(reportedLimits)).toEqual([...CHROME_CAPABILITY_LIMIT_FIELDS]);
    expect(reportedLimits).toEqual(
      expect.objectContaining({
        bindingConcurrency: PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS,
        bindingPayloadBytes: PERSISTENT_BINDING_MAX_PAYLOAD_BYTES,
        bindingTimeoutMs: PERSISTENT_BINDING_WORKER_TIMEOUT_MS,
        inlineImageTotalBytes: INLINE_IMAGE_MAX_TOTAL_BYTES,
        mutationCountPerKind: PERSISTENT_MUTATION_MAX_COUNT_PER_KIND,
        mutationEntryBytes: PERSISTENT_MUTATION_MAX_ENTRY_BYTES,
        mutationTotalBytes: PERSISTENT_MUTATION_MAX_TOTAL_BYTES,
        snapshotMaxBytes: SNAPSHOT_MAX_BYTES,
        snapshotMaxDepth: SNAPSHOT_MAX_DEPTH,
        snapshotMinBytes: SNAPSHOT_MIN_BYTES,
        snapshotMinDepth: SNAPSHOT_MIN_DEPTH,
        snapshotRetainedCount: SNAPSHOT_RETAINED_COUNT,
      }),
    );
    await service.close();
  });

  test("routes owner-close authorization through the runtime and preserves its failure code", async () => {
    const fixture = await createFixture(async (options) => {
      const action = requestAction(options);
      const session = fixture.runtime.sessions.get(
        `${String(action.connectionId)}\0${options.request.browserMode}`,
      );
      if (!session) throw new Error("Fake browser session is unavailable");
      session.browserClients = Number(action.clients);
      session.pendingAdmissions = Number(action.pendingAdmissions);
      await options.adapter.execute(
        { operation: "owner_close_authorize", payload: { resource: "browser" } },
        rpcContext(),
      );
      return success(options, []);
    });

    type OwnerCloseInput = {
      browser: Exclude<BrowserMode, "isolated-headless">;
      clients: number;
      connectionId: string;
      pendingAdmissions: number;
    };
    const run = (input: OwnerCloseInput) =>
      fixture.service.handlers.runPlaywright(
        {
          args: {
            clients: input.clients,
            connectionId: input.connectionId,
            pendingAdmissions: input.pendingAdmissions,
          },
          browser: input.browser,
          code: "return true",
          timeoutMs: 1000,
        },
        toolContext(toolSession(input.connectionId)),
      );

    const exclusive = await run({
      browser: "isolated",
      clients: 1,
      connectionId: "exclusive-close",
      pendingAdmissions: 0,
    });
    expect(structured(exclusive).ok).toBeTrue();

    const rejectedInputs: OwnerCloseInput[] = [
      { browser: "shared", clients: 2, connectionId: "shared-close", pendingAdmissions: 0 },
      { browser: "isolated", clients: 1, connectionId: "queued-close", pendingAdmissions: 1 },
      { browser: "main", clients: 1, connectionId: "main-close", pendingAdmissions: 0 },
    ];
    for (const input of rejectedInputs) {
      const result = await run(input);
      const output = structured(result);
      expect(result.isError).toBeTrue();
      expect(isRecord(output.error) ? output.error.code : undefined).toBe(
        "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
      );
    }

    await fixture.service.close();
  });

  test("returns a successful terminal result after an authorized owner close", async () => {
    const fixture = await createFixture(async (options) => {
      await options.adapter.execute(
        { operation: "owner_close_authorize", payload: { resource: "browser" } },
        rpcContext(),
      );

      const session = fixture.runtime.sessions.get(`terminal-close\0${options.request.browserMode}`);
      if (!session) throw new Error("Fake browser session is unavailable");
      session.disconnect();
      return success(options, [], { closed: true });
    });

    const result = await fixture.service.handlers.runPlaywright(
      {
        args: {},
        browser: "isolated",
        code: "await browser.close(); return { closed: true }",
        timeoutMs: 1000,
      },
      toolContext(toolSession("terminal-close")),
    );

    expect(structured(result)).toMatchObject({
      ok: true,
      selectedTargetId: null,
      value: { closed: true },
    });
    await fixture.service.close();
  });

  test("defers runtime directories until session use and removes an empty owned artifact instance on close", async () => {
    const runtime = new FakeRuntime();
    const root = await mkdtemp(join(tmpdir(), "chrome-service-lazy-runtime-"));
    roots.push(root);
    const service = await createChromeService({
      artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
      executionKernel: async (options) => success(options, []),
      playwrightVersion: "test",
      runtime,
    });
    const instanceRoot = service.artifactStore.instanceRoot;
    const session = toolSession("lazy-runtime-directories");
    const onConnect = service.sessionLifecycle.onConnect;
    if (!onConnect) throw new Error("Expected a session connect hook");

    expect(await pathExists(instanceRoot)).toBeFalse();
    await onConnect({
      connectionId: session.connectionId,
      notifyResourcesListChanged: () => Promise.resolve(),
      session,
    });
    expect(await pathExists(instanceRoot)).toBeTrue();

    await service.close();
    expect(await pathExists(instanceRoot)).toBeFalse();
  });

  test("closes an unused service without accessing its uncreated artifact directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-service-unused-"));
    roots.push(root);
    await writeFile(join(root, "blocked"), "not a directory");
    const service = await createChromeService({
      artifactStore: new ArtifactStore({ root: join(root, "blocked", "artifacts") }),
      playwrightVersion: "test",
      runtime: new FakeRuntime(),
    });

    await service.close();
    expect(await Bun.file(join(root, "blocked")).text()).toBe("not a directory");
  });

  test("exits successfully after constructing an unused service with no artifact directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-service-unused-exit-"));
    roots.push(root);
    await writeFile(join(root, "blocked"), "not a directory");
    const source = `
import { ArtifactStore } from ${JSON.stringify(new URL("../artifacts/store.ts", import.meta.url).href)};
import { createChromeService } from ${JSON.stringify(new URL("./service.ts", import.meta.url).href)};

await createChromeService({
  artifactStore: new ArtifactStore({ root: ${JSON.stringify(join(root, "blocked", "artifacts"))} }),
  executablePath: "unused",
  playwrightVersion: "test",
  workspacePath: ${JSON.stringify(root)},
});
console.log("constructed");
`;
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect({ exitCode, stderr, stdout }).toEqual({ exitCode: 0, stderr: "", stdout: "constructed\n" });
    expect(await Bun.file(join(root, "blocked")).text()).toBe("not a directory");
  });

  test("removes its artifact instance after the final published artifact is deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-service-deleted-artifact-"));
    roots.push(root);
    const artifactStore = new ArtifactStore({ root: join(root, "artifacts") });
    const service = await createChromeService({
      artifactStore,
      executionKernel: async (options) => success(options, []),
      playwrightVersion: "test",
      runtime: new FakeRuntime(),
    });
    const session = toolSession("deleted-artifact");
    const context = toolContext(session);
    const onConnect = service.sessionLifecycle.onConnect;
    if (!onConnect) throw new Error("Expected a session connect hook");
    await onConnect({
      connectionId: session.connectionId,
      notifyResourcesListChanged: () => Promise.resolve(),
      session,
    });
    const owner = service.artifactConnection(context);
    const publication = await artifactStore.beginPublication(owner);
    const descriptor = await artifactStore.publishBytes(publication, new TextEncoder().encode("delete me"), {
      name: "delete-me.txt",
      origin: { browserMode: "isolated", tool: "run_playwright" },
    });
    await artifactStore.finishPublication(publication);
    await artifactStore.deleteArtifact(owner, descriptor.artifactId);

    await service.close();
    expect(await pathExists(artifactStore.instanceRoot)).toBeFalse();
  });

  test("removes its artifact instance after the final published artifact expires", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-service-expired-artifact-"));
    roots.push(root);
    const artifactStore = new ArtifactStore({ expiryMs: 0, root: join(root, "artifacts") });
    const service = await createChromeService({
      artifactStore,
      executionKernel: async (options) => success(options, []),
      playwrightVersion: "test",
      runtime: new FakeRuntime(),
    });
    const session = toolSession("expired-artifact");
    const context = toolContext(session);
    const onConnect = service.sessionLifecycle.onConnect;
    if (!onConnect) throw new Error("Expected a session connect hook");
    await onConnect({
      connectionId: session.connectionId,
      notifyResourcesListChanged: () => Promise.resolve(),
      session,
    });
    const owner = service.artifactConnection(context);
    const publication = await artifactStore.beginPublication(owner);
    await artifactStore.publishBytes(publication, new TextEncoder().encode("expire me"), {
      name: "expire-me.txt",
      origin: { browserMode: "isolated", tool: "run_playwright" },
    });
    await artifactStore.finishPublication(publication);
    await service.closeConnection(context);
    await artifactStore.sweepExpired();

    await service.close();
    expect(await pathExists(artifactStore.instanceRoot)).toBeFalse();
  });

  test("retains its artifact instance while a published artifact remains readable", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-service-retained-artifact-"));
    roots.push(root);
    const artifactStore = new ArtifactStore({ root: join(root, "artifacts") });
    const service = await createChromeService({
      artifactStore,
      executionKernel: async (options) => success(options, []),
      playwrightVersion: "test",
      runtime: new FakeRuntime(),
    });
    const session = toolSession("retained-artifact");
    const context = toolContext(session);
    const onConnect = service.sessionLifecycle.onConnect;
    if (!onConnect) throw new Error("Expected a session connect hook");
    await onConnect({
      connectionId: session.connectionId,
      notifyResourcesListChanged: () => Promise.resolve(),
      session,
    });
    const owner = service.artifactConnection(context);
    const publication = await artifactStore.beginPublication(owner);
    await artifactStore.publishBytes(publication, new TextEncoder().encode("retain me"), {
      name: "retain-me.txt",
      origin: { browserMode: "isolated", tool: "run_playwright" },
    });
    await artifactStore.finishPublication(publication);

    await service.close();
    expect(await pathExists(artifactStore.instanceRoot)).toBeTrue();
  });

  test("commits state and selection only after successful execution", async () => {
    const kernel: ChromeExecutionKernel = async (options) => {
      const args = requestAction(options);
      if (args.action === "fail") {
        await options.adapter.execute(
          { operation: "select_page", payload: { targetId: `${options.request.browserMode}-failed` } },
          rpcContext(),
        );
        return failure(options);
      }
      if (args.action === "inspect") {
        return success(options, options.request.state, copyJsonValue(options.request.state));
      }
      await options.adapter.execute(
        { operation: "select_page", payload: { targetId: `${options.request.browserMode}-next` } },
        rpcContext(),
      );
      return {
        ...success(options, [["committed", 1]], { committed: true }),
        selectedTargetId: `${options.request.browserMode}-next`,
      };
    };
    const { runtime, service } = await createFixture(kernel);
    const context = toolContext(toolSession("transaction"));

    const succeeded = await service.handlers.runPlaywright(
      { args: { action: "commit" }, browser: "isolated", code: "return args", timeoutMs: 1000 },
      context,
    );
    expect(structured(succeeded).selectedTargetId).toBe("isolated-next");

    const failed = await service.handlers.runPlaywright(
      { args: { action: "fail" }, browser: "isolated", code: "throw new Error()", timeoutMs: 1000 },
      context,
    );
    expect(failed.isError).toBe(true);
    expect(structured(failed).selectedTargetId).toBe("isolated-next");

    const inspected = await service.handlers.runPlaywright(
      {
        args: { action: "inspect" },
        browser: "isolated",
        code: "return chrome.listSessionStateEntries()",
        timeoutMs: 1000,
      },
      context,
    );
    expect(structured(inspected).value).toEqual([["committed", 1]]);
    expect(runtime.sessions.values().next().value?.currentTarget().targetId).toBe("isolated-next");
    await service.close();
  });

  test("rolls back selection and state when rendering metadata fails before commit", async () => {
    const fixture = await createFixture(async (options) => {
      if (requestAction(options).action === "inspect") {
        return success(options, options.request.state, copyJsonValue(options.request.state));
      }

      const session = fixture.runtime.sessions.get("rendering-failure\0isolated-virtual-display\0desktop");
      assert(session);

      session.cdpProbeResponses = new Map([
        ["Runtime.evaluate", () => Promise.resolve({ result: { value: 0 } })],
      ]);
      await options.adapter.execute(
        { operation: "select_page", payload: { targetId: "isolated-virtual-display-next" } },
        rpcContext(),
      );
      return {
        ...success(options, [["uncommitted", 1]]),
        selectedTargetId: "isolated-virtual-display-next",
      };
    });

    const context = toolContext(toolSession("rendering-failure"));
    const input = {
      browser: "isolated-virtual-display",
      browserInstanceId: "desktop",
      nativeDeviceScaleFactor: 1,
      code: "return args",
      timeoutMs: 1000,
    } as const;

    try {
      const failed = await fixture.service.handlers.runPlaywright(
        { ...input, args: { action: "fail" } },
        context,
      );
      expect(structured(failed)).toMatchObject({
        ok: false,
        selectedTargetId: "isolated-virtual-display-initial",
      });

      const session = fixture.runtime.sessions.get("rendering-failure\0isolated-virtual-display\0desktop");
      assert(session);

      session.cdpProbeResponses = undefined;

      const inspected = await fixture.service.handlers.runPlaywright(
        { ...input, args: { action: "inspect" } },
        context,
      );
      expect(structured(inspected)).toMatchObject({
        ok: true,
        selectedTargetId: "isolated-virtual-display-initial",
        value: [],
      });
    } finally {
      await fixture.service.close();
    }
  });

  test("preserves a page-closed failure after selection begins without retrying user work", async () => {
    let kernelCalls = 0;
    const fixture = await createFixture(async (options) => {
      kernelCalls++;
      const session = fixture.runtime.sessions.get("post-selection-close\0isolated");
      if (!session) throw new Error("Expected the post-selection-close runtime session");
      session.destroyTarget(options.request.selectedTargetId);
      return {
        ...failure(options),
        error: {
          code: "CHROME_MCP_PAGE_CLOSED",
          message: "The selected page closed after the selection transaction began",
          name: "ChromeMcpExecutionError",
        },
      };
    });

    const result = await fixture.service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
      toolContext(toolSession("post-selection-close")),
    );

    expect(structured(result).error).toMatchObject({ code: "CHROME_MCP_PAGE_CLOSED" });
    expect(kernelCalls).toBe(1);
    await fixture.service.close();
  });

  test("preserves execution errors and emitted diagnostics when selection rollback fails", async () => {
    const fixture = await createFixture(async (options) => {
      const session = fixture.runtime.sessions.get("execution-rollback-failure\0isolated");
      if (!session) throw new Error("Expected the execution-rollback-failure runtime session");
      session.selectionRollbackFailure = new ChromeMcpExecutionError(
        "CHROME_MCP_PAGE_CLOSED",
        "No usable page remains",
      );
      return {
        ...failure(options),
        partialContent: [{ text: "measurement captured", type: "text" }],
        partialEmittedCount: 1,
        partialOmittedCount: 0,
      };
    });
    const result = await fixture.service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
      toolContext(toolSession("execution-rollback-failure")),
    );
    expect(structured(result)).toMatchObject({
      error: { code: "CHROME_MCP_INVALID_INPUT" },
      ok: false,
      partialEmittedCount: 1,
      partialOmittedCount: 0,
      selectedTargetId: null,
    });
    const error = structured(result).error;
    if (!isRecord(error)) throw new Error("Expected a structured execution error");
    expect(error.message).toContain("scripted failure");
    expect(error.message).toContain("CHROME_MCP_PAGE_CLOSED: No usable page remains");
    expect(result.content).toContainEqual({ text: "measurement captured", type: "text" });
    await fixture.service.close();
  });

  test("attaches the selected target crash before rollback without replacing the original failure", async () => {
    const journal = new BoundedEventJournal(1);
    const fixture = await createFixture(async (options) => {
      journal.append(options.request.selectedTargetId, {
        errorCode: 4,
        status: boundedText("crashed", 256),
        type: "target_crashed",
      });
      return {
        ...failure(options),
        error: {
          code: "CHROME_MCP_EXECUTION_FAILED",
          message: "waitForFunction: Target crashed",
          name: "Error",
        },
        partialContent: [{ text: "before crash", type: "text" }],
        partialEmittedCount: 1,
        partialOmittedCount: 0,
      };
    });
    await fixture.runtime.acquire("target-crash", "isolated");
    const session = fixture.runtime.sessions.get("target-crash\0isolated");
    if (!session) {
      throw new Error("Expected the target-crash runtime session");
    }
    session.currentEventCursor = () => Promise.resolve(journal.currentCursor);
    session.readEvents = (options) => Promise.resolve(journal.read(options));
    session.selectionRollbackFailure = new Error("rollback failed");

    const result = await fixture.service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
      toolContext(toolSession("target-crash")),
    );

    expect(structured(result)).toMatchObject({
      diagnostics: {
        browserConnection: "connected",
        chromeProduct: "Fake Chrome/1",
        targetCrash: {
          errorCode: 4,
          ownerGeneration: 1,
          targetId: "isolated-initial",
          type: "target_crashed",
        },
      },
      error: { code: "CHROME_MCP_EXECUTION_FAILED", name: "Error" },
      partialEmittedCount: 1,
      partialOmittedCount: 0,
      selectedTargetId: null,
    });
    expect(result.content).toContainEqual({ text: "before crash", type: "text" });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("waitForFunction: Target crashed"),
    });
    expect(session.invalidatedOwners).toBe(0);
    await fixture.service.close();
  });

  test("does not attribute an earlier or different target crash to a failed call", async () => {
    const journal = new BoundedEventJournal(1);
    const crash = {
      errorCode: 4,
      status: boundedText("crashed", 256),
      type: "target_crashed",
    } satisfies BrowserJournalInput;
    journal.append("isolated-initial", crash);
    const fixture = await createFixture(async (options) => {
      journal.append("other-page", crash);
      return failure(options);
    });
    await fixture.runtime.acquire("unrelated-crash", "isolated");
    const session = fixture.runtime.sessions.get("unrelated-crash\0isolated");
    if (!session) {
      throw new Error("Expected the unrelated-crash runtime session");
    }
    session.currentEventCursor = () => Promise.resolve(journal.currentCursor);
    session.readEvents = (options) => Promise.resolve(journal.read(options));

    const result = await fixture.service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
      toolContext(toolSession("unrelated-crash")),
    );

    expect(structured(result).diagnostics).toBeUndefined();
    await fixture.service.close();
  });

  test("does not attach crash details or connection state from a replacement browser owner", async () => {
    const journal = new BoundedEventJournal(2);
    let replaced = false;
    const fixture = await createFixture(async (options) => {
      replaced = true;
      journal.append(options.request.selectedTargetId, {
        errorCode: 4,
        status: boundedText("crashed", 256),
        type: "target_crashed",
      });
      return failure(options);
    });
    await fixture.runtime.acquire("replaced-owner", "isolated");
    const session = fixture.runtime.sessions.get("replaced-owner\0isolated");
    if (!session) {
      throw new Error("Expected the replaced-owner runtime session");
    }
    const capabilities = session.capabilities.bind(session);
    session.capabilities = async () => ({ ...(await capabilities()), ownerGeneration: replaced ? 2 : 1 });
    session.readEvents = (options) => Promise.resolve(journal.read(options));

    const result = await fixture.service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
      toolContext(toolSession("replaced-owner")),
    );

    expect(structured(result).diagnostics).toEqual({
      browserConnection: "unknown",
      journal: { droppedBefore: null, ownerReset: true },
      unavailable: ["browser-state"],
    });
    await fixture.service.close();
  });

  test("reports browser disconnection without replacing an execution-worker failure", async () => {
    let disconnected = false;
    const fixture = await createFixture(async (options) => {
      disconnected = true;
      return {
        ...failure(options),
        error: { code: "CHROME_MCP_WORKER_CRASH", message: "worker exited", name: "Error" },
      };
    });
    await fixture.runtime.acquire("disconnected-worker", "isolated");
    const session = fixture.runtime.sessions.get("disconnected-worker\0isolated");
    if (!session) {
      throw new Error("Expected the disconnected-worker runtime session");
    }
    const capabilities = session.capabilities.bind(session);
    session.capabilities = async () => ({ ...(await capabilities()), browserConnected: !disconnected });

    const result = await fixture.service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
      toolContext(toolSession("disconnected-worker")),
    );

    expect(structured(result)).toMatchObject({
      diagnostics: { browserConnection: "disconnected", chromeProduct: "Fake Chrome/1" },
      error: { code: "CHROME_MCP_WORKER_CRASH", message: "worker exited" },
    });
    expect(session.invalidatedOwners).toBe(0);
    await fixture.service.close();
  });

  test("preserves the execution failure when crash diagnostics are unavailable", async () => {
    let browserStateUnavailable = false;
    const fixture = await createFixture(async (options) => {
      browserStateUnavailable = true;
      return failure(options);
    });
    await fixture.runtime.acquire("missing-diagnostics", "isolated");
    const session = fixture.runtime.sessions.get("missing-diagnostics\0isolated");
    if (!session) {
      throw new Error("Expected the missing-diagnostics runtime session");
    }
    session.currentEventCursor = () => Promise.reject(new Error("cursor unavailable"));
    const capabilities = session.capabilities.bind(session);
    session.capabilities = () => {
      if (browserStateUnavailable) {
        return Promise.reject(new Error("owner unavailable"));
      }
      return capabilities();
    };

    const result = await fixture.service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
      toolContext(toolSession("missing-diagnostics")),
    );

    expect(structured(result)).toMatchObject({
      diagnostics: { browserConnection: "unknown", unavailable: ["browser-state", "crash-events"] },
      error: { code: "CHROME_MCP_INVALID_INPUT", message: "scripted failure" },
    });
    await fixture.service.close();
  });

  test("invalidates the browser owner only when execution reports a disconnected browser", async () => {
    const fixture = await createFixture(async (options) => {
      const action = requestAction(options);
      if (action.code === "disconnected-rollback-failure") {
        const session = fixture.runtime.sessions.get("rollback-failed-owner\0isolated");
        if (!session) throw new Error("Expected the rollback-failed runtime session");
        session.selectionRollbackFailure = new Error("scripted rollback failure");
      }
      return {
        ...failure(options),
        error: {
          code:
            action.code === "disconnected" || action.code === "disconnected-rollback-failure" ?
              "CHROME_MCP_BROWSER_DISCONNECTED"
            : "CHROME_MCP_TIMEOUT",
          message: "scripted runtime failure",
          name: "ChromeMcpExecutionError",
        },
      };
    });
    const { runtime, service } = fixture;
    const disconnectedContext = toolContext(toolSession("disconnected-owner"));
    const rollbackFailedContext = toolContext(toolSession("rollback-failed-owner"));
    const timeoutContext = toolContext(toolSession("timed-out-owner"));

    const disconnected = await service.handlers.runPlaywright(
      { args: { code: "disconnected" }, browser: "isolated", code: "return true", timeoutMs: 1000 },
      disconnectedContext,
    );
    const timedOut = await service.handlers.runPlaywright(
      { args: { code: "timeout" }, browser: "isolated", code: "return true", timeoutMs: 1000 },
      timeoutContext,
    );
    await service.handlers.runPlaywright(
      {
        args: { code: "disconnected-rollback-failure" },
        browser: "isolated",
        code: "return true",
        timeoutMs: 1000,
      },
      rollbackFailedContext,
    );

    expect(structured(disconnected).error).toMatchObject({ code: "CHROME_MCP_BROWSER_DISCONNECTED" });
    expect(structured(timedOut).error).toMatchObject({ code: "CHROME_MCP_TIMEOUT" });
    expect(runtime.sessions.get("disconnected-owner\0isolated")?.invalidatedOwners).toBe(1);
    expect(runtime.sessions.get("rollback-failed-owner\0isolated")?.invalidatedOwners).toBe(1);
    expect(runtime.sessions.get("timed-out-owner\0isolated")?.invalidatedOwners).toBe(0);
    await service.close();
  });

  test("preserves a selection commit failure after the runtime finishes its rollback", async () => {
    const fixture = await createFixture(async (options) => {
      const session = fixture.runtime.sessions.get("commit-failure\0isolated");
      if (!session) throw new Error("Expected the commit-failure runtime session");
      session.selectionCommitFailure = new ChromeMcpExecutionError(
        "CHROME_MCP_PAGE_CLOSED",
        "The selected page closed before selection commit",
      );
      return success(options, options.request.state);
    });
    const failed = await fixture.service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
      toolContext(toolSession("commit-failure")),
    );

    const active = fixture.runtime.sessions.get("commit-failure\0isolated");
    if (!active) throw new Error("Expected the commit-failure runtime session");
    expect(structured(failed).error).toMatchObject({ code: "CHROME_MCP_PAGE_CLOSED" });
    expect(active.selectionRollbackCalls).toBe(0);
    await fixture.service.close();
  });

  test("uses a same-call selected page for events and target-scoped helpers", async () => {
    const kernel: ChromeExecutionKernel = async (options) => {
      const targetId = `${options.request.browserMode}-next`;
      await options.adapter.execute({ operation: "select_page", payload: { targetId } }, rpcContext());
      await options.adapter.execute(
        { operation: "events_read", payload: { options: { target: "selected" } } },
        rpcContext(),
      );
      await options.adapter.execute(
        {
          operation: "mutation_add",
          payload: {
            input: {
              action: { type: "continue" },
              kind: "route",
              urlPattern: "https://api.example.test/*",
            },
          },
        },
        rpcContext(),
      );
      const capture = await options.adapter.execute(
        { operation: "capture_start", payload: { options: { type: "network-bodies" } } },
        rpcContext(),
      );
      return {
        ...success(options, [], capture.value),
        selectedTargetId: targetId,
      };
    };
    const { runtime, service } = await createFixture(kernel);
    const context = toolContext(toolSession("same-call-target-scoped-helpers"));

    const result = await service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
      context,
    );
    const session = runtime.sessions.values().next().value;

    expect(structured(result).value).toEqual(expect.objectContaining({ targetId: "isolated-next" }));
    expect(session?.lastReadOptions).toEqual(expect.objectContaining({ target: "isolated-next" }));
    expect(session?.lastMutationTarget).toEqual({ ownerGeneration: 1, targetId: "isolated-next" });
    await service.close();
  });

  test("refreshes a cached diagnostic page URL before a later reload trace", async () => {
    const { runtime, service } = await createFixture(async (options) => success(options, []));
    const context = toolContext(toolSession("diagnostic-current-url"));
    await service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
      context,
    );
    const session = runtime.sessions.get("diagnostic-current-url\0isolated");
    if (!session) throw new Error("Expected the diagnostic fake runtime session");
    session.tracingStartFailures = 1;

    expect(
      service.handlers.performanceStartTrace(
        { autoStop: false, browser: "isolated", reload: false },
        context,
      ),
    ).rejects.toThrow();

    const selectedTargetId = session.currentTarget().targetId;
    session.setTargetUrl(selectedTargetId, "https://isolated.test/current-after-navigation");
    await service.handlers.performanceStartTrace(
      { autoStop: false, browser: "isolated", reload: true },
      context,
    );

    expect(session.lastModalPolicy).toBe("reject");
    expect(session.navigationUrls).toEqual(["about:blank", "https://isolated.test/current-after-navigation"]);
    await service.close();
  });

  test("releases diagnostic attachments as targets close in a long-lived mode", async () => {
    const kernel: ChromeExecutionKernel = async (options) => {
      const args = requestAction(options);
      if (typeof args.targetId === "string") {
        await options.adapter.execute(
          { operation: "select_page", payload: { targetId: args.targetId } },
          rpcContext(),
        );
        return { ...success(options, []), selectedTargetId: args.targetId };
      }
      return success(options, []);
    };
    const { runtime, service } = await createFixture(kernel);
    const context = toolContext(toolSession("diagnostic-target-cleanup"));
    await service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
      context,
    );
    const session = runtime.sessions.get("diagnostic-target-cleanup\0isolated");
    if (!session) throw new Error("Expected the diagnostic cleanup runtime session");

    for (let index = 0; index < 12; index += 1) {
      const targetId = `diagnostic-target-${index}`;
      session.addTarget(targetId, `https://diagnostic.test/${index}`);
      await service.handlers.runPlaywright(
        { args: { targetId }, browser: "isolated", code: "return args.targetId", timeoutMs: 1000 },
        context,
      );
      session.tracingStartFailures += 1;
      expect(
        service.handlers.performanceStartTrace(
          { autoStop: false, browser: "isolated", reload: false },
          context,
        ),
      ).rejects.toThrow();
      expect(session.activeDiagnosticAttachments).toBe(1);

      session.destroyTarget(targetId);
      await session.waitForNoDiagnosticAttachments();

      expect(session.activeDiagnosticAttachments).toBe(0);
    }

    await service.close();
  });

  test("routes file chooser files through the service to the runtime", async () => {
    const inputRoot = await mkdtemp(join(tmpdir(), "chrome-service-upload-test-"));
    roots.push(inputRoot);
    const inputPath = join(inputRoot, "input.txt");
    await writeFile(inputPath, "upload");
    const kernel: ChromeExecutionKernel = async (options) => {
      await options.adapter.execute(
        {
          operation: "file_chooser_set_files",
          payload: { files: [{ kind: "path", path: inputPath }], modalId: "chooser-1" },
        },
        rpcContext(),
      );
      return success(options, []);
    };
    const { runtime, service } = await createFixture(kernel);
    const context = toolContext(toolSession("file-chooser-routing", inputRoot));

    await service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
      context,
    );

    expect(runtime.sessions.values().next().value?.lastFileChooserRequest).toEqual({
      chooserId: "chooser-1",
      files: [inputPath],
    });
    await service.close();
  });

  test("uses the shared owner FIFO across connections", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const order: string[] = [];
    const kernel: ChromeExecutionKernel = async (options) => {
      const args = requestAction(options);
      const id = String(args.id);
      order.push(`start:${id}`);
      if (id === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      order.push(`end:${id}`);
      return success(options, []);
    };
    const { service } = await createFixture(kernel);
    const firstContext = toolContext(toolSession("fifo-a"));
    const secondContext = toolContext(toolSession("fifo-b"));
    const first = service.handlers.runPlaywright(
      { args: { id: "first" }, browser: "shared", code: "return 1", timeoutMs: 1000 },
      firstContext,
    );
    await firstStarted.promise;
    const second = service.handlers.runPlaywright(
      { args: { id: "second" }, browser: "shared", code: "return 2", timeoutMs: 1000 },
      secondContext,
    );
    await Promise.resolve();
    expect(order).toEqual(["start:first"]);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    await service.close();
  });

  test("routes bounded worker console output to the server debug log", async () => {
    const { service } = await createFixture(async (options) => {
      options.onDebugLog?.({ stderr: "worker stderr", stdout: "worker stdout" });
      return success(options, []);
    });
    const baseContext = toolContext(toolSession("debug-log"));
    const logs: (readonly [string, unknown])[] = [];
    const context: ChromeToolContext = {
      ...baseContext,
      log: {
        ...baseContext.log,
        debug: (message, data) => logs.push([message, data]),
      },
    };

    const result = await service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "console.log('worker stdout')", timeoutMs: 1000 },
      context,
    );

    expect(structured(result).ok).toBeTrue();
    expect(logs).toEqual([
      ["run_playwright worker stdout", { output: "worker stdout" }],
      ["run_playwright worker stderr", { output: "worker stderr" }],
    ]);
    expect(JSON.stringify(result)).not.toContain("worker stdout");
    expect(JSON.stringify(result)).not.toContain("worker stderr");
    await service.close();
  });

  test("converges concurrent first acquisition for one connection and mode", async () => {
    const { runtime, service } = await createFixture(async (options) => success(options, []));
    const context = toolContext(toolSession("acquisition"));
    await Promise.all([
      service.handlers.runPlaywright(
        { args: {}, browser: "isolated", code: "return 1", timeoutMs: 1000 },
        context,
      ),
      service.handlers.runPlaywright(
        { args: {}, browser: "isolated", code: "return 2", timeoutMs: 1000 },
        context,
      ),
    ]);
    expect(runtime.acquireCalls).toEqual(["isolated"]);
    await service.close();
  });

  test("evicts every generation-bound mode after transport death and reacquires on the same MCP connection", async () => {
    let call = 0;
    const { runtime, service } = await createFixture(async (options) => {
      call += 1;
      return success(options, [["call", call]], copyJsonValue(options.request.state));
    });
    const context = toolContext(toolSession("broker-reconnect"));

    const first = await service.handlers.runPlaywright(
      { args: {}, browser: "shared", code: "return chrome.listSessionStateEntries()", timeoutMs: 1000 },
      context,
    );
    expect(structured(first).value).toEqual([]);
    const firstHeadless = await service.handlers.runPlaywright(
      {
        args: {},
        browser: "shared-headless",
        code: "return chrome.listSessionStateEntries()",
        timeoutMs: 1000,
      },
      context,
    );
    expect(structured(firstHeadless).value).toEqual([]);
    const firstSession = runtime.sessions.get("broker-reconnect\0shared");
    const firstHeadlessSession = runtime.sessions.get("broker-reconnect\0shared-headless");
    if (!firstSession || !firstHeadlessSession) throw new Error("Expected both fake broker sessions");
    runtime.disconnectConnection("broker-reconnect");

    const second = await service.handlers.runPlaywright(
      { args: {}, browser: "shared", code: "return chrome.listSessionStateEntries()", timeoutMs: 1000 },
      context,
    );
    const secondHeadless = await service.handlers.runPlaywright(
      {
        args: {},
        browser: "shared-headless",
        code: "return chrome.listSessionStateEntries()",
        timeoutMs: 1000,
      },
      context,
    );
    expect(structured(second).value).toEqual([]);
    expect(structured(secondHeadless).value).toEqual([]);
    expect(runtime.acquireCalls).toEqual(["shared", "shared-headless", "shared", "shared-headless"]);
    expect(runtime.sessions.get("broker-reconnect\0shared")).not.toBe(firstSession);
    expect(runtime.sessions.get("broker-reconnect\0shared-headless")).not.toBe(firstHeadlessSession);

    await service.close();
  });

  test("isolates helper state and selection across all browser modes", async () => {
    const kernel: ChromeExecutionKernel = async (options) => {
      const prior = copyJsonValue(options.request.state);
      await options.adapter.execute(
        { operation: "select_page", payload: { targetId: `${options.request.browserMode}-next` } },
        rpcContext(),
      );
      return {
        ...success(options, [["mode", options.request.browserMode]], prior),
        selectedTargetId: `${options.request.browserMode}-next`,
      };
    };
    const { service } = await createFixture(kernel);
    const context = toolContext(toolSession("modes"));
    const browserInstances: BrowserSelection[] = [
      { browser: "isolated" },
      { browser: "isolated-headless", browserInstanceId: "modes" },
      { browser: "isolated-virtual-display", browserInstanceId: "modes", nativeDeviceScaleFactor: 1.296_875 },
      { browser: "shared" },
      { browser: "shared-headless" },
      { browser: "main" },
    ];

    for (const browserInstance of browserInstances) {
      await service.handlers.runPlaywright(
        { args: {}, ...browserInstance, code: "return null", timeoutMs: 1000 },
        context,
      );
    }
    for (const browserInstance of browserInstances) {
      const result = await service.handlers.runPlaywright(
        { args: {}, ...browserInstance, code: "return chrome.listSessionStateEntries()", timeoutMs: 1000 },
        context,
      );
      expect(structured(result).value).toEqual([["mode", browserInstance.browser]]);
      expect(structured(result).selectedTargetId).toBe(`${browserInstance.browser}-next`);
    }
    await service.close();
  });

  test("prints each failure once while preserving useful stack frames", async () => {
    for (const frames of [
      undefined,
      "",
      "    at run (chrome-mcp-user-code.js:2:3)\n    at click (/playwright-core/client.js:4:5)",
    ]) {
      const stackText = frames ? `\n${frames}` : "";
      const { service } = await createFixture(async (options) => ({
        ...failure(options),
        error: {
          code: "CHROME_MCP_INVALID_INPUT",
          message: "scripted failure",
          name: "ChromeMcpExecutionError",
          ...(frames === undefined ? {} : { stack: `ChromeMcpExecutionError: scripted failure${stackText}` }),
        },
      }));
      try {
        const result = await service.handlers.runPlaywright(
          { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
          toolContext(toolSession("single-error")),
        );
        expect(result.content).toEqual([
          {
            type: "text",
            text: `CHROME_MCP_INVALID_INPUT: scripted failure${stackText}`,
          },
        ]);
        expect(structured(result).error).toEqual({
          code: "CHROME_MCP_INVALID_INPUT",
          message: "scripted failure",
          name: "ChromeMcpExecutionError",
        });
      } finally {
        await service.close();
      }
    }
  });

  test("keeps published artifacts in a normalized failure envelope", async () => {
    const kernel: ChromeExecutionKernel = async (options) => {
      const published = await options.adapter.execute(
        {
          operation: "artifact_publish",
          payload: {
            data: "evidence",
            encoding: "utf8",
            mediaType: "text/plain",
            name: "evidence.txt",
          },
        },
        rpcContext(),
      );
      expect(published.artifacts).toHaveLength(1);
      return {
        ...failure(options),
        partialContent: [
          { text: "measurements before failure", type: "text" },
          {
            data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
            mediaType: "image/png",
            type: "image",
          },
        ],
        partialEmittedCount: 2,
        partialOmittedCount: 1,
      };
    };
    const { service } = await createFixture(kernel);
    const context = toolContext(toolSession("artifact-error"));
    const result = await service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "throw new Error()", timeoutMs: 1000 },
      context,
    );
    const envelope = structured(result);
    expect(result.isError).toBe(true);
    expect(envelope.error).toMatchObject({
      code: "CHROME_MCP_INVALID_INPUT",
      name: "ChromeMcpExecutionError",
    });
    expect(envelope.partialEmittedCount).toBe(2);
    expect(envelope.partialOmittedCount).toBe(1);
    expect(Array.isArray(envelope.artifacts)).toBe(true);
    if (!Array.isArray(envelope.artifacts) || !isRecord(envelope.artifacts[0])) {
      throw new Error("Expected artifact envelope");
    }
    expect(envelope.artifacts[0].expiresAt).toBeNull();
    expect(result.content[0]?.type).toBe("text");
    expect(result.content.slice(1, 3)).toEqual([
      { text: "measurements before failure", type: "text" },
      {
        data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
        mimeType: "image/png",
        type: "image",
      },
    ]);
    expect(result.content.at(-1)?.type).toBe("resource_link");
    await service.closeConnection(context);
    await service.close();
  });

  test("preserves published evidence and the original failure when admission cleanup fails", async () => {
    const fixture = await createFixture(async (options) => {
      await options.adapter.execute(
        {
          operation: "artifact_publish",
          payload: {
            data: "captured evidence",
            encoding: "utf8",
            mediaType: "text/plain",
            name: "evidence.txt",
          },
        },
        rpcContext(),
      );
      return {
        ...failure(options),
        partialContent: [{ type: "text", text: "measurement before failure" }],
        partialEmittedCount: 1,
        partialOmittedCount: 0,
      };
    });
    const session = await fixture.runtime.acquire("admission-failure", "isolated");
    session.admissionCloseFailure = new ChromeMcpExecutionError(
      "CHROME_MCP_TIMEOUT",
      "Execution termination could not be confirmed",
    );

    try {
      const result = await fixture.service.handlers.runPlaywright(
        { args: {}, browser: "isolated", code: "throw new Error()", timeoutMs: 1000 },
        toolContext(toolSession("admission-failure")),
      );
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        ok: false,
        artifacts: [expect.objectContaining({ name: "evidence.txt" })],
        error: {
          code: "CHROME_MCP_INVALID_INPUT",
          message: expect.stringMatching(
            /scripted failure.*CHROME_MCP_TIMEOUT: Execution termination could not be confirmed/u,
          ),
        },
        partialEmittedCount: 1,
        partialOmittedCount: 0,
        selectedTargetId: "isolated-initial",
      });
      expect(result.content).toContainEqual({ type: "text", text: "measurement before failure" });
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "resource_link", name: "evidence.txt" }),
      );
    } finally {
      await fixture.service.close();
    }
  });

  test("retains completed output and artifacts when admission cleanup turns success into failure", async () => {
    const fixture = await createFixture(async (options) => {
      await options.adapter.execute(
        {
          operation: "artifact_publish",
          payload: {
            data: "completed evidence",
            encoding: "utf8",
            mediaType: "text/plain",
            name: "completed.txt",
          },
        },
        rpcContext(),
      );

      return {
        ...success(options, [], { measuredMs: 42 }),
        content: [{ type: "text", text: "completed measurement" }],
        emittedCount: 1,
      };
    });
    const session = await fixture.runtime.acquire("admission-success", "isolated");
    session.admissionCloseFailure = new ChromeMcpExecutionError(
      "CHROME_MCP_TIMEOUT",
      "Execution termination could not be confirmed",
    );

    try {
      const result = await fixture.service.handlers.runPlaywright(
        { args: {}, browser: "isolated", code: "return true", timeoutMs: 1000 },
        toolContext(toolSession("admission-success")),
      );
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        ok: false,
        artifacts: [expect.objectContaining({ name: "completed.txt" })],
        error: { code: "CHROME_MCP_TIMEOUT" },
        selectedTargetId: "isolated-initial",
      });
      expect(result.content).toContainEqual({ type: "text", text: "completed measurement" });
      expect(result.content).toContainEqual({ type: "text", text: '{"measuredMs":42}' });
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "resource_link", name: "completed.txt" }),
      );
    } finally {
      await fixture.service.close();
    }
  });

  test("publishes a helper file outside the session base cwd", async () => {
    let sourcePath = "";
    const { root, service } = await createFixture(async (options) => {
      await options.adapter.execute(
        { operation: "artifact_file", payload: { path: sourcePath } },
        rpcContext(),
      );
      return success(options, []);
    });
    const outside = await mkdtemp(join(tmpdir(), "chrome-service-outside-"));
    roots.push(outside);
    sourcePath = join(outside, "external-artifact.txt");
    await writeFile(sourcePath, "external artifact");
    const context = toolContext(toolSession("artifact-path", root));
    const result = await service.handlers.runPlaywright(
      {
        args: {},
        browser: "isolated",
        code: "return await chrome.publishFileArtifact(args.path)",
        timeoutMs: 1000,
      },
      context,
    );
    expect(result.isError).not.toBe(true);
    expect(structured(result).artifacts).toHaveLength(1);
    await service.close();
  });

  test("returns published artifacts in the normalized success envelope", async () => {
    const kernel: ChromeExecutionKernel = async (options) => {
      const published = await options.adapter.execute(
        {
          operation: "artifact_publish",
          payload: {
            data: "success",
            encoding: "utf8",
            mediaType: "text/plain",
            name: "success.txt",
          },
        },
        rpcContext(),
      );
      const artifact = published.artifacts?.[0];
      if (!artifact) throw new Error("Expected the fake publication to return an artifact");
      return {
        ...success(options, []),
        artifacts: [artifact],
        content: [{ artifact, type: "resource" }],
        emittedCount: 1,
      };
    };
    const { service } = await createFixture(kernel);
    const context = toolContext(toolSession("artifact-success"));
    const result = await service.handlers.runPlaywright(
      {
        args: {},
        browser: "isolated",
        code: "return await chrome.publishFileArtifact('success.txt')",
        timeoutMs: 1000,
      },
      context,
    );
    const envelope = structured(result);
    expect(result.isError).toBeUndefined();
    expect(envelope.ok).toBe(true);
    if (!Array.isArray(envelope.artifacts) || !isRecord(envelope.artifacts[0])) {
      throw new Error("Expected artifact envelope");
    }
    expect(envelope.artifacts[0].expiresAt).toBeNull();
    expect(result.content).toEqual([
      expect.objectContaining({ mimeType: "text/plain", name: "success.txt", type: "resource_link" }),
    ]);
    await service.close();
  });

  test("rejects worker artifacts absent from or inconsistent with this call ledger", async () => {
    const forged: ArtifactDescriptor = {
      artifactId: "forged",
      complete: true,
      createdAt: "2026-08-15T00:00:00.000Z",
      expiresAt: null,
      mediaType: "text/plain",
      name: "forged.txt",
      sha256: "forged-digest",
      size: 6,
      uri: "artifact://forged/forged.txt",
    };
    const { service } = await createFixture(async (options) => {
      const args = requestAction(options);
      if (args.action === "inspect") {
        return success(options, options.request.state, copyJsonValue(options.request.state));
      }
      if (args.action === "content") {
        return {
          ...success(options, [["forged", true]]),
          content: [{ artifact: forged, type: "resource" }],
          emittedCount: 1,
        };
      }
      if (args.action === "value") {
        return {
          ...success(options, [["forged", true]]),
          valueArtifact: forged,
        };
      }
      if (args.action === "tampered") {
        const published = await options.adapter.execute(
          {
            operation: "artifact_publish",
            payload: {
              data: "ledger",
              encoding: "utf8",
              mediaType: "text/plain",
              name: "ledger.txt",
            },
          },
          rpcContext(),
        );
        const artifact = published.artifacts?.[0];
        if (!artifact) throw new Error("Expected ledger artifact");
        return {
          ...success(options, [["forged", true]]),
          artifacts: [{ ...artifact, size: artifact.size + 1 }],
        };
      }
      return {
        ...success(options, [["forged", true]]),
        artifacts: [forged],
      };
    });
    const context = toolContext(toolSession("artifact-provenance"));
    const forgedCases: (readonly [string, number])[] = [
      ["list", 0],
      ["content", 0],
      ["value", 0],
      ["tampered", 1],
    ];
    for (const [action, publishedCount] of forgedCases) {
      const result = await service.handlers.runPlaywright(
        { args: { action }, browser: "isolated", code: "return forged", timeoutMs: 1000 },
        context,
      );
      const envelope = structured(result);
      expect(result.isError).toBe(true);
      expect(envelope.error).toEqual(
        expect.objectContaining({
          code: "CHROME_MCP_WORKER_CRASH",
        }),
      );
      expect(envelope.artifacts).toHaveLength(publishedCount);
      expect(result.content.filter((item) => item.type === "resource_link")).toHaveLength(publishedCount);
    }

    const inspect = await service.handlers.runPlaywright(
      {
        args: { action: "inspect" },
        browser: "isolated",
        code: "return chrome.listSessionStateEntries()",
        timeoutMs: 1000,
      },
      context,
    );
    expect(structured(inspect).value).toEqual([]);
    await service.close();
  });

  test("keeps Playwright trace capture active across calls and publishes its artifact", async () => {
    const traceCalls: string[] = [];
    let tracePath = "";
    const tracingResolver: PlaywrightTracingResolver = {
      tracing: async (contextId) => ({
        start: async () => {
          traceCalls.push(`start:${contextId}`);
        },
        stop: async ({ path }) => {
          tracePath = path;
          traceCalls.push(`stop:${contextId}`);
          await writeFile(path, "trace archive");
        },
      }),
    };
    let captureId = "";
    const kernel: ChromeExecutionKernel = async (options) => {
      const args = requestAction(options);
      if (args.action === "start") {
        const response = await options.adapter.execute(
          { operation: "capture_start", payload: { options: { type: "trace" } } },
          rpcContext(),
        );
        if (!isRecord(response.value) || typeof response.value.captureId !== "string") {
          throw new Error("Expected trace capture ID");
        }
        captureId = response.value.captureId;
        return success(options, [], response.value);
      }
      const response = await options.adapter.execute(
        { operation: "capture_stop", payload: { captureId } },
        rpcContext(),
      );
      const artifacts = response.artifacts ?? [];
      return {
        ...success(options, [], response.value),
        artifacts,
        content: artifacts.map((artifact) => ({ artifact, type: "resource" })),
        emittedCount: artifacts.length,
      };
    };
    const { service } = await createFixture(kernel, { capture: { tracingResolver } });
    const context = toolContext(toolSession("trace-capture"));

    const started = await service.handlers.runPlaywright(
      {
        args: { action: "start" },
        browser: "isolated",
        code: "return await chrome.capture.start(args)",
        timeoutMs: 1000,
      },
      context,
    );
    expect(structured(started).value).toEqual(expect.objectContaining({ type: "trace" }));
    const stopped = await service.handlers.runPlaywright(
      {
        args: { action: "stop" },
        browser: "isolated",
        code: "return await chrome.capture.stop(args.id)",
        timeoutMs: 1000,
      },
      context,
    );
    expect(traceCalls).toEqual(["start:owner-isolated-trace-capture", "stop:owner-isolated-trace-capture"]);
    expect(structured(stopped).artifacts).toHaveLength(1);
    expect(stopped.content.filter((item) => item.type === "resource_link")).toEqual([
      expect.objectContaining({ mimeType: "application/zip", type: "resource_link" }),
    ]);
    const captureRoot = dirname(dirname(tracePath));
    expect(await pathExists(captureRoot)).toBeTrue();
    await service.close();
    expect(await pathExists(captureRoot)).toBeFalse();
  });

  test("classifies probed CDP methods from rebuilt broker command errors", async () => {
    let reportedCdpSupport: JsonValue | undefined;
    const kernel: ChromeExecutionKernel = async (options) => {
      reportedCdpSupport = options.request.capabilities.cdp;
      return success(options, []);
    };
    const probeResponses = new Map<string, () => Promise<unknown>>(
      CHROME_CAPABILITY_CDP_METHODS.map((method) => [method, () => Promise.resolve({})]),
    );
    probeResponses.set("Network.getResponseBody", () =>
      Promise.reject(new CdpCommandError("Invalid parameters", -32_602)),
    );
    probeResponses.set("Page.startScreencast", () =>
      Promise.reject(new CdpCommandError("'Page.startScreencast' wasn't found", CDP_METHOD_NOT_FOUND)),
    );
    const { service } = await createFixture(kernel, {
      configureRuntime: (runtime) => {
        runtime.cdpProbeResponses = probeResponses;
      },
    });
    const context = toolContext(toolSession("probed-capabilities"));
    await service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return 1", timeoutMs: 1000 },
      context,
    );

    expect(reportedCdpSupport).toMatchObject({
      "Network.getResponseBody": true,
      "Page.startScreencast": false,
    });
    await service.close();
  });

  test("probes ffmpeg and publishes a cross-call WebM capture when supported", async () => {
    const supportedExecutables: string[] = [];
    const processes: FfmpegProcessFactory = {
      supported: (executable) => {
        supportedExecutables.push(executable);
        return Promise.resolve(true);
      },
      start: (_executable, outputPath) => {
        const exit = Promise.withResolvers<number>();
        return {
          closeInput: async () => {
            await writeFile(outputPath, "webm video");
            exit.resolve(0);
          },
          errorText: () => Promise.resolve(""),
          exited: exit.promise,
          terminate: () => exit.resolve(1),
          write: () => Promise.resolve(),
        };
      },
    };
    let captureId = "";
    let reportedVideoSupport: JsonValue | undefined;
    const kernel: ChromeExecutionKernel = async (options) => {
      const args = requestAction(options);
      const captures =
        isRecord(options.request.capabilities.captures) ? options.request.capabilities.captures : undefined;
      const video = captures && isRecord(captures.video) ? captures.video : undefined;
      reportedVideoSupport = video?.supported;
      if (args.action === "start") {
        const response = await options.adapter.execute(
          { operation: "capture_start", payload: { options: { type: "video" } } },
          rpcContext(),
        );
        if (!isRecord(response.value) || typeof response.value.captureId !== "string") {
          throw new Error("Expected video capture ID");
        }
        captureId = response.value.captureId;
        return success(options, [], response.value);
      }
      const response = await options.adapter.execute(
        { operation: "capture_stop", payload: { captureId } },
        rpcContext(),
      );
      const artifacts = response.artifacts ?? [];
      return {
        ...success(options, [], response.value),
        artifacts,
        content: artifacts.map((artifact) => ({ artifact, type: "resource" })),
        emittedCount: artifacts.length,
      };
    };
    const { service } = await createFixture(kernel, {
      capture: { ffmpegExecutable: "test-ffmpeg", ffmpegProcesses: processes },
      configureRuntime: (runtime) => runtime.supportedMethods.add("Page.startScreencast"),
    });
    const context = toolContext(toolSession("video-capture"));
    await service.handlers.runPlaywright(
      {
        args: { action: "start" },
        browser: "isolated",
        code: "return await chrome.capture.start(args)",
        timeoutMs: 1000,
      },
      context,
    );
    const stopped = await service.handlers.runPlaywright(
      {
        args: { action: "stop" },
        browser: "isolated",
        code: "return await chrome.capture.stop(args.id)",
        timeoutMs: 1000,
      },
      context,
    );

    expect(reportedVideoSupport).toBe(true);
    expect(supportedExecutables).toEqual(["test-ffmpeg"]);
    expect(structured(stopped).artifacts).toHaveLength(1);
    expect(stopped.content.filter((item) => item.type === "resource_link")).toEqual([
      expect.objectContaining({ mimeType: "video/webm", type: "resource_link" }),
    ]);
    await service.close();
  });

  test("captures descendant OOPIF response bodies from the active target across calls", async () => {
    let captureId = "";
    const fixture = await createFixture(async (options) => {
      const args = requestAction(options);
      if (args.action === "start") {
        const response = await options.adapter.execute(
          { operation: "capture_start", payload: { options: { type: "network-bodies" } } },
          rpcContext(),
        );
        if (!isRecord(response.value) || typeof response.value.captureId !== "string") {
          throw new Error("Expected network capture ID");
        }
        captureId = response.value.captureId;
        return success(options, [], response.value);
      }
      if (args.action === "traffic") {
        const session = fixture.runtime.sessions.get("network-capture\0isolated");
        if (!session) throw new Error("Expected active network runtime session");
        session.setNetworkTarget("oopif-network-session", "oopif-target", session.currentTarget().targetId);
        await session.emitNetworkExchange("oopif-network-session");
        return success(options, []);
      }
      const response = await options.adapter.execute(
        { operation: "capture_stop", payload: { captureId } },
        rpcContext(),
      );
      const artifacts = response.artifacts ?? [];
      return {
        ...success(options, [], response.value),
        artifacts,
        content: artifacts.map((artifact) => ({ artifact, type: "resource" })),
        emittedCount: artifacts.length,
      };
    });

    const context = toolContext(toolSession("network-capture"));
    await fixture.service.handlers.runPlaywright(
      {
        args: { action: "start" },
        browser: "isolated",
        code: "return await chrome.capture.start(args)",
        timeoutMs: 1000,
      },
      context,
    );
    await fixture.service.handlers.runPlaywright(
      { args: { action: "traffic" }, browser: "isolated", code: "await page.reload()", timeoutMs: 1000 },
      context,
    );
    const stopped = await fixture.service.handlers.runPlaywright(
      {
        args: { action: "stop" },
        browser: "isolated",
        code: "return await chrome.capture.stop(args.id)",
        timeoutMs: 1000,
      },
      context,
    );

    const stoppedEnvelope = structured(stopped);
    expect(stoppedEnvelope.artifacts).toHaveLength(2);
    expect(stopped.content.filter((item) => item.type === "resource_link")).toHaveLength(2);
    if (!Array.isArray(stoppedEnvelope.artifacts)) throw new Error("Expected network artifacts");
    for (const artifact of stoppedEnvelope.artifacts) {
      expect(isRecord(artifact) && artifact.expiresAt === null).toBe(true);
    }
    await fixture.service.close();
  });

  test("accepts an explicit diagnostic path outside the session base cwd", async () => {
    const { root, service } = await createFixture(async (options) => success(options, []));
    const context = toolContext(toolSession("diagnostic-paths", root));
    const outside = await mkdtemp(join(tmpdir(), "chrome-service-diagnostics-outside-"));
    roots.push(outside);
    const tracePath = join(outside, "trace.json");

    await service.handlers.performanceStartTrace(
      {
        autoStop: false,
        browser: "isolated",
        reload: false,
      },
      context,
    );
    const stopped = await service.handlers.performanceStopTrace(
      { browser: "isolated", filePath: tracePath },
      context,
    );

    expect(JSON.stringify(stopped)).toContain(tracePath);
    expect(await pathExists(tracePath)).toBe(true);
    await service.close();
  });

  test("publishes session resources and releases them through lifecycle hooks", async () => {
    const kernel: ChromeExecutionKernel = async (options) => {
      const published = await options.adapter.execute(
        {
          operation: "artifact_publish",
          payload: {
            data: "lifecycle",
            encoding: "utf8",
            mediaType: "text/plain",
            name: "lifecycle.txt",
          },
        },
        rpcContext(),
      );
      return { ...success(options, []), artifacts: published.artifacts ?? [] };
    };
    const { service } = await createFixture(kernel);
    const session = toolSession("lifecycle");
    const secondSession = toolSession("lifecycle-second");
    const context = toolContext(session);
    const notified = Promise.withResolvers<void>();
    let firstNotifications = 0;
    let secondNotifications = 0;
    const onConnect = service.sessionLifecycle.onConnect;
    const onClose = service.sessionLifecycle.onClose;
    if (!onConnect || !onClose) throw new Error("Expected complete session lifecycle hooks");
    expect(() =>
      onConnect({
        connectionId: "mismatched",
        notifyResourcesListChanged: () => Promise.resolve(),
        session,
      }),
    ).toThrow();
    await onConnect({
      connectionId: session.connectionId,
      notifyResourcesListChanged: () => {
        firstNotifications += 1;
        notified.resolve();
        return Promise.resolve();
      },
      session,
    });
    await onConnect({
      connectionId: secondSession.connectionId,
      notifyResourcesListChanged: () => {
        secondNotifications += 1;
        return Promise.resolve();
      },
      session: secondSession,
    });

    await service.handlers.runPlaywright(
      { args: {}, browser: "isolated", code: "return null", timeoutMs: 1000 },
      context,
    );
    await notified.promise;
    expect(firstNotifications).toBe(1);
    expect(secondNotifications).toBe(0);
    const resources = await service.sessionResources(session);
    expect(resources).toHaveLength(1);
    expect(resources[0]?.uri).toContain("/manifest");
    expect(service.artifactOwner(session, undefined)).toEqual(service.artifactConnection(context));
    expect(() => service.artifactOwner(toolSession("foreign"), undefined)).toThrow(
      "has not acquired artifact ownership",
    );

    await onClose({
      connectionId: session.connectionId,
      notifyResourcesListChanged: () => Promise.resolve(),
      session,
    });
    expect(() => service.artifactOwner(session, undefined)).toThrow();
    await onClose({
      connectionId: secondSession.connectionId,
      notifyResourcesListChanged: () => Promise.resolve(),
      session: secondSession,
    });
    await service.close();
  });

  test("keeps native scale immutable across concurrent and later virtual-display calls", async () => {
    const { service, runtime } = await createFixture(async (options) => success(options, []));
    const context = toolContext(toolSession("native-scale"));
    const input = {
      args: {},
      browser: "isolated-virtual-display",
      browserInstanceId: "desktop",
      nativeDeviceScaleFactor: 1.296_875,
      code: "return 1",
      timeoutMs: 1000,
    } as const;

    try {
      const [first, conflicting] = await Promise.all([
        service.handlers.runPlaywright(input, context),
        service.handlers.runPlaywright({ ...input, nativeDeviceScaleFactor: 2 }, context),
      ]);
      expect(structured(first)).toMatchObject({
        ok: true,
        rendering: {
          profile: "virtual-display",
          nativeDeviceScaleFactor: 1.296_875,
          devicePixelRatio: 1.296_875,
          pageZoom: 1,
        },
      });
      expect(structured(conflicting)).toMatchObject({
        ok: false,
        error: { code: "CHROME_MCP_INVALID_INPUT" },
      });

      const reused = await service.handlers.runPlaywright(input, context);
      expect(structured(reused).selectedTargetId).toBe(structured(first).selectedTargetId);
      expect(runtime.acquireCalls).toEqual(["isolated-virtual-display"]);

      const changed = await service.handlers.runPlaywright({ ...input, nativeDeviceScaleFactor: 2 }, context);
      expect(structured(changed)).toMatchObject({ ok: false, error: { code: "CHROME_MCP_INVALID_INPUT" } });
    } finally {
      await service.close();
    }
  });

  test("closes an idle virtual-display owner before acquiring its replacement", async () => {
    const scheduler = createIdleShutdownScheduler();
    const { service, runtime } = await createFixture(async (options) => success(options, []), {
      scheduleIdleShutdown: scheduler.schedule,
    });
    const context = toolContext(toolSession("virtual-display-idle"));
    const input = {
      args: {},
      browser: "isolated-virtual-display",
      browserInstanceId: "desktop",
      nativeDeviceScaleFactor: 1.296_875,
      code: "return 1",
      timeoutMs: 1000,
    } as const;

    try {
      expect(structured(await service.handlers.runPlaywright(input, context)).ok).toBeTrue();

      const initial = runtime.sessions.get("virtual-display-idle\0isolated-virtual-display\0desktop");
      assert(initial);

      const [timer] = scheduler.armed();
      assert(timer);

      timer.fire();
      expect(initial.closed).toBeTrue();
      expect(structured(await service.handlers.runPlaywright(input, context)).ok).toBeTrue();
      expect(runtime.sessions.get("virtual-display-idle\0isolated-virtual-display\0desktop")).not.toBe(
        initial,
      );
    } finally {
      await service.close();
    }
  });

  test("closes an idle isolated-headless browser and recovers a fresh owner on the next call", async () => {
    const scheduler = createIdleShutdownScheduler();
    const { runtime, service } = await createFixture(async (options) => success(options, []), {
      scheduleIdleShutdown: scheduler.schedule,
    });
    const context = toolContext(toolSession("idle-shutdown"));

    await service.handlers.runPlaywright(
      {
        args: {},
        browser: "isolated-headless",
        browserInstanceId: "idle",
        code: "return 1",
        timeoutMs: 1000,
      },
      context,
    );
    const firstSession = runtime.sessions.get("idle-shutdown\0isolated-headless\0idle");
    expect(firstSession?.closed).toBeFalse();

    const armed = scheduler.armed();
    expect(armed).toHaveLength(1);
    expect(armed[0]?.delayMs).toBe(30 * 60_000);

    armed[0]?.fire();
    expect(firstSession?.closed).toBeTrue();

    const recovered = await service.handlers.runPlaywright(
      {
        args: {},
        browser: "isolated-headless",
        browserInstanceId: "idle",
        code: "return 2",
        timeoutMs: 1000,
      },
      context,
    );
    expect(structured(recovered).ok).toBeTrue();
    expect(runtime.acquireCalls).toEqual(["isolated-headless", "isolated-headless"]);
    expect(runtime.sessions.get("idle-shutdown\0isolated-headless\0idle")).not.toBe(firstSession);
    await service.close();
  });

  test("runs distinct reusable isolated-headless browser instances concurrently", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    const endpointsById = new Map<string, string>();
    const kernel: ChromeExecutionKernel = async (options) => {
      const id = String(requestAction(options).id);
      endpointsById.set(id, options.request.cdpEndpoint);
      if (id === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      if (id === "second") {
        secondStarted.resolve();
        await releaseSecond.promise;
      }
      return success(options, []);
    };
    const { runtime, service } = await createFixture(kernel, {
      configureRuntime: (configuredRuntime) => {
        configuredRuntime.rejectOverlappingAdmissions = true;
      },
    });
    const context = toolContext(toolSession("isolated-headless-overlap"));

    const first = service.handlers.runPlaywright(
      {
        args: { id: "first" },
        browser: "isolated-headless",
        browserInstanceId: "first",
        code: "return 1",
        timeoutMs: 1000,
      },
      context,
    );
    await firstStarted.promise;
    const second = service.handlers.runPlaywright(
      {
        args: { id: "second" },
        browser: "isolated-headless",
        browserInstanceId: "second",
        code: "return 2",
        timeoutMs: 1000,
      },
      context,
    );
    await secondStarted.promise;
    const thirdResult = await service.handlers.runPlaywright(
      {
        args: { id: "third" },
        browser: "isolated-headless",
        browserInstanceId: "third",
        code: "return 3",
        timeoutMs: 1000,
      },
      context,
    );
    releaseSecond.resolve();
    releaseFirst.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(structured(firstResult).ok).toBeTrue();
    expect(structured(secondResult).ok).toBeTrue();
    expect(structured(thirdResult).ok).toBeTrue();
    expect(new Set(endpointsById.values()).size).toBe(3);
    expect(runtime.acquireCalls).toEqual(["isolated-headless", "isolated-headless", "isolated-headless"]);
    const firstEndpoint = endpointsById.get("first");
    const reused = await service.handlers.runPlaywright(
      {
        args: { id: "first-reused" },
        browser: "isolated-headless",
        browserInstanceId: "first",
        code: "return 4",
        timeoutMs: 1000,
      },
      context,
    );
    expect(structured(reused).ok).toBeTrue();
    expect(endpointsById.get("first-reused")).toBe(firstEndpoint);
    expect(runtime.acquireCalls).toHaveLength(3);
    const namedSessions = [...runtime.sessions.entries()]
      .filter(([key]) => key.startsWith("isolated-headless-overlap\0isolated-headless\0"))
      .map(([, session]) => session);
    expect(namedSessions).toHaveLength(3);
    expect(namedSessions.every((session) => !session.closed)).toBeTrue();
    await service.close();
  });

  test("recovers one isolated-headless instance without finalizing a sibling capture", async () => {
    const captureIds = new Map<string, string>();
    const kernel: ChromeExecutionKernel = async (options) => {
      const args = requestAction(options);
      const id = String(args.id);
      if (args.action === "start") {
        const response = await options.adapter.execute(
          { operation: "capture_start", payload: { options: { type: "har" } } },
          rpcContext(),
        );
        if (!isRecord(response.value) || typeof response.value.captureId !== "string") {
          throw new Error("Expected HAR capture ID");
        }
        captureIds.set(id, response.value.captureId);
        return success(options, [], response.value);
      }
      const captureId = captureIds.get(args.action === "stop-foreign" ? "first" : id);
      if (!captureId) throw new Error(`Expected capture for ${id}`);
      const response = await options.adapter.execute(
        { operation: "capture_stop", payload: { captureId } },
        rpcContext(),
      );
      const artifacts = response.artifacts ?? [];
      return {
        ...success(options, [], response.value),
        artifacts,
        content: artifacts.map((artifact) => ({ artifact, type: "resource" })),
        emittedCount: artifacts.length,
      };
    };
    const { runtime, service } = await createFixture(kernel);
    const context = toolContext(toolSession("isolated-headless-capture-recovery"));
    const run = (id: string, action: "start" | "stop") =>
      service.handlers.runPlaywright(
        {
          args: { action, id },
          browser: "isolated-headless",
          browserInstanceId: id,
          code: `return await chrome.capture.${action}(args)`,
          timeoutMs: 1000,
        },
        context,
      );
    await run("first", "start");
    await run("second", "start");
    const foreignStop = await service.handlers.runPlaywright(
      {
        args: { action: "stop-foreign", id: "second" },
        browser: "isolated-headless",
        browserInstanceId: "second",
        code: "return await chrome.capture.stop(args.captureId)",
        timeoutMs: 1000,
      },
      context,
    );
    expect(structured(foreignStop).error).toMatchObject({ code: "CHROME_MCP_INVALID_INPUT" });
    const firstSession = runtime.sessions.get("isolated-headless-capture-recovery\0isolated-headless\0first");
    if (!firstSession) throw new Error("Expected the first isolated-headless session");
    firstSession.disconnect();

    const stopped = await run("second", "stop");

    expect(structured(stopped)).toMatchObject({
      ok: true,
      value: { status: "completed", type: "har" },
    });
    expect(
      runtime.sessions.get("isolated-headless-capture-recovery\0isolated-headless\0second")?.closed,
    ).toBeFalse();
    await service.close();
  });

  test("recovers one isolated-headless instance without discarding a sibling performance trace", async () => {
    const { runtime, service } = await createFixture(async (options) => success(options, []));
    const context = toolContext(toolSession("isolated-headless-trace-recovery"));
    await service.handlers.runPlaywright(
      {
        args: {},
        browser: "isolated-headless",
        browserInstanceId: "first",
        code: "return true",
        timeoutMs: 1000,
      },
      context,
    );
    await service.handlers.performanceStartTrace(
      {
        autoStop: false,
        browser: "isolated-headless",
        browserInstanceId: "second",
        reload: false,
      },
      context,
    );
    const firstSession = runtime.sessions.get("isolated-headless-trace-recovery\0isolated-headless\0first");
    if (!firstSession) throw new Error("Expected the first isolated-headless session");
    firstSession.disconnect();

    const stopped = await service.handlers.performanceStopTrace(
      { browser: "isolated-headless", browserInstanceId: "second" },
      context,
    );

    expect(stopped.structuredContent).toMatchObject({
      message: expect.stringContaining("The performance trace has been stopped."),
    });
    await service.close();
  });

  test("uses a healthy isolated-headless instance while a disconnected sibling is still recovering", async () => {
    const releaseRecovery = Promise.withResolvers<void>();
    const { runtime, service } = await createFixture(async (options) => success(options, []));
    const context = toolContext(toolSession("isolated-headless-independent-recovery"));
    const run = (browserInstanceId: string) =>
      service.handlers.runPlaywright(
        {
          args: {},
          browser: "isolated-headless",
          browserInstanceId,
          code: "return true",
          timeoutMs: 1000,
        },
        context,
      );
    await run("first");
    await run("second");
    const firstSession = runtime.sessions.get(
      "isolated-headless-independent-recovery\0isolated-headless\0first",
    );
    if (!firstSession) throw new Error("Expected the first isolated-headless session");
    firstSession.closeGate = releaseRecovery.promise;
    firstSession.disconnect();

    const secondResult = await run("second");

    expect(structured(secondResult).ok).toBeTrue();
    expect(
      runtime.sessions.get("isolated-headless-independent-recovery\0isolated-headless\0second")?.closed,
    ).toBeFalse();
    releaseRecovery.resolve();
    await service.close();
  }, 2000);

  test("queues overlapping calls for the same isolated-headless browser instance", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const kernel: ChromeExecutionKernel = async (options) => {
      if (requestAction(options).id === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return success(options, []);
    };
    const { runtime, service } = await createFixture(kernel, {
      configureRuntime: (configuredRuntime) => {
        configuredRuntime.rejectOverlappingAdmissions = true;
      },
    });
    const context = toolContext(toolSession("isolated-headless-queue"));
    const first = service.handlers.runPlaywright(
      {
        args: { id: "first" },
        browser: "isolated-headless",
        browserInstanceId: "reusable",
        code: "return 1",
        timeoutMs: 1000,
      },
      context,
    );
    await firstStarted.promise;
    const second = service.handlers.runPlaywright(
      {
        args: { id: "second" },
        browser: "isolated-headless",
        browserInstanceId: "reusable",
        code: "return 2",
        timeoutMs: 1000,
      },
      context,
    );
    let secondSettled = false;
    second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(secondSettled).toBeFalse();
    releaseFirst.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(structured(firstResult).ok).toBeTrue();
    expect(structured(secondResult).ok).toBeTrue();
    expect(runtime.acquireInstanceCalls).toEqual([
      { browserInstanceId: "reusable", connectionId: "isolated-headless-queue", mode: "isolated-headless" },
    ]);
    expect(runtime.sessions.get("isolated-headless-queue\0isolated-headless\0reusable")?.closed).toBeFalse();
    await service.close();
  });

  test("disarms the idle timer while a call is admitted and rearms it on completion", async () => {
    const scheduler = createIdleShutdownScheduler();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const kernel: ChromeExecutionKernel = async (options) => {
      if (requestAction(options).action === "block") {
        started.resolve();
        await release.promise;
      }
      return success(options, []);
    };
    const { runtime, service } = await createFixture(kernel, {
      idleShutdownMs: 45_000,
      scheduleIdleShutdown: scheduler.schedule,
    });
    const context = toolContext(toolSession("idle-reset"));

    await service.handlers.runPlaywright(
      {
        args: {},
        browser: "isolated-headless",
        browserInstanceId: "idle",
        code: "return 1",
        timeoutMs: 1000,
      },
      context,
    );
    expect(scheduler.armed()).toHaveLength(1);

    const blocked = service.handlers.runPlaywright(
      {
        args: { action: "block" },
        browser: "isolated-headless",
        browserInstanceId: "idle",
        code: "return 2",
        timeoutMs: 1000,
      },
      context,
    );
    await started.promise;
    expect(scheduler.armed()).toHaveLength(0);
    release.resolve();
    await blocked;
    expect(scheduler.armed()).toHaveLength(1);
    expect(runtime.sessions.get("idle-reset\0isolated-headless\0idle")?.closed).toBeFalse();
    await service.close();
  });

  test("rearms the idle timer only after the last overlapping call completes", async () => {
    const scheduler = createIdleShutdownScheduler();
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    const kernel: ChromeExecutionKernel = async (options) => {
      const id = String(requestAction(options).id);
      if (id === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      if (id === "second") await releaseSecond.promise;
      return success(options, []);
    };
    const { service } = await createFixture(kernel, {
      idleShutdownMs: 45_000,
      scheduleIdleShutdown: scheduler.schedule,
    });
    const context = toolContext(toolSession("idle-overlap"));

    const first = service.handlers.runPlaywright(
      {
        args: { id: "first" },
        browser: "isolated-headless",
        browserInstanceId: "idle",
        code: "return 1",
        timeoutMs: 1000,
      },
      context,
    );
    const second = service.handlers.runPlaywright(
      {
        args: { id: "second" },
        browser: "isolated-headless",
        browserInstanceId: "idle",
        code: "return 2",
        timeoutMs: 1000,
      },
      context,
    );
    await firstStarted.promise;
    releaseFirst.resolve();
    await first;
    expect(scheduler.scheduled).toHaveLength(0);

    releaseSecond.resolve();
    await second;
    expect(scheduler.armed()).toHaveLength(1);
    await service.close();
  });

  test("ignores a raced idle fire while a call is in flight", async () => {
    const scheduler = createIdleShutdownScheduler();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const kernel: ChromeExecutionKernel = async (options) => {
      if (requestAction(options).action === "block") {
        started.resolve();
        await release.promise;
      }
      return success(options, []);
    };
    const { runtime, service } = await createFixture(kernel, {
      idleShutdownMs: 45_000,
      scheduleIdleShutdown: scheduler.schedule,
    });
    const context = toolContext(toolSession("idle-raced-fire"));

    await service.handlers.runPlaywright(
      {
        args: {},
        browser: "isolated-headless",
        browserInstanceId: "idle",
        code: "return 1",
        timeoutMs: 1000,
      },
      context,
    );
    const [timer] = scheduler.scheduled;
    if (!timer) throw new Error("Expected an armed idle timer");

    const blocked = service.handlers.runPlaywright(
      {
        args: { action: "block" },
        browser: "isolated-headless",
        browserInstanceId: "idle",
        code: "return 2",
        timeoutMs: 1000,
      },
      context,
    );
    await started.promise;
    // a timer whose expiry raced the admitted call's cancellation
    timer.fire();
    expect(runtime.sessions.get("idle-raced-fire\0isolated-headless\0idle")?.closed).toBeFalse();

    release.resolve();
    const result = await blocked;
    expect(structured(result).ok).toBeTrue();
    expect(runtime.sessions.get("idle-raced-fire\0isolated-headless\0idle")?.closed).toBeFalse();
    expect(scheduler.armed()).toHaveLength(1);
    await service.close();
  });

  test("ignores a stale idle fire after the timer is rearmed", async () => {
    const scheduler = createIdleShutdownScheduler();
    const { runtime, service } = await createFixture(async (options) => success(options, []), {
      idleShutdownMs: 45_000,
      scheduleIdleShutdown: scheduler.schedule,
    });
    const context = toolContext(toolSession("idle-stale-fire"));

    await service.handlers.runPlaywright(
      {
        args: {},
        browser: "isolated-headless",
        browserInstanceId: "idle",
        code: "return 1",
        timeoutMs: 1000,
      },
      context,
    );
    await service.handlers.runPlaywright(
      {
        args: {},
        browser: "isolated-headless",
        browserInstanceId: "idle",
        code: "return 2",
        timeoutMs: 1000,
      },
      context,
    );
    const [staleTimer, rearmedTimer] = scheduler.scheduled;
    if (!staleTimer || !rearmedTimer) throw new Error("Expected a superseded and a rearmed idle timer");

    // The first arm's expiry raced past its cancellation and occurs after the rearm.
    staleTimer.fire();
    expect(runtime.sessions.get("idle-stale-fire\0isolated-headless\0idle")?.closed).toBeFalse();

    rearmedTimer.fire();
    expect(runtime.sessions.get("idle-stale-fire\0isolated-headless\0idle")?.closed).toBeTrue();
    await service.close();
  });

  test("never schedules idle shutdown for visible isolated, shared, or main browsers", async () => {
    const scheduler = createIdleShutdownScheduler();
    const { service } = await createFixture(async (options) => success(options, []), {
      idleShutdownMs: 45_000,
      scheduleIdleShutdown: scheduler.schedule,
    });
    const context = toolContext(toolSession("idle-exempt"));

    const exemptModes: ("isolated" | "main" | "shared-headless" | "shared")[] = [
      "isolated",
      "shared",
      "shared-headless",
      "main",
    ];
    for (const browser of exemptModes) {
      await service.handlers.runPlaywright({ args: {}, browser, code: "return 1", timeoutMs: 1000 }, context);
    }
    expect(scheduler.scheduled).toHaveLength(0);
    await service.close();
  });

  test("clears the armed idle timer when its connection closes", async () => {
    const scheduler = createIdleShutdownScheduler();
    const { runtime, service } = await createFixture(async (options) => success(options, []), {
      idleShutdownMs: 45_000,
      scheduleIdleShutdown: scheduler.schedule,
    });
    const context = toolContext(toolSession("idle-teardown"));

    await service.handlers.runPlaywright(
      {
        args: {},
        browser: "isolated-headless",
        browserInstanceId: "idle",
        code: "return 1",
        timeoutMs: 1000,
      },
      context,
    );
    const session = runtime.sessions.get("idle-teardown\0isolated-headless\0idle");
    expect(scheduler.armed()).toHaveLength(1);

    await service.closeConnection(context);
    expect(scheduler.armed()).toHaveLength(0);
    expect(session?.closed).toBeTrue();
    await service.close();
  });
});
