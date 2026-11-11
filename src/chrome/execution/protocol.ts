import type { ArtifactDescriptor as StoredArtifactDescriptor } from "../artifacts/types";
import { isRecord } from "../../platform/records";
import { ARTIFACT_URI_PROTOCOL } from "../artifacts/uris";
import { BROWSER_MODES, type BrowserMode } from "../browser-modes";
import { type PageViewportRequest, pageViewportRequestSchema } from "../runtime/page-viewport";
import {
  type PersistentMutationInput,
  persistentMutationInputSchema,
  type PersistentMutationKind,
  persistentMutationKindSchema,
} from "../runtime/persistent-mutations";
import { type PwaOperation, pwaOperationSchema } from "../runtime/pwa-controller";
import {
  ChromeMcpExecutionError,
  EXECUTION_ERROR_CODES,
  type ExecutionErrorCode,
  type SerializedExecutionError,
} from "./errors";
import { decodeCanonicalBase64, type ImageMediaType, validateEncodedImage } from "./image-codec";
import {
  canonicalJsonStringify,
  copyJsonObject,
  copyJsonValue,
  type JsonObject,
  type JsonValue,
} from "./json";
import { type StateSnapshot, validateStateSnapshot } from "./state";

export const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;
export const MIN_EXECUTION_TIMEOUT_MS = 100;
export const MAX_EXECUTION_TIMEOUT_MS = 120_000;
export const INLINE_TEXT_MAX_BYTES = 64 * 1024;
export const INLINE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const INLINE_IMAGE_MAX_COUNT = 4;
export const INLINE_IMAGE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const RUN_ARTIFACT_MAX_BYTES = 100 * 1024 * 1024;

export { BROWSER_MODES, type BrowserMode } from "../browser-modes";
export type { ImageMediaType } from "./image-codec";

export type ArtifactDescriptor = StoredArtifactDescriptor;

export type DialogDescriptor = {
  defaultValue: string;
  message: string;
  modalId: string;
  type: "alert" | "beforeunload" | "confirm" | "prompt";
};

export type FileChooserDescriptor = {
  accept: string;
  isMultiple: boolean;
  modalId: string;
};

export type SnapshotRootToken = {
  attributeName: string;
  attributeValue: string;
  kind: "temporary-attribute";
};

export type BrokerRpcRequest =
  | { operation: "artifact_file"; payload: { mediaType?: string; path: string } }
  | {
      operation: "artifact_output_path";
      payload: { mediaType?: string; name: string };
    }
  | {
      operation: "artifact_publish";
      payload: {
        data: string;
        encoding: "base64" | "utf8";
        mediaType: string;
        name: string;
      };
    }
  | { operation: "capture_start"; payload: { options: JsonObject } }
  | { operation: "capture_stop"; payload: { captureId: string } }
  | { operation: "checkpoint_create"; payload: { options: JsonObject } }
  | {
      operation: "checkpoint_diff";
      payload: { checkpointId: string; options: JsonObject };
    }
  | { operation: "dialog_accept"; payload: { modalId: string; promptText?: string } }
  | { operation: "dialog_dismiss"; payload: { modalId: string } }
  | { operation: "events_mark"; payload: JsonObject }
  | { operation: "events_read"; payload: { options: JsonObject } }
  | {
      operation: "file_chooser_set_files";
      payload: { files: JsonValue[]; modalId: string };
    }
  | { operation: "locator_resolve"; payload: { ref: string } }
  | { operation: "media_emulate"; payload: { options: JsonObject; targetId: string } }
  | { operation: "mutation_add"; payload: { input: PersistentMutationInput } }
  | { operation: "mutation_clear"; payload: { kind: PersistentMutationKind } }
  | { operation: "mutation_list"; payload: { kind: PersistentMutationKind } }
  | { operation: "mutation_remove"; payload: { id: string; kind: PersistentMutationKind } }
  | {
      operation: "owner_close_authorize";
      payload: { resource: "browser" | "default-context" };
    }
  | { operation: "page_viewport"; payload: PageViewportRequest }
  | {
      operation: "progress";
      payload: { current?: number; message: string; total?: number };
    }
  | { operation: "pwa"; payload: PwaOperation }
  | { operation: "select_page"; payload: { targetId: string } }
  | {
      operation: "snapshot";
      payload: { options: JsonObject; root?: SnapshotRootToken };
    };

export type BrokerRpcSuccess = {
  artifacts: ArtifactDescriptor[];
  ok: true;
  value: JsonValue;
};

export type BrokerRpcFailure = {
  error: SerializedExecutionError;
  ok: false;
};

export type BrokerRpcResponse = BrokerRpcFailure | BrokerRpcSuccess;

export type StagedContent =
  | { artifact: ArtifactDescriptor; type: "resource" }
  | { data: string; mediaType: ImageMediaType; type: "image" }
  | { text: string; type: "text" };

export type InlineStagedContent = Exclude<StagedContent, { type: "resource" }>;

