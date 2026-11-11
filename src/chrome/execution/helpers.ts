import type { ExecutionRpcClient } from "./rpc-client";
import { isRecord } from "../../platform/records";
import { ARTIFACT_NAME_MAX_BYTES } from "../artifacts/constants";
import { CAPTURE_BODY_LIMITS, CAPTURE_VIDEO_LIMITS } from "../captures/types";
import { JOURNAL_READ_MAX_LIMIT, JOURNAL_READ_MIN_LIMIT } from "../runtime/event-journal";
import {
  type PersistentBinding,
  type PersistentBindingInput,
  persistentBindingInputSchema,
  type PersistentInitScript,
  persistentInitScriptInputSchema,
  type PersistentMutationEntry,
  persistentMutationEntrySchema,
  type PersistentMutationInput,
  type PersistentMutationKind,
  type PersistentRoute,
  type PersistentRouteInput,
  persistentRouteInputSchema,
} from "../runtime/persistent-mutations";
import {
  type PwaInstallInput,
  type PwaLaunchInput,
  type PwaOperation,
  pwaOperationSchema,
  pwaResultSchema,
} from "../runtime/pwa-controller";
import { ChromeMcpExecutionError } from "./errors";
import { validateImageBytes } from "./image-codec";
import { copyJsonObject, freezeJsonValue, type JsonObject, type JsonValue } from "./json";
import {
  type ArtifactDescriptor,
  type BrokerRpcSuccess,
  type DialogDescriptor,
  type FileChooserDescriptor,
  type ImageMediaType,
  RUN_ARTIFACT_MAX_BYTES,
  type SnapshotRootToken,
  type StagedContent,
} from "./protocol";
import { createTransactionalState, type StateSnapshot } from "./state";

const PROGRESS_MESSAGE_MAX_BYTES = 512;
const PROGRESS_INTERVAL_MS = 200;
const SNAPSHOT_MARKER_PREFIX = "data-chrome-mcp-snapshot-root";
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu;

export const SNAPSHOT_DEFAULT_DEPTH = 8;
export const SNAPSHOT_MIN_DEPTH = 1;
export const SNAPSHOT_MAX_DEPTH = 20;
export const SNAPSHOT_DEFAULT_MAX_BYTES = 16 * 1024;
export const SNAPSHOT_MIN_BYTES = 4 * 1024;
export const SNAPSHOT_MAX_BYTES = 1024 * 1024;
export const SNAPSHOT_RETAINED_COUNT = 4;

export interface ExecutionBrowserSession {
  readonly browser: unknown;
  readonly context: unknown;
  readonly page: unknown;
  evaluateWorker: (input: WorkerEvaluationInput, signal: AbortSignal) => Promise<JsonValue | undefined>;
  locatorFromRecipe: (recipe: LocatorRecipe) => Promise<unknown>;
  markSnapshotRoot: (locator: unknown, token: SnapshotRootToken) => Promise<() => Promise<void>>;
  targetIdForPage: (page: unknown) => Promise<string>;
  pageForTarget: (targetId: string, signal: AbortSignal) => Promise<unknown>;
}

export type WorkerEvaluationInput = Readonly<{
  targetId: string;
  expression: string;
}>;

export type LocatorRecipe = Readonly<{
  frameChain: readonly string[];
  selector: string;
  targetId: string;
}>;

export interface ChromeDialogHelper {
  readonly defaultValue: string;
  readonly message: string;
  readonly type: DialogDescriptor["type"];
  accept: (promptText?: string) => Promise<void>;
  dismiss: () => Promise<void>;
}

export interface ChromeFileChooserHelper {
  readonly accept: string;
  readonly isMultiple: boolean;
  setFiles: (files: unknown) => Promise<void>;
}

