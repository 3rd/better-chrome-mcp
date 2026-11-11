import { randomUUID } from "node:crypto";
import { CaptureError, captureError, CaptureFinalizeError } from "./errors";
import { type CapturePublicationResult, HarRecorder, NetworkBodiesRecorder } from "./network-capture";
import { ArtifactPublicationLedger, artifactsFromError, codeFromError } from "./publication-ledger";
import {
  type ArtifactPublisher,
  type BrowserScope,
  CAPTURE_FINALIZE_TIMEOUT_MS,
  CAPTURE_VIDEO_LIMITS,
  type CaptureFinishReason,
  type CaptureScope,
  type CaptureStarted,
  type CaptureStartRequest,
  type CaptureStopped,
  type CaptureType,
  type Clock,
  type ExternalCaptureConflict,
  type IdGenerator,
  isSameBrowserOwner,
  type NetworkExchange,
  type TraceAdapter,
  type TraceCaptureOptions,
  type VideoAdapter,
  type VideoCaptureOptions,
} from "./types";

export interface CaptureManagerOptions {
  artifacts: ArtifactPublisher;
  trace?: TraceAdapter;
  video?: VideoAdapter;
  externalConflicts?: ExternalCaptureConflict;
  clock?: Clock;
  ids?: IdGenerator;
  finalizeTimeoutMs?: number;
}

type CapturePhase = "active" | "starting" | "stopping" | "tombstone";

interface CaptureState {
  captureId: string;
  type: CaptureType;
  scope: CaptureScope;
  startedAt: string;
  startedCursor: number;
  phase: CapturePhase;
  adapterHandle?: unknown;
  har?: HarRecorder;
  networkBodies?: NetworkBodiesRecorder;
  pendingNetwork: Set<Promise<void>>;
  collectionAbort: AbortController;
  startAbort: AbortController;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (reason?: unknown) => void;
  finalize?: Promise<CaptureStopped>;
}

interface CompletedCapture {
  scope: BrowserScope;
  result: CaptureStopped;
}

interface CaptureFinalizationOutcome {
  publication: CapturePublicationResult;
  status: "completed" | "incomplete";
}