export type ExecutionKernelSuccess = {
  artifacts: ArtifactDescriptor[];
  content: StagedContent[];
  emittedCount: number;
  ok: true;
  selectedTargetId: string;
  state: StateSnapshot;
  value?: JsonValue;
  valueArtifact?: ArtifactDescriptor;
  valueImage?: { data: string; mediaType: ImageMediaType };
};

export type ExecutionKernelFailure = {
  artifacts: ArtifactDescriptor[];
  error: SerializedExecutionError;
  ok: false;
  partialContent?: InlineStagedContent[];
  partialEmittedCount?: number;
  partialOmittedCount?: number;
  selectedTargetId: string | null;
};

export type ExecutionKernelResult = ExecutionKernelFailure | ExecutionKernelSuccess;

export type ExecutionWorkerRequest = {
  args: JsonValue;
  browserMode: BrowserMode;
  callId: string;
  capabilities: JsonObject;
  cdpEndpoint: string;
  code: string;
  connectTimeoutMs: number;
  dialog: DialogDescriptor | null;
  downloadsPath?: string;
  fileChooser: FileChooserDescriptor | null;
  selectedTargetId: string;
  state: StateSnapshot;
};

export type BrokerToWorkerMessage =
  | {
      callId: string;
      response: BrokerRpcResponse;
      rpcId: string;
      type: "rpc_response";
    }
  | {
      callId: string;
      type: "execution_result_ack";
    }
  | {
      request: ExecutionWorkerRequest;
      type: "execute";
    };

export type WorkerToBrokerMessage =
  | {
      callId: string;
      request: BrokerRpcRequest;
      rpcId: string;
      type: "rpc_request";
    }
  | {
      callId: string;
      result: ExecutionKernelResult;
      type: "execution_result";
    }
  | {
      callId: string;
      rpcIds: string[];
      type: "rpc_cancel";
    }
  | {
      type: "ready";
    };

const invalidInput = (message: string, cause?: unknown): ChromeMcpExecutionError =>
  new ChromeMcpExecutionError(
    "CHROME_MCP_INVALID_INPUT",
    message,
    cause === undefined ? undefined : { cause },
  );

const ARTIFACT_MEDIA_TYPE_PATTERN = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const ownKeys = (value: Record<string, unknown>): string[] =>
  Object.keys(value).sort((left, right) => left.localeCompare(right));

const assertStrictKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  const unexpected = ownKeys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw invalidInput(`${label} contains unknown field: ${unexpected[0]}`);
};

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw invalidInput(`${label} must be an object`);
  return value;
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidInput(`${label} must be a non-empty string`);
  }
  return value;
};

const requireText = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw invalidInput(`${label} must be a string`);
  return value;
};

const optionalString = (value: unknown, label: string): string | undefined =>
  value === undefined ? undefined : requireString(value, label);

const requireInteger = (value: unknown, label: string, minimum = 0): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw invalidInput(`${label} must be an integer no smaller than ${minimum}`);
  }
  return value;
};

const parseArtifactMediaType = (value: unknown, label: string): string => {
  const mediaType = requireString(value, label);
  if (!ARTIFACT_MEDIA_TYPE_PATTERN.test(mediaType)) {
    throw invalidInput(`${label} must be a syntactically valid media type without parameters`);
  }
  return mediaType.toLowerCase();
};

const requireFiniteNumber = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidInput(`${label} must be a finite number`);
  }
  return value;
};

const parseBrowserMode = (value: unknown, label: string): BrowserMode => {
  for (const mode of BROWSER_MODES) {
    if (value === mode) return mode;
  }
  throw invalidInput(`${label} must be one of ${BROWSER_MODES.join(", ")}`);
};

const parseStateSnapshot = (value: unknown): StateSnapshot => {
  if (!Array.isArray(value)) throw invalidInput("Worker state must be an array");
  const entries: StateSnapshot = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string") {
      throw invalidInput("Worker state entries must be [key, value]");
    }
    entries.push([item[0], copyJsonValue(item[1], "Worker state value")]);
  }
  try {
    return validateStateSnapshot(entries);
  } catch (error: unknown) {
    throw invalidInput(error instanceof Error ? error.message : "Worker state is invalid", error);
  }
};

