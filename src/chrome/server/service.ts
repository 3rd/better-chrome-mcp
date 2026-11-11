import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Content } from "#fastmcp";
import type {
  SessionLifecycleContext,
  SessionLifecycleHooks,
  SessionResourceProvider,
  SessionResourcesCapabilities,
} from "../../mcp/capturing-server";
import type { AnalyzeHeapSnapshotInput } from "./contracts";
import type { ChromeToolContext, ChromeToolHandlers } from "./register-tools";
import type { ChromeServiceRuntime, ChromeServiceRuntimeSession, ServiceSelection } from "./service-runtime";
import { resolveToolOutputPath, type ToolPathContext } from "../../mcp/session-context";
import { isRecord } from "../../platform/records";
import {
  ARTIFACT_CHUNK_BYTES,
  ARTIFACT_CONNECTION_MAX_BYTES,
  ARTIFACT_DIRECT_CONTENT_BYTES,
  ARTIFACT_MAX_BYTES,
  type ArtifactConnection,
  type ArtifactDescriptor,
  type ArtifactOrigin,
  type ArtifactPublication,
  type ArtifactReservation,
  type ArtifactResourceOwnerResolver,
  ArtifactStore,
  createArtifactSessionResourceAdapter,
  ORDINARY_CALL_MAX_ARTIFACTS,
  ORDINARY_CALL_MAX_BYTES,
} from "../artifacts";
import {
  redactBrokerErrorMessage,
  type RemoteDownloadFinished,
  type RemoteDownloadPublication,
} from "../broker-rpc";
import { type BrowserInstanceOptions, type BrowserSelection, isNamedBrowserMode } from "../browser-modes";
import {
  type ArtifactPublicationScope,
  type ArtifactPublicationSession,
  type ArtifactPublisher,
  artifactsFromError,
  CAPTURE_BODY_LIMITS,
  type ArtifactPublication as CaptureArtifactPublication,
  CaptureManager,
  type CaptureOutputPathAllocator,
  type CaptureScope,
  type CaptureStartOptions,
  CdpFfmpegVideoAdapter,
  CheckpointManager,
  type FfmpegProcessFactory,
  isSameBrowserOwner,
  MAX_CAPTURE_NETWORK_ENTRIES,
  MAX_HAR_BYTES,
  PixelmatchPixelDiffAdapter,
  PlaywrightTraceAdapter,
  type PlaywrightTracingResolver,
} from "../captures";
import {
  createDiagnosticOutputPathResolver,
  type DiagnosticCall,
  type DiagnosticCdpSession,
  type DiagnosticDeviceScope,
  type DiagnosticOutputPathResolver,
  type DiagnosticToolResult,
  HeapSnapshotDiagnostics,
  LighthouseDiagnostics,
  lighthouseEndpointTarget,
  PerformanceDiagnostics,
  type SelectedDiagnosticPage,
  type SelectedPageProvider,
} from "../diagnostics";
import { SubprocessHeapSnapshotAnalyzer } from "../diagnostics/heap-analysis";
import { heapQueryRequestSchema, type HeapQueryResult } from "../diagnostics/heap-analysis-protocol";
import { textResult } from "../diagnostics/types";
import {
  type BrokerRpcExecutionContext,
  type BrokerRpcRequest,
  canonicalJsonStringify,
  ChromeMcpExecutionError,
  copyJsonObject,
  copyJsonValue,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  type DialogDescriptor,
  type ExecutionBrokerRpcAdapter,
  type ExecutionKernelFailure,
  type ExecutionKernelResult,
  type ExecutionKernelSuccess,
  INLINE_IMAGE_MAX_BYTES,
  INLINE_IMAGE_MAX_COUNT,
  INLINE_IMAGE_MAX_TOTAL_BYTES,
  INLINE_TEXT_MAX_BYTES,
  type InlineStagedContent,
  type JsonObject,
  type JsonValue,
  RUN_ARTIFACT_MAX_BYTES,
  runExecutionWorker,
  type RunExecutionWorkerOptions,
  type SerializedExecutionError,
  serializeExecutionError,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_DEPTH,
  SNAPSHOT_MIN_BYTES,
  SNAPSHOT_MIN_DEPTH,
  SNAPSHOT_RETAINED_COUNT,
  type StagedContent,
  STATE_KEY_MAX_BYTES,
  STATE_TOTAL_MAX_BYTES,
  STATE_VALUE_MAX_BYTES,
  type StateSnapshot,
} from "../execution";
import {
  type BrowserCallAdmission,
  type BrowserMode,
  type BrowserOwnerSnapshot,
  CDP_METHOD_NOT_FOUND,
  CdpCommandError,
  type EventCursor,
  type GenerationTargetId,
  JOURNAL_EVENT_TYPES,
  JOURNAL_MAX_BYTES,
  JOURNAL_MAX_EVENTS,
  type JournalEventType,
  PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS,
  PERSISTENT_BINDING_MAX_PAYLOAD_BYTES,
  PERSISTENT_BINDING_WORKER_TIMEOUT_MS,
  PERSISTENT_MUTATION_MAX_COUNT_PER_KIND,
  PERSISTENT_MUTATION_MAX_ENTRY_BYTES,
  PERSISTENT_MUTATION_MAX_TOTAL_BYTES,
} from "../runtime";
import {
  assertMatchingNativeDeviceScaleFactor,
  assertNativeDeviceScaleFactor,
  isSharedMode,
} from "../runtime/modes";
import { isPwaCdpMethod, type PwaCdpMethod } from "../runtime/pwa-controller";
import {
  REACT_ANALYSIS_RESULT_MAX_BYTES,
  REACT_INLINE_RESULT_MAX_BYTES,
  REACT_PROFILE_ANALYSIS_METRICS,
  REACT_PROFILE_MAX_BYTES,
  type ReactBrowserOperation,
  type ReactOperationResult,
} from "../runtime/react-inspection-protocol";
import { BrokerRuntime } from "./broker-runtime";
import { browserRenderingInfoSchema } from "./contracts";
import {
  CHROME_CAPABILITY_CAPTURE_TYPES,
  CHROME_CAPABILITY_CDP_METHODS,
  chromeCapabilitiesSchema,
  type ChromeCapabilityCdpMethod,
  type ReactHighlightComponentInput,
  type ReactInspectComponentInput,
  type ReactListComponentsInput,
  type ReactProfileAnalyzeInput,
  type ReactProfileStartInput,
  type ReactProfileStopInput,
  type ReactUpdateComponentInput,
  type RunPlaywrightInput,
  type RunPlaywrightOutput,
} from "./contracts";
import { ChromePageAdapter, type ChromePageAdapterOptions, formatSnapshotResult } from "./page-adapter";
import {
  analyzeReactProfile,
  rankReactProfileRows,
  type ReactProfileAnalysisRow,
} from "./react-profile-analysis";

const serializeServiceError = (
  error: unknown,
  fallbackCode: Parameters<typeof serializeExecutionError>[1],
  secrets: readonly string[] = [],
): SerializedExecutionError => {
  const serialized = serializeExecutionError(error, fallbackCode, secrets);
  return {
    ...serialized,
    message: redactBrokerErrorMessage(serialized.message),
    ...(serialized.stack === undefined ? {} : { stack: redactBrokerErrorMessage(serialized.stack) }),
  };
};

type RunPlaywrightFailureOutput = Extract<RunPlaywrightOutput, { ok: false }>;
type RunPlaywrightSuccessOutput = Extract<RunPlaywrightOutput, { ok: true }>;
type RunPlaywrightFailureDiagnostics = NonNullable<RunPlaywrightFailureOutput["diagnostics"]>;

export type ChromeExecutionKernel = (options: RunExecutionWorkerOptions) => Promise<ExecutionKernelResult>;

const ISOLATED_BROWSER_IDLE_SHUTDOWN_MS = 30 * 60_000;

export type IdleShutdownScheduler = (delayMs: number, fire: () => void) => () => void;

const scheduleIdleShutdownTimer: IdleShutdownScheduler = (delayMs, fire) => {
  const timer = setTimeout(fire, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export type ChromeServiceOptions = Readonly<{
  artifactStore?: ArtifactStore;
  capture?: Readonly<{
    ffmpegExecutable?: string;
    ffmpegProcesses?: FfmpegProcessFactory;
    tracingResolver?: PlaywrightTracingResolver;
  }>;
  executablePath?: string;
  executionKernel?: ChromeExecutionKernel;
  idleShutdownMs?: number;
  mainUserDataDir?: string;
  playwrightVersion?: string;
  runtime?: ChromeServiceRuntime;
  scheduleIdleShutdown?: IdleShutdownScheduler;
  snapshotConnector?: NonNullable<ChromePageAdapterOptions["connectSnapshot"]>;
  workspacePath?: string;
}>;

export type ChromeService = Readonly<{
  artifactConnection: (context: ChromeToolContext) => ArtifactConnection;
  artifactOwner: ArtifactResourceOwnerResolver<NonNullable<ChromeToolContext["session"]>>;
  artifactStore: ArtifactStore;
  close: () => Promise<void>;
  closeConnection: (context: ChromeToolContext) => Promise<void>;
  handlers: ChromeToolHandlers;
  resourcesCapabilities: SessionResourcesCapabilities;
  sessionLifecycle: SessionLifecycleHooks;
  sessionResources: SessionResourceProvider;
}>;

type ConnectionState = {
  artifactConnection: ArtifactConnection;
  closed: boolean;
  closing: boolean;
  diagnosticOutputPaths: DiagnosticOutputPathResolver;
  heapQueries: Map<AbortController, Promise<HeapQueryResult>>;
  modeAcquisitions: Map<string, Promise<ModeState>>;
  modeRecoveries: Map<string, Promise<void>>;
  modes: Map<string, ModeState>;
  reactProfiles: Map<string, ReactProfileRecord>;
  reactAnalysisCursors: Map<string, ReactAnalysisCursor>;
  session: NonNullable<ChromeToolContext["session"]>;
};

type ReactProfileRecord =
  | Readonly<{
      completedAt: string;
      kind: "completed";
      mode: ModeState;
      result: ReactOperationResult;
      size: number;
    }>
  | Readonly<{ kind: "active"; mode: ModeState; startedAt: string }>;

type ReactAnalysisCursor = Readonly<{
  includeChangeDescriptions: boolean;
  index: number;
  limit: number;
  metrics: readonly string[];
  profileId: string;
  rows: readonly ReactProfileAnalysisRow[];
}>;

type ModeState = {
  admissionTail: Promise<void>;
  browserInstanceId?: string;
  nativeDeviceScaleFactor?: number;
  cancelIdleShutdown: () => void;
  idleShutdownGeneration: number;
  inFlightCalls: number;
  releaseNetworkWatcher: () => void;
  releaseTargetWatcher: () => void;
  runtime: ChromeServiceRuntimeSession;
  state: StateSnapshot;
  terminated: boolean;
};

type CallArtifacts = {
  add: (...artifacts: readonly ArtifactDescriptor[]) => void;
  list: () => ArtifactDescriptor[];
  requirePublished: (artifact: ArtifactDescriptor, label: string) => ArtifactDescriptor;
};

type CallRpcState = {
  artifacts: CallArtifacts;
  connection: ConnectionState;
  context: ChromeToolContext;
  mode: ModeState;
  ownerCloseAuthorized: boolean;
  publication: ArtifactPublication;
  reservations: Map<string, ArtifactReservation>;
  selection: ServiceSelection;
  temporaryDirectories: string[];
};

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new ChromeMcpExecutionError("CHROME_MCP_INVALID_INPUT", `${label} must be an object`);
  }
  return value;
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new ChromeMcpExecutionError("CHROME_MCP_INVALID_INPUT", `${label} must be a non-empty string`);
  }
  return value;
};

const resolveInputFile = async (pathContext: ToolPathContext, path: string): Promise<string> => {
  try {
    return await resolveToolOutputPath(pathContext, path);
  } catch (error: unknown) {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_INVALID_INPUT",
      error instanceof Error ? error.message : String(error),
      error instanceof Error ? { cause: error } : undefined,
    );
  }
};

const lifecycleSession = (context: SessionLifecycleContext) => {
  if (context.connectionId !== context.session.connectionId) {
    throw new Error("Chrome lifecycle connection does not match its authenticated session");
  }
  return context.session;
};

const artifactTracker = (): CallArtifacts => {
  const artifacts = new Map<string, ArtifactDescriptor>();
  return {
    add: (...values) => {
      for (const value of values) artifacts.set(value.artifactId, value);
    },
    list: () => [...artifacts.values()],
    requirePublished: (artifact, label) => {
      const published = artifacts.get(artifact.artifactId);
      if (
        !published ||
        published.complete !== artifact.complete ||
        published.createdAt !== artifact.createdAt ||
        published.expiresAt !== artifact.expiresAt ||
        published.mediaType !== artifact.mediaType ||
        published.name !== artifact.name ||
        published.sha256 !== artifact.sha256 ||
        published.size !== artifact.size ||
        published.uri !== artifact.uri
      ) {
        throw new ChromeMcpExecutionError(
          "CHROME_MCP_WORKER_CRASH",
          `${label} was not published by this run_playwright call`,
        );
      }
      return published;
    },
  };
};

const validateExecutionArtifactProvenance = (
  result: ExecutionKernelResult,
  artifacts: CallArtifacts,
): ExecutionKernelResult => {
  const publishedArtifacts = result.artifacts.map((artifact) =>
    artifacts.requirePublished(artifact, "Execution artifact"),
  );
  if (!result.ok) return { ...result, artifacts: publishedArtifacts };
  const content = result.content.map((item): StagedContent => {
    if (item.type !== "resource") return item;
    return {
      artifact: artifacts.requirePublished(item.artifact, "Execution content artifact"),
      type: "resource",
    };
  });
  if (result.valueArtifact === undefined) return { ...result, artifacts: publishedArtifacts, content };
  return {
    ...result,
    artifacts: publishedArtifacts,
    content,
    valueArtifact: artifacts.requirePublished(result.valueArtifact, "Execution value artifact"),
  };
};