export interface ChromeExecutionHelper {
  readonly bindings: {
    add: (input: PersistentBindingInput) => Promise<PersistentBinding>;
    clear: () => Promise<number>;
    list: () => Promise<PersistentBinding[]>;
    remove: (id: string) => Promise<boolean>;
  };
  readonly capabilities: JsonObject;
  readonly capture: {
    start: (options: unknown) => Promise<JsonValue>;
    stop: (captureId: string) => Promise<JsonValue>;
  };
  readonly checkpoint: {
    create: (options?: unknown) => Promise<JsonValue>;
    diff: (checkpointId: string, options?: unknown) => Promise<JsonValue>;
  };
  readonly dialog: ChromeDialogHelper | undefined;
  readonly events: {
    mark: () => Promise<JsonValue>;
    read: (options?: unknown) => Promise<JsonValue>;
  };
  readonly pwa: {
    install: (input: PwaInstallInput) => Promise<JsonValue>;
    launch: (input: PwaLaunchInput) => Promise<unknown>;
    getState: (input: { manifestId: string }) => Promise<JsonValue>;
    uninstall: (input: { manifestId: string }) => Promise<JsonValue>;
  };
  readonly fileChooser: ChromeFileChooserHelper | undefined;
  readonly initScripts: {
    add: (source: string) => Promise<PersistentInitScript>;
    clear: () => Promise<number>;
    list: () => Promise<PersistentInitScript[]>;
    remove: (id: string) => Promise<boolean>;
  };
  readonly routes: {
    add: (input: PersistentRouteInput) => Promise<PersistentRoute>;
    clear: () => Promise<number>;
    list: () => Promise<PersistentRoute[]>;
    remove: (id: string) => Promise<boolean>;
  };
  captureAccessibilitySnapshot: (options?: unknown) => Promise<JsonValue>;
  clearSessionState: () => undefined;
  deleteSessionStateValue: (key: string) => undefined;
  emitImageResult: (buffer: Uint8Array, options?: { mediaType?: ImageMediaType }) => undefined;
  emitTextResult: (value: string) => undefined;
  evaluateWorker: (input: WorkerEvaluationInput) => Promise<JsonValue | undefined>;
  getSessionStateValue: (key: string) => JsonValue | undefined;
  listSessionStateEntries: () => StateSnapshot;
  publishFileArtifact: (path: string, mediaType?: string) => Promise<ArtifactDescriptor>;
  reportCallProgress: (message: string, current?: number, total?: number) => Promise<void>;
  reserveArtifactOutputPath: (name: string, mediaType?: string) => Promise<string>;
  resolveSnapshotRefToLocator: (ref: string) => Promise<unknown>;
  selectPageForSession: (page: unknown) => Promise<void>;
  setSessionStateValue: (key: string, value: unknown) => undefined;
}

export interface ChromeHelperRuntime {
  readonly helper: ChromeExecutionHelper;
  cancelPending: () => Promise<void>;
  selectedTargetId: () => string;
  stagedContent: () => StagedContent[];
  stateSnapshot: () => StateSnapshot;
}

type ProgressWaiter = {
  reject: (error: Error) => void;
  resolve: () => void;
};

type PendingProgress = {
  current: number;
  message: string;
  total?: number;
  waiters: ProgressWaiter[];
};

type HelperRpc = {
  request: ExecutionRpcClient["request"];
};

type SnapshotMarker = {
  restore: () => Promise<void>;
};

const helperError = (message: string): ChromeMcpExecutionError =>
  new ChromeMcpExecutionError("CHROME_MCP_INVALID_INPUT", message);

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw helperError(`${label} must be a non-empty string`);
  }
  return value;
};

const requireJsonObject = (value: unknown, label: string): JsonObject => {
  try {
    return copyJsonObject(value, label);
  } catch (error: unknown) {
    throw helperError(error instanceof Error ? error.message : `${label} must be a JSON-safe object`);
  }
};

const persistentInput = <Value>(
  schema: {
    safeParse: (
      value: unknown,
    ) =>
      | { success: false; error: { issues: readonly { message: string }[] } }
      | { success: true; data: Value };
  },
  value: unknown,
): Value => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw helperError(parsed.error.issues[0]?.message ?? "Persistent mutation input is invalid");
  }
  return parsed.data;
};

const parsePwaInput = (input: unknown, operation: PwaOperation["operation"]) => {
  const hasInvalidInput = !isRecord(input) || "operation" in input;
  if (hasInvalidInput) {
    throw helperError("PWA input must be an object without an operation field");
  }

  const parsed = pwaOperationSchema.safeParse({ ...input, operation });
  if (!parsed.success) {
    throw helperError(parsed.error.message);
  }

  return parsed.data;
};

const persistentEntries = (value: JsonValue, kind: PersistentMutationKind): PersistentMutationEntry[] => {
  if (!Array.isArray(value)) throw helperError("Persistent mutation list response must be an array");
  const entries: PersistentMutationEntry[] = [];
  for (const item of value) {
    const parsed = persistentMutationEntrySchema.safeParse(item);
    if (!parsed.success || parsed.data.kind !== kind) {
      throw helperError(`Persistent ${kind} response is invalid`);
    }
    entries.push(parsed.data);
  }
  return entries;
};

const strictOptions = (value: unknown, allowed: readonly string[], label: string): JsonObject => {
  const options = requireJsonObject(value ?? {}, label);
  const unexpected = Object.keys(options).find((key) => !allowed.includes(key));
  if (unexpected) throw helperError(`${label} contains unknown field: ${unexpected}`);
  return options;
};

const requireBoolean = (value: JsonValue | undefined, label: string): void => {
  if (value !== undefined && typeof value !== "boolean") throw helperError(`${label} must be a boolean`);
};

const requireIntegerRange = (
  value: JsonValue | undefined,
  label: string,
  minimum: number,
  maximum: number,
): void => {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw helperError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
};