const parseArtifactDescriptor = (value: unknown): ArtifactDescriptor => {
  const record = requireRecord(value, "Artifact descriptor");
  assertStrictKeys(
    record,
    ["artifactId", "complete", "createdAt", "expiresAt", "mediaType", "name", "sha256", "size", "uri"],
    "Artifact descriptor",
  );
  if (typeof record.complete !== "boolean") throw invalidInput("Artifact complete must be a boolean");
  const artifactId = requireString(record.artifactId, "Artifact ID");
  const expiresAt =
    record.expiresAt === null ? null : requireString(record.expiresAt, "Artifact expiry time");
  const sha256 = requireString(record.sha256, "Artifact digest");
  if (!SHA256_PATTERN.test(sha256)) {
    throw invalidInput("Artifact digest must be a lowercase SHA-256 hex string");
  }
  const uri = requireString(record.uri, "Artifact URI");
  let parsedUri: URL;
  try {
    parsedUri = new URL(uri);
  } catch (error: unknown) {
    throw invalidInput("Artifact URI must be a valid chrome-artifact URI", error);
  }
  const path = parsedUri.pathname.split("/").filter((segment) => segment.length > 0);
  const isDescriptorArtifactUri =
    parsedUri.protocol === ARTIFACT_URI_PROTOCOL &&
    parsedUri.hostname.length > 0 &&
    path[0] === artifactId &&
    (path[1] === "content" || path[1] === "manifest") &&
    path.length === 2 &&
    parsedUri.search.length === 0 &&
    parsedUri.hash.length === 0;
  if (!isDescriptorArtifactUri) throw invalidInput("Artifact URI must identify the descriptor artifact");

  return {
    artifactId,
    complete: record.complete,
    createdAt: requireString(record.createdAt, "Artifact creation time"),
    expiresAt,
    mediaType: parseArtifactMediaType(record.mediaType, "Artifact media type"),
    name: requireString(record.name, "Artifact name"),
    sha256,
    size: requireInteger(record.size, "Artifact size"),
    uri,
  };
};

const parseArtifactDescriptors = (value: unknown): ArtifactDescriptor[] => {
  if (!Array.isArray(value)) throw invalidInput("Artifact list must be an array");
  const descriptors = value.map(parseArtifactDescriptor);
  const artifactIds = new Set<string>();
  for (const descriptor of descriptors) {
    if (artifactIds.has(descriptor.artifactId)) {
      throw invalidInput(`Artifact list contains duplicate ID: ${descriptor.artifactId}`);
    }
    artifactIds.add(descriptor.artifactId);
  }
  return descriptors;
};

export const artifactDescriptorsEqual = (left: ArtifactDescriptor, right: ArtifactDescriptor): boolean =>
  left.artifactId === right.artifactId &&
  left.complete === right.complete &&
  left.createdAt === right.createdAt &&
  left.expiresAt === right.expiresAt &&
  left.mediaType === right.mediaType &&
  left.name === right.name &&
  left.sha256 === right.sha256 &&
  left.size === right.size &&
  left.uri === right.uri;

const artifactMap = (artifacts: readonly ArtifactDescriptor[]): Map<string, ArtifactDescriptor> =>
  new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));

const assertArtifactReference = (
  reference: ArtifactDescriptor,
  artifacts: ReadonlyMap<string, ArtifactDescriptor>,
  label: string,
): void => {
  const owned = artifacts.get(reference.artifactId);
  if (!owned || !artifactDescriptorsEqual(reference, owned)) {
    throw invalidInput(`${label} must exactly match a top-level artifact descriptor`);
  }
};

const parseSerializedError = (value: unknown): SerializedExecutionError => {
  const record = requireRecord(value, "Execution error");
  assertStrictKeys(record, ["code", "message", "name", "stack"], "Execution error");
  let code: ExecutionErrorCode | undefined;
  for (const candidate of EXECUTION_ERROR_CODES) {
    if (record.code === candidate) code = candidate;
  }
  if (!code) throw invalidInput("Execution error code is unknown");
  const stack = optionalString(record.stack, "Execution error stack");
  const parsed = {
    code,
    message: requireString(record.message, "Execution error message"),
    name: requireString(record.name, "Execution error name"),
  };
  return stack ? { ...parsed, stack } : parsed;
};

const parseDialog = (value: unknown): DialogDescriptor | null => {
  if (value === null) return null;
  const record = requireRecord(value, "Dialog descriptor");
  assertStrictKeys(record, ["defaultValue", "message", "modalId", "type"], "Dialog descriptor");
  if (!["alert", "beforeunload", "confirm", "prompt"].includes(String(record.type))) {
    throw invalidInput("Dialog type is invalid");
  }
  const type = String(record.type);
  if (type !== "alert" && type !== "beforeunload" && type !== "confirm" && type !== "prompt") {
    throw invalidInput("Dialog type is invalid");
  }
  return {
    defaultValue: requireText(record.defaultValue, "Dialog default value"),
    message: requireText(record.message, "Dialog message"),
    modalId: requireString(record.modalId, "Dialog modal ID"),
    type,
  };
};

const parseFileChooser = (value: unknown): FileChooserDescriptor | null => {
  if (value === null) return null;
  const record = requireRecord(value, "File chooser descriptor");
  assertStrictKeys(record, ["accept", "isMultiple", "modalId"], "File chooser descriptor");
  if (typeof record.isMultiple !== "boolean") throw invalidInput("File chooser isMultiple must be a boolean");
  return {
    accept: requireText(record.accept, "File chooser accept value"),
    isMultiple: record.isMultiple,
    modalId: requireString(record.modalId, "File chooser modal ID"),
  };
};