const throwTrackedArtifactError = (artifacts: CallArtifacts, error: unknown): never => {
  artifacts.add(...artifactsFromError(error));
  throw error;
};

const artifactOrigin = (mode: ModeState, targetId: string, tool: string): ArtifactOrigin => ({
  browserMode: mode.runtime.browserMode,
  targetId,
  tool,
});

const contentForArtifact = (artifact: ArtifactDescriptor): Content => ({
  type: "resource_link",
  uri: artifact.uri,
  name: artifact.name,
  mimeType: artifact.mediaType,
  description: `${artifact.size} bytes; sha256 ${artifact.sha256}`,
});

const collectFailureDiagnostics = async (
  runtime: ChromeServiceRuntimeSession,
  after: EventCursor | undefined,
  targetId: string,
) => {
  const [browser, crashes] = await Promise.allSettled([
    runtime.capabilities(),
    after === undefined ?
      Promise.resolve(undefined)
    : runtime.readEvents({
        after,
        limit: 1,
        target: targetId,
        types: ["target_crashed"],
      }),
  ]);
  const diagnostics: RunPlaywrightFailureDiagnostics = { browserConnection: "unknown" };
  const unavailable: NonNullable<RunPlaywrightFailureDiagnostics["unavailable"]> = [];

  if (
    browser.status === "fulfilled" &&
    (after === undefined || browser.value.ownerGeneration === after.ownerGeneration)
  ) {
    diagnostics.browserConnection = browser.value.browserConnected ? "connected" : "disconnected";
    if (browser.value.chromeProduct !== undefined) {
      diagnostics.chromeProduct = browser.value.chromeProduct;
    }
    if (browser.value.unavailableTargets) {
      diagnostics.unavailableTargets = browser.value.unavailableTargets;
    }
  } else {
    unavailable.push("browser-state");
  }

  if (crashes.status === "fulfilled" && crashes.value !== undefined) {
    diagnostics.journal = {
      droppedBefore: crashes.value.droppedBefore,
      ownerReset: crashes.value.ownerReset,
    };
    if (!crashes.value.ownerReset) {
      const crash = crashes.value.events.find((event) => event.type === "target_crashed");
      if (crash) {
        diagnostics.targetCrash = crash;
      }
    }
  } else {
    unavailable.push("crash-events");
  }

  if (unavailable.length > 0) {
    diagnostics.unavailable = unavailable;
  }

  const hasCrashContext =
    diagnostics.targetCrash ||
    diagnostics.unavailable ||
    diagnostics.journal?.droppedBefore ||
    diagnostics.journal?.ownerReset;
  if (diagnostics.browserConnection === "connected" && !hasCrashContext && !diagnostics.unavailableTargets) {
    return undefined;
  }

  return diagnostics;
};

const failureEnvelope = (
  artifacts: readonly ArtifactDescriptor[],
  error: SerializedExecutionError,
  selectedTargetId: string | null,
  options?: Readonly<{
    diagnostics?: RunPlaywrightFailureDiagnostics;
    partial?: Readonly<{
      content: readonly InlineStagedContent[];
      emittedCount: number;
      omittedCount: number;
    }>;
  }>,
) => {
  const partial = options?.partial;
  const structuredContent: RunPlaywrightFailureOutput = {
    artifacts: [...artifacts],
    ...(options?.diagnostics ? { diagnostics: options.diagnostics } : {}),
    error: { code: error.code, message: error.message, name: error.name },
    ok: false,
    ...(partial ?
      {
        partialEmittedCount: partial.emittedCount,
        partialOmittedCount: partial.omittedCount,
      }
    : {}),
    selectedTargetId,
  };
  const stackFrames = error.stack?.split(/\r?\n/u).slice(1).join("\n");
  const stackText = stackFrames ? `\n${stackFrames}` : "";
  const content: Content[] = [
    {
      type: "text",
      text: `${error.code}: ${error.message}${stackText}`,
    },
    ...(partial?.content.map(
      (item): Content =>
        item.type === "text" ?
          { type: "text", text: item.text }
        : { type: "image", data: item.data, mimeType: item.mediaType },
    ) ?? []),
    ...artifacts.map(contentForArtifact),
    ...(options?.diagnostics ?
      ([
        { type: "text", text: `Chrome diagnostics: ${JSON.stringify(options.diagnostics)}` },
      ] satisfies Content[])
    : []),
  ];
  return {
    content,
    isError: true,
    structuredContent,
  };
};

type PlaywrightSuccessEnvelopeOptions = Readonly<{
  artifacts: readonly ArtifactDescriptor[];
  result: ExecutionKernelSuccess;
  rendering?: RunPlaywrightSuccessOutput["rendering"];
  selectedTargetId: string | null;
  unavailableTargets?: BrowserOwnerSnapshot["unavailableTargets"];
}>;

const successEnvelope = ({
  artifacts,
  result,
  rendering,
  selectedTargetId,
  unavailableTargets,
}: PlaywrightSuccessEnvelopeOptions) => {
  const structuredContent: RunPlaywrightSuccessOutput = {
    artifacts: [...artifacts],
    emittedCount: result.emittedCount,
    ok: true,
    selectedTargetId,
    ...(rendering === undefined ? {} : { rendering }),
    ...(result.value === undefined ? {} : { value: result.value }),
    ...(result.valueArtifact === undefined ? {} : { valueArtifact: result.valueArtifact }),
    ...(unavailableTargets ? { unavailableTargets } : {}),
  };
  const content = result.content.map((item): Content => {
    if (item.type === "text") return { type: "text", text: item.text };
    if (item.type === "image") return { type: "image", data: item.data, mimeType: item.mediaType };
    return contentForArtifact(item.artifact);
  });

  if (result.valueImage) {
    content.push({ type: "image", data: result.valueImage.data, mimeType: result.valueImage.mediaType });
  }
  if (result.valueArtifact) content.push(contentForArtifact(result.valueArtifact));
  if (content.length === 0 && result.value === undefined) {
    content.push({ type: "text", text: "Playwright code completed." });
  }
  if (unavailableTargets) {
    content.push({
      type: "text",
      text: `Unavailable Chrome tabs (not exposed as Playwright pages): ${JSON.stringify(unavailableTargets)}`,
    });
  }

  if (rendering) {
    content.push({ type: "text", text: `Chrome rendering: ${JSON.stringify(rendering)}` });
  }

  return { content, structuredContent };
};

const reactSuccessEnvelope = (
  result: Readonly<Record<string, unknown>>,
  artifacts: readonly ArtifactDescriptor[] = [],
) => ({
  content: [
    { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ...artifacts.map(contentForArtifact),
  ],
  structuredContent: { artifacts: [...artifacts], ok: true, ...result },
});

const reactFailureEnvelope = (error: unknown) => {
  const serialized = serializeServiceError(error, "CHROME_MCP_EXECUTION_FAILED");
  return {
    content: [{ type: "text" as const, text: `${serialized.code}: ${serialized.message}` }],
    isError: true,
    structuredContent: {
      error: { code: serialized.code, message: serialized.message, name: serialized.name },
      ok: false,
    },
  };
};

const sameReactAnalysisMetrics = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((metric, index) => metric === right[index]);

const partialFailureOutput = (result: ExecutionKernelFailure) => {
  if (
    result.partialContent === undefined ||
    result.partialEmittedCount === undefined ||
    result.partialOmittedCount === undefined
  ) {
    return undefined;
  }
  return {
    content: result.partialContent,
    emittedCount: result.partialEmittedCount,
    omittedCount: result.partialOmittedCount,
  };
};

const selectedDialog = (session: ChromeServiceRuntimeSession): DialogDescriptor | null => {
  const dialog = session.activeDialog();
  if (!dialog) return null;
  const type = dialog.dialogType;
  if (type !== "alert" && type !== "beforeunload" && type !== "confirm" && type !== "prompt") return null;
  return {
    defaultValue: dialog.defaultValue,
    message: dialog.message,
    modalId: dialog.dialogId,
    type,
  };
};

const selectedFileChooser = (session: ChromeServiceRuntimeSession) => {
  const chooser = session.activeFileChooser();
  if (!chooser) return null;
  return {
    accept: chooser.accept ?? "",
    isMultiple: chooser.multiple,
    modalId: chooser.chooserId,
  };
};

const modeScopeKey = (
  scope: Pick<CaptureScope, "browserGeneration" | "browserMode" | "connectionId" | "contextId">,
): string => `${scope.connectionId}\0${scope.browserMode}\0${scope.contextId}\0${scope.browserGeneration}`;

const browserInstanceKey = (browserMode: BrowserMode, browserInstanceId?: string): string =>
  `${browserMode}\0${browserInstanceId ?? ""}`;

const createBrowserScope = (runtime: ChromeServiceRuntimeSession) => ({
  browserGeneration: runtime.ownerGeneration,
  browserMode: runtime.browserMode,
  connectionId: runtime.connectionId,
  contextId: runtime.ownerId,
});

const createOwnerKey = (runtime: ChromeServiceRuntimeSession) =>
  `${runtime.ownerId}\0${runtime.ownerGeneration}`;

const createDiagnosticPageKey = (runtime: ChromeServiceRuntimeSession, targetId: string) => {
  return `${modeScopeKey(createBrowserScope(runtime))}\0${targetId}`;
};

const stopModeTimerAndWatchers = (mode: ModeState) => {
  mode.cancelIdleShutdown();
  mode.releaseNetworkWatcher();
  mode.releaseTargetWatcher();
};

const CDP_METHOD_PROBE_PARAMETERS: Readonly<
  Record<Exclude<ChromeCapabilityCdpMethod, PwaCdpMethod>, Record<string, unknown>>
> = {
  "Accessibility.getFullAXTree": { depth: "unsupported" },
  "DOM.getBoxModel": { nodeId: "unsupported" },
  "HeapProfiler.takeHeapSnapshot": { reportProgress: "unsupported" },
  "Network.getResponseBody": { requestId: 0 },
  "Page.captureScreenshot": { format: 0 },
  "Page.startScreencast": { format: 0 },
  "Tracing.start": { bufferUsageReportingInterval: "unsupported" },
};

const isCdpMethodNotFound = (error: unknown): boolean => {
  if (error instanceof CdpCommandError && error.code !== undefined) {
    return error.code === CDP_METHOD_NOT_FOUND;
  }

  return error instanceof Error && error.message.endsWith("wasn't found");
};

const probeCdpMethods = async (
  runtime: ChromeServiceRuntimeSession,
  targetId: string,
): Promise<ReadonlySet<string>> => {
  const attached = requireRecord(
    await runtime.sendCdp("Target.attachToTarget", { flatten: true, targetId }),
    "Target.attachToTarget result",
  );
  const sessionId = requireString(attached.sessionId, "Target session ID");
  const supported = new Set<string>();
  try {
    await Promise.all(
      CHROME_CAPABILITY_CDP_METHODS.map(async (method) => {
        if (isPwaCdpMethod(method)) return;

        try {
          await runtime.sendCdp(method, CDP_METHOD_PROBE_PARAMETERS[method], sessionId);
        } catch (error: unknown) {
          if (isCdpMethodNotFound(error)) {
            return;
          }

          if (!(error instanceof CdpCommandError)) {
            throw error;
          }
        }
        supported.add(method);
      }),
    );
  } finally {
    await runtime.sendCdp("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }

  const pwa = await runtime.pwa({ operation: "capabilities" });
  if (pwa.operation !== "capabilities") {
    throw new Error("PWA capabilities returned an invalid result");
  }

  for (const [method, isSupported] of Object.entries(pwa.cdp)) {
    if (isSupported) {
      supported.add(method);
    }
  }

  return supported;
};

class TemporaryCaptureOutputPaths implements CaptureOutputPathAllocator {
  readonly #allocated = new Set<string>();
  #root: Promise<string> | undefined;
  #rootPath: string | undefined;

  private constructor() {}

  static async create(): Promise<TemporaryCaptureOutputPaths> {
    return new TemporaryCaptureOutputPaths();
  }

  async allocate(captureId: string, name: string): Promise<string> {
    if (basename(captureId) !== captureId || basename(name) !== name) {
      throw new Error("Capture output names must not contain path separators");
    }
    this.#root ??= mkdtemp(join(tmpdir(), "chrome-mcp-captures-")).then((root) => {
      this.#rootPath = root;
      return root;
    });
    const directory = join(await this.#root, captureId);
    await mkdir(directory, { mode: 0o700, recursive: true });
    const path = join(directory, name);
    this.#allocated.add(path);
    return path;
  }

  async discard(path: string): Promise<void> {
    if (!this.#allocated.delete(path)) {
      throw new Error("Capture output path was not allocated by this service");
    }
    await rm(path, { force: true });
  }

  async close(): Promise<void> {
    this.#allocated.clear();
    const root = this.#root;
    this.#root = undefined;
    if (!root) {
      this.#rootPath = undefined;
      return;
    }
    const rootPath = await root;
    await rm(rootPath, { force: true, recursive: true });
    if (this.#rootPath === rootPath) this.#rootPath = undefined;
  }

  closeSync(): void {
    this.#allocated.clear();
    this.#root = undefined;
    const rootPath = this.#rootPath;
    this.#rootPath = undefined;
    if (rootPath) rmSync(rootPath, { force: true, recursive: true });
  }
}

class StoreArtifactPublisher implements ArtifactPublisher {
  readonly #connectionById: (connectionId: string) => ArtifactConnection;
  readonly #store: ArtifactStore;

  constructor(store: ArtifactStore, connectionById: (connectionId: string) => ArtifactConnection) {
    this.#store = store;
    this.#connectionById = connectionById;
  }

  async begin(scope: ArtifactPublicationScope): Promise<ArtifactPublicationSession> {
    const publication = await this.#store.beginPublication(
      this.#connectionById(scope.connectionId),
      scope.kind === "capture" ? "capture" : "ordinary",
    );
    let finished = false;
    return {
      finish: async () => {
        if (finished) return;
        finished = true;
        await this.#store.finishPublication(publication);
      },
      publish: (input) => this.#publish(publication, input),
    };
  }

  async #publish(
    publication: ArtifactPublication,
    input: CaptureArtifactPublication,
  ): Promise<ArtifactDescriptor> {
    if (input.signal?.aborted) throw input.signal.reason;
    const origin: ArtifactOrigin = {
      browserMode: input.browserMode,
      targetId: input.targetId,
      tool: input.origin === "checkpoint" ? "checkpoint" : "capture",
    };
    if (input.source.kind === "bytes") {
      return this.#store.publishBytes(publication, input.source.bytes, {
        complete: input.complete,
        mediaType: input.mediaType,
        name: input.name,
        origin,
      });
    }
    return this.#store.publishFile(publication, input.source.path, {
      complete: input.complete,
      mediaType: input.mediaType,
      name: input.name,
      origin,
    });
  }
}