const validateMediaType = (mediaType: string | undefined, label: string): string | undefined => {
  if (mediaType === undefined) return undefined;
  if (!MEDIA_TYPE_PATTERN.test(mediaType)) {
    throw helperError(`${label} must be a syntactically valid media type`);
  }
  return mediaType.toLowerCase();
};

const imageMediaTypeFromOptions = (value: unknown): ImageMediaType | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw helperError(
      'chrome.emitImageResult(buffer, options?): options must be an object such as { mediaType: "image/png" }',
    );
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "mediaType")) {
    throw helperError(
      "chrome.emitImageResult options may contain only mediaType; image labels and filenames are not supported",
    );
  }
  if (value.mediaType === undefined) return undefined;
  if (
    value.mediaType === "image/png" ||
    value.mediaType === "image/jpeg" ||
    value.mediaType === "image/webp"
  ) {
    return value.mediaType;
  }
  throw helperError(
    'chrome.emitImageResult options.mediaType must be "image/png", "image/jpeg", or "image/webp"',
  );
};

export const encodeImage = (
  value: unknown,
  declaredMediaType?: ImageMediaType,
): { data: string; mediaType: ImageMediaType; size: number } => {
  if (!(value instanceof Uint8Array)) throw helperError("Image value must be a Buffer or Uint8Array");
  if (value.byteLength > RUN_ARTIFACT_MAX_BYTES) {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_ARTIFACT_QUOTA",
      `Image is ${value.byteLength} bytes; per-call maximum is ${RUN_ARTIFACT_MAX_BYTES} bytes`,
    );
  }
  let mediaType: ImageMediaType;
  try {
    mediaType = validateImageBytes(value, declaredMediaType);
  } catch (error: unknown) {
    throw helperError(error instanceof Error ? error.message : "Image bytes are invalid");
  }
  return { data: Buffer.from(value).toString("base64"), mediaType, size: value.byteLength };
};

const validateEventsOptions = (value: unknown): JsonObject => {
  const options = strictOptions(
    value,
    ["advance", "after", "includeStackTraces", "limit", "target", "types"],
    "Event read options",
  );
  requireBoolean(options.advance, "Event advance");
  requireBoolean(options.includeStackTraces, "Event includeStackTraces");
  requireIntegerRange(options.limit, "Event limit", JOURNAL_READ_MIN_LIMIT, JOURNAL_READ_MAX_LIMIT);
  if (options.target !== undefined && typeof options.target !== "string") {
    throw helperError("Event target must be a string");
  }
  if (
    options.types !== undefined &&
    (!Array.isArray(options.types) ||
      options.types.some((type) => typeof type !== "string" || type.length === 0))
  ) {
    throw helperError("Event types must be non-empty strings");
  }
  if (options.after !== undefined) {
    if (!isRecord(options.after)) throw helperError("Event cursor must be an object");
    const cursor = strictOptions(options.after, ["ownerGeneration", "sequence"], "Event cursor");
    requireIntegerRange(cursor.ownerGeneration, "Event owner generation", 0, Number.MAX_SAFE_INTEGER);
    requireIntegerRange(cursor.sequence, "Event sequence", 0, Number.MAX_SAFE_INTEGER);
  }
  return options;
};

const validateSnapshotOptions = (value: unknown): { options: JsonObject; root?: unknown } => {
  if (value === undefined) return { options: {} };
  if (!isRecord(value)) throw helperError("Snapshot options must be an object");
  const unexpected = Object.keys(value).find(
    (key) => !["depth", "diffFrom", "includeBoxes", "maxBytes", "root", "view"].includes(key),
  );
  if (unexpected) throw helperError(`Snapshot options contains unknown field: ${unexpected}`);
  const root = value.root;
  const jsonOptions: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "root") jsonOptions[key] = item;
  }
  const options = requireJsonObject(jsonOptions, "Snapshot options");
  requireIntegerRange(options.depth, "Snapshot depth", SNAPSHOT_MIN_DEPTH, SNAPSHOT_MAX_DEPTH);
  requireIntegerRange(options.maxBytes, "Snapshot maxBytes", SNAPSHOT_MIN_BYTES, SNAPSHOT_MAX_BYTES);
  requireBoolean(options.includeBoxes, "Snapshot includeBoxes");
  if (options.view !== undefined && options.view !== "bounded" && options.view !== "full") {
    throw helperError("Snapshot view must be bounded or full");
  }
  if (
    options.diffFrom !== undefined &&
    (typeof options.diffFrom !== "string" || options.diffFrom.length === 0)
  ) {
    throw helperError("Snapshot diffFrom must be a non-empty string");
  }
  return root === undefined ? { options } : { options, root };
};