export const parseExecutionWorkerRequest = (value: unknown): ExecutionWorkerRequest => {
  const record = requireRecord(value, "Execution worker request");
  assertStrictKeys(
    record,
    [
      "args",
      "browserMode",
      "callId",
      "capabilities",
      "cdpEndpoint",
      "code",
      "connectTimeoutMs",
      "dialog",
      "downloadsPath",
      "fileChooser",
      "selectedTargetId",
      "state",
    ],
    "Execution worker request",
  );
  return {
    args: copyJsonValue(record.args, "Execution args"),
    browserMode: parseBrowserMode(record.browserMode, "Execution browser mode"),
    callId: requireString(record.callId, "Execution call ID"),
    capabilities: copyJsonObject(record.capabilities, "Execution capabilities"),
    cdpEndpoint: requireString(record.cdpEndpoint, "Execution CDP endpoint"),
    code: requireString(record.code, "Execution code"),
    connectTimeoutMs: requireInteger(record.connectTimeoutMs, "Execution connect timeout", 1),
    dialog: parseDialog(record.dialog),
    ...(record.downloadsPath === undefined ?
      {}
    : { downloadsPath: requireString(record.downloadsPath, "Execution downloads path") }),
    fileChooser: parseFileChooser(record.fileChooser),
    selectedTargetId: requireString(record.selectedTargetId, "Execution selected target ID"),
    state: parseStateSnapshot(record.state),
  };
};

const parseImageMediaType = (value: unknown): ImageMediaType => {
  if (value === "image/jpeg" || value === "image/png" || value === "image/webp") return value;
  throw invalidInput("Image media type is invalid");
};

const parseEncodedImage = (dataValue: unknown, mediaTypeValue: unknown, label: string) => {
  const data = requireString(dataValue, `${label} data`);
  const mediaType = parseImageMediaType(mediaTypeValue);
  try {
    validateEncodedImage(data, mediaType, INLINE_IMAGE_MAX_BYTES, label);
  } catch (error: unknown) {
    throw invalidInput(error instanceof Error ? error.message : `${label} is invalid`, error);
  }
  return { data, mediaType };
};

const parseStagedContent = (value: unknown): StagedContent => {
  const record = requireRecord(value, "Staged content");
  if (record.type === "text") {
    assertStrictKeys(record, ["text", "type"], "Text content");
    return { text: requireText(record.text, "Text content value"), type: "text" };
  }
  if (record.type === "image") {
    assertStrictKeys(record, ["data", "mediaType", "type"], "Image content");
    return { ...parseEncodedImage(record.data, record.mediaType, "Image content"), type: "image" };
  }
  if (record.type === "resource") {
    assertStrictKeys(record, ["artifact", "type"], "Resource content");
    return { artifact: parseArtifactDescriptor(record.artifact), type: "resource" };
  }
  throw invalidInput("Staged content type is invalid");
};

const parseStagedContentList = (value: unknown): StagedContent[] => {
  if (!Array.isArray(value)) throw invalidInput("Execution content must be an array");
  const content = value.map(parseStagedContent);
  const textBytes = content.reduce(
    (total, item) => total + (item.type === "text" ? Buffer.byteLength(item.text, "utf8") : 0),
    0,
  );
  if (textBytes > INLINE_TEXT_MAX_BYTES) {
    throw invalidInput(`Inline execution text exceeds ${INLINE_TEXT_MAX_BYTES} UTF-8 bytes`);
  }
  return content;
};

const assertInlineImageLimits = (
  content: readonly StagedContent[],
  valueImage: { data: string } | undefined,
  label: string,
): void => {
  let inlineImageBytes = valueImage ? Buffer.byteLength(valueImage.data, "base64") : 0;
  let inlineImageCount = valueImage ? 1 : 0;
  for (const item of content) {
    if (item.type !== "image") continue;
    inlineImageBytes += Buffer.byteLength(item.data, "base64");
    inlineImageCount += 1;
  }
  if (inlineImageCount > INLINE_IMAGE_MAX_COUNT) {
    throw invalidInput(`${label} may contain at most ${INLINE_IMAGE_MAX_COUNT} inline images`);
  }
  if (inlineImageBytes > INLINE_IMAGE_MAX_TOTAL_BYTES) {
    throw invalidInput(
      `${label} may contain at most ${INLINE_IMAGE_MAX_TOTAL_BYTES} decoded inline image bytes`,
    );
  }
};