class AttachedDiagnosticPage implements SelectedDiagnosticPage {
  readonly cdp: DiagnosticCdpSession;
  readonly cpuThrottling = 1;
  readonly deviceScope: DiagnosticDeviceScope = "DESKTOP";
  readonly engineTarget: JsonObject;
  readonly ownerGeneration: number;
  readonly ownerId: string;
  readonly targetId: string;

  readonly #detach: () => Promise<void>;
  readonly #listeners = new Map<string, Map<(payload: unknown) => void, () => void>>();
  #url: string;

  private constructor(
    session: ChromeServiceRuntimeSession,
    sessionId: string,
    engineTarget: JsonObject,
    detach: () => Promise<void>,
    url: string,
  ) {
    this.#detach = detach;
    this.ownerGeneration = session.ownerGeneration;
    this.ownerId = session.ownerId;
    this.targetId = session.currentTarget().targetId;
    this.#url = url;
    this.engineTarget = engineTarget;
    this.cdp = {
      off: (event, listener) => {
        this.#listeners.get(event)?.get(listener)?.();
        this.#listeners.get(event)?.delete(listener);
      },
      on: (event, listener) => {
        const remove = session.onCdp(event, (payload, incomingSessionId) => {
          if (incomingSessionId === sessionId) listener(payload);
        });
        const eventListeners = this.#listeners.get(event) ?? new Map();
        eventListeners.set(listener, remove);
        this.#listeners.set(event, eventListeners);
      },
      send: (method, parameters) => session.sendCdp(method, parameters, sessionId),
    };
  }

  get url(): string {
    return this.#url;
  }

  static async create(session: ChromeServiceRuntimeSession): Promise<AttachedDiagnosticPage> {
    const selected = session.currentTarget();
    const attached = requireRecord(
      await session.sendCdp("Target.attachToTarget", { flatten: true, targetId: selected.targetId }),
      "Target.attachToTarget result",
    );
    const sessionId = requireString(attached.sessionId, "Target session ID");
    const [targetRecord, worker] = await Promise.all([
      session.targetRecord(selected.targetId),
      session.workerConnection(),
    ]);
    const engineTarget = lighthouseEndpointTarget({
      browserWSEndpoint: worker.endpoint,
      targetId: selected.targetId,
    });
    return new AttachedDiagnosticPage(
      session,
      sessionId,
      engineTarget,
      async () => {
        await session.sendCdp("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      },
      targetRecord?.url ?? "about:blank",
    );
  }

  async close(): Promise<void> {
    for (const listeners of this.#listeners.values()) {
      for (const remove of listeners.values()) remove();
    }
    this.#listeners.clear();
    await this.#detach();
  }

  refreshUrl(url: string): void {
    this.#url = url;
  }

  async navigate(url: string, _options: { waitUntil: "load" }): Promise<void> {
    const loaded = Promise.withResolvers<void>();
    const onLoad = () => loaded.resolve();
    this.cdp.on("Page.loadEventFired", onLoad);
    const timeout = setTimeout(
      () => loaded.reject(new Error("Chrome navigation did not reach load within 30 seconds")),
      30_000,
    );
    try {
      await this.cdp.send("Page.enable");
      const navigation = requireRecord(await this.cdp.send("Page.navigate", { url }), "Page.navigate result");
      if (typeof navigation.errorText === "string" && navigation.errorText.length > 0) {
        throw new Error(navigation.errorText);
      }
      await loaded.promise;
    } finally {
      clearTimeout(timeout);
      this.cdp.off("Page.loadEventFired", onLoad);
    }
  }

  async restoreEmulation(): Promise<void> {
    await Promise.all([
      this.cdp.send("Emulation.clearDeviceMetricsOverride"),
      this.cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }),
      this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }),
      this.cdp.send("Network.emulateNetworkConditions", {
        connectionType: "none",
        downloadThroughput: -1,
        latency: 0,
        offline: false,
        uploadThroughput: -1,
      }),
    ]);
  }
}

const parseJournalEventType = (value: string): JournalEventType => {
  for (const candidate of JOURNAL_EVENT_TYPES) {
    if (candidate === value) return candidate;
  }
  throw new ChromeMcpExecutionError("CHROME_MCP_INVALID_INPUT", `Unknown journal event type ${value}`);
};

const parseCaptureOptions = (options: JsonObject): CaptureStartOptions => {
  const type = requireString(options.type, "Capture type");
  switch (type) {
    case "trace": {
      return {
        type,
        ...(typeof options.screenshots === "boolean" ? { screenshots: options.screenshots } : {}),
        ...(typeof options.snapshots === "boolean" ? { snapshots: options.snapshots } : {}),
        ...(typeof options.sources === "boolean" ? { sources: options.sources } : {}),
      };
    }
    case "har": {
      const content = options.content;
      if (content !== undefined && content !== "omit" && content !== "embed" && content !== "attach") {
        throw new ChromeMcpExecutionError("CHROME_MCP_INVALID_INPUT", "HAR content is invalid");
      }
      return {
        type,
        ...(content === undefined ? {} : { content }),
        ...(typeof options.urlFilter === "string" ? { urlFilter: options.urlFilter } : {}),
      };
    }
    case "network-bodies": {
      let mimeTypes: string[] | undefined;
      if (options.mimeTypes !== undefined) {
        if (!Array.isArray(options.mimeTypes)) {
          throw new ChromeMcpExecutionError(
            "CHROME_MCP_INVALID_INPUT",
            "Network-body MIME types must be strings",
          );
        }
        mimeTypes = [];
        for (const value of options.mimeTypes) {
          if (typeof value !== "string") {
            throw new ChromeMcpExecutionError(
              "CHROME_MCP_INVALID_INPUT",
              "Network-body MIME types must be strings",
            );
          }
          mimeTypes.push(value);
        }
      }
      return {
        type,
        ...(typeof options.maxBodyBytes === "number" ? { maxBodyBytes: options.maxBodyBytes } : {}),
        ...(typeof options.maxTotalBytes === "number" ? { maxTotalBytes: options.maxTotalBytes } : {}),
        ...(mimeTypes === undefined ? {} : { mimeTypes }),
      };
    }
    case "video": {
      return {
        type,
        ...(options.format === "webm" ? { format: options.format } : {}),
        ...(typeof options.framesPerSecond === "number" ? { framesPerSecond: options.framesPerSecond } : {}),
        ...(typeof options.height === "number" ? { height: options.height } : {}),
        ...(typeof options.width === "number" ? { width: options.width } : {}),
      };
    }
    default: {
      throw new ChromeMcpExecutionError("CHROME_MCP_INVALID_INPUT", `Unknown capture type ${type}`);
    }
  }
};

const readRenderingInfo = async (runtime: ChromeServiceRuntimeSession, targetId: string) => {
  if (runtime.browserMode !== "isolated-virtual-display") return undefined;

  const attached = requireRecord(
    await runtime.sendCdp("Target.attachToTarget", { flatten: true, targetId }),
    "Target.attachToTarget result",
  );
  const sessionId = requireString(attached.sessionId, "Target session ID");

  try {
    const [owner, metricsResult, ratioResult] = await Promise.all([
      runtime.capabilities(),
      runtime.sendCdp("Page.getLayoutMetrics", {}, sessionId),
      runtime.sendCdp(
        "Runtime.evaluate",
        { expression: "window.devicePixelRatio", returnByValue: true },
        sessionId,
      ),
    ]);
    const metrics = requireRecord(metricsResult, "Page.getLayoutMetrics result");
    const viewport = requireRecord(metrics.cssVisualViewport, "CSS visual viewport");
    const ratio = requireRecord(
      requireRecord(ratioResult, "Device pixel ratio result").result,
      "Device pixel ratio value",
    );

    return browserRenderingInfoSchema.parse({
      profile: "virtual-display",
      chromeProduct: owner.chromeProduct,
      nativeDeviceScaleFactor: owner.nativeDeviceScaleFactor,
      devicePixelRatio: ratio.value,
      viewport: { width: viewport.clientWidth, height: viewport.clientHeight },
      ...(viewport.zoom === undefined ? {} : { pageZoom: viewport.zoom }),
      visualViewportScale: viewport.scale,
    });
  } finally {
    await runtime.sendCdp("Target.detachFromTarget", { sessionId });
  }
};

const requireToolSession = (
  context: Pick<ChromeToolContext, "session">,
): NonNullable<ChromeToolContext["session"]> => {
  if (!context.session) throw new Error("Chrome tools require a live MCP session context");
  return context.session;
};

const evictCompletedReactProfiles = (connection: ConnectionState) => {
  const completed = [...connection.reactProfiles.entries()]
    .filter(
      (entry): entry is [string, Extract<ReactProfileRecord, { kind: "completed" }>] =>
        entry[1].kind === "completed",
    )
    .sort((left, right) => left[1].completedAt.localeCompare(right[1].completedAt));
  let retainedBytes = completed.reduce((total, entry) => total + entry[1].size, 0);
  while (completed.length > 8 || retainedBytes > REACT_PROFILE_MAX_BYTES) {
    const oldest = completed.shift();
    if (!oldest) break;
    connection.reactProfiles.delete(oldest[0]);
    retainedBytes -= oldest[1].size;
    for (const [cursorId, cursor] of connection.reactAnalysisCursors) {
      if (cursor.profileId === oldest[0]) connection.reactAnalysisCursors.delete(cursorId);
    }
  }
};

const parseEventOptions = (options: JsonObject, selectedTargetId: string) => {
  let after: EventCursor | undefined;
  if (isRecord(options.after)) {
    const ownerGeneration = options.after.ownerGeneration;
    const sequence = options.after.sequence;
    if (typeof ownerGeneration === "number" && typeof sequence === "number") {
      after = { ownerGeneration, sequence };
    }
  }
  let target = selectedTargetId;

  if (typeof options.target === "string" && options.target !== "selected") {
    target = options.target;
  }

  const types: JournalEventType[] = [];
  if (Array.isArray(options.types)) {
    for (const value of options.types) {
      if (typeof value === "string") types.push(parseJournalEventType(value));
    }
  }
  return {
    ...(options.advance === undefined ? {} : { advance: options.advance === true }),
    ...(after ? { after } : {}),
    ...(typeof options.includeStackTraces === "boolean" ?
      { includeStackTraces: options.includeStackTraces }
    : {}),
    ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
    target,
    ...(types.length > 0 ? { types } : {}),
  };
};

const setFileChooserFiles = async (
  request: Extract<BrokerRpcRequest, { operation: "file_chooser_set_files" }>,
  call: CallRpcState,
) => {
  const files: string[] = [];
  for (const value of request.payload.files) {
    const file = requireRecord(value, "File chooser item");
    if (file.kind === "path") {
      files.push(
        await resolveInputFile(
          call.connection.session.pathContext,
          requireString(file.path, "File chooser path"),
        ),
      );
      continue;
    }
    if (file.kind !== "payload") {
      throw new ChromeMcpExecutionError("CHROME_MCP_INVALID_INPUT", "File chooser item kind is invalid");
    }
    const name = requireString(file.name, "File chooser payload name");
    const encoded = requireString(file.bufferBase64, "File chooser payload buffer");
    if (basename(name) !== name || name === "." || name === "..") {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_INVALID_INPUT",
        "File chooser payload name must be a basename",
      );
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_INVALID_INPUT",
        "File chooser payload buffer is not canonical base64",
      );
    }
    const directory = await mkdtemp(join(tmpdir(), "chrome-mcp-upload-"));
    call.temporaryDirectories.push(directory);
    const path = join(directory, name);
    await writeFile(path, bytes, { mode: 0o600 });
    files.push(path);
  }
  await call.mode.runtime.setFileChooserFiles(request.payload.modalId, files);

  return { value: null };
};

class ChromePublicService {
  readonly artifactStore: ArtifactStore;
  readonly handlers: ChromeToolHandlers;