const validateCaptureOptions = (value: unknown): JsonObject => {
  const options = requireJsonObject(value, "Capture options");
  const type = options.type;
  if (type === "trace") {
    const parsed = strictOptions(
      options,
      ["screenshots", "snapshots", "sources", "type"],
      "Trace capture options",
    );
    requireBoolean(parsed.screenshots, "Trace screenshots");
    requireBoolean(parsed.snapshots, "Trace snapshots");
    requireBoolean(parsed.sources, "Trace sources");
    return parsed;
  }
  if (type === "har") {
    const parsed = strictOptions(options, ["content", "type", "urlFilter"], "HAR capture options");
    if (parsed.content !== undefined && !["attach", "embed", "omit"].includes(String(parsed.content))) {
      throw helperError("HAR content must be attach, embed, or omit");
    }
    if (parsed.urlFilter !== undefined && typeof parsed.urlFilter !== "string") {
      throw helperError("HAR urlFilter must be a string");
    }
    return parsed;
  }
  if (type === "network-bodies") {
    const parsed = strictOptions(
      options,
      ["maxBodyBytes", "maxTotalBytes", "mimeTypes", "type"],
      "Network body capture options",
    );
    requireIntegerRange(
      parsed.maxBodyBytes,
      "Network body maxBodyBytes",
      1,
      CAPTURE_BODY_LIMITS.maximumBodyBytes,
    );
    requireIntegerRange(
      parsed.maxTotalBytes,
      "Network body maxTotalBytes",
      1,
      CAPTURE_BODY_LIMITS.maximumTotalBytes,
    );
    if (
      parsed.mimeTypes !== undefined &&
      (!Array.isArray(parsed.mimeTypes) ||
        parsed.mimeTypes.some((item) => typeof item !== "string" || item.length === 0))
    ) {
      throw helperError("Network body mimeTypes must be non-empty strings");
    }
    return parsed;
  }
  if (type === "video") {
    const parsed = strictOptions(
      options,
      ["format", "framesPerSecond", "height", "type", "width"],
      "Video capture options",
    );
    if (parsed.format !== undefined && parsed.format !== "webm") {
      throw helperError("Video format must be webm");
    }
    requireIntegerRange(
      parsed.width,
      "Video width",
      CAPTURE_VIDEO_LIMITS.minimumDimension,
      CAPTURE_VIDEO_LIMITS.maximumDimension,
    );
    requireIntegerRange(
      parsed.height,
      "Video height",
      CAPTURE_VIDEO_LIMITS.minimumDimension,
      CAPTURE_VIDEO_LIMITS.maximumDimension,
    );
    requireIntegerRange(
      parsed.framesPerSecond,
      "Video framesPerSecond",
      CAPTURE_VIDEO_LIMITS.minimumFramesPerSecond,
      CAPTURE_VIDEO_LIMITS.maximumFramesPerSecond,
    );
    return parsed;
  }
  throw helperError("Capture type must be trace, har, video, or network-bodies");
};

const validateCheckpointCreateOptions = (value: unknown): JsonObject => {
  const options = strictOptions(value, ["name", "screenshot", "storage"], "Checkpoint create options");
  requireBoolean(options.screenshot, "Checkpoint screenshot");
  requireBoolean(options.storage, "Checkpoint storage");
  if (options.name !== undefined && (typeof options.name !== "string" || options.name.length === 0)) {
    throw helperError("Checkpoint name must be a non-empty string");
  }
  return options;
};

const validateCheckpointDiffOptions = (value: unknown): JsonObject => {
  const options = strictOptions(
    value,
    ["events", "screenshot", "snapshot", "storage"],
    "Checkpoint diff options",
  );
  for (const key of ["events", "screenshot", "snapshot", "storage"]) {
    requireBoolean(options[key], `Checkpoint ${key}`);
  }
  return options;
};

const encodeFileChooserFiles = (input: unknown): JsonValue[] => {
  const files = Array.isArray(input) ? input : [input];
  if (files.length === 0) throw helperError("File chooser files must not be empty");
  const encoded: JsonValue[] = [];
  for (const [index, file] of files.entries()) {
    if (typeof file === "string" && file.length > 0) {
      encoded.push({ kind: "path", path: file });
      continue;
    }
    if (!isRecord(file)) throw helperError(`File chooser item ${index} must be a path or file payload`);
    const unexpected = Object.keys(file).find((key) => !["buffer", "mimeType", "name"].includes(key));
    if (unexpected) throw helperError(`File chooser item ${index} contains unknown field: ${unexpected}`);
    if (!(file.buffer instanceof Uint8Array)) {
      throw helperError(`File chooser item ${index} buffer must be binary data`);
    }
    encoded.push({
      bufferBase64: Buffer.from(file.buffer).toString("base64"),
      kind: "payload",
      mimeType: requireString(file.mimeType, `File chooser item ${index} mimeType`),
      name: requireString(file.name, `File chooser item ${index} name`),
    });
  }
  return encoded;
};