const systemClock: Clock = { now: () => new Date() };
const randomIds: IdGenerator = { next: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}` };

const assertScope = (scope: CaptureScope) => {
  if (
    scope.connectionId.length === 0 ||
    scope.contextId.length === 0 ||
    scope.targetId.length === 0 ||
    !Number.isInteger(scope.browserGeneration) ||
    scope.browserGeneration < 0
  ) {
    throw captureError("CHROME_MCP_CAPTURE_INVALID_OPTIONS", "Capture scope is incomplete or invalid.");
  }
};

const normalizeTraceOptions = (options: TraceCaptureOptions): Required<Omit<TraceCaptureOptions, "type">> => {
  for (const [name, value] of Object.entries(options)) {
    if (name !== "type" && value !== undefined && typeof value !== "boolean") {
      throw captureError("CHROME_MCP_CAPTURE_INVALID_OPTIONS", `${name} must be a boolean.`);
    }
  }
  return {
    screenshots: options.screenshots ?? true,
    snapshots: options.snapshots ?? true,
    sources: options.sources ?? true,
  };
};

const rangedInteger = (value: number, minimum: number, maximum: number, name: string) => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw captureError(
      "CHROME_MCP_CAPTURE_INVALID_OPTIONS",
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
};

const normalizeVideoOptions = (
  options: VideoCaptureOptions,
  scope: CaptureScope,
): Required<Omit<VideoCaptureOptions, "type">> => {
  if (options.format !== undefined && options.format !== "webm") {
    throw captureError("CHROME_MCP_CAPTURE_INVALID_OPTIONS", "Video format must be webm.");
  }
  const width = options.width ?? scope.viewport?.width;
  const height = options.height ?? scope.viewport?.height;
  if (width === undefined || height === undefined) {
    throw captureError(
      "CHROME_MCP_UNSUPPORTED_CAPTURE",
      "Video capture needs an explicit width and height when the selected target has no viewport.",
    );
  }
  return {
    format: options.format ?? "webm",
    width: rangedInteger(
      width,
      CAPTURE_VIDEO_LIMITS.minimumDimension,
      CAPTURE_VIDEO_LIMITS.maximumDimension,
      "width",
    ),
    height: rangedInteger(
      height,
      CAPTURE_VIDEO_LIMITS.minimumDimension,
      CAPTURE_VIDEO_LIMITS.maximumDimension,
      "height",
    ),
    framesPerSecond: rangedInteger(
      options.framesPerSecond ?? 15,
      CAPTURE_VIDEO_LIMITS.minimumFramesPerSecond,
      CAPTURE_VIDEO_LIMITS.maximumFramesPerSecond,
      "framesPerSecond",
    ),
  };
};

const captureKey = (scope: CaptureScope, type: CaptureType) =>
  [
    scope.connectionId,
    scope.browserMode,
    scope.browserGeneration,
    scope.contextId,
    scope.targetId,
    type,
  ].join("\0");

const ownerTraceKey = (scope: CaptureScope) =>
  [scope.browserMode, scope.browserGeneration, scope.contextId, "trace"].join("\0");

const ownerVideoKey = (scope: CaptureScope) =>
  [scope.browserMode, scope.browserGeneration, scope.contextId, scope.targetId, "video"].join("\0");

const sameNetworkTarget = (scope: CaptureScope, exchange: NetworkExchange) =>
  isSameBrowserOwner(scope, exchange) && scope.targetId === exchange.rootTargetId;

const publishOutput = async (
  publisher: ArtifactPublicationLedger,
  state: CaptureState,
  output: {
    name: string;
    mediaType: string;
    source: { kind: "bytes"; bytes: Uint8Array } | { kind: "path"; path: string };
    metadata?: Record<string, unknown>;
  },
  complete: boolean,
  signal?: AbortSignal,
) => {
  if (signal?.aborted) throw signal.reason;
  return publisher.publish({
    connectionId: state.scope.connectionId,
    browserMode: state.scope.browserMode,
    targetId: state.scope.targetId,
    name: output.name,
    mediaType: output.mediaType,
    complete,
    origin: "capture",
    source: output.source,
    metadata: {
      captureId: state.captureId,
      captureType: state.type,
      ...output.metadata,
    },
    signal,
  });
};

const throwCaptureNotFound: (captureId: string) => never = (captureId) => {
  throw captureError(
    "CHROME_MCP_CAPTURE_NOT_FOUND",
    `Capture ${captureId} was not found for this browser owner.`,
  );
};

export class CaptureManager {
  private readonly artifacts: ArtifactPublisher;
  private readonly trace?: TraceAdapter;
  private readonly video?: VideoAdapter;
  private readonly externalConflicts?: ExternalCaptureConflict;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly finalizeTimeoutMs: number;
  private readonly captures = new Map<string, CaptureState>();
  private readonly completed = new Map<string, CompletedCapture>();
  private readonly activeKeys = new Map<string, string>();
  private readonly ownerTraceKeys = new Map<string, string>();
  private readonly ownerVideoKeys = new Map<string, string>();

  constructor(options: CaptureManagerOptions) {
    this.artifacts = options.artifacts;
    this.trace = options.trace;
    this.video = options.video;
    this.externalConflicts = options.externalConflicts;
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIds;
    this.finalizeTimeoutMs = options.finalizeTimeoutMs ?? CAPTURE_FINALIZE_TIMEOUT_MS;
    if (!Number.isInteger(this.finalizeTimeoutMs) || this.finalizeTimeoutMs < 1) {
      throw new Error("finalizeTimeoutMs must be a positive integer.");
    }
  }

  async start(request: CaptureStartRequest): Promise<CaptureStarted> {
    assertScope(request.scope);
    if (
      request.eventCursor !== undefined &&
      (!Number.isInteger(request.eventCursor) || request.eventCursor < 0)
    ) {
      throw captureError("CHROME_MCP_CAPTURE_INVALID_OPTIONS", "eventCursor must be a non-negative integer.");
    }
    const type = request.options.type;
    const key = captureKey(request.scope, type);
    if (this.activeKeys.has(key)) {
      throw captureError(
        "CHROME_MCP_CAPTURE_CONFLICT",
        `A ${type} capture is already active for this connection, mode, and target.`,
      );
    }
    if (type === "trace" && this.ownerTraceKeys.has(ownerTraceKey(request.scope))) {
      throw captureError(
        "CHROME_MCP_CAPTURE_CONFLICT",
        "Playwright tracing is already active for this browser context.",
      );
    }
    if (type === "video" && this.ownerVideoKeys.has(ownerVideoKey(request.scope))) {
      throw captureError(
        "CHROME_MCP_CAPTURE_CONFLICT",
        "CDP screencast video is already active for this target.",
      );
    }

    const captureId = this.ids.next("capture");
    const ready = Promise.withResolvers<void>();
    ready.promise.catch(() => undefined);
    const state: CaptureState = {
      captureId,
      type,
      scope: { ...request.scope, viewport: request.scope.viewport && { ...request.scope.viewport } },
      startedAt: this.clock.now().toISOString(),
      startedCursor: request.eventCursor ?? 0,
      phase: "starting",
      pendingNetwork: new Set(),
      collectionAbort: new AbortController(),
      startAbort: new AbortController(),
      ready: ready.promise,
      resolveReady: ready.resolve,
      rejectReady: ready.reject,
    };
    this.captures.set(captureId, state);
    this.activeKeys.set(key, captureId);
    if (type === "trace") this.ownerTraceKeys.set(ownerTraceKey(request.scope), captureId);
    if (type === "video") this.ownerVideoKeys.set(ownerVideoKey(request.scope), captureId);

    try {
      const externalConflict = await this.externalConflicts?.find(request.scope, type);
      if (state.startAbort.signal.aborted) throw state.startAbort.signal.reason;
      if (externalConflict) {
        throw captureError("CHROME_MCP_CAPTURE_CONFLICT", externalConflict);
      }
      if (request.options.type === "trace") {
        if (!this.trace) {
          throw captureError(
            "CHROME_MCP_UNSUPPORTED_CAPTURE",
            "Playwright tracing is unavailable for this browser owner.",
          );
        }
        state.adapterHandle = await this.trace.start({
          captureId,
          scope: state.scope,
          signal: state.startAbort.signal,
          options: normalizeTraceOptions(request.options),
        });
      } else if (request.options.type === "video") {
        if (!this.video || !(await this.video.supported())) {
          throw captureError(
            "CHROME_MCP_UNSUPPORTED_CAPTURE",
            "CDP screencast video requires a compatible target and a local ffmpeg encoder.",
          );
        }
        state.adapterHandle = await this.video.start({
          captureId,
          scope: state.scope,
          signal: state.startAbort.signal,
          options: normalizeVideoOptions(request.options, request.scope),
        });
      } else if (request.options.type === "har") {
        state.har = new HarRecorder(request.options);
      } else {
        state.networkBodies = new NetworkBodiesRecorder(request.options);
      }
      state.resolveReady();
      if (state.phase === "starting") state.phase = "active";
      return { captureId, type, targetId: request.scope.targetId, startedAt: state.startedAt };
    } catch (error) {
      state.rejectReady(error);
      this.release(state);
      if (error instanceof CaptureError) throw error;
      throw captureError("CHROME_MCP_CAPTURE_INVALID_OPTIONS", `Could not start ${type} capture.`, error);
    }
  }

  recordNetwork(exchange: NetworkExchange) {
    for (const state of this.captures.values()) {
      if (
        state.phase !== "active" ||
        exchange.sequence <= state.startedCursor ||
        !sameNetworkTarget(state.scope, exchange)
      ) {
        continue;
      }
      const operation =
        state.har?.record(exchange, state.collectionAbort.signal) ??
        state.networkBodies?.record(exchange, state.collectionAbort.signal);
      if (!operation) continue;
      state.pendingNetwork.add(operation);
      operation.finally(() => state.pendingNetwork.delete(operation)).catch(() => undefined);
    }
  }

  async stop(browser: BrowserScope, captureId: string) {
    const completed = this.completed.get(captureId);
    if (completed) {
      if (!isSameBrowserOwner(completed.scope, browser)) throwCaptureNotFound(captureId);
      return completed.result;
    }
    const state = this.captures.get(captureId);
    if (!state || !isSameBrowserOwner(state.scope, browser)) throwCaptureNotFound(captureId);
    return this.finalize(state, "manual");
  }

  async finalizeConnection(connectionId: string) {
    const states = [...this.captures.values()].filter((state) => state.scope.connectionId === connectionId);
    const results = await Promise.all(states.map((state) => this.finalizeForLifecycle(state, "disconnect")));
    for (const [captureId, completed] of this.completed) {
      if (completed.scope.connectionId === connectionId) this.completed.delete(captureId);
    }
    return results;
  }

  async finalizeBrowser(browser: BrowserScope) {
    const states = [...this.captures.values()].filter((state) => isSameBrowserOwner(state.scope, browser));
    const results = await Promise.all(
      states.map((state) => this.finalizeForLifecycle(state, "browser-death")),
    );
    for (const [captureId, completed] of this.completed) {
      if (isSameBrowserOwner(completed.scope, browser)) this.completed.delete(captureId);
    }
    return results;
  }

  async shutdown() {
    const states = [...this.captures.values()];
    return Promise.all(states.map((state) => this.finalizeForLifecycle(state, "shutdown")));
  }

  activeConflicts(scope: CaptureScope) {
    const result: Record<CaptureType, boolean> = {
      trace: this.ownerTraceKeys.has(ownerTraceKey(scope)),
      har: this.activeKeys.has(captureKey(scope, "har")),
      video: this.ownerVideoKeys.has(ownerVideoKey(scope)),
      "network-bodies": this.activeKeys.has(captureKey(scope, "network-bodies")),
    };
    return result;
  }

  private async finalizeForLifecycle(state: CaptureState, reason: Exclude<CaptureFinishReason, "manual">) {
    try {
      return await this.finalize(state, reason);
    } catch (error) {
      return this.incompleteResult(state, error);
    }
  }

  private finalize(state: CaptureState, reason: CaptureFinishReason) {
    if (state.finalize) return state.finalize;
    const wasStarting = state.phase === "starting";
    state.phase = "stopping";
    if (wasStarting) state.startAbort.abort(new Error(`Capture start was interrupted by ${reason}.`));
    state.finalize = this.performFinalize(state, reason);
    return state.finalize;
  }

  private async performFinalize(state: CaptureState, reason: CaptureFinishReason): Promise<CaptureStopped> {
    const complete = reason === "manual";
    const ledger = new ArtifactPublicationLedger(this.artifacts, {
      connectionId: state.scope.connectionId,
      kind: "capture",
    });
    const controller = new AbortController();
    const actual = ledger.run((publicationLedger) =>
      this.executeFinalization(state, reason, controller.signal, complete, publicationLedger),
    );
    actual.catch(() => undefined);
    const timeoutError = captureError(
      "CHROME_MCP_CAPTURE_FINALIZE_FAILED",
      `Capture finalization exceeded ${this.finalizeTimeoutMs} ms.`,
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort(timeoutError);
        reject(ledger.attach(timeoutError));
      }, this.finalizeTimeoutMs);
    });

    try {
      const outcome = await Promise.race([actual, deadline]);
      const result = this.resultFrom(state, outcome);
      this.complete(state, result);
      return result;
    } catch (error) {
      if (controller.signal.reason === timeoutError) {
        state.phase = "tombstone";
        this.releaseAfterTombstone(state, actual, reason);
        throw error;
      }
      this.release(state);
      if (reason !== "manual") throw error;
      if (codeFromError(error) !== undefined) throw error;
      throw ledger.attach(
        captureError(
          "CHROME_MCP_CAPTURE_FINALIZE_FAILED",
          `Could not finalize ${state.type} capture ${state.captureId}.`,
          error,
        ),
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async executeFinalization(
    state: CaptureState,
    reason: CaptureFinishReason,
    signal: AbortSignal,
    complete: boolean,
    ledger: ArtifactPublicationLedger,
  ): Promise<CaptureFinalizationOutcome> {
    const abortCollection = () => state.collectionAbort.abort(signal.reason);
    signal.addEventListener("abort", abortCollection, { once: true });
    try {
      await state.ready;
      await Promise.allSettled(state.pendingNetwork);
      if (signal.aborted) throw signal.reason;
      try {
        const publication = await this.publishCapture(state, reason, signal, complete, ledger);
        return { publication, status: complete ? "completed" : "incomplete" };
      } catch (error) {
        if (!(error instanceof CaptureFinalizeError) || !error.partialOutput) throw error;
        const artifact = await publishOutput(ledger, state, error.partialOutput, false, signal);
        return {
          publication: {
            artifact,
            artifacts: [...ledger.artifacts],
            warnings: [error.message],
            byteCount: ledger.artifacts.reduce((total, descriptor) => total + descriptor.size, 0),
          },
          status: "incomplete",
        };
      }
    } finally {
      signal.removeEventListener("abort", abortCollection);
    }
  }

  private async publishCapture(
    state: CaptureState,
    reason: CaptureFinishReason,
    signal: AbortSignal,
    complete: boolean,
    ledger: ArtifactPublicationLedger,
  ): Promise<CapturePublicationResult> {
    if (state.har) return state.har.publish(ledger, state.captureId, state.scope, complete, signal);
    if (state.networkBodies) {
      return state.networkBodies.publish(ledger, state.captureId, state.scope, complete, signal);
    }
    const adapter = state.type === "trace" ? this.trace : this.video;
    if (!adapter) {
      throw captureError("CHROME_MCP_UNSUPPORTED_CAPTURE", `${state.type} capture adapter is unavailable.`);
    }
    const output = await adapter.finish(state.adapterHandle, { reason, signal });
    const artifact = await publishOutput(ledger, state, output, complete, signal);
    return { artifact, artifacts: [...ledger.artifacts], warnings: [], byteCount: artifact.size };
  }

  private resultFrom(state: CaptureState, outcome: CaptureFinalizationOutcome): CaptureStopped {
    return {
      captureId: state.captureId,
      type: state.type,
      targetId: state.scope.targetId,
      startedAt: state.startedAt,
      stoppedAt: this.clock.now().toISOString(),
      status: outcome.status,
      byteCount: outcome.publication.artifacts.reduce((total, descriptor) => total + descriptor.size, 0),
      artifact: outcome.publication.artifact,
      artifacts: [...outcome.publication.artifacts],
      warnings: [...outcome.publication.warnings],
    };
  }

  private releaseAfterTombstone(
    state: CaptureState,
    actual: Promise<CaptureFinalizationOutcome>,
    reason: CaptureFinishReason,
  ) {
    actual
      .then(
        (outcome) => {
          if (reason === "manual") this.complete(state, this.resultFrom(state, outcome));
          else this.release(state);
        },
        () => this.release(state),
      )
      .catch(() => undefined);
  }

  private incompleteResult(state: CaptureState, error: unknown): CaptureStopped {
    if (state.phase !== "tombstone") this.release(state);
    const artifacts = artifactsFromError(error);
    return {
      captureId: state.captureId,
      type: state.type,
      targetId: state.scope.targetId,
      startedAt: state.startedAt,
      stoppedAt: this.clock.now().toISOString(),
      status: "incomplete",
      byteCount: artifacts.reduce((total, descriptor) => total + descriptor.size, 0),
      artifacts: [...artifacts],
      warnings: [error instanceof Error ? error.message : String(error)],
    };
  }

  private complete(state: CaptureState, result: CaptureStopped) {
    this.release(state);
    this.completed.set(state.captureId, {
      scope: {
        browserGeneration: state.scope.browserGeneration,
        browserMode: state.scope.browserMode,
        connectionId: state.scope.connectionId,
        contextId: state.scope.contextId,
      },
      result,
    });
  }

  private release(state: CaptureState) {
    if (!state.startAbort.signal.aborted) state.startAbort.abort();
    if (state.pendingNetwork.size > 0 && !state.collectionAbort.signal.aborted) state.collectionAbort.abort();
    this.captures.delete(state.captureId);
    this.activeKeys.delete(captureKey(state.scope, state.type));
    if (state.type === "trace") this.ownerTraceKeys.delete(ownerTraceKey(state.scope));
    if (state.type === "video") this.ownerVideoKeys.delete(ownerVideoKey(state.scope));
  }
}