  readonly #captureManager: CaptureManager;
  readonly #captureOutputPaths: TemporaryCaptureOutputPaths;
  readonly #cleanupOwnedRootsOnExit: () => void;
  readonly #captureScopes = new Map<string, CaptureScope>();
  readonly #checkpointManager: CheckpointManager;
  readonly #cdpMethods = new Map<string, Promise<ReadonlySet<string>>>();
  readonly #connections = new Map<string, Promise<ConnectionState>>();
  readonly #connectionStates = new Map<string, ConnectionState>();
  readonly #diagnosticPages = new Map<string, Promise<AttachedDiagnosticPage>>();
  readonly #executionKernel: ChromeExecutionKernel;
  readonly #heap: HeapSnapshotDiagnostics;
  private readonly heapQueryAnalyzer = new SubprocessHeapSnapshotAnalyzer();
  readonly #idleShutdownMs: number;
  readonly #lighthouse: LighthouseDiagnostics;
  readonly #modeByScope = new Map<string, ModeState>();
  readonly #pageAdapter: ChromePageAdapter;
  readonly #performance: PerformanceDiagnostics;
  readonly #playwrightVersion: string;
  readonly #resourceNotifications = new Map<string, () => Promise<void>>();
  readonly #runtime: ChromeServiceRuntime;
  readonly #scheduleIdleShutdown: IdleShutdownScheduler;
  readonly #unsubscribeArtifactEvents: () => void;
  readonly #video: CdpFfmpegVideoAdapter;
  #closed = false;