const readLocatorRecipe = (value: JsonValue): LocatorRecipe => {
  const recipe = strictOptions(value, ["frameChain", "selector", "targetId"], "Locator broker response");
  const frameChain = recipe.frameChain;
  if (!Array.isArray(frameChain)) throw helperError("Locator frameChain must be an array");
  return {
    frameChain: frameChain.map((selector, index) =>
      requireString(selector, `Locator frameChain item ${index}`),
    ),
    selector: requireString(recipe.selector, "Locator selector"),
    targetId: requireString(recipe.targetId, "Locator target ID"),
  };
};

const createProgressReporter = (rpc: HelperRpc) => {
  let acceptedCurrent: number | undefined;
  let fixedTotal: number | undefined;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let pending: PendingProgress | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sendPending = async () => {
    const update = pending;
    pending = undefined;
    timer = undefined;
    if (!update) return;
    try {
      await rpc.request({
        operation: "progress",
        payload: {
          current: update.current,
          message: update.message,
          ...(update.total === undefined ? {} : { total: update.total }),
        },
      });
      lastSentAt = Date.now();
      for (const waiter of update.waiters) waiter.resolve();
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      for (const waiter of update.waiters) waiter.reject(normalized);
    }
  };

  const report = (messageValue: string, currentValue?: number, totalValue?: number): Promise<void> => {
    const message = requireString(messageValue, "Progress message");
    if (Buffer.byteLength(message, "utf8") > PROGRESS_MESSAGE_MAX_BYTES) {
      throw helperError(`Progress message exceeds ${PROGRESS_MESSAGE_MAX_BYTES} UTF-8 bytes`);
    }
    if (currentValue !== undefined && (!Number.isFinite(currentValue) || currentValue < 0)) {
      throw helperError("Progress current must be a finite non-negative number");
    }
    if (totalValue !== undefined && (!Number.isFinite(totalValue) || totalValue < 0)) {
      throw helperError("Progress total must be a finite non-negative number");
    }
    if (fixedTotal !== undefined && totalValue !== undefined && totalValue !== fixedTotal) {
      throw helperError("Progress total must not change after its first value");
    }
    if (fixedTotal === undefined && totalValue !== undefined) fixedTotal = totalValue;
    const current = currentValue ?? (acceptedCurrent ?? 0) + 1;
    if (acceptedCurrent !== undefined && current <= acceptedCurrent) {
      throw helperError("Progress current must increase monotonically");
    }
    if (fixedTotal !== undefined && current > fixedTotal) {
      throw helperError("Progress current must not exceed total");
    }
    acceptedCurrent = current;

    let waiter: ProgressWaiter | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      waiter = { reject, resolve };
    });
    promise.catch(() => undefined);
    if (!waiter) throw helperError("Progress waiter initialization failed");

    if (pending) {
      pending.current = current;
      pending.message = message;
      pending.total = fixedTotal;
      pending.waiters.push(waiter);
      return promise;
    }

    pending = { current, message, total: fixedTotal, waiters: [waiter] };
    const delay = Math.max(0, PROGRESS_INTERVAL_MS - (Date.now() - lastSentAt));
    if (delay === 0) {
      sendPending().catch(() => undefined);
    } else {
      timer = setTimeout(() => sendPending().catch(() => undefined), delay);
    }
    return promise;
  };

  return {
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const update = pending;
      pending = undefined;
      if (!update) return;
      const error = new ChromeMcpExecutionError(
        "CHROME_MCP_CANCELLED",
        "Execution completed before progress was sent",
      );
      for (const waiter of update.waiters) waiter.reject(error);
    },
    report,
  };
};

const createDialogHelper = (dialog: DialogDescriptor, rpc: HelperRpc): ChromeDialogHelper =>
  Object.freeze({
    accept: async (promptText?: string) => {
      if (promptText !== undefined && typeof promptText !== "string") {
        throw helperError("Dialog prompt text must be a string");
      }
      await rpc.request({
        operation: "dialog_accept",
        payload: { modalId: dialog.modalId, ...(promptText === undefined ? {} : { promptText }) },
      });
    },
    defaultValue: dialog.defaultValue,
    dismiss: async () => {
      await rpc.request({ operation: "dialog_dismiss", payload: { modalId: dialog.modalId } });
    },
    message: dialog.message,
    type: dialog.type,
  });