export const parseExecutionKernelResult = (value: unknown): ExecutionKernelResult => {
  const record = requireRecord(value, "Execution result");
  if (record.ok === false) {
    assertStrictKeys(
      record,
      [
        "artifacts",
        "error",
        "ok",
        "partialContent",
        "partialEmittedCount",
        "partialOmittedCount",
        "selectedTargetId",
      ],
      "Failed execution result",
    );
    if (record.selectedTargetId !== null && typeof record.selectedTargetId !== "string") {
      throw invalidInput("Failed execution selected target ID must be a string or null");
    }
    const result: ExecutionKernelFailure = {
      artifacts: parseArtifactDescriptors(record.artifacts),
      error: parseSerializedError(record.error),
      ok: false,
      selectedTargetId: record.selectedTargetId,
    };
    const hasPartialFields =
      record.partialContent !== undefined ||
      record.partialEmittedCount !== undefined ||
      record.partialOmittedCount !== undefined;
    if (!hasPartialFields) return result;
    if (
      record.partialContent === undefined ||
      record.partialEmittedCount === undefined ||
      record.partialOmittedCount === undefined
    ) {
      throw invalidInput("Failed execution partial output fields must be provided together");
    }
    const partialContent = parseStagedContentList(record.partialContent);
    const inlinePartialContent = partialContent.filter(
      (item): item is InlineStagedContent => item.type !== "resource",
    );
    if (inlinePartialContent.length !== partialContent.length) {
      throw invalidInput("Failed execution partial content may contain only text and images");
    }
    const partialEmittedCount = requireInteger(
      record.partialEmittedCount,
      "Failed execution partial emitted count",
    );
    const partialOmittedCount = requireInteger(
      record.partialOmittedCount,
      "Failed execution partial omitted count",
    );
    if (partialEmittedCount !== inlinePartialContent.length) {
      throw invalidInput("Failed execution partial emitted count must equal the partial content count");
    }
    assertInlineImageLimits(inlinePartialContent, undefined, "Failed execution partial content");
    result.partialContent = inlinePartialContent;
    result.partialEmittedCount = partialEmittedCount;
    result.partialOmittedCount = partialOmittedCount;
    return result;
  }
  if (record.ok !== true) throw invalidInput("Execution result ok must be a boolean");
  assertStrictKeys(
    record,
    [
      "artifacts",
      "content",
      "emittedCount",
      "ok",
      "selectedTargetId",
      "state",
      "value",
      "valueArtifact",
      "valueImage",
    ],
    "Successful execution result",
  );
  const artifacts = parseArtifactDescriptors(record.artifacts);
  const content = parseStagedContentList(record.content);
  const emittedCount = requireInteger(record.emittedCount, "Execution emitted count");
  if (emittedCount !== content.length) {
    throw invalidInput("Execution emitted count must equal the staged content count");
  }
  const result: ExecutionKernelSuccess = {
    artifacts,
    content,
    emittedCount,
    ok: true,
    selectedTargetId: requireString(record.selectedTargetId, "Execution selected target ID"),
    state: parseStateSnapshot(record.state),
  };
  const valueFields = [
    record.value !== undefined,
    record.valueArtifact !== undefined,
    record.valueImage !== undefined,
  ].filter(Boolean).length;
  if (valueFields > 1) {
    throw invalidInput("Execution result may contain only one returned value representation");
  }
  if (record.value !== undefined) {
    result.value = copyJsonValue(record.value, "Execution return value");
    const textBytes = content.reduce(
      (total, item) => total + (item.type === "text" ? Buffer.byteLength(item.text, "utf8") : 0),
      0,
    );
    const combinedBytes = textBytes + Buffer.byteLength(canonicalJsonStringify(result.value), "utf8");
    if (combinedBytes > INLINE_TEXT_MAX_BYTES) {
      throw invalidInput(
        `Combined inline execution text and JSON exceeds ${INLINE_TEXT_MAX_BYTES} UTF-8 bytes`,
      );
    }
  }
  if (record.valueArtifact !== undefined) {
    result.valueArtifact = parseArtifactDescriptor(record.valueArtifact);
  }
  if (record.valueImage !== undefined) {
    const image = requireRecord(record.valueImage, "Execution returned image");
    assertStrictKeys(image, ["data", "mediaType"], "Execution returned image");
    result.valueImage = parseEncodedImage(image.data, image.mediaType, "Execution returned image");
  }
  assertInlineImageLimits(content, result.valueImage, "Execution result");
  const artifactsById = artifactMap(artifacts);
  for (const item of content) {
    if (item.type === "resource") {
      assertArtifactReference(item.artifact, artifactsById, "Resource content artifact");
    }
  }
  if (result.valueArtifact) {
    assertArtifactReference(result.valueArtifact, artifactsById, "Returned value artifact");
  }
  return result;
};

export const assertExecutionArtifactProvenance = (
  result: ExecutionKernelResult,
  brokerArtifacts: readonly ArtifactDescriptor[],
): void => {
  const expected = artifactMap(parseArtifactDescriptors(brokerArtifacts));
  const actual = artifactMap(result.artifacts);
  if (expected.size !== actual.size) {
    throw invalidInput("Execution result artifact list does not match broker-issued artifacts");
  }
  for (const [artifactId, descriptor] of expected) {
    const returned = actual.get(artifactId);
    if (!returned || !artifactDescriptorsEqual(descriptor, returned)) {
      throw invalidInput(`Execution result contains an unissued or modified artifact: ${artifactId}`);
    }
  }
};

const BROKER_RPC_OPERATION_NAMES = {
  artifact_file: true,
  artifact_output_path: true,
  artifact_publish: true,
  capture_start: true,
  capture_stop: true,
  checkpoint_create: true,
  checkpoint_diff: true,
  dialog_accept: true,
  dialog_dismiss: true,
  events_mark: true,
  events_read: true,
  file_chooser_set_files: true,
  locator_resolve: true,
  media_emulate: true,
  page_viewport: true,
  pwa: true,
  mutation_add: true,
  mutation_clear: true,
  mutation_list: true,
  mutation_remove: true,
  owner_close_authorize: true,
  progress: true,
  select_page: true,
  snapshot: true,
} satisfies Record<BrokerRpcRequest["operation"], true>;