  constructor(
    options: Readonly<{
      artifactStore: ArtifactStore;
      capture?: ChromeServiceOptions["capture"];
      captureOutputPaths: TemporaryCaptureOutputPaths;
      executionKernel: ChromeExecutionKernel;
      idleShutdownMs: number;
      playwrightVersion: string;
      runtime: ChromeServiceRuntime;
      scheduleIdleShutdown: IdleShutdownScheduler;
      snapshotConnector?: NonNullable<ChromePageAdapterOptions["connectSnapshot"]>;
    }>,
  ) {
    this.artifactStore = options.artifactStore;
    this.#captureOutputPaths = options.captureOutputPaths;
    this.#cleanupOwnedRootsOnExit = () => {
      this.#captureOutputPaths.closeSync();
      this.artifactStore.removeEmptyInstanceSync();
      this.artifactStore.releaseInstanceSync();
    };
    this.#runtime = options.runtime;
    this.#runtime.setDownloadPublisher((download) => this.#publishDownload(download));
    this.#executionKernel = options.executionKernel;
    this.#idleShutdownMs = options.idleShutdownMs;
    this.#playwrightVersion = options.playwrightVersion;
    this.#scheduleIdleShutdown = options.scheduleIdleShutdown;
    this.#unsubscribeArtifactEvents = options.artifactStore.subscribe((event) => {
      const notify = this.#resourceNotifications.get(event.connectionId);
      if (!notify) return;
      notify().catch((error: unknown) => {
        console.error(
          `[chrome-mcp] resource list notification failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
    const publisher = new StoreArtifactPublisher(options.artifactStore, (connectionId) => {
      const connection = this.#connectionStates.get(connectionId);
      if (!connection || connection.closed) throw new Error("Chrome artifact connection is not active");
      return connection.artifactConnection;
    });
    this.#pageAdapter = new ChromePageAdapter({
      ...(options.snapshotConnector === undefined ? {} : { connectSnapshot: options.snapshotConnector }),
      resolveContext: (contextId) => this.#runtimeForContext(contextId),
      resolveScope: (scope) => {
        const mode = this.#modeByScope.get(modeScopeKey(scope));
        if (!mode) {
          throw new ChromeMcpExecutionError(
            "CHROME_MCP_BROWSER_DISCONNECTED",
            "Chrome browser generation is no longer active",
          );
        }
        return mode.runtime;
      },
      resolveTarget: (targetId) => this.#runtimeForTarget(targetId),
    });
    const trace = new PlaywrightTraceAdapter(
      options.capture?.tracingResolver ?? this.#pageAdapter,
      this.#captureOutputPaths,
    );
    this.#video = new CdpFfmpegVideoAdapter({
      cdp: this.#pageAdapter,
      ...(options.capture?.ffmpegExecutable === undefined ?
        {}
      : { executable: options.capture.ffmpegExecutable }),
      outputPaths: this.#captureOutputPaths,
      ...(options.capture?.ffmpegProcesses === undefined ?
        {}
      : { processes: options.capture.ffmpegProcesses }),
    });
    this.#captureManager = new CaptureManager({ artifacts: publisher, trace, video: this.#video });
    this.#checkpointManager = new CheckpointManager({
      artifacts: publisher,
      pixels: new PixelmatchPixelDiffAdapter(),
      runtime: this.#pageAdapter,
    });
    const pageProvider: SelectedPageProvider = {
      acquire: (call) => this.#diagnosticPage(call),
      release: () => Promise.resolve(),
    };
    const outputPaths: DiagnosticOutputPathResolver = {
      resolveDirectory: (request) =>
        this.#diagnosticOutputPaths(request.call.connectionId).resolveDirectory(request),
      resolveFile: (request) => this.#diagnosticOutputPaths(request.call.connectionId).resolveFile(request),
    };
    this.#performance = new PerformanceDiagnostics({ outputPaths, pageProvider });
    this.#lighthouse = new LighthouseDiagnostics({ outputPaths, pageProvider });
    this.#heap = new HeapSnapshotDiagnostics({ outputPaths, pageProvider });
    this.handlers = {
      analyzeHeapSnapshot: (args, context) => this.analyzeSavedHeap(args, context),
      lighthouseAudit: (args, context) =>
        this.#diagnostic(args, context, (call) =>
          this.#lighthouse.audit(call, {
            device: args.device,
            mode: args.mode,
            ...(args.outputDirPath === undefined ? {} : { outputDirPath: args.outputDirPath }),
          }),
        ),
      performanceAnalyzeInsight: (args, context) =>
        this.#diagnostic(args, context, (call) =>
          this.#performance.analyzeInsight(
            call,
            args.insightName === undefined || args.insightSetId === undefined ?
              {}
            : { insightName: args.insightName, insightSetId: args.insightSetId },
          ),
        ),
      performanceStartTrace: (args, context) =>
        this.#diagnostic(args, context, (call) =>
          this.#performance.startTrace(call, {
            autoStop: args.autoStop,
            reload: args.reload,
            ...(args.filePath === undefined ? {} : { filePath: args.filePath }),
          }),
        ),
      performanceStopTrace: (args, context) =>
        this.#diagnostic(args, context, (call) =>
          this.#performance.stopTrace(call, args.filePath === undefined ? {} : { filePath: args.filePath }),
        ),
      runPlaywright: (args, context) =>
        this.#runPlaywright(args, context).catch((error: unknown) =>
          failureEnvelope([], serializeServiceError(error, "CHROME_MCP_BROWSER_DISCONNECTED"), null),
        ),
      reactListComponents: (args, context) => this.#reactListComponents(args, context),
      reactInspectComponent: (args, context) => this.#reactInspectComponent(args, context),
      reactUpdateComponent: (args, context) => this.#reactUpdateComponent(args, context),
      reactHighlightComponent: (args, context) => this.#reactHighlightComponent(args, context),
      reactProfileStart: (args, context) => this.#reactProfileStart(args, context),
      reactProfileStop: (args, context) => this.#reactProfileStop(args, context),
      reactProfileAnalyze: (args, context) => this.#reactProfileAnalyze(args, context),
      takeHeapSnapshot: (args, context) =>
        this.#diagnostic(args, context, (call) =>
          this.#heap.takeSnapshot(call, {
            filePath: args.filePath,
            ...(args.analysis === undefined ? {} : { analysis: args.analysis }),
          }),
        ),
    };
    process.once("exit", this.#cleanupOwnedRootsOnExit);
  }

  artifactConnection(context: ChromeToolContext): ArtifactConnection {
    return this.artifactConnectionForSession(requireToolSession(context));
  }

  artifactConnectionForSession(session: NonNullable<ChromeToolContext["session"]>): ArtifactConnection {
    const pending = this.#connections.get(session.connectionId);
    if (!pending) throw new Error("Chrome connection has not acquired artifact ownership");
    const connection = this.#connectionStates.get(session.connectionId);
    if (!connection || connection.closed) throw new Error("Chrome connection is not active");
    return connection.artifactConnection;
  }

  async closeConnection(context: ChromeToolContext): Promise<void> {
    await this.closeSession(requireToolSession(context));
  }

  async connectSession(
    session: NonNullable<ChromeToolContext["session"]>,
    notifyResourcesListChanged: () => Promise<void>,
  ): Promise<void> {
    const connection = await this.#connectionForSession(session);
    this.#resourceNotifications.set(connection.artifactConnection.connectionId, notifyResourcesListChanged);
  }

  async closeSession(session: NonNullable<ChromeToolContext["session"]>): Promise<void> {
    const pending = this.#connections.get(session.connectionId);
    if (!pending) return;
    this.#connections.delete(session.connectionId);
    const connection = await pending;
    this.#resourceNotifications.delete(connection.artifactConnection.connectionId);
    await this.#closeState(connection);
  }

  async sessionResources(session: NonNullable<ChromeToolContext["session"]>) {
    const connection = await this.#connectionForSession(session);
    const resources = createArtifactSessionResourceAdapter<NonNullable<ChromeToolContext["session"]>>({
      store: this.artifactStore,
    });
    return resources.manifestResources(connection.artifactConnection);
  }

  async #closeState(connection: ConnectionState): Promise<void> {
    if (connection.closed || connection.closing) return;
    connection.closing = true;

    for (const controller of connection.heapQueries.keys()) {
      controller.abort(
        new ChromeMcpExecutionError("CHROME_MCP_CANCELLED", "Chrome connection closed during heap analysis"),
      );
    }

    await Promise.allSettled(connection.heapQueries.values());

    this.#connections.delete(connection.session.connectionId);
    this.#resourceNotifications.delete(connection.artifactConnection.connectionId);
    await Promise.allSettled([
      ...connection.modeAcquisitions.values(),
      ...connection.modeRecoveries.values(),
    ]);
    connection.modeAcquisitions.clear();
    connection.modeRecoveries.clear();
    connection.reactProfiles.clear();
    connection.reactAnalysisCursors.clear();
    await this.#captureManager.finalizeConnection(connection.session.connectionId).catch(() => undefined);
    for (const [captureId, scope] of this.#captureScopes) {
      if (scope.connectionId === connection.session.connectionId) this.#captureScopes.delete(captureId);
    }
    await this.#performance.releaseConnection(connection.session.connectionId).catch(() => undefined);
    await this.#lighthouse.releaseConnection(connection.session.connectionId).catch(() => undefined);
    connection.closed = true;
    await this.#checkpointManager.releaseConnection(connection.session.connectionId);
    this.#pageAdapter.releaseConnection(connection.session.connectionId);
    const pages = [...this.#diagnosticPages.entries()].filter(([key]) =>
      key.startsWith(`${connection.session.connectionId}\0`),
    );
    for (const [key, page] of pages) {
      this.#diagnosticPages.delete(key);
      await page.then((value) => value.close()).catch(() => undefined);
    }
    for (const mode of connection.modes.values()) {
      stopModeTimerAndWatchers(mode);
    }

    const sessionResults = await Promise.allSettled(
      [...connection.modes.values()].map((mode) => mode.runtime.close()),
    );
    const connectionResults = await Promise.allSettled([
      this.#runtime.closeConnection(connection.session.connectionId),
    ]);
    const results = [...sessionResults, ...connectionResults];
    for (const mode of connection.modes.values()) {
      const ownerUse = this.unregisterModeScope(mode);
      if (ownerUse === "owner-unused") {
        await this.#pageAdapter.releaseOwner(mode.runtime.ownerId, mode.runtime.ownerGeneration);
      }
    }

    connection.modes.clear();
    this.#connectionStates.delete(connection.session.connectionId);
    await this.artifactStore.closeConnection(connection.artifactConnection);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Chrome connection cleanup failed",
      );
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failures: unknown[] = [];
    const connections = await Promise.allSettled(this.#connections.values());
    for (const result of connections) {
      if (result.status !== "fulfilled") {
        failures.push(result.reason);
        continue;
      }
      const connection = result.value;
      if (connection.closed) continue;
      await this.#closeState(connection).catch((error: unknown) => {
        failures.push(error);
      });
    }
    await this.#captureManager.shutdown().catch((error: unknown) => {
      failures.push(error);
    });
    this.#runtime.setDownloadPublisher(undefined);
    await this.#runtime.close().catch((error: unknown) => {
      failures.push(error);
    });
    await this.#pageAdapter.close().catch((error: unknown) => {
      failures.push(error);
    });
    await this.#captureOutputPaths.close().catch((error: unknown) => {
      failures.push(error);
    });
    this.#unsubscribeArtifactEvents();
    this.#resourceNotifications.clear();
    await this.artifactStore.close().catch((error: unknown) => {
      failures.push(error);
    });
    await this.artifactStore.removeEmptyInstance().catch((error: unknown) => {
      failures.push(error);
    });
    process.off("exit", this.#cleanupOwnedRootsOnExit);
    if (failures.length > 0) throw new AggregateError(failures, "Chrome service cleanup failed");
  }

  async #connection(context: ChromeToolContext): Promise<ConnectionState> {
    return this.#connectionForSession(requireToolSession(context));
  }

  async #publishDownload(download: RemoteDownloadFinished): Promise<RemoteDownloadPublication> {
    const connection = this.#connectionStates.get(download.connectionId);
    if (!connection || connection.closed || connection.closing) {
      throw new Error("Chrome download owner connection is not active");
    }
    const publication = await this.artifactStore.beginPublication(connection.artifactConnection);
    try {
      const suggestedName = basename(download.suggestedFilename ?? download.downloadId);
      const name =
        !suggestedName || suggestedName === "." || suggestedName === ".." ?
          `download-${download.downloadId}`
        : suggestedName;
      const artifact = await this.artifactStore.publishFile(publication, download.path, {
        name,
        origin: {
          browserMode: download.browserMode,
          targetId: download.targetId,
          tool: "download",
        },
      });
      return { artifactUri: artifact.uri, byteCount: artifact.size };
    } finally {
      await this.artifactStore.finishPublication(publication);
    }
  }

  async #connectionForSession(session: NonNullable<ChromeToolContext["session"]>): Promise<ConnectionState> {
    if (this.#closed) throw new Error("Chrome service is closed");
    let pending = this.#connections.get(session.connectionId);
    if (!pending) {
      pending = createDiagnosticOutputPathResolver({
        baseDirectory: session.pathContext.baseCwd,
      }).then(async (diagnosticOutputPaths) => {
        const artifactConnection = await this.artifactStore.openConnection();
        const connection: ConnectionState = {
          artifactConnection,
          closed: false,
          closing: false,
          diagnosticOutputPaths,
          heapQueries: new Map(),
          modeAcquisitions: new Map(),
          modeRecoveries: new Map(),
          modes: new Map(),
          reactAnalysisCursors: new Map(),
          reactProfiles: new Map(),
          session,
        };
        this.#connectionStates.set(session.connectionId, connection);
        return connection;
      });
      this.#connections.set(session.connectionId, pending);
      pending.catch(() => {
        if (this.#connections.get(session.connectionId) === pending) {
          this.#connections.delete(session.connectionId);
        }
      });
    }
    return pending;
  }

  async #mode(
    connection: ConnectionState,
    browserMode: BrowserMode,
    options: BrowserInstanceOptions = {},
  ): Promise<ModeState> {
    if (connection.closing || connection.closed) throw new Error("Chrome connection is closing");

    const { browserInstanceId, nativeDeviceScaleFactor } = options;
    assertNativeDeviceScaleFactor(browserMode, nativeDeviceScaleFactor);

    const key = browserInstanceKey(browserMode, browserInstanceId);
    this.#recoverDisconnectedModes(connection);
    const recovery = connection.modeRecoveries.get(key);
    if (recovery) await recovery;
    const existing = connection.modes.get(key);
    if (existing) {
      assertMatchingNativeDeviceScaleFactor(existing.nativeDeviceScaleFactor, nativeDeviceScaleFactor);
      return existing;
    }

    let pending = connection.modeAcquisitions.get(key);
    if (!pending) {
      pending = this.#runtime
        .acquire(connection.session.connectionId, browserMode, options)
        .then(async (runtime) => {
          if (connection.closing || connection.closed) {
            await runtime.close();
            throw new Error("Chrome connection closed during browser acquisition");
          }
          const mode = this.#createModeState(runtime, options);
          connection.modes.set(key, mode);
          this.#modeByScope.set(modeScopeKey(createBrowserScope(runtime)), mode);
          return mode;
        });
      connection.modeAcquisitions.set(key, pending);
    }
    try {
      const mode = await pending;
      assertMatchingNativeDeviceScaleFactor(mode.nativeDeviceScaleFactor, nativeDeviceScaleFactor);
      return mode;
    } finally {
      if (connection.modeAcquisitions.get(key) === pending) {
        connection.modeAcquisitions.delete(key);
      }
    }
  }

  #createModeState(runtime: ChromeServiceRuntimeSession, options: BrowserInstanceOptions): ModeState {
    return {
      admissionTail: Promise.resolve(),
      ...(options.browserInstanceId === undefined ? {} : { browserInstanceId: options.browserInstanceId }),
      ...(options.nativeDeviceScaleFactor === undefined ?
        {}
      : { nativeDeviceScaleFactor: options.nativeDeviceScaleFactor }),
      cancelIdleShutdown: () => undefined,
      idleShutdownGeneration: 0,
      inFlightCalls: 0,
      releaseNetworkWatcher: this.#pageAdapter.watchNetwork(runtime, (exchange) =>
        this.#captureManager.recordNetwork(exchange),
      ),
      releaseTargetWatcher: runtime.onCdp("Target.targetDestroyed", (payload) => {
        if (!isRecord(payload) || typeof payload.targetId !== "string") return;
        this.#releaseTargetResources(runtime, payload.targetId).catch((error: unknown) => {
          console.error(
            `[chrome-mcp] target resource cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }),
      runtime,
      state: [],
      terminated: false,
    };
  }

  private unregisterModeScope(mode: ModeState) {
    const scopeKey = modeScopeKey(createBrowserScope(mode.runtime));
    if (this.#modeByScope.get(scopeKey) === mode) {
      this.#modeByScope.delete(scopeKey);
    }

    const isOwnerStillActive = [...this.#modeByScope.values()].some((candidate) => {
      return (
        candidate.runtime.ownerId === mode.runtime.ownerId &&
        candidate.runtime.ownerGeneration === mode.runtime.ownerGeneration
      );
    });
    if (isOwnerStillActive) return "owner-active";

    this.#cdpMethods.delete(createOwnerKey(mode.runtime));

    return "owner-unused";
  }

  #recoverDisconnectedModes(connection: ConnectionState): void {
    for (const [key, mode] of connection.modes) {
      if ((!mode.terminated && !mode.runtime.closed) || connection.modeRecoveries.has(key)) continue;
      const recovery = (async () => {
        const browser = createBrowserScope(mode.runtime);
        const diagnosticCall: DiagnosticCall = {
          ...(mode.browserInstanceId === undefined ? {} : { browserInstanceId: mode.browserInstanceId }),
          ...(mode.nativeDeviceScaleFactor === undefined ?
            {}
          : { nativeDeviceScaleFactor: mode.nativeDeviceScaleFactor }),
          browserMode: mode.runtime.browserMode,
          connectionId: connection.session.connectionId,
        };
        await this.#captureManager.finalizeBrowser(browser).catch(() => undefined);
        for (const [captureId, scope] of this.#captureScopes) {
          if (isSameBrowserOwner(scope, browser)) this.#captureScopes.delete(captureId);
        }
        await this.#performance
          .releaseOwner(diagnosticCall, mode.runtime.ownerId, mode.runtime.ownerGeneration)
          .catch(() => undefined);
        await this.#checkpointManager.releaseBrowser(browser);
        const diagnosticPagePrefix = `${modeScopeKey(browser)}\0`;
        const pages = [...this.#diagnosticPages.entries()].filter(([pageKey]) =>
          pageKey.startsWith(diagnosticPagePrefix),
        );
        for (const [pageKey, page] of pages) {
          this.#diagnosticPages.delete(pageKey);
          await page.then((value) => value.close()).catch(() => undefined);
        }
        stopModeTimerAndWatchers(mode);
        connection.modes.delete(key);

        const ownerUse = this.unregisterModeScope(mode);
        if (ownerUse === "owner-unused") {
          await this.#pageAdapter
            .releaseOwner(mode.runtime.ownerId, mode.runtime.ownerGeneration)
            .catch(() => undefined);
        }

        await mode.runtime.close().catch(() => undefined);
      })();
      connection.modeRecoveries.set(key, recovery);
      recovery
        .finally(() => {
          if (connection.modeRecoveries.get(key) === recovery) connection.modeRecoveries.delete(key);
        })
        .catch(() => undefined);
    }
  }

  async #admit<Result>(
    connection: ConnectionState,
    mode: ModeState,
    operation: BrowserCallAdmission<Result>,
  ): Promise<Result> {
    mode.inFlightCalls += 1;
    mode.cancelIdleShutdown();
    const admitted = mode.admissionTail.then(() => mode.runtime.admit(operation));
    mode.admissionTail = admitted.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await admitted;
    } finally {
      mode.inFlightCalls -= 1;
      this.#armIdleShutdown(connection, mode);
    }
  }

  #armIdleShutdown(connection: ConnectionState, mode: ModeState): void {
    if (!isNamedBrowserMode(mode.runtime.browserMode)) return;
    if (mode.inFlightCalls > 0 || mode.terminated || mode.runtime.closed) return;
    if (this.#closed || connection.closed || connection.closing) return;
    const generation = ++mode.idleShutdownGeneration;
    let fired = false;
    const cancel = this.#scheduleIdleShutdown(this.#idleShutdownMs, () => {
      // a fire from a superseded arm must not touch the currently armed timer
      if (generation !== mode.idleShutdownGeneration) return;
      fired = true;
      mode.cancelIdleShutdown = () => undefined;
      if (mode.inFlightCalls > 0 || mode.terminated || mode.runtime.closed) return;
      if (this.#closed || connection.closed || connection.closing) return;
      // same terminal transaction as an authorized owner close: the next call recovers a fresh owner
      mode.terminated = true;
      mode.runtime.close().catch((error: unknown) => {
        console.error(
          `[chrome-mcp] idle browser shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
    if (fired) return;
    mode.cancelIdleShutdown = () => {
      mode.cancelIdleShutdown = () => undefined;
      cancel();
    };
  }

  async #reactBrowserCall(
    args: BrowserSelection,
    context: ChromeToolContext,
    input: ReactBrowserOperation,
  ): Promise<Readonly<{ connection: ConnectionState; mode: ModeState; result: ReactOperationResult }>> {
    const connection = await this.#connection(context);
    const mode = await this.#mode(connection, args.browser, args);
    const result = await this.#admit(connection, mode, {
      modalPolicy: "reject",
      run: () => mode.runtime.react(input),
    });
    return { connection, mode, result };
  }

  async #reactResult(
    connection: ConnectionState,
    mode: ModeState,
    result: ReactOperationResult,
    tool: string,
  ) {
    return this.#boundedReactResult(
      connection,
      mode,
      {
        browserMode: mode.runtime.browserMode,
        ownerGeneration: mode.runtime.ownerGeneration,
        ...result,
      },
      result.targetId,
      tool,
    );
  }

  async #boundedReactResult(
    connection: ConnectionState,
    mode: ModeState,
    result: Readonly<Record<string, unknown>>,
    targetId: string,
    tool: string,
  ) {
    const structured = { ok: true, ...result };
    const encoded = Buffer.from(JSON.stringify(structured, null, 2), "utf8");
    if (encoded.byteLength <= REACT_INLINE_RESULT_MAX_BYTES) return reactSuccessEnvelope(result);
    const publication = await this.artifactStore.beginPublication(connection.artifactConnection);
    let artifact: ArtifactDescriptor;
    try {
      artifact = await this.artifactStore.publishBytes(publication, encoded, {
        mediaType: "application/json",
        name: `${tool}-${randomUUID()}.json`,
        origin: artifactOrigin(mode, targetId, tool),
      });
    } finally {
      await this.artifactStore.finishPublication(publication);
    }
    const inlineData =
      isRecord(result.data) && "profile" in result.data ?
        { ...result.data, inlineTruncated: true, profile: null, profileArtifact: artifact }
      : { artifact, inlineTruncated: true };
    const inline = "data" in result ? { ...result, data: inlineData } : { artifact, inlineTruncated: true };
    return reactSuccessEnvelope(inline, [artifact]);
  }

  async #reactListComponents(args: ReactListComponentsInput, context: ChromeToolContext) {
    try {
      const call = await this.#reactBrowserCall(args, context, {
        limit: args.limit,
        operation: "list",
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        ...(args.parentComponentId === undefined ? {} : { parentComponentId: args.parentComponentId }),
        ...(args.rendererId === undefined ? {} : { rendererId: args.rendererId }),
        ...(args.rootId === undefined ? {} : { rootId: args.rootId }),
        ...(args.search === undefined ? {} : { search: args.search }),
      });
      return await this.#reactResult(call.connection, call.mode, call.result, "react_list_components");
    } catch (error: unknown) {
      return reactFailureEnvelope(error);
    }
  }

  async #reactInspectComponent(args: ReactInspectComponentInput, context: ChromeToolContext) {
    try {
      if (args.lookup.type !== "snapshot-ref") {
        const call = await this.#reactBrowserCall(args, context, {
          lookup: args.lookup,
          operation: "inspect",
        });
        return await this.#reactResult(call.connection, call.mode, call.result, "react_inspect_component");
      }
      const ref = args.lookup.ref;
      const connection = await this.#connection(context);
      const mode = await this.#mode(connection, args.browser, args);
      const result = await this.#admit(connection, mode, {
        modalPolicy: "reject",
        run: async () => {
          await mode.runtime.react({ operation: "prepare" });
          const staged = await this.#pageAdapter.stageSnapshotElement(
            mode.runtime,
            mode.runtime.currentTarget(),
            ref,
          );
          let outcome:
            | Readonly<{ error: unknown; ok: false }>
            | Readonly<{ ok: true; value: ReactOperationResult }>;
          try {
            outcome = {
              ok: true,
              value: await mode.runtime.react({
                lookup: { key: staged.key, type: "staged-node" },
                operation: "inspect",
              }),
            };
          } catch (error: unknown) {
            outcome = { error, ok: false };
          }
          let releaseError: unknown;
          try {
            await staged.release();
          } catch (error: unknown) {
            releaseError = error;
          }
          if (!outcome.ok) {
            if (releaseError === undefined) throw outcome.error;
            const inspectionError = serializeServiceError(outcome.error, "CHROME_MCP_EXECUTION_FAILED");
            const message = releaseError instanceof Error ? releaseError.message : String(releaseError);
            throw new ChromeMcpExecutionError(
              inspectionError.code,
              `${inspectionError.message}; React snapshot-ref staging cleanup also failed: ${message}`,
              { cause: new AggregateError([outcome.error, releaseError]) },
            );
          }
          if (releaseError !== undefined) throw releaseError;
          return outcome.value;
        },
      });
      return await this.#reactResult(connection, mode, result, "react_inspect_component");
    } catch (error: unknown) {
      return reactFailureEnvelope(error);
    }
  }

  async #reactUpdateComponent(args: ReactUpdateComponentInput, context: ChromeToolContext) {
    try {
      const call = await this.#reactBrowserCall(args, context, {
        componentId: args.componentId,
        location: args.location,
        operation: "update",
        value: args.value,
      });
      return await this.#reactResult(call.connection, call.mode, call.result, "react_update_component");
    } catch (error: unknown) {
      return reactFailureEnvelope(error);
    }
  }

  async #reactHighlightComponent(args: ReactHighlightComponentInput, context: ChromeToolContext) {
    try {
      const call = await this.#reactBrowserCall(args, context, {
        action: args.action,
        operation: "highlight",
      });
      return await this.#reactResult(call.connection, call.mode, call.result, "react_highlight_component");
    } catch (error: unknown) {
      return reactFailureEnvelope(error);
    }
  }

  async #reactProfileStart(args: ReactProfileStartInput, context: ChromeToolContext) {
    try {
      const call = await this.#reactBrowserCall(args, context, { operation: "profile-start" });
      const profileId = requireString(call.result.data.profileId, "React profile ID");
      const startedAt = requireString(call.result.data.startedAt, "React profile start time");
      call.connection.reactProfiles.set(profileId, { kind: "active", mode: call.mode, startedAt });
      return await this.#reactResult(call.connection, call.mode, call.result, "react_profile_start");
    } catch (error: unknown) {
      return reactFailureEnvelope(error);
    }
  }

  async #reactProfileStop(args: ReactProfileStopInput, context: ChromeToolContext) {
    let connection: ConnectionState | undefined;
    try {
      connection = await this.#connection(context);
      const profile = connection.reactProfiles.get(args.profileId);
      if (!profile || profile.kind !== "active") {
        throw new ChromeMcpExecutionError(
          "CHROME_MCP_REACT_PROFILE_NOT_ACTIVE",
          "React profile is not active for this connection",
        );
      }
      if (profile.mode.terminated || profile.mode.runtime.closed) {
        connection.reactProfiles.delete(args.profileId);
        throw new ChromeMcpExecutionError(
          "CHROME_MCP_REACT_PROFILE_EXPIRED",
          "React profile browser owner is no longer active",
        );
      }
      const result = await this.#admit(connection, profile.mode, {
        modalPolicy: "allow",
        run: () => profile.mode.runtime.react({ operation: "profile-stop", profileId: args.profileId }),
      });
      const size = Buffer.byteLength(JSON.stringify(result), "utf8");
      if (result.data.status === "complete" && result.data.profile !== null) {
        connection.reactProfiles.set(args.profileId, {
          completedAt: new Date().toISOString(),
          kind: "completed",
          mode: profile.mode,
          result,
          size,
        });
      } else {
        connection.reactProfiles.delete(args.profileId);
      }
      evictCompletedReactProfiles(connection);
      return await this.#reactResult(connection, profile.mode, result, "react_profile_stop");
    } catch (error: unknown) {
      if (connection && isRecord(error) && error.code === "CHROME_MCP_REACT_PROFILE_EXPIRED") {
        connection.reactProfiles.delete(args.profileId);
      }
      return reactFailureEnvelope(error);
    }
  }

  async #reactProfileAnalyze(args: ReactProfileAnalyzeInput, context: ChromeToolContext) {
    try {
      const connection = await this.#connection(context);
      const profile = connection.reactProfiles.get(args.profileId);
      if (!profile || profile.kind !== "completed") {
        throw new ChromeMcpExecutionError(
          "CHROME_MCP_REACT_PROFILE_EXPIRED",
          "Completed React profile is unavailable for this connection",
        );
      }
      const metrics = args.metrics ?? [...REACT_PROFILE_ANALYSIS_METRICS];
      const includeChangeDescriptions = args.includeChangeDescriptions ?? false;
      let rows: readonly ReactProfileAnalysisRow[];
      let index = 0;
      let reusableCursor: readonly [string, ReactAnalysisCursor] | undefined;
      if (args.cursor) {
        const cursor = connection.reactAnalysisCursors.get(args.cursor);
        if (
          !cursor ||
          cursor.profileId !== args.profileId ||
          cursor.includeChangeDescriptions !== includeChangeDescriptions ||
          !sameReactAnalysisMetrics(cursor.metrics, metrics)
        ) {
          throw new ChromeMcpExecutionError(
            "CHROME_MCP_REACT_STALE_CURSOR",
            "React profile analysis cursor is stale",
          );
        }
        rows = cursor.rows;
        index = cursor.index;
        connection.reactAnalysisCursors.delete(args.cursor);
      } else {
        reusableCursor = [...connection.reactAnalysisCursors].find(
          ([, cursor]) =>
            cursor.profileId === args.profileId &&
            cursor.limit === args.limit &&
            cursor.includeChangeDescriptions === includeChangeDescriptions &&
            sameReactAnalysisMetrics(cursor.metrics, metrics),
        );
        rows =
          reusableCursor?.[1].rows ??
          rankReactProfileRows(
            analyzeReactProfile(profile.result.data.profile),
            metrics[0] ?? "total-inclusive-duration",
          );
      }
      const mintedCursor = randomUUID();
      const nextCursorId = (nextIndex: number) =>
        reusableCursor !== undefined && reusableCursor[1].index === nextIndex ?
          reusableCursor[0]
        : mintedCursor;
      const { envelope, nextIndex } = await this.reactAnalysisPage({
        args,
        connection,
        index,
        metrics,
        nextCursorId,
        profile,
        rows,
      });
      if (nextIndex < rows.length) {
        for (const [cursorId, cursor] of connection.reactAnalysisCursors) {
          if (cursor.profileId === args.profileId) {
            connection.reactAnalysisCursors.delete(cursorId);
          }
        }
        connection.reactAnalysisCursors.set(nextCursorId(nextIndex), {
          includeChangeDescriptions,
          index: nextIndex,
          limit: args.limit,
          metrics,
          profileId: args.profileId,
          rows,
        });
      } else if (!args.cursor) {
        for (const [cursorId, cursor] of connection.reactAnalysisCursors) {
          if (cursor.profileId === args.profileId) {
            connection.reactAnalysisCursors.delete(cursorId);
          }
        }
      }
      return envelope;
    } catch (error: unknown) {
      return reactFailureEnvelope(error);
    }
  }

  private async reactAnalysisPage(
    options: Readonly<{
      args: ReactProfileAnalyzeInput;
      connection: ConnectionState;
      index: number;
      metrics: readonly string[];
      nextCursorId: (nextIndex: number) => string;
      profile: Extract<ReactProfileRecord, { kind: "completed" }>;
      rows: readonly ReactProfileAnalysisRow[];
    }>,
  ) {
    const { args, connection, index, metrics, nextCursorId, profile, rows } = options;
    const candidates = rows.slice(index, index + args.limit);
    const inlineRow = ({ changeDescriptions, ...row }: ReactProfileAnalysisRow) => row;
    const pageResultFor = (selected: readonly ReactProfileAnalysisRow[]) => ({
      metrics,
      nextCursor: index + selected.length < rows.length ? nextCursorId(index + selected.length) : null,
      profileId: args.profileId,
      results: selected.map(inlineRow),
      totalResults: rows.length,
    });
    const envelopeBytes = (selected: readonly ReactProfileAnalysisRow[]) =>
      Buffer.byteLength(JSON.stringify(reactSuccessEnvelope(pageResultFor(selected))));

    const inlineBudget = REACT_ANALYSIS_RESULT_MAX_BYTES - 8 * 1024;
    let budgeted = envelopeBytes([]);
    let fitting = 0;
    for (const row of candidates) {
      budgeted += Buffer.byteLength(JSON.stringify(inlineRow(row))) + 1;
      if (fitting > 0 && budgeted > inlineBudget) {
        break;
      }

      fitting += 1;
    }

    let page = candidates.slice(0, Math.max(fitting, 1));
    while (page.length > 1 && envelopeBytes(page) > inlineBudget) {
      page = page.slice(0, -1);
    }

    const result = pageResultFor(page);
    const oversizedRow = Buffer.byteLength(JSON.stringify(reactSuccessEnvelope(result))) > inlineBudget;
    const artifacts: ArtifactDescriptor[] = [];
    const inline: Record<string, unknown> = { ...result };
    if (args.includeChangeDescriptions || oversizedRow) {
      const publication = await this.artifactStore.beginPublication(connection.artifactConnection);
      try {
        if (oversizedRow) {
          const artifact = await this.artifactStore.publishBytes(
            publication,
            Buffer.from(JSON.stringify(result)),
            {
              mediaType: "application/json",
              name: "react-profile-analysis.json",
              origin: artifactOrigin(profile.mode, profile.result.targetId, "react_profile_analyze"),
            },
          );
          artifacts.push(artifact);
          inline.results = [];
          inline.resultsArtifact = artifact;
        }
        if (args.includeChangeDescriptions) {
          const artifact = await this.artifactStore.publishBytes(
            publication,
            Buffer.from(
              JSON.stringify({
                profileId: args.profileId,
                results: page.map(({ changeDescriptions, componentId }) => ({
                  changeDescriptions,
                  componentId,
                })),
              }),
            ),
            {
              mediaType: "application/json",
              name: "react-profile-change-descriptions.json",
              origin: artifactOrigin(profile.mode, profile.result.targetId, "react_profile_analyze"),
            },
          );
          artifacts.push(artifact);
          inline.changeDescriptionsArtifact = artifact;
        }
      } finally {
        await this.artifactStore.finishPublication(publication);
      }
    }
    const envelope = reactSuccessEnvelope(inline, artifacts);
    if (Buffer.byteLength(JSON.stringify(envelope)) > REACT_ANALYSIS_RESULT_MAX_BYTES) {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_EXECUTION_FAILED",
        "React profile analysis response exceeds its inline byte limit",
      );
    }
    return { envelope, nextIndex: index + page.length };
  }

  async #runPlaywright(args: RunPlaywrightInput, context: ChromeToolContext) {
    const connection = await this.#connection(context);
    const mode = await this.#mode(connection, args.browser, args);
    const operation = {
      modalPolicy: "allow",
      run: async (signal: AbortSignal) => {
        const artifacts = artifactTracker();
        const publication = await this.artifactStore.beginPublication(connection.artifactConnection);
        let selection: ServiceSelection;
        try {
          selection = await mode.runtime.beginSelection();
        } catch (error: unknown) {
          await this.artifactStore.finishPublication(publication);
          return failureEnvelope([], serializeServiceError(error, "CHROME_MCP_BROWSER_DISCONNECTED"), null);
        }
        const rpcState: CallRpcState = {
          artifacts,
          connection,
          context,
          mode,
          ownerCloseAuthorized: false,
          publication,
          reservations: new Map(),
          selection,
          temporaryDirectories: [],
        };
        let result: ExecutionKernelResult;
        let publicationError: unknown;
        let privateEndpoint: string | undefined;
        let unavailableTargets: BrowserOwnerSnapshot["unavailableTargets"];
        const diagnosticStart = await mode.runtime.currentEventCursor().catch(() => undefined);

        try {
          const worker = await mode.runtime.workerConnection();
          privateEndpoint = worker.executionEndpoint;
          const adapter: ExecutionBrokerRpcAdapter = {
            execute: (request, rpcContext) => this.#executeRpc(request, rpcContext, rpcState),
          };
          const capabilities = await this.#capabilities(mode);
          unavailableTargets = capabilities.unavailableTargets;
          result = await this.#executionKernel({
            adapter,
            onDebugLog: ({ stderr, stdout }) => {
              if (stdout) context.log.debug("run_playwright worker stdout", { output: stdout });
              if (stderr) context.log.debug("run_playwright worker stderr", { output: stderr });
            },
            request: {
              args: copyJsonValue(args.args, "Playwright arguments"),
              browserMode: args.browser,
              callId: randomUUID(),
              capabilities: capabilities.value,
              cdpEndpoint: worker.executionEndpoint,
              code: args.code,
              connectTimeoutMs: Math.min(10_000, args.timeoutMs),
              dialog: selectedDialog(mode.runtime),
              ...(worker.downloadsPath === undefined ? {} : { downloadsPath: worker.downloadsPath }),
              fileChooser: selectedFileChooser(mode.runtime),
              selectedTargetId: worker.target.targetId,
              state: mode.state,
            },
            signal,
            timeoutMs: args.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
          });
        } catch (error: unknown) {
          let selectedTargetId: string | null = null;
          try {
            selectedTargetId = mode.runtime.currentTarget().targetId;
          } catch {
            selectedTargetId = null;
          }
          result = {
            artifacts: [],
            error: serializeServiceError(
              error,
              "CHROME_MCP_WORKER_CRASH",
              privateEndpoint === undefined ? [] : [privateEndpoint],
            ),
            ok: false,
            selectedTargetId,
          };
        } finally {
          try {
            await Promise.all(
              rpcState.temporaryDirectories.map((directory) =>
                rm(directory, { force: true, recursive: true }),
              ),
            );
          } catch (error: unknown) {
            publicationError = error;
          }
          try {
            await this.artifactStore.finishPublication(publication);
          } catch (error: unknown) {
            publicationError ??= error;
          }
        }
        let rendering: RunPlaywrightSuccessOutput["rendering"];
        if (publicationError === undefined) {
          try {
            result = validateExecutionArtifactProvenance(result, artifacts);
          } catch (error: unknown) {
            result = {
              artifacts: [],
              error: serializeServiceError(error, "CHROME_MCP_WORKER_CRASH"),
              ok: false,
              selectedTargetId: result.selectedTargetId,
            };
          }
        } else {
          result = {
            artifacts: artifacts.list(),
            error: serializeServiceError(publicationError, "CHROME_MCP_WORKER_CRASH"),
            ok: false,
            selectedTargetId: result.selectedTargetId,
          };
        }
        if (!result.ok) {
          const diagnostics = await collectFailureDiagnostics(
            mode.runtime,
            diagnosticStart,
            result.selectedTargetId ?? selection.current().targetId,
          );
          try {
            if (result.error.code === "CHROME_MCP_BROWSER_DISCONNECTED") {
              mode.terminated = true;
              await mode.runtime.invalidateOwner();
            } else {
              await mode.runtime.enableOwnedDownloads();
            }
            const selected = await selection.rollback();
            return failureEnvelope(artifacts.list(), result.error, selected.targetId, {
              diagnostics,
              partial: partialFailureOutput(result),
            });
          } catch (error: unknown) {
            const cleanupError = serializeServiceError(error, "CHROME_MCP_BROWSER_DISCONNECTED");
            const sameFailure =
              cleanupError.code === result.error.code && cleanupError.message === result.error.message;
            return failureEnvelope(
              artifacts.list(),
              {
                ...result.error,
                message:
                  sameFailure ?
                    result.error.message
                  : `${result.error.message}; Chrome failure cleanup also failed (${cleanupError.code}: ${cleanupError.message})`,
              },
              null,
              { diagnostics, partial: partialFailureOutput(result) },
            );
          }
        }
        if (rpcState.ownerCloseAuthorized) {
          mode.terminated = true;
          return successEnvelope({ artifacts: artifacts.list(), result, selectedTargetId: null });
        }
        let selected: GenerationTargetId;
        let hasStartedSelectionCommit = false;

        try {
          if (result.selectedTargetId !== selection.current().targetId) {
            throw new ChromeMcpExecutionError(
              "CHROME_MCP_WORKER_CRASH",
              "Execution result selected target does not match the broker selection transaction",
            );
          }

          await mode.runtime.enableOwnedDownloads();

          if (mode.runtime.browserMode === "isolated-virtual-display") {
            const prepared = await selection.prepare();
            selected = prepared.target;

            if (!prepared.hasBlockingDialog) {
              rendering = await readRenderingInfo(mode.runtime, selected.targetId);
            }
          }

          hasStartedSelectionCommit = true;
          selected = await selection.commit();
        } catch (error: unknown) {
          let failure = serializeServiceError(error, "CHROME_MCP_BROWSER_DISCONNECTED");
          let selectedTargetId: string | null = null;

          try {
            const target =
              hasStartedSelectionCommit ? mode.runtime.currentTarget() : await selection.rollback();
            if (await mode.runtime.targetRecord(target.targetId)) selectedTargetId = target.targetId;
          } catch (cleanupError: unknown) {
            selectedTargetId = null;

            if (!hasStartedSelectionCommit) {
              const cleanupFailure = serializeServiceError(cleanupError, "CHROME_MCP_BROWSER_DISCONNECTED");
              failure = {
                ...failure,
                message: `${failure.message}; Chrome selection rollback also failed (${cleanupFailure.code}: ${cleanupFailure.message})`,
              };
            }
          }
          return failureEnvelope(artifacts.list(), failure, selectedTargetId);
        }
        mode.state = result.state;

        return successEnvelope({
          artifacts: artifacts.list(),
          result,
          rendering,
          selectedTargetId: selected.targetId,
          unavailableTargets,
        });
      },
    } satisfies BrowserCallAdmission<unknown>;
    let completed: Awaited<ReturnType<typeof operation.run>> | undefined;

    try {
      return await this.#admit(connection, mode, {
        ...operation,
        run: async (signal) => {
          completed = await operation.run(signal);
          return completed;
        },
      });
    } catch (error: unknown) {
      if (completed === undefined) {
        throw error;
      }

      const cleanupError = serializeServiceError(error, "CHROME_MCP_BROWSER_DISCONNECTED");
      const cleanupMessage = `Chrome admission cleanup failed (${cleanupError.code}: ${cleanupError.message})`;

      const { content: completedContent, structuredContent: output } = completed;
      const content: Content[] = [...completedContent];
      let structuredContent: RunPlaywrightFailureOutput;

      if (output.ok) {
        structuredContent = failureEnvelope(
          output.artifacts,
          cleanupError,
          output.selectedTargetId,
        ).structuredContent;

        if (output.value !== undefined) {
          content.push({ type: "text", text: canonicalJsonStringify(output.value) });
        }
      } else {
        structuredContent = {
          ...output,
          error: { ...output.error, message: `${output.error.message}; ${cleanupMessage}` },
        };
      }

      const unlinkedArtifacts = output.artifacts.filter(
        (artifact) =>
          !completedContent.some((item) => item.type === "resource_link" && item.uri === artifact.uri),
      );
      content.push(...unlinkedArtifacts.map(contentForArtifact), { type: "text", text: cleanupMessage });
      return { content, isError: true, structuredContent };
    }
  }

  async #executeRpc(
    request: BrokerRpcRequest,
    rpcContext: BrokerRpcExecutionContext,
    call: CallRpcState,
  ): Promise<{ artifacts?: ArtifactDescriptor[]; value: JsonValue }> {
    if (rpcContext.signal.aborted) throw rpcContext.signal.reason;
    switch (request.operation) {
      case "owner_close_authorize": {
        if (call.mode.inFlightCalls > 1) {
          throw new ChromeMcpExecutionError(
            "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
            "Browser-owner close is forbidden while another call is queued for this browser instance",
          );
        }
        await call.mode.runtime.authorizeOwnerClose(request.payload.resource);
        call.ownerCloseAuthorized = true;
        return { value: null };
      }
      case "artifact_output_path": {
        const reservation = await this.artifactStore.reserveOutput(
          call.publication,
          request.payload.name,
          request.payload.mediaType,
        );
        call.reservations.set(reservation.path, reservation);
        return { value: reservation.path };
      }
      case "artifact_file": {
        const origin = artifactOrigin(call.mode, call.selection.current().targetId, "run_playwright");
        const reservation = call.reservations.get(request.payload.path);
        const sourcePath =
          reservation ?
            request.payload.path
          : await resolveInputFile(call.connection.session.pathContext, request.payload.path);
        const artifact =
          reservation ?
            await this.artifactStore.publishReservation(call.publication, reservation, { origin })
          : await this.artifactStore.publishFile(call.publication, sourcePath, {
              ...(request.payload.mediaType === undefined ? {} : { mediaType: request.payload.mediaType }),
              origin,
            });
        call.reservations.delete(request.payload.path);
        call.artifacts.add(artifact);
        return { artifacts: [artifact], value: copyJsonValue(artifact, "Artifact descriptor") };
      }
      case "artifact_publish": {
        const origin = artifactOrigin(call.mode, call.selection.current().targetId, "run_playwright");
        const bytes = Buffer.from(request.payload.data, request.payload.encoding);
        if (request.payload.encoding === "base64" && bytes.toString("base64") !== request.payload.data) {
          throw new ChromeMcpExecutionError(
            "CHROME_MCP_INVALID_INPUT",
            "Artifact data is not canonical base64",
          );
        }
        const artifact = await this.artifactStore.publishBytes(call.publication, bytes, {
          mediaType: request.payload.mediaType,
          name: request.payload.name,
          origin,
        });
        call.artifacts.add(artifact);
        return { artifacts: [artifact], value: copyJsonValue(artifact, "Artifact descriptor") };
      }
      case "select_page": {
        await call.selection.select(request.payload.targetId);
        return { value: null };
      }
      case "media_emulate": {
        await this.#pageAdapter.emulateMedia(call.mode.runtime, {
          ...request.payload,
          signal: rpcContext.signal,
        });
        return { value: null };
      }
      case "page_viewport": {
        return { value: await call.mode.runtime.pageViewport(request.payload) };
      }
      case "pwa": {
        return { value: copyJsonValue(await call.mode.runtime.pwa(request.payload), "PWA result") };
      }
      case "mutation_add": {
        const entry = await call.mode.runtime.addMutation(request.payload.input, call.selection.current());
        return { value: copyJsonValue(entry, "Persistent mutation") };
      }
      case "mutation_list": {
        const entries = await call.mode.runtime.listMutations(request.payload.kind);
        return { value: copyJsonValue(entries, "Persistent mutation list") };
      }
      case "mutation_remove": {
        return { value: await call.mode.runtime.removeMutation(request.payload.kind, request.payload.id) };
      }
      case "mutation_clear": {
        return { value: await call.mode.runtime.clearMutations(request.payload.kind) };
      }
      case "dialog_accept":
      case "dialog_dismiss": {
        await call.mode.runtime.handleDialog(
          request.payload.modalId,
          request.operation === "dialog_accept",
          request.operation === "dialog_accept" ? request.payload.promptText : undefined,
        );
        return { value: null };
      }
      case "file_chooser_set_files": {
        return setFileChooserFiles(request, call);
      }
      case "events_mark": {
        return { value: copyJsonValue(await call.mode.runtime.markEvents(), "Event cursor") };
      }
      case "events_read": {
        const options = parseEventOptions(request.payload.options, call.selection.current().targetId);
        return { value: copyJsonValue(await call.mode.runtime.readEvents(options), "Event read result") };
      }
      case "progress": {
        await call.context.reportProgress({
          progress: request.payload.current ?? 1,
          ...(request.payload.message.length === 0 ? {} : { message: request.payload.message }),
          ...(request.payload.total === undefined ? {} : { total: request.payload.total }),
        });
        return { value: null };
      }
      case "snapshot": {
        const result = await this.#pageAdapter.snapshotForHelper(call.mode.runtime, {
          options: request.payload.options,
          ...(request.payload.root ? { root: request.payload.root } : {}),
          target: call.selection.current(),
        });
        const preview = formatSnapshotResult(result);
        const needsDataArtifact = result.view === "bounded" && preview.omissionReason !== null;
        const needsTextArtifact = Buffer.byteLength(result.completeText, "utf8") > result.maxBytes;
        if (!needsDataArtifact && !needsTextArtifact) return { value: preview };
        const origin = artifactOrigin(call.mode, call.selection.current().targetId, "run_playwright");
        const artifacts: ArtifactDescriptor[] = [];
        let artifact: ArtifactDescriptor | undefined;
        let dataArtifact: ArtifactDescriptor | undefined;
        if (needsTextArtifact) {
          artifact = await this.artifactStore.publishBytes(
            call.publication,
            Buffer.from(result.completeText, "utf8"),
            {
              mediaType: "text/plain",
              name: `snapshot-${result.value.snapshotId}.txt`,
              origin,
            },
          );
          call.artifacts.add(artifact);
          artifacts.push(artifact);
        }
        if (needsDataArtifact) {
          dataArtifact = await this.artifactStore.publishBytes(
            call.publication,
            Buffer.from(canonicalJsonStringify(result.value), "utf8"),
            { mediaType: "application/json", name: `snapshot-${result.value.snapshotId}.json`, origin },
          );
          call.artifacts.add(dataArtifact);
          artifacts.push(dataArtifact);
        }
        return {
          artifacts,
          value: formatSnapshotResult(result, {
            ...(artifact ? { artifact } : {}),
            ...(dataArtifact ? { dataArtifact } : {}),
          }),
        };
      }
      case "locator_resolve": {
        return {
          value: await this.#pageAdapter.locatorForHelper(
            call.mode.runtime,
            call.selection.current(),
            request.payload.ref,
          ),
        };
      }
      case "capture_start": {
        const scope = await this.#captureScope(call.mode, call.selection.current());
        const eventCursor = await call.mode.runtime.currentEventCursor();
        const started = await this.#captureManager.start({
          eventCursor: eventCursor.sequence,
          options: parseCaptureOptions(request.payload.options),
          scope,
        });
        this.#captureScopes.set(started.captureId, scope);
        return { value: copyJsonValue(started, "Capture result") };
      }
      case "capture_stop": {
        const browser = createBrowserScope(call.mode.runtime);
        const captureScope = this.#captureScopes.get(request.payload.captureId);
        if (captureScope && !isSameBrowserOwner(captureScope, browser)) {
          throw new ChromeMcpExecutionError(
            "CHROME_MCP_INVALID_INPUT",
            "Capture does not belong to this browser owner",
          );
        }
        const stopped = await this.#captureManager
          .stop(browser, request.payload.captureId)
          .catch((error: unknown) => throwTrackedArtifactError(call.artifacts, error));
        this.#captureScopes.delete(request.payload.captureId);
        call.artifacts.add(...stopped.artifacts);
        return { artifacts: stopped.artifacts, value: copyJsonValue(stopped, "Capture result") };
      }
      case "checkpoint_create":
      case "checkpoint_diff": {
        return this.executeCheckpointRpc(request, call);
      }
      default: {
        return request satisfies never;
      }
    }
  }

  private async executeCheckpointRpc(
    request: Extract<BrokerRpcRequest, { operation: "checkpoint_create" | "checkpoint_diff" }>,
    call: CallRpcState,
  ) {
    const scope = await this.#captureScope(call.mode, call.selection.current());
    if (request.operation === "checkpoint_create") {
      const options = request.payload.options;
      const created = await this.#checkpointManager
        .create({
          options: {
            ...(typeof options.name === "string" ? { name: options.name } : {}),
            ...(typeof options.screenshot === "boolean" ? { screenshot: options.screenshot } : {}),
            ...(typeof options.storage === "boolean" ? { storage: options.storage } : {}),
          },
          scope,
        })
        .catch((error: unknown) => throwTrackedArtifactError(call.artifacts, error));
      call.artifacts.add(...created.artifacts);
      return { artifacts: created.artifacts, value: copyJsonValue(created, "Checkpoint result") };
    }
    const options = request.payload.options;
    const diff = await this.#checkpointManager
      .diff({
        checkpointId: request.payload.checkpointId,
        options: {
          ...(typeof options.events === "boolean" ? { events: options.events } : {}),
          ...(typeof options.screenshot === "boolean" ? { screenshot: options.screenshot } : {}),
          ...(typeof options.snapshot === "boolean" ? { snapshot: options.snapshot } : {}),
          ...(typeof options.storage === "boolean" ? { storage: options.storage } : {}),
        },
        scope,
      })
      .catch((error: unknown) => throwTrackedArtifactError(call.artifacts, error));
    call.artifacts.add(...diff.artifacts);
    return { artifacts: diff.artifacts, value: copyJsonValue(diff, "Checkpoint result") };
  }

  async #captureScope(mode: ModeState, target: GenerationTargetId): Promise<CaptureScope> {
    const scope = { ...createBrowserScope(mode.runtime), targetId: target.targetId };
    const metadata = await this.#pageAdapter.pageMetadata(scope);

    return { ...scope, ...(metadata.viewport ? { viewport: metadata.viewport } : {}) };
  }

  async #capabilities(mode: ModeState) {
    const [owner, journal, versionResult] = await Promise.all([
      mode.runtime.capabilities(),
      mode.runtime.journalCapabilities(),
      mode.runtime.sendCdp("Browser.getVersion"),
    ]);
    const version = requireRecord(versionResult, "Browser.getVersion result");
    const cdpKey = createOwnerKey(mode.runtime);
    let cdpMethods = this.#cdpMethods.get(cdpKey);
    if (!cdpMethods) {
      const probe =
        mode.runtime.cdpMethods ?
          mode.runtime.cdpMethods()
        : probeCdpMethods(mode.runtime, mode.runtime.currentTarget().targetId);
      const cached: Promise<ReadonlySet<string>> = probe.catch(() => {
        if (this.#cdpMethods.get(cdpKey) === cached) {
          this.#cdpMethods.delete(cdpKey);
        }
        return new Set<string>();
      });
      this.#cdpMethods.set(cdpKey, cached);
      cdpMethods = cached;
    }
    const supportedCdpMethods = await cdpMethods;
    const videoSupported = supportedCdpMethods.has("Page.startScreencast") && (await this.#video.supported());
    const conflicts = this.#captureManager.activeConflicts({
      ...createBrowserScope(mode.runtime),
      targetId: mode.runtime.currentTarget().targetId,
    });
    const captures: JsonObject = {};
    for (const type of CHROME_CAPABILITY_CAPTURE_TYPES) {
      captures[type] = {
        activeConflict: conflicts[type],
        supported:
          type === "trace" ||
          type === "har" ||
          (type === "video" && videoSupported) ||
          (type === "network-bodies" && supportedCdpMethods.has("Network.getResponseBody")),
      };
    }
    const capabilities = chromeCapabilitiesSchema.parse({
      playwrightVersion: this.#playwrightVersion,
      chromeProduct: owner.chromeProduct ?? "unknown",
      cdpProtocolVersion: typeof version.protocolVersion === "string" ? version.protocolVersion : "unknown",
      browserMode: mode.runtime.browserMode,
      browserOwnership: owner.ownership,
      headless: owner.headless,
      ...(owner.nativeDeviceScaleFactor === undefined ?
        {}
      : { nativeDeviceScaleFactor: owner.nativeDeviceScaleFactor }),
      selectedTargetId: mode.runtime.currentTarget().targetId,
      workspaceShared: isSharedMode(mode.runtime.browserMode),
      captures,
      limits: {
        artifactBytes: ARTIFACT_MAX_BYTES,
        artifactChunkBytes: ARTIFACT_CHUNK_BYTES,
        bindingConcurrency: PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS,
        bindingPayloadBytes: PERSISTENT_BINDING_MAX_PAYLOAD_BYTES,
        bindingTimeoutMs: PERSISTENT_BINDING_WORKER_TIMEOUT_MS,
        connectionArtifactBytes: ARTIFACT_CONNECTION_MAX_BYTES,
        directArtifactBytes: ARTIFACT_DIRECT_CONTENT_BYTES,
        eventBytes: JOURNAL_MAX_BYTES,
        eventCount: JOURNAL_MAX_EVENTS,
        harBytes: MAX_HAR_BYTES,
        inlineImageBytes: INLINE_IMAGE_MAX_BYTES,
        inlineImageCount: INLINE_IMAGE_MAX_COUNT,
        inlineImageTotalBytes: INLINE_IMAGE_MAX_TOTAL_BYTES,
        inlineTextBytes: INLINE_TEXT_MAX_BYTES,
        mutationCountPerKind: PERSISTENT_MUTATION_MAX_COUNT_PER_KIND,
        mutationEntryBytes: PERSISTENT_MUTATION_MAX_ENTRY_BYTES,
        mutationTotalBytes: PERSISTENT_MUTATION_MAX_TOTAL_BYTES,
        networkBodyBytes: CAPTURE_BODY_LIMITS.maximumBodyBytes,
        networkEntries: MAX_CAPTURE_NETWORK_ENTRIES,
        networkTotalBytes: CAPTURE_BODY_LIMITS.maximumTotalBytes,
        ordinaryArtifactBytes: ORDINARY_CALL_MAX_BYTES,
        ordinaryArtifactCount: ORDINARY_CALL_MAX_ARTIFACTS,
        runArtifactBytes: RUN_ARTIFACT_MAX_BYTES,
        snapshotMaxBytes: SNAPSHOT_MAX_BYTES,
        snapshotMaxDepth: SNAPSHOT_MAX_DEPTH,
        snapshotMinBytes: SNAPSHOT_MIN_BYTES,
        snapshotMinDepth: SNAPSHOT_MIN_DEPTH,
        snapshotRetainedCount: SNAPSHOT_RETAINED_COUNT,
        stateKeyBytes: STATE_KEY_MAX_BYTES,
        stateTotalBytes: STATE_TOTAL_MAX_BYTES,
        stateValueBytes: STATE_VALUE_MAX_BYTES,
      },
      journal: {
        currentSequence: journal.currentSequence,
        eventCount: journal.eventCount,
        firstRetainedSequence: journal.firstRetainedSequence,
        retainedBytes: journal.retainedBytes,
      },
      cdp: Object.fromEntries(
        CHROME_CAPABILITY_CDP_METHODS.map((method) => [method, supportedCdpMethods.has(method)]),
      ),
    });
    return {
      value: copyJsonObject(capabilities, "Chrome capabilities"),
      unavailableTargets: owner.unavailableTargets,
    };
  }

  private async analyzeSavedHeap(args: AnalyzeHeapSnapshotInput, context: ChromeToolContext) {
    const connection = await this.#connection(context);
    const snapshotPath = await resolveInputFile(connection.session.pathContext, args.filePath);
    const hasClosedConnection = connection.closed || connection.closing;
    if (hasClosedConnection) {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_CANCELLED",
        "Chrome connection closed before heap analysis",
      );
    }

    const controller = new AbortController();
    const query = this.heapQueryAnalyzer.query(
      heapQueryRequestSchema.parse({
        snapshotPath,
        query: args.query,
        limit: args.limit,
        cursor: args.cursor,
      }),
      controller.signal,
    );
    connection.heapQueries.set(controller, query);

    try {
      const result = await query;
      return textResult([JSON.stringify(result)], copyJsonObject(result, "Heap query result"));
    } finally {
      connection.heapQueries.delete(controller);
    }
  }

  async #diagnostic(
    args: BrowserSelection,
    context: ChromeToolContext,
    run: (call: DiagnosticCall) => Promise<DiagnosticToolResult>,
  ) {
    const connection = await this.#connection(context);
    const mode = await this.#mode(connection, args.browser, args);
    return this.#admit(connection, mode, {
      modalPolicy: "reject",
      run: async () =>
        run({
          ...(args.browserInstanceId === undefined ? {} : { browserInstanceId: args.browserInstanceId }),
          ...(args.nativeDeviceScaleFactor === undefined ?
            {}
          : { nativeDeviceScaleFactor: args.nativeDeviceScaleFactor }),
          browserMode: args.browser,
          connectionId: connection.session.connectionId,
        }),
    });
  }

  async #diagnosticPage(call: DiagnosticCall): Promise<AttachedDiagnosticPage> {
    const connection = this.#connectionStates.get(call.connectionId);
    if (!connection || connection.closed) throw new Error("Chrome diagnostic connection is not active");
    const mode = await this.#mode(connection, call.browserMode, call);
    const target = mode.runtime.currentTarget();
    const key = createDiagnosticPageKey(mode.runtime, target.targetId);
    let page = this.#diagnosticPages.get(key);
    if (!page) {
      page = AttachedDiagnosticPage.create(mode.runtime);
      this.#diagnosticPages.set(key, page);
      page.catch(() => {
        if (this.#diagnosticPages.get(key) === page) this.#diagnosticPages.delete(key);
      });
    }
    const [attached, targetRecord] = await Promise.all([page, mode.runtime.targetRecord(target.targetId)]);
    if (!targetRecord) {
      await this.#releaseTargetResources(mode.runtime, target.targetId);
      throw new ChromeMcpExecutionError("CHROME_MCP_PAGE_CLOSED", "The selected page is closed");
    }
    attached.refreshUrl(targetRecord.url);
    return attached;
  }

  async #releaseTargetResources(runtime: ChromeServiceRuntimeSession, targetId: string): Promise<void> {
    const key = createDiagnosticPageKey(runtime, targetId);
    const page = this.#diagnosticPages.get(key);
    this.#diagnosticPages.delete(key);
    await Promise.all([
      this.#pageAdapter.releaseTarget(runtime, targetId),
      ...(page ? [page.then((value) => value.close()).catch(() => undefined)] : []),
    ]);
  }

  #diagnosticOutputPaths(connectionId: string): DiagnosticOutputPathResolver {
    const connection = this.#connectionStates.get(connectionId);
    if (!connection || connection.closed) throw new Error("Chrome diagnostic connection is not active");
    return connection.diagnosticOutputPaths;
  }

  #runtimeForContext(contextId: string): ChromeServiceRuntimeSession {
    const owners = new Map<string, ChromeServiceRuntimeSession>();
    for (const mode of this.#modeByScope.values()) {
      if (mode.runtime.ownerId !== contextId) continue;
      owners.set(createOwnerKey(mode.runtime), mode.runtime);
    }
    const runtime = owners.values().next().value;
    if (!runtime) throw new Error(`Chrome browser context is not active: ${contextId}`);
    if (owners.size > 1) {
      throw new Error(`Chrome browser context is ambiguous across active generations: ${contextId}`);
    }
    return runtime;
  }

  async #runtimeForTarget(targetId: string): Promise<ChromeServiceRuntimeSession> {
    const owners = new Map<string, ChromeServiceRuntimeSession>();
    for (const mode of this.#modeByScope.values()) {
      if (!(await mode.runtime.targetRecord(targetId))) continue;
      owners.set(createOwnerKey(mode.runtime), mode.runtime);
    }
    const runtime = owners.values().next().value;
    if (!runtime) throw new Error(`Chrome target is not active: ${targetId}`);
    if (owners.size > 1) {
      throw new Error(`Chrome target ID is ambiguous across active browser owners: ${targetId}`);
    }
    return runtime;
  }
}

const loadPlaywrightVersion = async (): Promise<string> => {
  const packagePath = Bun.resolveSync("playwright-core/package.json", import.meta.dir);
  const parsed: unknown = JSON.parse(await readFile(packagePath, "utf8"));
  if (!isRecord(parsed) || typeof parsed.version !== "string") {
    throw new Error("playwright-core package version is unavailable");
  }
  return parsed.version;
};

export const createChromeService = async (options: ChromeServiceOptions = {}): Promise<ChromeService> => {
  const artifactStore = options.artifactStore ?? new ArtifactStore();
  let runtime = options.runtime;
  if (!runtime) {
    if (!options.executablePath || !options.workspacePath) {
      throw new Error(
        "Chrome service requires executablePath and workspacePath when no runtime adapter is supplied",
      );
    }
    runtime = BrokerRuntime.create({
      executablePath: options.executablePath,
      mainUserDataDir: options.mainUserDataDir,
      workspacePath: options.workspacePath,
    });
  }
  const captureOutputPaths = await TemporaryCaptureOutputPaths.create();
  let service: ChromePublicService;
  try {
    service = new ChromePublicService({
      artifactStore,
      ...(options.capture === undefined ? {} : { capture: options.capture }),
      captureOutputPaths,
      executionKernel: options.executionKernel ?? runExecutionWorker,
      idleShutdownMs: options.idleShutdownMs ?? ISOLATED_BROWSER_IDLE_SHUTDOWN_MS,
      playwrightVersion: options.playwrightVersion ?? (await loadPlaywrightVersion()),
      runtime,
      scheduleIdleShutdown: options.scheduleIdleShutdown ?? scheduleIdleShutdownTimer,
      ...(options.snapshotConnector === undefined ? {} : { snapshotConnector: options.snapshotConnector }),
    });
  } catch (error: unknown) {
    await captureOutputPaths.close().catch(() => undefined);
    throw error;
  }
  return {
    artifactConnection: (context) => service.artifactConnection(context),
    artifactOwner: (auth, context) => {
      if (!auth) throw new Error("Chrome artifacts require authenticated MCP session ownership");
      if (context?.session && context.session.connectionId !== auth.connectionId) {
        throw new Error("Chrome artifact resource authentication does not match the active session");
      }
      return service.artifactConnectionForSession(auth);
    },
    artifactStore,
    close: () => service.close(),
    closeConnection: (context) => service.closeConnection(context),
    handlers: service.handlers,
    resourcesCapabilities: { listChanged: true, subscribe: false },
    sessionLifecycle: {
      onClose: (context) => service.closeSession(lifecycleSession(context)),
      onConnect: (context) =>
        service.connectSession(lifecycleSession(context), context.notifyResourcesListChanged),
    },
    sessionResources: (session) => service.sessionResources(session),
  };
};