const createFileChooserHelper = (
  fileChooser: FileChooserDescriptor,
  rpc: HelperRpc,
): ChromeFileChooserHelper =>
  Object.freeze({
    accept: fileChooser.accept,
    isMultiple: fileChooser.isMultiple,
    setFiles: async (files: unknown, unsupportedOptions?: unknown) => {
      if (unsupportedOptions !== undefined) {
        throw helperError(
          "File chooser setFiles options are not supported; configure the run_playwright timeout instead",
        );
      }
      await rpc.request({
        operation: "file_chooser_set_files",
        payload: {
          files: encodeFileChooserFiles(files),
          modalId: fileChooser.modalId,
        },
      });
    },
  });

export const createChromeHelperRuntime = (options: {
  capabilities: JsonObject;
  dialog: DialogDescriptor | null;
  fileChooser: FileChooserDescriptor | null;
  initialState: StateSnapshot;
  rpc: ExecutionRpcClient;
  selectedTargetId: string;
  session: ExecutionBrowserSession;
}): ChromeHelperRuntime => {
  const state = createTransactionalState(options.initialState);
  const stagedContent: StagedContent[] = [];
  let helperRequestsOpen = true;

  const helperController = new AbortController();

  let finalization: Promise<void> | undefined;
  const snapshotMarkers = new Set<SnapshotMarker>();
  const snapshotMarkerPreparations = new Set<Promise<SnapshotMarker>>();
  const workerEvaluations = new Set<Promise<JsonValue | undefined>>();
  const cancelledHelperResponse = Promise.withResolvers<BrokerRpcSuccess>().promise;
  const helperRpc: HelperRpc = Object.freeze({
    request: (request) => {
      if (!helperRequestsOpen) return cancelledHelperResponse;
      const promise = options.rpc
        .request(request)
        .then((response) => (helperRequestsOpen ? response : cancelledHelperResponse));
      promise.catch(() => undefined);
      return promise;
    },
  });
  const progress = createProgressReporter(helperRpc);
  const capabilityTemplate = copyJsonObject(options.capabilities, "Capabilities");
  freezeJsonValue(capabilityTemplate);
  let selectedTargetId = options.selectedTargetId;

  const mutationEntry = async (input: PersistentMutationInput): Promise<PersistentMutationEntry> => {
    const response = await helperRpc.request({ operation: "mutation_add", payload: { input } });
    const parsed = persistentMutationEntrySchema.safeParse(response.value);
    if (!parsed.success || parsed.data.kind !== input.kind) {
      throw helperError(`Persistent ${input.kind} response is invalid`);
    }
    return parsed.data;
  };

  const mutationList = async (kind: PersistentMutationKind): Promise<PersistentMutationEntry[]> => {
    const response = await helperRpc.request({ operation: "mutation_list", payload: { kind } });
    return persistentEntries(response.value, kind);
  };

  const mutationRemove = async (kind: PersistentMutationKind, idValue: string): Promise<boolean> => {
    const response = await helperRpc.request({
      operation: "mutation_remove",
      payload: { id: requireString(idValue, "Persistent mutation ID"), kind },
    });
    if (typeof response.value !== "boolean") {
      throw helperError(`Persistent ${kind} remove response is invalid`);
    }
    return response.value;
  };

  const mutationClear = async (kind: PersistentMutationKind): Promise<number> => {
    const response = await helperRpc.request({ operation: "mutation_clear", payload: { kind } });
    if (typeof response.value !== "number" || !Number.isSafeInteger(response.value) || response.value < 0) {
      throw helperError(`Persistent ${kind} clear response is invalid`);
    }
    return response.value;
  };

  const prepareSnapshotMarker = (root: unknown, token: SnapshotRootToken): Promise<SnapshotMarker> => {
    const preparation = options.session.markSnapshotRoot(root, token).then((restore) => {
      let restorePromise: Promise<void> | undefined;
      const marker: SnapshotMarker = {
        restore: () => {
          if (restorePromise) return restorePromise;
          restorePromise = (async () => {
            try {
              await restore();
            } finally {
              snapshotMarkers.delete(marker);
            }
          })();
          restorePromise.catch(() => undefined);
          return restorePromise;
        },
      };
      snapshotMarkers.add(marker);
      return marker;
    });
    snapshotMarkerPreparations.add(preparation);
    preparation.then(
      () => snapshotMarkerPreparations.delete(preparation),
      () => snapshotMarkerPreparations.delete(preparation),
    );
    return preparation;
  };

  const helper: ChromeExecutionHelper = Object.freeze({
    evaluateWorker: (input: WorkerEvaluationInput) => {
      if (!isRecord(input)) {
        throw helperError("Worker evaluation input must be an object");
      }

      const targetId = requireString(input.targetId, "Worker target ID");
      const expression = requireString(input.expression, "Worker expression");
      const evaluation = options.session.evaluateWorker({ targetId, expression }, helperController.signal);
      workerEvaluations.add(evaluation);
      evaluation.then(
        () => workerEvaluations.delete(evaluation),
        () => workerEvaluations.delete(evaluation),
      );

      return evaluation;
    },
    pwa: Object.freeze({
      install: async (input: PwaInstallInput) => {
        const result = await helperRpc.request({
          operation: "pwa",
          payload: parsePwaInput(input, "install"),
        });
        return result.value;
      },
      launch: async (input: PwaLaunchInput) => {
        const response = await helperRpc.request({
          operation: "pwa",
          payload: parsePwaInput(input, "launch"),
        });
        const result = pwaResultSchema.parse(response.value);
        if (result.operation !== "launch") {
          throw helperError("PWA launch returned an invalid result");
        }

        const launchedPage = await options.session.pageForTarget(result.targetId, helperController.signal);
        await helperRpc.request({ operation: "select_page", payload: { targetId: result.targetId } });
        selectedTargetId = result.targetId;
        return launchedPage;
      },
      getState: async (input: { manifestId: string }) => {
        const response = await helperRpc.request({
          operation: "pwa",
          payload: parsePwaInput(input, "getState"),
        });
        const result = pwaResultSchema.parse(response.value);
        if (result.operation !== "getState") {
          throw helperError("PWA state returned an invalid result");
        }

        return result.state;
      },
      uninstall: async (input: { manifestId: string }) => {
        const result = await helperRpc.request({
          operation: "pwa",
          payload: parsePwaInput(input, "uninstall"),
        });
        return result.value;
      },
    }),
    bindings: Object.freeze({
      add: async (bindingInput: PersistentBindingInput) => {
        const input = persistentInput(persistentBindingInputSchema, bindingInput);
        const entry = await mutationEntry({ ...input, kind: "binding" });
        if (entry.kind !== "binding") throw helperError("Persistent binding response is invalid");
        return entry;
      },
      clear: () => mutationClear("binding"),
      list: async () => {
        const entries = await mutationList("binding");
        return entries.map((entry) => {
          if (entry.kind !== "binding") throw helperError("Persistent binding response is invalid");
          return entry;
        });
      },
      remove: (id: string) => mutationRemove("binding", id),
    }),
    get capabilities() {
      const current = copyJsonObject(capabilityTemplate, "Capabilities");
      current.selectedTargetId = selectedTargetId;
      freezeJsonValue(current);
      return current;
    },
    capture: Object.freeze({
      start: async (captureOptions: unknown) => {
        const response = await helperRpc.request({
          operation: "capture_start",
          payload: { options: validateCaptureOptions(captureOptions) },
        });

        return response.value;
      },
      stop: async (captureId: string) => {
        const response = await helperRpc.request({
          operation: "capture_stop",
          payload: { captureId: requireString(captureId, "Capture ID") },
        });

        return response.value;
      },
    }),
    checkpoint: Object.freeze({
      create: async (checkpointOptions?: unknown) => {
        const response = await helperRpc.request({
          operation: "checkpoint_create",
          payload: { options: validateCheckpointCreateOptions(checkpointOptions) },
        });

        return response.value;
      },
      diff: async (checkpointId: string, checkpointOptions?: unknown) => {
        const response = await helperRpc.request({
          operation: "checkpoint_diff",
          payload: {
            checkpointId: requireString(checkpointId, "Checkpoint ID"),
            options: validateCheckpointDiffOptions(checkpointOptions),
          },
        });

        return response.value;
      },
    }),
    captureAccessibilitySnapshot: async (snapshotOptions?: unknown) => {
      const parsed = validateSnapshotOptions(snapshotOptions);
      if (parsed.root === undefined) {
        const response = await helperRpc.request({
          operation: "snapshot",
          payload: { options: parsed.options },
        });

        return response.value;
      }
      const token: SnapshotRootToken = {
        attributeName: `${SNAPSHOT_MARKER_PREFIX}-${crypto.randomUUID()}`,
        attributeValue: "root",
        kind: "temporary-attribute",
      };
      const marker = await prepareSnapshotMarker(parsed.root, token);
      try {
        const response = await helperRpc.request({
          operation: "snapshot",
          payload: { options: parsed.options, root: token },
        });

        return response.value;
      } finally {
        await marker.restore();
      }
    },
    clearSessionState: state.clear,
    deleteSessionStateValue: state.delete,
    dialog: options.dialog ? createDialogHelper(options.dialog, helperRpc) : undefined,
    events: Object.freeze({
      mark: async () => {
        const response = await helperRpc.request({ operation: "events_mark", payload: {} });

        return response.value;
      },
      read: async (eventOptions?: unknown) => {
        const response = await helperRpc.request({
          operation: "events_read",
          payload: { options: validateEventsOptions(eventOptions) },
        });

        return response.value;
      },
    }),
    emitImageResult: (buffer: Uint8Array, imageOptions?: { mediaType?: ImageMediaType }) => {
      const encoded = encodeImage(buffer, imageMediaTypeFromOptions(imageOptions));
      stagedContent.push({ data: encoded.data, mediaType: encoded.mediaType, type: "image" });
      return undefined;
    },
    emitTextResult: (value: string) => {
      if (typeof value !== "string") throw helperError("Text output must be a string");
      stagedContent.push({ text: value, type: "text" });
      return undefined;
    },
    getSessionStateValue: state.get,
    listSessionStateEntries: state.entries,
    publishFileArtifact: async (pathValue: string, mediaTypeValue?: string) => {
      const path = requireString(pathValue, "Artifact file path");
      const mediaType = validateMediaType(mediaTypeValue, "Artifact file media type");
      const response = await helperRpc.request({
        operation: "artifact_file",
        payload: { path, ...(mediaType ? { mediaType } : {}) },
      });
      const artifact = response.artifacts[0];
      if (!artifact) throw helperError("Artifact broker did not return a descriptor");
      stagedContent.push({ artifact, type: "resource" });
      return artifact;
    },
    fileChooser: options.fileChooser ? createFileChooserHelper(options.fileChooser, helperRpc) : undefined,
    initScripts: Object.freeze({
      add: async (source: string) => {
        const input = persistentInput(persistentInitScriptInputSchema, { source });
        const entry = await mutationEntry({ ...input, kind: "initScript" });
        if (entry.kind !== "initScript") throw helperError("Persistent initScript response is invalid");
        return entry;
      },
      clear: () => mutationClear("initScript"),
      list: async () => {
        const entries = await mutationList("initScript");
        return entries.map((entry) => {
          if (entry.kind !== "initScript") throw helperError("Persistent initScript response is invalid");
          return entry;
        });
      },
      remove: (id: string) => mutationRemove("initScript", id),
    }),
    resolveSnapshotRefToLocator: async (ref: string) => {
      const response = await helperRpc.request({
        operation: "locator_resolve",
        payload: { ref: requireString(ref, "Snapshot ref") },
      });
      const recipe = readLocatorRecipe(response.value);
      return options.session.locatorFromRecipe(recipe);
    },
    reportCallProgress: progress.report,
    reserveArtifactOutputPath: async (nameValue: string, mediaTypeValue?: string) => {
      const name = requireString(nameValue, "Artifact output name");
      const isBoundedBasename =
        Buffer.byteLength(name, "utf8") <= ARTIFACT_NAME_MAX_BYTES &&
        !name.includes("/") &&
        !name.includes("\\") &&
        name !== "." &&
        name !== "..";
      if (!isBoundedBasename) {
        throw helperError(
          `Artifact output name must be a basename no longer than ${ARTIFACT_NAME_MAX_BYTES} UTF-8 bytes`,
        );
      }
      const mediaType = validateMediaType(mediaTypeValue, "Artifact output media type");
      const response = await helperRpc.request({
        operation: "artifact_output_path",
        payload: { name, ...(mediaType ? { mediaType } : {}) },
      });
      if (typeof response.value !== "string" || response.value.length === 0) {
        throw helperError("Artifact broker did not return an output path");
      }
      return response.value;
    },
    routes: Object.freeze({
      add: async (routeInput: PersistentRouteInput) => {
        const input = persistentInput(persistentRouteInputSchema, routeInput);
        const entry = await mutationEntry({ ...input, kind: "route" });
        if (entry.kind !== "route") throw helperError("Persistent route response is invalid");
        return entry;
      },
      clear: () => mutationClear("route"),
      list: async () => {
        const entries = await mutationList("route");
        return entries.map((entry) => {
          if (entry.kind !== "route") throw helperError("Persistent route response is invalid");
          return entry;
        });
      },
      remove: (id: string) => mutationRemove("route", id),
    }),
    selectPageForSession: async (page: unknown) => {
      const targetId = await options.session.targetIdForPage(page);
      await helperRpc.request({ operation: "select_page", payload: { targetId } });
      selectedTargetId = targetId;
    },
    setSessionStateValue: state.set,
  });

  return Object.freeze({
    cancelPending: () => {
      if (finalization) return finalization;
      helperRequestsOpen = false;

      helperController.abort(
        new ChromeMcpExecutionError("CHROME_MCP_CANCELLED", "Execution ended during PWA page registration"),
      );

      progress.cancel();
      options.rpc.cancelPending();
      finalization = (async () => {
        await Promise.allSettled(workerEvaluations);
        await Promise.all(snapshotMarkerPreparations);
        await Promise.all([...snapshotMarkers].map((marker) => marker.restore()));
      })();
      finalization.catch(() => undefined);
      return finalization;
    },
    helper,
    selectedTargetId: () => selectedTargetId,
    stagedContent: () => [...stagedContent],
    stateSnapshot: state.snapshot,
  });
};