const isBrokerRpcOperation = (value: unknown): value is BrokerRpcRequest["operation"] => {
  return typeof value === "string" && Object.hasOwn(BROKER_RPC_OPERATION_NAMES, value);
};

const parseRpcOperation = (value: unknown) => {
  if (isBrokerRpcOperation(value)) return value;
  throw invalidInput("Broker RPC operation is unknown");
};

const strictPayload = (
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> => {
  const payload = requireRecord(value, label);
  assertStrictKeys(payload, allowed, label);
  return payload;
};

const parseFileChooserFile = (value: unknown, index: number): JsonValue => {
  const file = requireRecord(value, `File chooser item ${index}`);
  if (file.kind === "path") {
    assertStrictKeys(file, ["kind", "path"], `File chooser item ${index}`);
    return { kind: "path", path: requireString(file.path, `File chooser item ${index} path`) };
  }
  if (file.kind === "payload") {
    assertStrictKeys(file, ["bufferBase64", "kind", "mimeType", "name"], `File chooser item ${index}`);
    const bufferBase64 = requireText(file.bufferBase64, `File chooser item ${index} buffer`);
    try {
      decodeCanonicalBase64(bufferBase64, RUN_ARTIFACT_MAX_BYTES, `File chooser item ${index} buffer`, true);
    } catch (error: unknown) {
      throw invalidInput(
        error instanceof Error ? error.message : `File chooser item ${index} buffer is invalid`,
        error,
      );
    }
    return {
      bufferBase64,
      kind: "payload",
      mimeType: parseArtifactMediaType(file.mimeType, `File chooser item ${index} media type`),
      name: requireString(file.name, `File chooser item ${index} name`),
    };
  }
  throw invalidInput(`File chooser item ${index} kind must be path or payload`);
};

const parseArtifactPublication = (value: unknown) => {
  const payload = strictPayload(value, ["data", "encoding", "mediaType", "name"], "artifact_publish payload");

  const { encoding } = payload;
  const hasSupportedEncoding = encoding === "base64" || encoding === "utf8";
  if (!hasSupportedEncoding) throw invalidInput("artifact_publish encoding must be base64 or utf8");

  const data = requireText(payload.data, "artifact_publish data");
  const mediaType = parseArtifactMediaType(payload.mediaType, "artifact_publish media type");
  if (encoding === "base64") {
    try {
      decodeCanonicalBase64(data, RUN_ARTIFACT_MAX_BYTES, "artifact_publish data", true);

      const isImage = mediaType === "image/jpeg" || mediaType === "image/png" || mediaType === "image/webp";
      if (isImage) {
        validateEncodedImage(data, mediaType, RUN_ARTIFACT_MAX_BYTES, "artifact_publish image");
      }
    } catch (error: unknown) {
      throw invalidInput(error instanceof Error ? error.message : "artifact_publish data is invalid", error);
    }
  } else if (Buffer.byteLength(data, "utf8") > RUN_ARTIFACT_MAX_BYTES) {
    throw invalidInput(`artifact_publish data exceeds ${RUN_ARTIFACT_MAX_BYTES} UTF-8 bytes`);
  }

  return {
    data,
    encoding,
    mediaType,
    name: requireString(payload.name, "artifact_publish name"),
  } satisfies Extract<BrokerRpcRequest, { operation: "artifact_publish" }>["payload"];
};

export const parseBrokerRpcRequest = (value: unknown): BrokerRpcRequest => {
  const record = requireRecord(value, "Broker RPC request");
  assertStrictKeys(record, ["operation", "payload"], "Broker RPC request");
  const operation = parseRpcOperation(record.operation);

  switch (operation) {
    case "page_viewport": {
      const parsed = pageViewportRequestSchema.safeParse(record.payload);
      if (!parsed.success) {
        throw invalidInput("Invalid page viewport request", parsed.error);
      }

      return { operation, payload: parsed.data };
    }
    case "events_mark": {
      const payload = strictPayload(record.payload, [], "events_mark payload");
      return { operation, payload: copyJsonObject(payload) };
    }
    case "select_page": {
      const payload = strictPayload(record.payload, ["targetId"], "select_page payload");
      return { operation, payload: { targetId: requireString(payload.targetId, "select_page target ID") } };
    }
    case "owner_close_authorize": {
      const payload = strictPayload(record.payload, ["resource"], "owner_close_authorize payload");
      if (payload.resource !== "browser" && payload.resource !== "default-context") {
        throw invalidInput("owner_close_authorize resource must be browser or default-context");
      }
      return { operation, payload: { resource: payload.resource } };
    }
    case "media_emulate": {
      const payload = strictPayload(record.payload, ["options", "targetId"], "media_emulate payload");
      return {
        operation,
        payload: {
          options: copyJsonObject(payload.options, "Media emulation options"),
          targetId: requireString(payload.targetId, "Media emulation target ID"),
        },
      };
    }
    case "artifact_file": {
      const payload = strictPayload(record.payload, ["mediaType", "path"], "artifact_file payload");
      const mediaType =
        payload.mediaType === undefined ?
          undefined
        : parseArtifactMediaType(payload.mediaType, "artifact_file media type");
      return {
        operation,
        payload: {
          path: requireString(payload.path, "artifact_file path"),
          ...(mediaType ? { mediaType } : {}),
        },
      };
    }
    case "artifact_output_path": {
      const payload = strictPayload(record.payload, ["mediaType", "name"], "artifact_output_path payload");
      const mediaType =
        payload.mediaType === undefined ?
          undefined
        : parseArtifactMediaType(payload.mediaType, "artifact_output_path media type");
      return {
        operation,
        payload: {
          name: requireString(payload.name, "artifact_output_path name"),
          ...(mediaType ? { mediaType } : {}),
        },
      };
    }
    case "artifact_publish": {
      return { operation, payload: parseArtifactPublication(record.payload) };
    }
    case "capture_start": {
      const payload = strictPayload(record.payload, ["options"], "capture_start payload");
      return { operation, payload: { options: copyJsonObject(payload.options, "Capture options") } };
    }
    case "capture_stop": {
      const payload = strictPayload(record.payload, ["captureId"], "capture_stop payload");
      return { operation, payload: { captureId: requireString(payload.captureId, "Capture ID") } };
    }
    case "checkpoint_create": {
      const payload = strictPayload(record.payload, ["options"], "checkpoint_create payload");
      return { operation, payload: { options: copyJsonObject(payload.options, "Checkpoint options") } };
    }
    case "checkpoint_diff": {
      const payload = strictPayload(record.payload, ["checkpointId", "options"], "checkpoint_diff payload");
      return {
        operation,
        payload: {
          checkpointId: requireString(payload.checkpointId, "Checkpoint ID"),
          options: copyJsonObject(payload.options, "Checkpoint diff options"),
        },
      };
    }
    case "dialog_accept": {
      const payload = strictPayload(record.payload, ["modalId", "promptText"], "dialog_accept payload");
      const promptText =
        payload.promptText === undefined ? undefined : requireText(payload.promptText, "Dialog prompt text");
      return {
        operation,
        payload: {
          modalId: requireString(payload.modalId, "Dialog modal ID"),
          ...(promptText === undefined ? {} : { promptText }),
        },
      };
    }
    case "dialog_dismiss": {
      const payload = strictPayload(record.payload, ["modalId"], "dialog_dismiss payload");
      return { operation, payload: { modalId: requireString(payload.modalId, "Dialog modal ID") } };
    }
    case "events_read": {
      const payload = strictPayload(record.payload, ["options"], "events_read payload");
      return { operation, payload: { options: copyJsonObject(payload.options, "Event read options") } };
    }
    case "pwa": {
      return { operation, payload: pwaOperationSchema.parse(record.payload) };
    }
    case "file_chooser_set_files": {
      const payload = strictPayload(record.payload, ["files", "modalId"], "file_chooser_set_files payload");
      if (!Array.isArray(payload.files)) throw invalidInput("File chooser files must be an array");
      return {
        operation,
        payload: {
          files: payload.files.map(parseFileChooserFile),
          modalId: requireString(payload.modalId, "File chooser modal ID"),
        },
      };
    }
    case "locator_resolve": {
      const payload = strictPayload(record.payload, ["ref"], "locator_resolve payload");
      return { operation, payload: { ref: requireString(payload.ref, "Locator ref") } };
    }
    case "mutation_add": {
      const payload = strictPayload(record.payload, ["input"], "mutation_add payload");
      const parsed = persistentMutationInputSchema.safeParse(payload.input);
      if (!parsed.success) {
        throw invalidInput(parsed.error.issues[0]?.message ?? "Persistent mutation input is invalid");
      }
      return { operation, payload: { input: parsed.data } };
    }
    case "mutation_clear":
    case "mutation_list": {
      const payload = strictPayload(record.payload, ["kind"], `${operation} payload`);
      const parsed = persistentMutationKindSchema.safeParse(payload.kind);
      if (!parsed.success) {
        throw invalidInput(parsed.error.issues[0]?.message ?? "Persistent mutation kind is invalid");
      }
      return { operation, payload: { kind: parsed.data } };
    }
    case "mutation_remove": {
      const payload = strictPayload(record.payload, ["id", "kind"], "mutation_remove payload");
      const parsed = persistentMutationKindSchema.safeParse(payload.kind);
      if (!parsed.success) {
        throw invalidInput(parsed.error.issues[0]?.message ?? "Persistent mutation kind is invalid");
      }
      return {
        operation,
        payload: { id: requireString(payload.id, "Persistent mutation ID"), kind: parsed.data },
      };
    }
    case "progress": {
      const payload = strictPayload(record.payload, ["current", "message", "total"], "progress payload");
      const current =
        payload.current === undefined ? undefined : requireFiniteNumber(payload.current, "Progress current");
      const total =
        payload.total === undefined ? undefined : requireFiniteNumber(payload.total, "Progress total");
      return {
        operation,
        payload: {
          message: requireString(payload.message, "Progress message"),
          ...(current === undefined ? {} : { current }),
          ...(total === undefined ? {} : { total }),
        },
      };
    }
    case "snapshot": {
      const payload = strictPayload(record.payload, ["options", "root"], "snapshot payload");
      let root: SnapshotRootToken | undefined;
      if (payload.root !== undefined) {
        const rootRecord = strictPayload(
          payload.root,
          ["attributeName", "attributeValue", "kind"],
          "Snapshot root token",
        );
        if (rootRecord.kind !== "temporary-attribute") {
          throw invalidInput("Snapshot root token kind is invalid");
        }
        root = {
          attributeName: requireString(rootRecord.attributeName, "Snapshot root attribute name"),
          attributeValue: requireString(rootRecord.attributeValue, "Snapshot root attribute value"),
          kind: "temporary-attribute",
        };
      }
      return {
        operation,
        payload: {
          options: copyJsonObject(payload.options, "Snapshot options"),
          ...(root ? { root } : {}),
        },
      };
    }
    default: {
      throw invalidInput(`Unhandled broker RPC operation: ${operation satisfies never}`);
    }
  }
};

export const parseBrokerRpcResponse = (value: unknown): BrokerRpcResponse => {
  const record = requireRecord(value, "Broker RPC response");
  if (record.ok === false) {
    assertStrictKeys(record, ["error", "ok"], "Failed broker RPC response");
    return { error: parseSerializedError(record.error), ok: false };
  }
  if (record.ok !== true) throw invalidInput("Broker RPC response ok must be a boolean");
  assertStrictKeys(record, ["artifacts", "ok", "value"], "Successful broker RPC response");
  return {
    artifacts: parseArtifactDescriptors(record.artifacts),
    ok: true,
    value: copyJsonValue(record.value, "Broker RPC value"),
  };
};

export const parseBrokerRpcSuccess = (value: unknown): BrokerRpcSuccess => {
  const response = parseBrokerRpcResponse(value);
  if (!response.ok) throw invalidInput("Broker RPC response must be successful");
  return response;
};

export const parseBrokerToWorkerMessage = (value: unknown): BrokerToWorkerMessage => {
  const record = requireRecord(value, "Broker-to-worker message");
  if (record.type === "execute") {
    assertStrictKeys(record, ["request", "type"], "Execute message");
    return {
      request: parseExecutionWorkerRequest(record.request),
      type: "execute",
    };
  }
  if (record.type === "execution_result_ack") {
    assertStrictKeys(record, ["callId", "type"], "Execution result acknowledgment");
    return {
      callId: requireString(record.callId, "Execution result acknowledgment call ID"),
      type: "execution_result_ack",
    };
  }
  if (record.type === "rpc_response") {
    assertStrictKeys(record, ["callId", "response", "rpcId", "type"], "RPC response message");
    return {
      callId: requireString(record.callId, "RPC response call ID"),
      response: parseBrokerRpcResponse(record.response),
      rpcId: requireString(record.rpcId, "RPC response ID"),
      type: "rpc_response",
    };
  }
  throw invalidInput("Broker-to-worker message type is unknown");
};

export const parseWorkerToBrokerMessage = (value: unknown): WorkerToBrokerMessage => {
  const record = requireRecord(value, "Worker-to-broker message");
  if (record.type === "ready") {
    assertStrictKeys(record, ["type"], "Ready message");
    return { type: "ready" };
  }
  if (record.type === "rpc_request") {
    assertStrictKeys(record, ["callId", "request", "rpcId", "type"], "RPC request message");
    return {
      callId: requireString(record.callId, "RPC request call ID"),
      request: parseBrokerRpcRequest(record.request),
      rpcId: requireString(record.rpcId, "RPC request ID"),
      type: "rpc_request",
    };
  }
  if (record.type === "rpc_cancel") {
    assertStrictKeys(record, ["callId", "rpcIds", "type"], "RPC cancel message");
    if (
      !Array.isArray(record.rpcIds) ||
      record.rpcIds.some((item) => typeof item !== "string" || item.length === 0)
    ) {
      throw invalidInput("RPC cancel IDs must be non-empty strings");
    }
    return {
      callId: requireString(record.callId, "RPC cancel call ID"),
      rpcIds: [...record.rpcIds],
      type: "rpc_cancel",
    };
  }
  if (record.type === "execution_result") {
    assertStrictKeys(record, ["callId", "result", "type"], "Execution result message");
    return {
      callId: requireString(record.callId, "Execution result call ID"),
      result: parseExecutionKernelResult(record.result),
      type: "execution_result",
    };
  }
  throw invalidInput("Worker-to-broker message type is unknown");
};
