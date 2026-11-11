import { Window } from "happy-dom";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isProxy } from "node:util/types";
import vm from "node:vm";
import type { CdpClient } from "./cdp-connection";
import { isRecord } from "../../platform/records";
import { ChromeRuntimeError } from "./errors";
import {
  REACT_BRIDGE_MESSAGE_MAX_BYTES,
  REACT_BRIDGE_PENDING_MAX_BYTES,
  REACT_BRIDGE_PENDING_MAX_MESSAGES,
  REACT_HOST_NODE_MAX,
  REACT_INSPECTED_GRAPH_MAX_BYTES,
  REACT_INSPECTED_GRAPH_MAX_DEPTH,
  REACT_INSPECTED_GRAPH_MAX_ENTRIES,
  REACT_PROFILE_MAX_BYTES,
  REACT_PROFILE_MAX_COMMITS,
  REACT_TREE_COMPONENT_MAX,
  type ReactBrowserOperation,
  type ReactMutationValue,
  type ReactOperationResult,
  type ReactRendererCapabilities,
} from "./react-inspection-protocol";

type BridgeMessage = Readonly<{ event: string; payload: unknown }>;

type ParsedBridgeMessage =
  | Readonly<{ kind: "ignore" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "message"; message: BridgeMessage }>;

type FrontendRuntime = Readonly<{
  bridge: unknown;
  store: unknown;
}>;

type FrontendModule = Readonly<{
  createBridge: (contentWindow: unknown, wall: unknown) => unknown;
  createStore: (bridge: unknown, config: unknown) => unknown;
}>;

type HookIdentity = Readonly<{
  elementId: number;
  hookId: number;
}>;

type ComponentMetadata = Readonly<{
  canEditFunctionProps: boolean;
  canEditHooks: boolean;
  hasContext: boolean;
  revision: number;
  searchable: string;
  source: Readonly<Record<string, unknown>> | null;
}>;

type ReactTreeCursorSnapshot = Readonly<{
  index: number;
  query: string;
  revision: number;
  truncated: boolean;
  values: readonly number[];
}>;

export class ReactTreeCursorStore {
  #current: Readonly<{ cursor: string; snapshot: ReactTreeCursorSnapshot }> | undefined;

  clear(): void {
    this.#current = undefined;
  }

  consume(cursor: string, query: string, revision: number): ReactTreeCursorSnapshot | undefined {
    if (
      this.#current?.cursor !== cursor ||
      this.#current.snapshot.query !== query ||
      this.#current.snapshot.revision !== revision
    ) {
      return undefined;
    }
    const snapshot = this.#current.snapshot;
    this.#current = undefined;
    return snapshot;
  }

  replace(snapshot: ReactTreeCursorSnapshot): string {
    const cursor = randomUUID();
    this.#current = { cursor, snapshot };
    return cursor;
  }
}

type PublicIds = {
  cursor: ReactTreeCursorStore;
  elementByPublicId: Map<string, number>;
  hookByPublicId: Map<string, HookIdentity>;
  hostByPublicId: Map<string, number>;
  publicIdByElement: Map<number, string>;
  publicIdByHook: Map<string, string>;
  publicIdByHost: Map<number, string>;
  publicIdByRenderer: Map<number, string>;
  publicIdByRoot: Map<number, string>;
  rendererByPublicId: Map<string, number>;
  rootByPublicId: Map<string, number>;
  metadataByElement: Map<number, ComponentMetadata>;
};

type ActiveProfile = Readonly<{
  connectionId: string;
  displayNamesByElement: Map<number, string | null>;
  profileId: string;
  rendererByRootId: Map<number, number>;
  startedAt: string;
  supportedRendererIds: ReadonlySet<number>;
}>;

type RendererMetadata = Readonly<{
  buildType: "development" | "production" | "profiling" | "unknown";
  capabilities: ReactRendererCapabilities;
  packageName: string | null;
  reactVersion: string;
}>;

type TargetState = {
  activeProfile?: ActiveProfile;
  bindingName: string;
  bridgeListeners: Set<(message: BridgeMessage) => void>;
  closed: boolean;
  closePromise?: Promise<void>;
  documentId: string;
  executionContextId?: number;
  frontend: FrontendRuntime;
  frameId: string;
  idsByConnection: Map<string, PublicIds>;
  highlightConnectionId?: string;
  markerKey: string;
  nonce: string;
  outbound: Promise<void>;
  pageReady: boolean;
  pendingOutbound: BridgeMessage[];
  pendingOutboundBytes: number;
  reloaded: boolean;
  removeListeners: (() => void)[];
  rendererMetadata: Map<number, RendererMetadata>;
  rendererSignature?: string;
  supportedRendererIds: Set<number>;
  requestId: number;
  scriptIdentifier?: string;
  sessionId: string;
  stateKey: string;
  targetId: string;
  url: string;
};

const require = createRequire(import.meta.url);

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const jsonStringByteLength = (value: string): number => {
  let bytes = 2;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      character === '"' ||
      character === "\\" ||
      character === "\b" ||
      character === "\f" ||
      character === "\n" ||
      character === "\r" ||
      character === "\t"
    ) {
      bytes += 2;
    } else if (codePoint < 0x20) {
      bytes += 6;
    } else {
      bytes += byteLength(character);
    }
  }
  return bytes;
};

const profileEntries = (value: unknown): readonly (readonly [unknown, unknown])[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry): readonly (readonly [unknown, unknown])[] =>
      Array.isArray(entry) && entry.length === 2 ? [[entry[0], entry[1]]] : [],
    );
  }
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return [];
  const forEach = Reflect.get(value, "forEach");
  if (typeof forEach !== "function") return [];
  const entries: (readonly [unknown, unknown])[] = [];
  Reflect.apply(forEach, value, [(entry: unknown, key: unknown) => entries.push([key, entry])]);
  return entries;
};

export const filterSupportedReactProfileRoots = (
  value: unknown,
  supportedRendererIds: ReadonlySet<number>,
  rendererIdForRoot: (rootId: number) => number | undefined,
): readonly (readonly [number, Readonly<Record<string, unknown>>])[] =>
  profileEntries(value).flatMap(([rootIdValue, rootValue]) => {
    const rootId = typeof rootIdValue === "number" && Number.isInteger(rootIdValue) ? rootIdValue : undefined;
    if (rootId === undefined || !isRecord(rootValue)) return [];
    const rendererId = rendererIdForRoot(rootId);
    if (rendererId === undefined || !supportedRendererIds.has(rendererId)) return [];
    return [[rootId, { ...rootValue, rendererID: rendererId }]];
  });

const profileCommitCount = (value: unknown): number => {
  if (!isRecord(value)) return 0;
  let count = 0;
  for (const [, root] of profileEntries(value.dataForRoots)) {
    if (!isRecord(root) || !Array.isArray(root.commitData)) continue;
    count += root.commitData.length;
  }
  return count;
};

const profileDataWithinBudget = (value: unknown, maxBytes: number): boolean => {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let bytes = 0;
  const consume = (amount: number): boolean => {
    bytes += amount;

    return bytes <= maxBytes;
  };

  const enqueueProfileChildren = (current: object) => {
    try {
      const entries: Iterable<[unknown, unknown]> = Map.prototype.entries.call(current);

      for (const [key, entry] of entries) {
        if (!consume(64)) return false;
        pending.push(key, entry);
      }

      return true;
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error;
    }

    try {
      const entries: Iterable<unknown> = Set.prototype.values.call(current);

      for (const entry of entries) {
        if (!consume(64)) return false;
        pending.push(entry);
      }

      return true;
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error;
    }

    if (Array.isArray(current)) {
      for (const entry of current) {
        if (!consume(64)) return false;
        pending.push(entry);
      }

      return true;
    }
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch {
      if (!consume(64)) return false;
      return true;
    }
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = Reflect.get(descriptors, key);
      if (!consume(64 + jsonStringByteLength(String(key)))) return false;
      if (descriptor && "value" in descriptor) pending.push(descriptor.value);
    }

    return true;
  };

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null) {
      if (!consume(4)) return false;
      continue;
    }
    if (typeof current === "string") {
      if (!consume(jsonStringByteLength(current))) return false;
      continue;
    }
    if (typeof current === "number" || typeof current === "bigint") {
      if (!consume(String(current).length + 32)) return false;
      continue;
    }
    if (
      typeof current === "boolean" ||
      current === undefined ||
      typeof current === "function" ||
      typeof current === "symbol"
    ) {
      if (!consume(32)) return false;
      continue;
    }
    if (seen.has(current)) {
      if (!consume(24)) return false;
      continue;
    }
    seen.add(current);
    if (!consume(256)) return false;
    if (isProxy(current)) {
      if (!consume(64)) return false;
      continue;
    }

    if (!enqueueProfileChildren(current)) return false;
  }
  return true;
};

export const inspectReactProfileLimits = (
  value: unknown,
  limits: Readonly<{ maxBytes: number; maxCommits: number }> = {
    maxBytes: REACT_PROFILE_MAX_BYTES,
    maxCommits: REACT_PROFILE_MAX_COMMITS,
  },
) => {
  const commitCount = profileCommitCount(value);
  return {
    commitCount,
    incomplete: commitCount > limits.maxCommits || !profileDataWithinBudget(value, limits.maxBytes),
  };
};

export const reactTreeScanBounds = (
  total: number,
  maximum: number = REACT_TREE_COMPONENT_MAX,
): Readonly<{ count: number; truncated: boolean }> => ({
  count: Math.min(total, maximum),
  truncated: total > maximum,
});

export const isSupportedReactRendererVersion = (version: string): boolean => {
  const major = Number.parseInt(version, 10);
  return major === 18 || major === 19;
};

// The source text of this function is evaluated inside the page, so it can use only its parameter and page
// globals. A reference to anything else in this module would throw a ReferenceError in the page.
export const countReactDevToolsOverlays = (document: unknown): number => {
  if (typeof document !== "object" || document === null) return 0;
  const body = Reflect.get(document, "body");
  if (typeof body !== "object" || body === null) return 0;
  const children = Reflect.get(body, "children");
  if (typeof children !== "object" || children === null) return 0;
  const length = Reflect.get(children, "length");
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0) return 0;
  let count = 0;
  for (let index = 0; index < length; index += 1) {
    const candidate = Reflect.get(children, String(index));
    if (typeof candidate !== "object" || candidate === null) continue;
    const style = Reflect.get(candidate, "style");
    const candidateChildren = Reflect.get(candidate, "children");
    if (
      typeof style !== "object" ||
      style === null ||
      typeof candidateChildren !== "object" ||
      candidateChildren === null
    ) {
      continue;
    }
    const tip = Reflect.get(candidateChildren, "0");
    if (typeof tip !== "object" || tip === null) continue;
    const tipStyle = Reflect.get(tip, "style");
    const tipChildren = Reflect.get(tip, "children");
    if (
      typeof tipStyle !== "object" ||
      tipStyle === null ||
      typeof tipChildren !== "object" ||
      tipChildren === null
    ) {
      continue;
    }
    if (
      Reflect.get(style, "zIndex") === "10000000" &&
      Reflect.get(tipStyle, "position") === "fixed" &&
      Reflect.get(tipChildren, "length") === 2
    ) {
      count += 1;
    }
  }
  return count;
};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const integer = (value: unknown): number | undefined => {
  const number = finiteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
};

export const parseReactBridgeMessage = (
  payload: unknown,
  expected: Readonly<{ bindingName: string; executionContextId?: number; nonce: string }>,
): ParsedBridgeMessage => {
  if (!isRecord(payload) || payload.name !== expected.bindingName) return { kind: "ignore" };
  if (integer(payload.executionContextId) !== expected.executionContextId) return { kind: "ignore" };
  if (typeof payload.payload !== "string") {
    return { kind: "invalid" };
  }
  if (byteLength(payload.payload) > REACT_BRIDGE_MESSAGE_MAX_BYTES) return { kind: "invalid" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.payload);
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(parsed) || parsed.nonce !== expected.nonce || typeof parsed.event !== "string") {
    return { kind: "invalid" };
  }
  const keys = Object.keys(parsed);
  if (keys.some((key) => key !== "event" && key !== "nonce" && key !== "payload")) return { kind: "invalid" };
  return {
    kind: "message",
    message: { event: parsed.event, payload: "payload" in parsed ? parsed.payload : undefined },
  };
};

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new ChromeRuntimeError("CHROME_MCP_REACT_PROTOCOL", `${label} has an unsupported shape`);
  }
  return value;
};

const requireStringProperty = (value: unknown, key: string, label: string): string => {
  const property = Reflect.get(requireRecord(value, label), key);
  if (typeof property !== "string" || property.length === 0) {
    throw new ChromeRuntimeError("CHROME_MCP_REACT_PROTOCOL", `${label}.${key} must be a non-empty string`);
  }
  return property;
};

export const readReactUpdateInspectionValue = (
  response: unknown,
  phase: "after" | "before",
): Record<string, unknown> => {
  const inspected = requireRecord(response, `React ${phase}-update inspected element response`);
  if (inspected.type === "not-found") {
    throw new ChromeRuntimeError(
      "CHROME_MCP_REACT_STALE_COMPONENT",
      phase === "after" ?
        "React component could not be inspected after the requested update; the update may have unmounted it"
      : "React component unmounted before the requested update could be applied",
    );
  }
  if (inspected.type === "error") {
    if (phase === "after") {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_STALE_COMPONENT",
        "React component could not be inspected after the requested update; the update may have unmounted it",
      );
    }
    const message = typeof inspected.message === "string" ? inspected.message : "React inspection failed";
    throw new ChromeRuntimeError(
      "CHROME_MCP_REACT_UNSUPPORTED_OPERATION",
      `React could not inspect the component before applying the requested update: ${message}`,
    );
  }
  if (!isRecord(inspected.value)) {
    if (phase === "after") {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_STALE_COMPONENT",
        "React component could not be inspected after the requested update; the update may have unmounted it",
      );
    }
    throw new ChromeRuntimeError(
      "CHROME_MCP_REACT_PROTOCOL",
      "React pre-update inspection returned an unsupported value shape",
    );
  }
  return inspected.value;
};

const property = (target: unknown, key: string): unknown => {
  if ((typeof target !== "object" || target === null) && typeof target !== "function") return undefined;
  return Reflect.get(target, key);
};

const normalizeReactError = (error: unknown): Error => {
  if (error instanceof Error) return error;
  const message = property(error, "message");
  return new ChromeRuntimeError(
    "CHROME_MCP_REACT_INITIALIZATION_FAILED",
    typeof message === "string" ? message : String(error),
  );
};

const invoke = (target: unknown, method: string, args: readonly unknown[] = []): unknown => {
  const member = property(target, method);
  if (typeof member !== "function") {
    throw new ChromeRuntimeError(
      "CHROME_MCP_REACT_PROTOCOL",
      `React DevTools object does not provide ${method}()`,
    );
  }
  return Reflect.apply(member, target, args);
};

const addListener = (target: unknown, event: string, listener: (payload: unknown) => void): (() => void) => {
  invoke(target, "addListener", [event, listener]);
  return () => {
    invoke(target, "removeListener", [event, listener]);
  };
};

const publicIds = (): PublicIds => ({
  cursor: new ReactTreeCursorStore(),
  elementByPublicId: new Map(),
  hookByPublicId: new Map(),
  hostByPublicId: new Map(),
  publicIdByElement: new Map(),
  publicIdByHook: new Map(),
  publicIdByHost: new Map(),
  publicIdByRenderer: new Map(),
  publicIdByRoot: new Map(),
  rendererByPublicId: new Map(),
  rootByPublicId: new Map(),
  metadataByElement: new Map(),
});

const mappedId = (forward: Map<number, string>, reverse: Map<string, number>, value: number): string => {
  const existing = forward.get(value);
  if (existing) return existing;
  const id = randomUUID();
  forward.set(value, id);
  reverse.set(id, value);
  return id;
};

const mappedHookId = (ids: PublicIds, elementId: number, hookId: number): string => {
  const key = `${elementId}:${hookId}`;
  const existing = ids.publicIdByHook.get(key);
  if (existing) return existing;
  const id = randomUUID();
  ids.publicIdByHook.set(key, id);
  ids.hookByPublicId.set(id, { elementId, hookId });
  return id;
};

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

const sourceLocation = (value: unknown): Readonly<Record<string, unknown>> | null => {
  if (Array.isArray(value)) {
    const fileName = stringOrNull(value[1]);
    if (fileName === null) return null;
    return {
      columnNumber: integer(value[3]) ?? null,
      fileName,
      functionName: stringOrNull(value[0]),
      lineNumber: integer(value[2]) ?? null,
    };
  }
  if (!isRecord(value)) return null;
  const fileName = stringOrNull(value.fileName) ?? stringOrNull(value.sourceURL) ?? stringOrNull(value.url);
  if (fileName === null) return null;
  return {
    columnNumber: integer(value.columnNumber) ?? integer(value.column) ?? null,
    fileName,
    functionName: stringOrNull(value.functionName),
    lineNumber: integer(value.lineNumber) ?? integer(value.line) ?? null,
  };
};

type ReactValuePath = readonly (number | string)[];

class ReactValuePreview {
  readonly metadata: Readonly<{ typeName: string; preview: string | null; inspectable: boolean }>;

  constructor(metadata: ReactValuePreview["metadata"]) {
    this.metadata = metadata;
  }
}

const isReactValuePath = (value: unknown): value is ReactValuePath =>
  Array.isArray(value) &&
  value.every(
    (part) =>
      typeof part === "string" || (typeof part === "number" && Number.isSafeInteger(part) && part >= 0),
  );

type NormalizationState = {
  bytes: number;
  entries: number;
  truncated: boolean;
};

const normalizationState = (): NormalizationState => ({ bytes: 0, entries: 0, truncated: false });

const reserveValue = (state: NormalizationState, bytes: number): boolean => {
  if (
    state.entries >= REACT_INSPECTED_GRAPH_MAX_ENTRIES ||
    state.bytes + bytes > REACT_INSPECTED_GRAPH_MAX_BYTES
  ) {
    state.truncated = true;
    return false;
  }
  state.entries += 1;
  state.bytes += bytes;
  return true;
};

export const unwrapReactBridgeValue = (value: unknown, hydratedPath?: ReactValuePath): unknown => {
  if (!isRecord(value) || !("data" in value)) {
    return value;
  }
  if (!Array.isArray(value.cleaned) || !Array.isArray(value.unserializable)) {
    return value;
  }
  const previews = new Set<string>();
  for (const path of [...value.cleaned, ...value.unserializable]) {
    if (!isReactValuePath(path) || hydratedPath?.some((part, index) => path[index] !== part)) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_PROTOCOL",
        "React inspected value contains an invalid preview path",
      );
    }
    previews.add(JSON.stringify(path.slice(hydratedPath?.length ?? 0)));
  }
  const graph = normalizationState();
  const decode = (entry: unknown, path: ReactValuePath): unknown => {
    if (
      !reserveValue(graph, typeof entry === "string" ? byteLength(entry) : 16) ||
      path.length >= REACT_INSPECTED_GRAPH_MAX_DEPTH
    ) {
      return new ReactValuePreview({ typeName: "unknown", preview: null, inspectable: false });
    }
    if (previews.has(JSON.stringify(path))) {
      const metadata = requireRecord(entry, "React inspected preview");
      if (metadata.type === "undefined") {
        return undefined;
      }
      if (metadata.type === "nan") {
        return Number.NaN;
      }
      if (metadata.type === "bigint" && typeof metadata.name === "string") {
        try {
          return BigInt(metadata.name);
        } catch {
          throw new ChromeRuntimeError("CHROME_MCP_REACT_PROTOCOL", "React inspected bigint is invalid");
        }
      }
      return new ReactValuePreview({
        typeName: stringOrNull(metadata.type) ?? "unknown",
        preview: stringOrNull(metadata.preview_long),
        inspectable: metadata.inspectable === true,
      });
    }
    if (
      typeof entry === "string" &&
      entry.length === 503 &&
      entry.endsWith("...") &&
      !(hydratedPath && path.length === 0)
    ) {
      return new ReactValuePreview({ typeName: "string", preview: entry, inspectable: true });
    }
    if (entry === null || typeof entry !== "object" || isProxy(entry)) {
      return entry;
    }
    const decoded = Array.isArray(entry) ? [] : {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(entry))) {
      if (Array.isArray(entry) && key === "length") {
        continue;
      }
      if (!("value" in descriptor)) {
        return new ReactValuePreview({ typeName: "object", preview: null, inspectable: false });
      }
      if (graph.entries >= REACT_INSPECTED_GRAPH_MAX_ENTRIES || graph.truncated) {
        return new ReactValuePreview({ typeName: "object", preview: null, inspectable: false });
      }
      Object.defineProperty(decoded, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: decode(descriptor.value, [...path, Array.isArray(entry) ? Number(key) : key]),
      });
    }
    return decoded;
  };
  return decode(value.data, []);
};

const unavailableValue = (reason: string): Readonly<Record<string, unknown>> => ({
  kind: "unavailable",
  reason,
});

const objectTypeName = (value: object): string => {
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null) return "Object";
    if (isProxy(prototype)) return "Object";
    const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
    if (typeof constructor !== "function") return "Object";
    const name = Object.getOwnPropertyDescriptor(constructor, "name")?.value;
    return typeof name === "string" && name.length > 0 ? name : "Object";
  } catch {
    return "Opaque";
  }
};

const normalizeReactNumber = (value: number) => {
  if (Number.isNaN(value)) return { kind: "nan" };
  if (!Number.isFinite(value)) return { kind: "infinity", sign: value < 0 ? -1 : 1 };
  return { kind: "number", value };
};

const normalizeUnknown = (
  value: unknown,
  state: NormalizationState,
  seen = new Map<object, string>(),
  depth = 0,
): unknown => {
  if (!reserveValue(state, typeof value === "string" ? byteLength(value) : 16)) {
    return unavailableValue("React inspected graph limit reached");
  }
  if (value === null) return { kind: "null" };
  if (value === undefined) return { kind: "undefined" };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "string") return { kind: "string", value };
  if (typeof value === "number") return normalizeReactNumber(value);
  if (typeof value === "bigint") return { kind: "bigint", value: value.toString() };
  if (typeof value === "function") {
    if (isProxy(value)) {
      return {
        kind: "opaque",
        preview: null,
        reason: "proxy functions are not inspected",
        typeName: "Function",
      };
    }
    const name = Object.getOwnPropertyDescriptor(value, "name")?.value;
    return { kind: "function", name: typeof name === "string" && name.length > 0 ? name : null };
  }
  if (typeof value === "symbol") return { kind: "symbol", description: value.description ?? null };
  if (typeof value !== "object") {
    return { kind: "opaque", preview: String(value), reason: "unsupported value", typeName: typeof value };
  }
  if (isProxy(value)) {
    return { kind: "opaque", preview: null, reason: "proxy objects are not inspected", typeName: "Object" };
  }
  if (value instanceof ReactValuePreview) {
    state.truncated = true;
    return {
      kind: "opaque",
      preview: value.metadata.preview,
      reason: "React DevTools returned a preview",
      typeName: value.metadata.typeName,
    };
  }
  if (depth >= REACT_INSPECTED_GRAPH_MAX_DEPTH) {
    state.truncated = true;
    return unavailableValue("React inspected graph depth limit reached");
  }
  const prior = seen.get(value);
  if (prior) return { kind: "reference", objectId: prior };
  const objectId = randomUUID();
  seen.set(value, objectId);
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    const length = Math.min(value.length, REACT_INSPECTED_GRAPH_MAX_ENTRIES - state.entries);
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor) {
        items.push(unavailableValue("array hole"));
      } else if ("value" in descriptor) {
        items.push(normalizeUnknown(descriptor.value, state, seen, depth + 1));
      } else {
        items.push(unavailableValue("accessor property was not invoked"));
      }
    }
    if (length < value.length) state.truncated = true;
    return { kind: "array", objectId, items };
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    state.truncated = true;
    return {
      kind: "opaque",
      objectId,
      preview: null,
      reason: "property descriptors are unavailable",
      typeName: objectTypeName(value),
    };
  }
  const entries: Readonly<Record<string, unknown>>[] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (state.entries >= REACT_INSPECTED_GRAPH_MAX_ENTRIES) {
      state.truncated = true;
      break;
    }
    const descriptor = Reflect.get(descriptors, key);
    const label = typeof key === "symbol" ? `[${String(key)}]` : key;
    if (!descriptor || !("value" in descriptor)) {
      entries.push({ key: label, value: unavailableValue("accessor property was not invoked") });
      continue;
    }
    entries.push({ key: label, value: normalizeUnknown(descriptor.value, state, seen, depth + 1) });
  }
  return {
    entries,
    kind: "object",
    objectId,
    typeName: objectTypeName(value),
  };
};

export const normalizeReactValue = (value: unknown): Readonly<{ truncated: boolean; value: unknown }> => {
  const state = normalizationState();
  const normalized = normalizeUnknown(value, state);
  return { truncated: state.truncated, value: normalized };
};

export const readReactValueAtPath = (value: unknown, path: readonly (number | string)[]): unknown => {
  let current = value;
  for (const segment of path) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") return undefined;
    if (isProxy(current)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, String(segment));
    if (!descriptor || !("value" in descriptor)) return undefined;
    current = descriptor.value;
  }
  return current;
};

export const sameReactMutationValue = (
  expected: unknown,
  observed: unknown,
  seen = new Map<object, object>(),
  depth = 0,
): boolean => {
  if (Object.is(expected, observed)) return true;
  if (depth >= REACT_INSPECTED_GRAPH_MAX_DEPTH) return false;
  if (
    typeof expected !== "object" ||
    expected === null ||
    typeof observed !== "object" ||
    observed === null
  ) {
    return false;
  }
  if (isProxy(expected) || isProxy(observed)) return false;
  const prior = seen.get(expected);
  if (prior !== undefined) return prior === observed;
  seen.set(expected, observed);
  let expectedDescriptors: PropertyDescriptorMap;
  let observedDescriptors: PropertyDescriptorMap;
  try {
    expectedDescriptors = Object.getOwnPropertyDescriptors(expected);
    observedDescriptors = Object.getOwnPropertyDescriptors(observed);
  } catch {
    return false;
  }
  const expectedKeys = Reflect.ownKeys(expectedDescriptors);
  const observedKeys = Reflect.ownKeys(observedDescriptors);
  if (expectedKeys.length !== observedKeys.length) return false;
  for (const key of expectedKeys) {
    if (!observedKeys.includes(key)) return false;
    const expectedDescriptor = Reflect.get(expectedDescriptors, key);
    const observedDescriptor = Reflect.get(observedDescriptors, key);
    if (
      !expectedDescriptor ||
      !("value" in expectedDescriptor) ||
      !observedDescriptor ||
      !("value" in observedDescriptor) ||
      !sameReactMutationValue(expectedDescriptor.value, observedDescriptor.value, seen, depth + 1)
    ) {
      return false;
    }
  }
  return true;
};

const REACT_MUTATION_INSPECTION_MAX_REQUESTS = 64;
type ReactHydrationPath = ReactValuePath | undefined;

function* reactHydrationPaths(
  value: unknown,
  path: ReactValuePath = [],
): Generator<ReactValuePath, void, unknown> {
  let currentValue = value;
  while (currentValue instanceof ReactValuePreview) {
    if (!currentValue.metadata.inspectable) break;
    currentValue = yield path;
  }

  const isOpaqueValue =
    currentValue instanceof ReactValuePreview ||
    currentValue === null ||
    typeof currentValue !== "object" ||
    isProxy(currentValue);
  if (isOpaqueValue) return;

  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(currentValue))) {
    const isInspectableProperty = "value" in descriptor && (!Array.isArray(currentValue) || key !== "length");
    if (!isInspectableProperty) continue;

    yield* reactHydrationPaths(descriptor.value, [...path, Array.isArray(currentValue) ? Number(key) : key]);
  }
}

export const inspectReactMutationValue = async (
  options: Readonly<{
    expected: unknown;
    path: ReactValuePath;
    inspect: (path: ReactValuePath) => Promise<unknown>;
  }>,
) => {
  let observed: unknown;
  let pending: ReactHydrationPath = [];
  let hydrationPaths: ReturnType<typeof reactHydrationPaths> | undefined;
  let bytes = 0;

  for (let request = 0; pending && request < REACT_MUTATION_INSPECTION_MAX_REQUESTS; request += 1) {
    const path = [...options.path, ...pending];
    const response = requireRecord(await options.inspect(path), "React mutation path inspection");
    if (response.type === "full-data" || response.type === "not-found" || response.type === "error") {
      readReactUpdateInspectionValue(response, "after");
      return {
        status: "unverified",
        observedValue: unavailableValue("React component changed during readback"),
      };
    }
    if (response.type !== "hydrated-path" || !sameReactMutationValue(response.path, path)) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_PROTOCOL",
        "React mutation inspection returned an unexpected path response",
      );
    }
    if (
      response.value !== null &&
      (!isRecord(response.value) ||
        !("data" in response.value) ||
        !Array.isArray(response.value.cleaned) ||
        !Array.isArray(response.value.unserializable))
    ) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_PROTOCOL",
        "React mutation inspection returned an invalid value envelope",
      );
    }

    bytes += byteLength(JSON.stringify(response));
    if (bytes > REACT_INSPECTED_GRAPH_MAX_BYTES) {
      break;
    }
    const value = unwrapReactBridgeValue(response.value, path);
    if (pending.length === 0) {
      observed = value;
    } else {
      const parent = readReactValueAtPath(observed, pending.slice(0, -1));
      const key = pending[pending.length - 1];
      if (parent === null || typeof parent !== "object" || key === undefined) {
        throw new ChromeRuntimeError(
          "CHROME_MCP_REACT_PROTOCOL",
          "React mutation preview parent is unavailable",
        );
      }
      Object.defineProperty(parent, key, { configurable: true, enumerable: true, writable: true, value });
    }
    hydrationPaths ??= reactHydrationPaths(value);
    const next = hydrationPaths.next(value);
    pending = next.done ? undefined : next.value;
  }

  const normalized = normalizeReactValue(observed);
  if (pending || normalized.truncated) {
    return { status: "unverified", observedValue: normalized.value };
  }
  return {
    status: sameReactMutationValue(options.expected, observed) ? "applied" : "overwritten",
    observedValue: normalized.value,
  };
};

const jsonSafe = (value: unknown, seen = new Set<object>()): unknown => {
  if (value === undefined) return { unavailable: "undefined" };
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) return { number: String(value) };
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return { reference: true };
  seen.add(value);
  if (value instanceof Map) {
    return [...value.entries()].map(([key, entry]) => [jsonSafe(key, seen), jsonSafe(entry, seen)]);
  }
  if (value instanceof Set) return [...value.values()].map((entry) => jsonSafe(entry, seen));
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry, seen)]));
};

const mutationValue = (value: ReactMutationValue): unknown => {
  switch (value.type) {
    case "json": {
      return value.value;
    }
    case "undefined": {
      return undefined;
    }
    case "nan": {
      return Number.NaN;
    }
    case "infinity": {
      return value.sign < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    }
    case "bigint": {
      return BigInt(value.value);
    }
    default: {
      return value satisfies never;
    }
  }
};

const elementKind = (value: unknown): string => {
  switch (integer(value)) {
    case 1: {
      return "class";
    }
    case 2: {
      return "context";
    }
    case 5: {
      return "function";
    }
    case 6: {
      return "forward-ref";
    }
    case 7: {
      return "host";
    }
    case 8: {
      return "memo";
    }
    case 12: {
      return "suspense";
    }
    default: {
      return "other";
    }
  }
};

const rendererCapabilities = (store: unknown, reported: unknown = {}): ReactRendererCapabilities => {
  const values = isRecord(reported) ? reported : {};
  return {
    canEditContext: values.canEditContext === true,
    canEditHooks: values.canEditHooks === true,
    canEditProps: values.canEditProps === true,
    canEditState: values.canEditState === true,
    canHighlight: values.canHighlight === true,
    canInspect: values.canInspect === true,
    canProfile: values.canProfile === true && property(store, "rootSupportsBasicProfiling") === true,
    domMapping: values.domMapping === true,
    ownerMetadata: property(store, "hasOwnerMetadata") === true,
    sourceMetadata: values.sourceMetadata === true,
  };
};

const COMPATIBLE_REACT_HOOK_EXPRESSION = `(() => {
  const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  return Boolean(
    hook &&
    typeof hook.emit === "function" &&
    typeof hook.inject === "function" &&
    typeof hook.off === "function" &&
    typeof hook.on === "function" &&
    typeof hook.sub === "function" &&
    hook.rendererInterfaces instanceof Map &&
    hook.renderers instanceof Map
  );
})()`;

const HOOK_INSTALL_RELOAD_TIMEOUT_MS = 15_000;

export const reactStagedNodeSelectionExpression = (key: string, stateKey: string) => `(() => {
  const key = ${JSON.stringify(key)};
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  if (!descriptor) return { selected: false };
  const deleted = delete globalThis[key];
  if (!deleted || !("value" in descriptor)) return { selected: false };
  const node = descriptor.value;
  if (!(node instanceof Element) || !node.isConnected) return { selected: false };
  return { selected: globalThis[${JSON.stringify(stateKey)}].select(node) === true };
})()`;

const combineRendererCapabilities = (state: TargetState): ReactRendererCapabilities => {
  const capabilities = [...state.supportedRendererIds].flatMap((rendererId) => {
    const metadata = state.rendererMetadata.get(rendererId);
    return metadata ? [metadata.capabilities] : [];
  });
  return rendererCapabilities(state.frontend.store, {
    canEditContext: capabilities.some((value) => value.canEditContext),
    canEditHooks: capabilities.some((value) => value.canEditHooks),
    canEditProps: capabilities.some((value) => value.canEditProps),
    canEditState: capabilities.some((value) => value.canEditState),
    canHighlight: capabilities.some((value) => value.canHighlight),
    canInspect: capabilities.some((value) => value.canInspect),
    canProfile: capabilities.some((value) => value.canProfile),
    domMapping: capabilities.some((value) => value.domMapping),
    sourceMetadata: capabilities.some((value) => value.sourceMetadata),
  });
};

const isDescendant = (store: unknown, id: number, parent: number): boolean => {
  let current = id;
  while (current !== 0) {
    const element = invoke(store, "getElementByID", [current]);
    const parentId = integer(property(element, "parentID")) ?? 0;
    if (parentId === parent) return true;
    current = parentId;
  }
  return false;
};

const findRootForElement = (store: unknown, id: number): number => {
  let current = id;
  for (;;) {
    const element = invoke(store, "getElementByID", [current]);
    const parent = integer(property(element, "parentID")) ?? 0;
    if (parent === 0) return current;
    current = parent;
  }
};

const filterSupportedProfileData = (
  value: unknown,
  supportedRendererIds: ReadonlySet<number>,
  rendererByRootId: ReadonlyMap<number, number>,
): Readonly<Record<string, unknown>> => {
  return {
    dataForRoots: filterSupportedReactProfileRoots(
      property(value, "dataForRoots"),
      supportedRendererIds,
      (rootId) => rendererByRootId.get(rootId),
    ),
    imported: property(value, "imported") === true,
  };
};

const createComponentMap = (value: unknown, ids: PublicIds): readonly (readonly [string, unknown])[] => {
  return profileEntries(value).flatMap(([idValue, entry]) => {
    const id = integer(idValue);
    return id === undefined ?
        []
      : [[mappedId(ids.publicIdByElement, ids.elementByPublicId, id), jsonSafe(entry)]];
  });
};

const normalizeProfileUpdaters = (value: unknown, ids: PublicIds): readonly unknown[] => {
  if (!Array.isArray(value)) return [];
  return value.map((updater) => {
    if (!isRecord(updater)) return jsonSafe(updater);
    const normalized = jsonSafe(updater);
    if (!isRecord(normalized)) return normalized;
    const id = integer(updater.id);
    return id === undefined ? normalized : (
        { ...normalized, id: mappedId(ids.publicIdByElement, ids.elementByPublicId, id) }
      );
  });
};

const waitForProfilerCompletion = async (profiler: unknown): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      remove();
      reject(new ChromeRuntimeError("CHROME_MCP_REACT_PROTOCOL", "Timed out waiting for React profile data"));
    }, 20_000);
    timer.unref?.();
    const remove = addListener(profiler, "isProcessingData", () => {
      if (property(profiler, "isProcessingData") !== false) return;
      clearTimeout(timer);
      remove();
      resolve();
    });
  });
};

const requireElementId = (ids: PublicIds, componentId: string): number => {
  const id = ids.elementByPublicId.get(componentId);
  if (id === undefined) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_REACT_STALE_COMPONENT",
      "React component ID is stale or belongs to another connection",
    );
  }
  return id;
};

const requireRendererId = (state: TargetState, elementId: number): number => {
  const rendererId = integer(invoke(state.frontend.store, "getRendererIDForElement", [elementId]));
  if (rendererId === undefined) {
    throw new ChromeRuntimeError("CHROME_MCP_REACT_STALE_COMPONENT", "React component is no longer mounted");
  }
  if (!state.supportedRendererIds.has(rendererId)) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_REACT_UNSUPPORTED_VERSION",
      "React component belongs to an unsupported renderer version",
    );
  }
  return rendererId;
};

const requireHookId = (ids: PublicIds, hookId: string, elementId: number): number => {
  const identity = ids.hookByPublicId.get(hookId);
  if (!identity || identity.elementId !== elementId) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_REACT_STALE_COMPONENT",
      "React hook or context ID is stale or belongs to another component or connection",
    );
  }
  return identity.hookId;
};

const scanStoreElementIds = (store: unknown) => {
  const total = integer(property(store, "numElements")) ?? 0;
  const scan = reactTreeScanBounds(total);
  const values: number[] = [];
  for (let index = 0; index < scan.count; index += 1) {
    const element = invoke(store, "getElementAtIndex", [index]);
    const id = integer(property(element, "id"));
    if (id !== undefined) values.push(id);
  }

  return { truncated: scan.truncated, values };
};

const normalizeIntegerArray = (value: unknown) => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => integer(entry) ?? []);
};

const validateReactListFilters = (
  state: TargetState,
  ids: PublicIds,
  request: Extract<ReactBrowserOperation, { operation: "list" }>,
): void => {
  const store = state.frontend.store;
  const renderer =
    request.rendererId === undefined ? undefined : ids.rendererByPublicId.get(request.rendererId);
  if (request.rendererId && (renderer === undefined || !state.supportedRendererIds.has(renderer))) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_REACT_STALE_COMPONENT",
      "React renderer ID is stale or belongs to another connection",
    );
  }

  const root = request.rootId === undefined ? undefined : ids.rootByPublicId.get(request.rootId);
  const isStaleRoot =
    request.rootId && (root === undefined || !normalizeIntegerArray(property(store, "roots")).includes(root));
  if (isStaleRoot) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_REACT_STALE_COMPONENT",
      "React root ID is stale or belongs to another connection",
    );
  }

  const parent =
    request.parentComponentId === undefined ?
      undefined
    : ids.elementByPublicId.get(request.parentComponentId);
  let parentMounted = parent !== undefined;
  if (parentMounted) {
    try {
      parentMounted = isRecord(invoke(store, "getElementByID", [parent]));
    } catch {
      parentMounted = false;
    }
  }
  if (request.parentComponentId && !parentMounted) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_REACT_STALE_COMPONENT",
      "React parent component ID is stale or belongs to another connection",
    );
  }
};

const normalizeProfileSnapshots = (
  value: unknown,
  ids: PublicIds,
): readonly (readonly [string, unknown])[] => {
  return profileEntries(value).flatMap(([idValue, entry]) => {
    const id = integer(idValue);
    if (id === undefined || !isRecord(entry)) return [];
    const normalized = jsonSafe(entry);
    if (!isRecord(normalized)) return [];
    const snapshotId = integer(entry.id) ?? id;
    return [
      [
        mappedId(ids.publicIdByElement, ids.elementByPublicId, id),
        {
          ...normalized,
          children: normalizeIntegerArray(entry.children).map((childId) =>
            mappedId(ids.publicIdByElement, ids.elementByPublicId, childId),
          ),
          id: mappedId(ids.publicIdByElement, ids.elementByPublicId, snapshotId),
        },
      ],
    ];
  });
};

const waitForReactRenderer = async (state: TargetState): Promise<void> => {
  const store = state.frontend.store;
  if (normalizeIntegerArray(property(store, "roots")).length === 0) {
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (normalizeIntegerArray(property(store, "roots")).length === 0) return;
        clearTimeout(timer);
        removeRoots();
        removeMutated();
        resolve();
      };
      const timer = setTimeout(() => {
        removeRoots();
        removeMutated();
        reject(
          new ChromeRuntimeError(
            "CHROME_MCP_REACT_NO_RENDERER",
            "The selected page has no compatible React renderer",
          ),
        );
      }, 5000);
      timer.unref?.();
      const removeRoots = addListener(store, "roots", finish);
      const removeMutated = addListener(store, "mutated", finish);
      finish();
    });
  }
};

type ReactElementFilterOptions = {
  state: TargetState;
  ids: PublicIds;
  id: number;
  request: Extract<ReactBrowserOperation, { operation: "list" }>;
};

const matchesReactElement = ({ state, ids, id, request }: ReactElementFilterOptions) => {
  const store = state.frontend.store;
  const element = invoke(store, "getElementByID", [id]);
  if (!isRecord(element)) return false;
  const renderer = integer(invoke(store, "getRendererIDForElement", [id]));
  if (renderer === undefined || !state.supportedRendererIds.has(renderer)) return false;
  if (request.rendererId && ids.rendererByPublicId.get(request.rendererId) !== renderer) return false;
  const root = findRootForElement(store, id);
  if (request.rootId && ids.rootByPublicId.get(request.rootId) !== root) return false;
  if (request.parentComponentId) {
    const parent = ids.elementByPublicId.get(request.parentComponentId);
    if (parent === undefined || !isDescendant(store, id, parent)) return false;
  }
  return true;
};

type ReactComponentCapabilityOptions = {
  state: TargetState;
  ids: PublicIds;
  id: number;
  element: Record<string, unknown>;
};

const readComponentCapabilities = ({ state, ids, id, element }: ReactComponentCapabilityOptions) => {
  const store = state.frontend.store;
  const renderer = integer(invoke(store, "getRendererIDForElement", [id]));
  const base =
    renderer === undefined ?
      rendererCapabilities(store)
    : (state.rendererMetadata.get(renderer)?.capabilities ?? rendererCapabilities(store));
  const inspected = ids.metadataByElement.get(id);
  const kind = elementKind(element.type);
  return {
    ...base,
    canEditContext: kind === "class" && inspected?.hasContext === true,
    canEditHooks: inspected?.canEditHooks === true,
    canEditProps: kind === "class" || inspected?.canEditFunctionProps === true,
    canEditState: kind === "class",
  };
};

type ReactBridgeRequestOptions = {
  state: TargetState;
  event: string;
  responseEvent: string;
  payload: Record<string, unknown>;
};

const sendReactBridgeRequest = async ({
  state,
  event,
  responseEvent,
  payload,
}: ReactBridgeRequestOptions) => {
  const requestID = ++state.requestId;
  const response = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      remove();
      reject(new ChromeRuntimeError("CHROME_MCP_REACT_PROTOCOL", `Timed out waiting for ${responseEvent}`));
    }, 10_000);
    timer.unref?.();
    const remove = addListener(state.frontend.bridge, responseEvent, (value) => {
      if (!isRecord(value) || value.responseID !== requestID) return;
      clearTimeout(timer);
      remove();
      resolve(value);
    });
  });
  invoke(state.frontend.bridge, "send", [event, { ...payload, requestID }]);
  return response;
};

type ReactPropertyWaitOptions = {
  target: unknown;
  key: string;
  expected: unknown;
  event: string;
  timeoutMs: number;
};

const waitForReactProperty = async ({
  target,
  key,
  expected,
  event,
  timeoutMs,
}: ReactPropertyWaitOptions) => {
  if (Object.is(property(target, key), expected)) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      if (!Object.is(property(target, key), expected)) return;
      clearTimeout(timer);
      remove();
      resolve();
    };
    const timer = setTimeout(() => {
      remove();
      reject(
        new ChromeRuntimeError(
          "CHROME_MCP_REACT_INITIALIZATION_FAILED",
          `Timed out waiting for React DevTools ${key}`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    const remove = addListener(target, event, finish);
    finish();
  });
};

const inspectReactUpdateValue = async (
  options: Readonly<{
    elementId: number;
    phase: "after" | "before";
    rendererId: number;
    state: TargetState;
  }>,
): Promise<Record<string, unknown>> => {
  const inspected = await sendReactBridgeRequest({
    state: options.state,
    event: "inspectElement",
    responseEvent: "inspectedElement",
    payload: {
      forceFullData: true,
      id: options.elementId,
      path: null,
      rendererID: options.rendererId,
    },
  });
  return readReactUpdateInspectionValue(inspected, options.phase);
};

const createReactProfile = (
  value: unknown,
  ids: PublicIds,
  displayNamesByElement: ReadonlyMap<number, string | null>,
): Readonly<Record<string, unknown>> => {
  const roots = profileEntries(property(value, "dataForRoots")).flatMap(([rootIdValue, rootValue]) => {
    const rootId = integer(rootIdValue);
    if (rootId === undefined || !isRecord(rootValue)) return [];
    const rendererId = integer(rootValue.rendererID);
    const snapshots = new Map(profileEntries(rootValue.snapshots));
    const displayNames = new Map<string, string | null>();
    const commits =
      Array.isArray(rootValue.commitData) ?
        rootValue.commitData.map((commit, commitIndex) => {
          if (!isRecord(commit)) return { commitIndex };
          for (const [idValue] of profileEntries(commit.fiberActualDurations)) {
            const id = integer(idValue);
            if (id === undefined) {
              continue;
            }
            const componentId = mappedId(ids.publicIdByElement, ids.elementByPublicId, id);
            const displayName =
              displayNamesByElement.get(id) ?? stringOrNull(property(snapshots.get(id), "displayName"));
            if (!displayNames.has(componentId) || displayName !== null) {
              displayNames.set(componentId, displayName);
            }
          }
          return {
            changeDescriptions: createComponentMap(commit.changeDescriptions, ids),
            commitIndex,
            duration: finiteNumber(commit.duration) ?? 0,
            effectDuration: finiteNumber(commit.effectDuration) ?? null,
            fiberActualDurations: createComponentMap(commit.fiberActualDurations, ids),
            fiberSelfDurations: createComponentMap(commit.fiberSelfDurations, ids),
            passiveEffectDuration: finiteNumber(commit.passiveEffectDuration) ?? null,
            priorityLevel: stringOrNull(commit.priorityLevel),
            timestamp: finiteNumber(commit.timestamp) ?? 0,
            updaters: normalizeProfileUpdaters(commit.updaters, ids),
          };
        })
      : [];
    return [
      {
        commitData: commits,
        displayName: stringOrNull(rootValue.displayName),
        displayNames: [...displayNames],
        initialTreeBaseDurations: createComponentMap(rootValue.initialTreeBaseDurations, ids),
        rendererId:
          rendererId === undefined ? null : (
            mappedId(ids.publicIdByRenderer, ids.rendererByPublicId, rendererId)
          ),
        rootId: mappedId(ids.publicIdByRoot, ids.rootByPublicId, rootId),
        snapshots: normalizeProfileSnapshots(rootValue.snapshots, ids),
      },
    ];
  });
  return {
    dataForRoots: roots,
    imported: property(value, "imported") === true,
  };
};

const stopReactProfiler = async (state: TargetState): Promise<void> => {
  const profiler = property(state.frontend.store, "profilerStore");
  if (property(profiler, "isProfilingBasedOnUserInput") !== true) return;
  invoke(profiler, "stopProfiling");
  await waitForReactProperty({
    target: profiler,
    key: "isProfilingBasedOnUserInput",
    expected: false,
    event: "isProfiling",
    timeoutMs: 10_000,
  });
  await Promise.resolve();
  await state.outbound;
};

type ReactComponentOptions = {
  state: TargetState;
  ids: PublicIds;
  id: number;
  hostNodeCount?: number;
};

const createReactComponent = ({ state, ids, id, hostNodeCount }: ReactComponentOptions) => {
  const store = state.frontend.store;
  const element = requireRecord(invoke(store, "getElementByID", [id]), "React Store element");
  const parent = integer(element.parentID) ?? 0;
  const owner = integer(element.ownerID) ?? 0;
  const root = findRootForElement(store, id);
  const renderer = integer(invoke(store, "getRendererIDForElement", [id])) ?? 0;
  const children = normalizeIntegerArray(element.children);
  return {
    capabilities: readComponentCapabilities({ state, ids, id, element }),
    childCount: children.length,
    componentId: mappedId(ids.publicIdByElement, ids.elementByPublicId, id),
    depth: integer(element.depth) ?? 0,
    displayName: stringOrNull(element.displayName),
    elementKind: elementKind(element.type),
    hostNodeCount: hostNodeCount ?? (elementKind(element.type) === "host" ? 1 : 0),
    key: typeof element.key === "string" || typeof element.key === "number" ? String(element.key) : null,
    ownerComponentId: owner === 0 ? null : mappedId(ids.publicIdByElement, ids.elementByPublicId, owner),
    parentComponentId:
      parent === 0 || parent === root ? null : mappedId(ids.publicIdByElement, ids.elementByPublicId, parent),
    rendererId: mappedId(ids.publicIdByRenderer, ids.rendererByPublicId, renderer),
    rootId: mappedId(ids.publicIdByRoot, ids.rootByPublicId, root),
    sourceAvailable:
      ids.metadataByElement.get(id)?.source !== undefined && ids.metadataByElement.get(id)?.source !== null,
  };
};

export class ReactInspectionManager {
  readonly #connection: CdpClient;
  readonly #onError: (error: unknown) => void;
  readonly #backendExportKey = `__chromeMcpReactBackend_${randomUUID().replaceAll("-", "")}`;
  readonly #expiredProfiles = new Map<string, string>();
  readonly #targets = new Map<string, Promise<TargetState>>();
  #backendSource: Promise<string> | undefined;
  #frontendModule: Promise<FrontendModule> | undefined;
  #frontendWindow: Window | undefined;

  constructor(connection: CdpClient, onError: (error: unknown) => void) {
    this.#connection = connection;
    this.#onError = onError;
  }

  async execute(
    connectionId: string,
    target: Readonly<{ targetId: string; url: string }>,
    request: ReactBrowserOperation,
  ): Promise<ReactOperationResult> {
    const state =
      request.operation === "profile-stop" ?
        await this.#activeProfileState(connectionId, request.profileId)
      : await this.#state(target);
    if (state.closed) {
      throw new ChromeRuntimeError("CHROME_MCP_REACT_STALE_COMPONENT", "React target document expired");
    }
    if (request.operation !== "profile-stop") state.url = target.url;
    await this.#ensureRenderer(state, request.operation !== "profile-stop");

    if (request.operation === "profile-stop") {
      this.throwIfProfileExpired(connectionId, request.profileId);
    }

    let data: Readonly<Record<string, unknown>>;
    if (request.operation === "prepare") {
      data = {};
    } else {
      const ids = state.idsByConnection.get(connectionId) ?? publicIds();
      state.idsByConnection.set(connectionId, ids);
      data = await this.#operation(state, ids, connectionId, request);
    }
    return {
      data,
      documentId: state.documentId,
      frameId: state.frameId,
      instrumentationState: state.reloaded ? "reloaded" : "attached",
      reloaded: state.reloaded,
      rendererCapabilities: combineRendererCapabilities(state),
      targetId: state.targetId,
      url: state.url,
      warnings: [],
    };
  }

  private throwIfProfileExpired(connectionId: string, profileId: string) {
    if (this.#expiredProfiles.get(profileId) !== connectionId) return;

    this.#expiredProfiles.delete(profileId);
    throw new ChromeRuntimeError(
      "CHROME_MCP_REACT_PROFILE_EXPIRED",
      "React profile target or renderer expired",
    );
  }

  async #activeProfileState(connectionId: string, profileId: string): Promise<TargetState> {
    this.throwIfProfileExpired(connectionId, profileId);
    const settled = await Promise.allSettled(this.#targets.values());
    const state = settled.find(
      (result): result is PromiseFulfilledResult<TargetState> =>
        result.status === "fulfilled" &&
        result.value.activeProfile?.connectionId === connectionId &&
        result.value.activeProfile.profileId === profileId,
    )?.value;
    if (!state) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_PROFILE_OWNERSHIP",
        "React profile belongs to another connection, target, or document",
      );
    }
    return state;
  }

  async closeConnection(connectionId: string): Promise<void> {
    for (const [profileId, ownerConnectionId] of this.#expiredProfiles) {
      if (ownerConnectionId === connectionId) this.#expiredProfiles.delete(profileId);
    }
    const states = await Promise.allSettled(this.#targets.values());
    const cleanup = states.flatMap((pending) =>
      pending.status === "fulfilled" ? [this.#closeConnectionState(pending.value, connectionId)] : [],
    );
    const settled = await Promise.allSettled(cleanup);
    const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length > 0) throw new AggregateError(errors, "React connection cleanup failed");
  }

  async #closeConnectionState(state: TargetState, connectionId: string): Promise<void> {
    state.idsByConnection.delete(connectionId);
    const errors: unknown[] = [];
    if (state.activeProfile?.connectionId === connectionId) {
      state.activeProfile = undefined;
      try {
        await stopReactProfiler(state);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (state.highlightConnectionId === connectionId) {
      state.highlightConnectionId = undefined;
      try {
        invoke(state.frontend.bridge, "send", ["clearHostInstanceHighlight"]);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    try {
      await Promise.resolve();
      await state.outbound;
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length === 0) return;
    this.#targets.delete(state.targetId);
    const cleanup = await Promise.allSettled([this.#closeTarget(state)]);
    for (const result of cleanup) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    for (const error of errors) this.#onError(error);
    throw new AggregateError(errors, "React target cleanup failed while releasing a connection");
  }

  async closeTarget(targetId: string): Promise<void> {
    const pending = this.#targets.get(targetId);
    if (!pending) return;
    this.#targets.delete(targetId);
    const state = await pending;
    this.#expireActiveProfile(state);
    await this.#closeTarget(state);
  }

  async close(): Promise<void> {
    const states = await Promise.allSettled(this.#targets.values());
    this.#targets.clear();
    this.#expiredProfiles.clear();
    const cleanup = await Promise.allSettled(
      states.flatMap((result) => (result.status === "fulfilled" ? [this.#closeTarget(result.value)] : [])),
    );
    const errors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    try {
      this.#frontendWindow?.close();
    } catch (error: unknown) {
      errors.push(error);
    }
    this.#frontendWindow = undefined;
    this.#frontendModule = undefined;
    if (errors.length > 0) throw new AggregateError(errors, "React inspection manager cleanup failed");
  }

  async #state(target: Readonly<{ targetId: string; url: string }>): Promise<TargetState> {
    let pending = this.#targets.get(target.targetId);
    if (!pending) {
      pending = this.#createTarget(target).catch((error: unknown) => {
        throw normalizeReactError(error);
      });
      this.#targets.set(target.targetId, pending);
      pending.catch(() => {
        if (this.#targets.get(target.targetId) === pending) this.#targets.delete(target.targetId);
      });
    }
    return pending;
  }

  async #createTarget(target: Readonly<{ targetId: string; url: string }>): Promise<TargetState> {
    const attached = await this.#connection.send("Target.attachToTarget", {
      flatten: true,
      targetId: target.targetId,
    });
    const sessionId = requireStringProperty(attached, "sessionId", "Target.attachToTarget result");
    const bindingName = `__chromeMcpReactBinding_${randomUUID().replaceAll("-", "")}`;
    const stateKey = `__chromeMcpReactState_${randomUUID().replaceAll("-", "")}`;
    const markerKey = `__chromeMcpReactValue_${randomUUID().replaceAll("-", "")}`;
    const nonce = randomUUID();
    const bridgeListeners = new Set<(message: BridgeMessage) => void>();
    let frameTreeResult: Record<string, unknown>;
    try {
      frameTreeResult = requireRecord(
        await this.#connection.send("Page.getFrameTree", {}, sessionId),
        "Page.getFrameTree result",
      );
    } catch (error: unknown) {
      await this.#connection.send("Target.detachFromTarget", { sessionId }).catch(this.#onError);
      throw error;
    }
    const frameTree = requireRecord(property(frameTreeResult, "frameTree"), "Page frame tree");
    const frame = requireRecord(property(frameTree, "frame"), "Page frame");
    const frameId = requireStringProperty(frame, "id", "Page frame");
    const state: TargetState = {
      bindingName,
      bridgeListeners,
      closed: false,
      documentId: randomUUID(),
      frontend: { bridge: undefined, store: undefined },
      frameId,
      idsByConnection: new Map(),
      markerKey,
      nonce,
      outbound: Promise.resolve(),
      pageReady: false,
      pendingOutbound: [],
      pendingOutboundBytes: 0,
      reloaded: false,
      removeListeners: [],
      rendererMetadata: new Map(),
      requestId: 0,
      sessionId,
      stateKey,
      supportedRendererIds: new Set(),
      targetId: target.targetId,
      url: target.url,
    };
    state.removeListeners.push(
      this.#connection.on("Runtime.bindingCalled", (payload, eventSessionId) => {
        if (eventSessionId !== sessionId) return;
        this.#bindingMessage(state, payload);
      }),
      this.#connection.on("Runtime.executionContextCreated", (payload, eventSessionId) => {
        if (eventSessionId !== sessionId || !isRecord(payload) || !isRecord(payload.context)) return;
        const contextId = integer(payload.context.id);
        const auxData = isRecord(payload.context.auxData) ? payload.context.auxData : {};
        if (contextId === undefined || auxData.frameId !== frameId || auxData.isDefault !== true) return;
        if (
          state.pageReady &&
          state.executionContextId !== undefined &&
          state.executionContextId !== contextId
        ) {
          this.#expireTarget(state);
          return;
        }
        state.executionContextId = contextId;
      }),
      this.#connection.on("Runtime.executionContextDestroyed", (payload, eventSessionId) => {
        if (eventSessionId !== sessionId || !isRecord(payload)) return;
        if (integer(payload.executionContextId) !== state.executionContextId) return;
        state.executionContextId = undefined;
        if (state.pageReady) this.#expireTarget(state);
      }),
      this.#connection.on("Page.frameNavigated", (payload, eventSessionId) => {
        if (eventSessionId !== sessionId || !isRecord(payload) || !isRecord(payload.frame)) return;
        if (payload.frame.parentId !== undefined) return;
        if (!state.pageReady) return;
        this.#expireTarget(state);
      }),
      this.#connection.on("Target.detachedFromTarget", (payload) => {
        if (isRecord(payload) && payload.sessionId === sessionId) this.#expireTarget(state);
      }),
    );
    try {
      await Promise.all([
        this.#connection.send("Runtime.enable", {}, sessionId),
        this.#connection.send("Page.enable", {}, sessionId),
        this.#connection.send("DOM.enable", {}, sessionId),
        this.#connection.send("Runtime.addBinding", { name: bindingName }, sessionId),
      ]);
      state.frontend = await this.#frontend(state);
      state.removeListeners.push(
        addListener(state.frontend.store, "mutated", (payload) => {
          const active = state.activeProfile;
          if (!active || !Array.isArray(payload)) {
            return;
          }
          for (const id of normalizeIntegerArray(payload[0])) {
            const element = invoke(state.frontend.store, "getElementByID", [id]);
            active.displayNamesByElement.set(id, stringOrNull(property(element, "displayName")));
          }
        }),
      );
      state.removeListeners.push(
        addListener(state.frontend.bridge, "operations", (payload) => {
          const active = state.activeProfile;
          if (!active || !Array.isArray(payload)) return;
          const rendererId = integer(payload[0]);
          const rootId = integer(payload[1]);
          if (
            rendererId === undefined ||
            rootId === undefined ||
            !active.supportedRendererIds.has(rendererId)
          ) {
            return;
          }
          active.rendererByRootId.set(rootId, rendererId);
        }),
      );
      const hadCompatibleHook = await this.#booleanEvaluation(sessionId, COMPATIBLE_REACT_HOOK_EXPRESSION);
      const source = await this.#bootstrapSource(state);
      const script = await this.#connection.send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source },
        sessionId,
      );
      if (isRecord(script) && typeof script.identifier === "string") {
        state.scriptIdentifier = script.identifier;
      }
      if (hadCompatibleHook) {
        await this.#evaluateCompatibleHook(sessionId, source);
        await this.initializePage(state, source);
      } else {
        state.reloaded = true;
        await Promise.all([
          this.waitForReloadedDocument(state, source),
          this.#connection.send("Page.reload", { ignoreCache: false }, sessionId),
        ]);
      }

      return state;
    } catch (error: unknown) {
      await this.#closeTarget(state).catch(this.#onError);
      throw error;
    }
  }

  private async initializePage(state: TargetState, source: string): Promise<void> {
    if (
      !(await this.#booleanEvaluation(
        state.sessionId,
        `Boolean(globalThis[${JSON.stringify(state.stateKey)}])`,
      ))
    ) {
      await this.#evaluateCompatibleHook(state.sessionId, source);
    }

    state.pageReady = true;
    await this.#flushOutbound(state);
  }

  async #readRendererMetadata(state: TargetState): Promise<Map<number, RendererMetadata>> {
    const value = await this.#evaluate(
      state.sessionId,
      `(() => {
      const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook || !(hook.renderers instanceof Map)) return [];
      return Array.from(hook.renderers, ([id, renderer]) => ({
        bundleType: renderer.bundleType,
        capabilities: (() => {
          const rendererInterface = hook.rendererInterfaces?.get(id);
          const injectedRenderer = rendererInterface?.renderer;
          const canOverrideClassValues = typeof rendererInterface?.overrideValueAtPath === "function";
          const canInspect = typeof rendererInterface?.inspectElement === "function";
          const domMapping = typeof rendererInterface?.findHostInstancesForElementID === "function";
          return {
            canEditContext: canOverrideClassValues,
            canEditHooks: typeof injectedRenderer?.overrideHookState === "function",
            canEditProps: canOverrideClassValues || typeof injectedRenderer?.overrideProps === "function",
            canEditState: canOverrideClassValues,
            canHighlight: domMapping,
            canInspect,
            canProfile: typeof rendererInterface?.startProfiling === "function" && typeof rendererInterface?.stopProfiling === "function",
            domMapping,
            sourceMetadata: canInspect,
          };
        })(),
        id,
        packageName: renderer.rendererPackageName,
        version: renderer.version,
      }));
    })()`,
    );
    const metadata = new Map<number, RendererMetadata>();
    if (!Array.isArray(value)) return metadata;
    for (const entry of value) {
      const renderer = integer(property(entry, "id"));
      const version = property(entry, "version");
      if (renderer === undefined || typeof version !== "string") continue;
      const bundleType = integer(property(entry, "bundleType"));
      let buildType: RendererMetadata["buildType"] = "unknown";

      if (bundleType === 1) {
        buildType = "development";
      } else if (bundleType === 0) {
        buildType = "production";
      } else if (bundleType === 2) {
        buildType = "profiling";
      }

      metadata.set(renderer, {
        buildType,
        capabilities: rendererCapabilities(
          state.frontend.store,
          isRecord(entry.capabilities) ? entry.capabilities : {},
        ),
        packageName: stringOrNull(property(entry, "packageName")),
        reactVersion: version,
      });
    }
    return metadata;
  }

  async #ensureRenderer(state: TargetState, waitForMountedRoot: boolean): Promise<void> {
    if (waitForMountedRoot) {
      try {
        await waitForReactRenderer(state);
      } catch (error: unknown) {
        if (
          error instanceof ChromeRuntimeError &&
          error.code === "CHROME_MCP_REACT_NO_RENDERER" &&
          !(await this.#hasCompatibleHook(state.sessionId))
        ) {
          throw new ChromeRuntimeError(
            "CHROME_MCP_REACT_UNSUPPORTED_RENDERER",
            "The selected page replaced the React DevTools hook with an incompatible stub",
          );
        }
        throw error;
      }
    }
    const metadata = await this.#readRendererMetadata(state);
    const rootRenderers = [
      ...new Set(
        normalizeIntegerArray(property(state.frontend.store, "roots")).flatMap(
          (root) => integer(invoke(state.frontend.store, "getRendererIDForElement", [root])) ?? [],
        ),
      ),
    ];
    const supportedRendererIds = new Set(
      rootRenderers.filter((renderer) => {
        const version = metadata.get(renderer)?.reactVersion;
        return version !== undefined && isSupportedReactRendererVersion(version);
      }),
    );
    if (rootRenderers.length > 0 && supportedRendererIds.size === 0) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_UNSUPPORTED_VERSION",
        "The selected page does not use React 18 or React 19",
      );
    }
    const signature = JSON.stringify(
      [...metadata.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([rendererId, value]) => [rendererId, value.buildType, value.packageName, value.reactVersion]),
    );
    if (state.rendererSignature !== undefined && state.rendererSignature !== signature) {
      if (state.activeProfile) {
        try {
          await stopReactProfiler(state);
        } catch (error: unknown) {
          this.#expireTarget(state);
          throw error;
        }
        this.#expireActiveProfile(state);
      }
      state.idsByConnection.clear();
      state.documentId = randomUUID();
      if (state.highlightConnectionId !== undefined) {
        state.highlightConnectionId = undefined;
        invoke(state.frontend.bridge, "send", ["clearHostInstanceHighlight"]);
        await Promise.resolve();
        await state.outbound;
      }
    }
    state.rendererMetadata = metadata;
    state.rendererSignature = signature;
    state.supportedRendererIds = supportedRendererIds;
  }

  async #hasCompatibleHook(sessionId: string): Promise<boolean> {
    return this.#booleanEvaluation(sessionId, COMPATIBLE_REACT_HOOK_EXPRESSION);
  }

  async #evaluateCompatibleHook(sessionId: string, source: string): Promise<void> {
    try {
      await this.#evaluate(sessionId, source);
    } catch (error: unknown) {
      if (!(await this.#hasCompatibleHook(sessionId))) {
        throw new ChromeRuntimeError(
          "CHROME_MCP_REACT_UNSUPPORTED_RENDERER",
          "The selected page has an incompatible React DevTools hook",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #frontend(state: TargetState): Promise<FrontendRuntime> {
    const module = await (this.#frontendModule ??= this.#readFrontendModule());
    const wall = {
      listen: (listener: (message: BridgeMessage) => void) => {
        state.bridgeListeners.add(listener);
        return () => state.bridgeListeners.delete(listener);
      },
      send: (event: string, payload: unknown) => {
        const message = { event, payload };
        if (!state.pageReady) {
          const bytes = byteLength(
            JSON.stringify(message, (_key, value: unknown) =>
              typeof value === "bigint" ? value.toString() : value,
            ),
          );
          if (
            state.pendingOutbound.length >= REACT_BRIDGE_PENDING_MAX_MESSAGES ||
            state.pendingOutboundBytes + bytes > REACT_BRIDGE_PENDING_MAX_BYTES
          ) {
            throw new ChromeRuntimeError(
              "CHROME_MCP_REACT_PROTOCOL",
              "React DevTools pending bridge queue exceeded its limit",
            );
          }
          state.pendingOutbound.push(message);
          state.pendingOutboundBytes += bytes;
          return;
        }
        this.#queueOutbound(state, message);
      },
    };
    const bridge: unknown = module.createBridge({}, wall);
    const store: unknown = module.createStore(bridge, {
      checkBridgeProtocolCompatibility: true,
      supportsInspectMatchingDOMElement: true,
      supportsTraceUpdates: false,
    });
    addListener(bridge, "getSavedPreferences", () => {
      invoke(bridge, "send", ["savedPreferences", { componentFilters: [] }]);
    });
    return { bridge, store };
  }

  async #readFrontendModule(): Promise<FrontendModule> {
    const window = new Window({ url: "http://react-devtools.invalid" });
    Reflect.defineProperty(window, "Worker", { configurable: true, value: undefined });
    const commonJsModule: { exports: Record<string, unknown> } = { exports: {} };
    const sandbox: Record<string, unknown> = {
      Buffer,
      clearInterval,
      clearTimeout,
      console,
      exports: commonJsModule.exports,
      module: commonJsModule,
      process,
      queueMicrotask,
      require,
      self: window,
      setInterval,
      setTimeout,
      window,
    };
    for (const name of [
      "AbortController",
      "Blob",
      "CustomEvent",
      "Event",
      "File",
      "FileReader",
      "HTMLElement",
      "Node",
      "TextDecoder",
      "TextEncoder",
      "URL",
      "atob",
      "btoa",
      "cancelAnimationFrame",
      "document",
      "localStorage",
      "navigator",
      "performance",
      "requestAnimationFrame",
    ]) {
      sandbox[name] = property(window, name) ?? property(globalThis, name);
    }
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    const path = Bun.resolveSync("react-devtools-inline/dist/frontend.js", import.meta.dir);
    vm.runInContext(await readFile(path, "utf8"), context, { filename: path });
    const createBridge = commonJsModule.exports.createBridge;
    const createStore = commonJsModule.exports.createStore;
    if (typeof createBridge !== "function" || typeof createStore !== "function") {
      window.close();
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_PROTOCOL",
        "react-devtools-inline/frontend does not expose createBridge and createStore",
      );
    }
    this.#frontendWindow = window;
    return {
      createBridge: (contentWindow, wall) => Reflect.apply(createBridge, undefined, [contentWindow, wall]),
      createStore: (bridge, config) => Reflect.apply(createStore, undefined, [bridge, config]),
    };
  }

  async #bootstrapSource(state: TargetState): Promise<string> {
    const backend = await (this.#backendSource ??= this.#readBackendSource());
    const stateKey = JSON.stringify(state.stateKey);
    const bindingName = JSON.stringify(state.bindingName);
    const markerKey = JSON.stringify(state.markerKey);
    const nonce = JSON.stringify(state.nonce);
    const backendExportKey = JSON.stringify(this.#backendExportKey);
    return `(() => {
      if (globalThis !== globalThis.top) return;
      const stateKey = ${stateKey};
      if (globalThis[stateKey]) return;
      const markerKey = ${markerKey};
      const revive = value => {
        if (Array.isArray(value)) return value.map(revive);
        if (!value || typeof value !== "object") return value;
        if (Object.prototype.hasOwnProperty.call(value, markerKey)) {
          switch (value[markerKey]) {
            case "undefined": return undefined;
            case "nan": return NaN;
            case "infinity": return value.sign < 0 ? -Infinity : Infinity;
            case "bigint": return BigInt(value.value);
          }
        }
        for (const key of Object.keys(value)) value[key] = revive(value[key]);
        return value;
      };
      const listeners = new Set();
      let previousSelection;
      const restoreSelection = () => {
        if (!previousSelection) return;
        const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (hook) {
          if (previousSelection.hadOwnProperty) hook.$0 = previousSelection.value;
          else delete hook.$0;
        }
        previousSelection = undefined;
      };
      const wall = {
        listen(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        send(event, payload) {
          const encoded = JSON.stringify({ event, nonce: ${nonce}, payload });
          if (new TextEncoder().encode(encoded).byteLength > ${REACT_BRIDGE_MESSAGE_MAX_BYTES}) throw new Error("React DevTools bridge message is too large");
          globalThis[${bindingName}](encoded);
        },
      };
      ${backend}
      const api = globalThis[${backendExportKey}];
      delete globalThis[${backendExportKey}];
      api.initialize(globalThis);
      const bridge = api.createBridge(globalThis, wall);
      globalThis[stateKey] = {
        deliver(encoded) {
          const message = revive(JSON.parse(encoded));
          for (const listener of listeners) listener(message);
        },
        restoreSelection,
        select(node) {
          restoreSelection();
          const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
          if (!hook) return false;
          previousSelection = { hadOwnProperty: Object.prototype.hasOwnProperty.call(hook, "$0"), value: hook.$0 };
          hook.$0 = node;
          return true;
        },
        shutdown() { restoreSelection(); bridge.shutdown(); listeners.clear(); },
      };
      api.activate(globalThis, { bridge });
    })();`;
  }

  async #readBackendSource(): Promise<string> {
    const path = Bun.resolveSync("react-devtools-inline/dist/backend.js", import.meta.dir);
    const exportKey = this.#backendExportKey;
    const result = await Bun.build({
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      entrypoints: ["chrome-mcp-react-backend-entry"],
      format: "iife",
      plugins: [
        {
          name: "chrome-mcp-react-backend-entry",
          setup(build) {
            build.onResolve({ filter: /^chrome-mcp-react-backend-entry$/u }, () => ({
              namespace: "chrome-mcp-react",
              path: "entry",
            }));
            build.onLoad({ filter: /.*/u, namespace: "chrome-mcp-react" }, () => ({
              contents: `import backend from ${JSON.stringify(path)}; globalThis[${JSON.stringify(exportKey)}] = backend;`,
              loader: "js",
            }));
          },
        },
      ],
      target: "browser",
    });
    const output = result.outputs[0];
    if (!result.success || !output) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_INITIALIZATION_FAILED",
        "Could not build the React DevTools browser backend",
      );
    }
    return output.text();
  }

  #bindingMessage(state: TargetState, payload: unknown): void {
    if (state.closed) return;
    const parsed = parseReactBridgeMessage(payload, {
      bindingName: state.bindingName,
      executionContextId: state.executionContextId,
      nonce: state.nonce,
    });
    if (parsed.kind === "ignore") return;
    if (parsed.kind === "invalid") {
      this.#expireTarget(state);
      return;
    }
    for (const listener of state.bridgeListeners) listener(parsed.message);
  }

  #queueOutbound(state: TargetState, message: BridgeMessage): void {
    state.outbound = state.outbound.then(() => this.#sendToPage(state, message));
    state.outbound.catch((error: unknown) => {
      this.#expireTarget(state);
      this.#onError(error);
    });
  }

  async #flushOutbound(state: TargetState): Promise<void> {
    const pending = state.pendingOutbound.splice(0);
    state.pendingOutboundBytes = 0;
    for (const message of pending) this.#queueOutbound(state, message);
    await state.outbound;
  }

  async #sendToPage(state: TargetState, message: BridgeMessage): Promise<void> {
    const serialized = JSON.stringify(message, (_key, value: unknown) => {
      if (value === undefined) return { [state.markerKey]: "undefined" };
      if (typeof value === "bigint") return { [state.markerKey]: "bigint", value: value.toString() };
      if (typeof value === "number" && Number.isNaN(value)) return { [state.markerKey]: "nan" };
      if (value === Number.POSITIVE_INFINITY) return { [state.markerKey]: "infinity", sign: 1 };
      if (value === Number.NEGATIVE_INFINITY) return { [state.markerKey]: "infinity", sign: -1 };
      return value;
    });
    if (byteLength(serialized) > REACT_BRIDGE_MESSAGE_MAX_BYTES) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_PROTOCOL",
        "React DevTools bridge message exceeds 8 MiB",
      );
    }
    await this.#evaluate(
      state.sessionId,
      `globalThis[${JSON.stringify(state.stateKey)}].deliver(${JSON.stringify(serialized)})`,
    );
  }

  async #operation(
    state: TargetState,
    ids: PublicIds,
    connectionId: string,
    request: Exclude<ReactBrowserOperation, { operation: "prepare" }>,
  ): Promise<Readonly<Record<string, unknown>>> {
    switch (request.operation) {
      case "list": {
        return this.#list(state, ids, request);
      }
      case "inspect": {
        return this.#inspect(state, ids, request.lookup);
      }
      case "update": {
        return this.#update(state, ids, request);
      }
      case "highlight": {
        return this.#highlight(state, ids, connectionId, request.action);
      }
      case "profile-start": {
        return this.#profileStart(state, ids, connectionId);
      }
      case "profile-stop": {
        return this.#profileStop(state, ids, connectionId, request.profileId);
      }
      default: {
        return request satisfies never;
      }
    }
  }

  async #list(
    state: TargetState,
    ids: PublicIds,
    request: Extract<ReactBrowserOperation, { operation: "list" }>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const store = state.frontend.store;
    validateReactListFilters(state, ids, request);
    const revision = integer(property(store, "revision")) ?? 0;
    const query = JSON.stringify({
      parentComponentId: request.parentComponentId,
      rendererId: request.rendererId,
      rootId: request.rootId,
      search: request.search?.toLocaleLowerCase("en-US"),
    });
    let values: readonly number[];
    let index = 0;
    let scanTruncated: boolean;
    if (request.cursor) {
      const cursor = ids.cursor.consume(request.cursor, query, revision);
      if (!cursor) {
        throw new ChromeRuntimeError("CHROME_MCP_REACT_STALE_CURSOR", "React component cursor is stale");
      }
      values = cursor.values;
      index = cursor.index;
      scanTruncated = cursor.truncated;
    } else {
      ids.cursor.clear();
      const scan = scanStoreElementIds(store);
      scanTruncated = scan.truncated;
      const candidates = scan.values.filter((id) => matchesReactElement({ state, ids, id, request }));
      if (request.search) {
        const needle = request.search.toLocaleLowerCase("en-US");
        const nameMatches = new Set(
          candidates.filter((id) => {
            const element = invoke(store, "getElementByID", [id]);
            const name = stringOrNull(property(element, "displayName"))?.toLocaleLowerCase("en-US") ?? "";
            return name.includes(needle);
          }),
        );
        await this.#readComponentMetadata(
          state,
          store,
          ids,
          candidates.filter((id) => !nameMatches.has(id)),
          revision,
        );
        values = candidates.filter(
          (id) => nameMatches.has(id) || ids.metadataByElement.get(id)?.searchable.includes(needle) === true,
        );
      } else {
        values = candidates;
      }
    }
    const page = values.slice(index, index + request.limit);
    await this.#readComponentMetadata(state, store, ids, page, revision);
    const hostNodeCounts = await this.#readHostNodeCounts(state, store, page);
    const components = page.map((id) =>
      createReactComponent({ state, ids, id, hostNodeCount: hostNodeCounts.get(id) }),
    );
    const nextIndex = index + page.length;
    let nextCursor: string | null = null;
    if (nextIndex < values.length) {
      nextCursor = ids.cursor.replace({
        index: nextIndex,
        query,
        revision,
        truncated: scanTruncated,
        values,
      });
    }
    const roots = normalizeIntegerArray(property(store, "roots"));
    const renderers = [
      ...new Set(
        roots.flatMap((root) => {
          const renderer = integer(invoke(store, "getRendererIDForElement", [root]));
          return renderer === undefined || !state.supportedRendererIds.has(renderer) ? [] : [renderer];
        }),
      ),
    ].map((renderer) => ({
      buildType: state.rendererMetadata.get(renderer)?.buildType ?? "unknown",
      capabilities: state.rendererMetadata.get(renderer)?.capabilities ?? rendererCapabilities(store),
      packageName: state.rendererMetadata.get(renderer)?.packageName ?? null,
      reactVersion: state.rendererMetadata.get(renderer)?.reactVersion ?? "unknown",
      rendererId: mappedId(ids.publicIdByRenderer, ids.rendererByPublicId, renderer),
      rootIds: roots
        .filter((root) => integer(invoke(store, "getRendererIDForElement", [root])) === renderer)
        .map((root) => mappedId(ids.publicIdByRoot, ids.rootByPublicId, root)),
    }));
    return {
      components,
      nextCursor,
      renderers,
      treeRevision: `${state.documentId}:${revision}`,
      truncated: scanTruncated,
    };
  }

  async #readComponentMetadata(
    state: TargetState,
    store: unknown,
    ids: PublicIds,
    elementIds: readonly number[],
    revision: number,
  ): Promise<void> {
    const pending = elementIds.filter((id) => ids.metadataByElement.get(id)?.revision !== revision);
    for (let index = 0; index < pending.length; index += 100) {
      const entries = pending.slice(index, index + 100).flatMap((id) => {
        const rendererId = integer(invoke(store, "getRendererIDForElement", [id]));
        return rendererId === undefined ? [] : [[id, rendererId]];
      });
      if (entries.length === 0) continue;
      const result = await this.#evaluate(
        state.sessionId,
        `(() => {
        const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        return ${JSON.stringify(entries)}.map(([id, rendererId]) => {
          const renderer = hook?.rendererInterfaces?.get(rendererId);
          if (!renderer || typeof renderer.inspectElement !== "function") return [id, null];
          try {
            const value = renderer.inspectElement(0, id, null, true)?.value;
            if (!value || typeof value !== "object") return [id, null];
            return [id, {
              canEditFunctionProps: value.canEditFunctionProps === true,
              canEditHooks: value.canEditHooks === true,
              hasContext: value.context !== null && value.context !== undefined,
              source: value.source ?? null,
            }];
          } catch {
            return [id, null];
          }
        });
      })()`,
      );
      if (!Array.isArray(result)) {
        throw new ChromeRuntimeError(
          "CHROME_MCP_REACT_PROTOCOL",
          "React source metadata has an unsupported shape",
        );
      }
      for (const entry of result) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const id = integer(entry[0]);
        if (id === undefined || !entries.some(([expectedId]) => expectedId === id)) continue;
        const metadata = isRecord(entry[1]) ? entry[1] : {};
        const source = sourceLocation(metadata.source);
        ids.metadataByElement.set(id, {
          canEditFunctionProps: metadata.canEditFunctionProps === true,
          canEditHooks: metadata.canEditHooks === true,
          hasContext: metadata.hasContext === true,
          revision,
          searchable: source === null ? "" : JSON.stringify(source).toLocaleLowerCase("en-US"),
          source,
        });
      }
    }
  }

  async #readHostNodeCounts(
    state: TargetState,
    store: unknown,
    elementIds: readonly number[],
  ): Promise<Map<number, number>> {
    const entries = elementIds.flatMap((id) => {
      const rendererId = integer(invoke(store, "getRendererIDForElement", [id]));
      return rendererId === undefined ? [] : [[id, rendererId]];
    });
    if (entries.length === 0) return new Map();
    const result = await this.#evaluate(
      state.sessionId,
      `(() => {
      const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      return ${JSON.stringify(entries)}.map(([id, rendererId]) => {
        const renderer = hook?.rendererInterfaces?.get(rendererId);
        if (!renderer || typeof renderer.findHostInstancesForElementID !== "function") return [id, 0];
        try {
          const nodes = renderer.findHostInstancesForElementID(id);
          return [id, Array.isArray(nodes) ? nodes.length : 0];
        } catch {
          return [id, 0];
        }
      });
    })()`,
    );
    if (!Array.isArray(result)) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_PROTOCOL",
        "React host-node counts have an unsupported shape",
      );
    }
    const counts = new Map<number, number>();
    for (const entry of result) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const id = integer(entry[0]);
      const count = integer(entry[1]);
      if (id !== undefined && count !== undefined && count >= 0) counts.set(id, count);
    }
    return counts;
  }

  async #readHighlightState(
    state: TargetState,
    rendererId: number,
    elementId: number,
  ): Promise<Readonly<{ hostNodeCount: number; overlayVisible: boolean }>> {
    const result = await this.#evaluate(
      state.sessionId,
      `(() => {
      const renderer = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__?.rendererInterfaces?.get(${rendererId});
      if (!renderer || typeof renderer.findHostInstancesForElementID !== "function") {
        return { hostNodeCount: 0, overlayVisible: false };
      }
      let nodes;
      try {
        nodes = renderer.findHostInstancesForElementID(${elementId});
      } catch {
        return { hostNodeCount: 0, overlayVisible: false };
      }
      if (!Array.isArray(nodes)) return { hostNodeCount: 0, overlayVisible: false };
      const overlayVisible = nodes.some(node => {
        if (!node || typeof node.getClientRects !== "function") return false;
        const rects = node.getClientRects();
        return rects.length > 0 && (rects.length > 2 || rects[0].width > 0 || rects[0].height > 0);
      });
      return { hostNodeCount: nodes.length, overlayVisible };
    })()`,
    );
    if (!isRecord(result)) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_PROTOCOL",
        "React highlight state has an unsupported shape",
      );
    }
    const hostNodeCount = integer(result.hostNodeCount);
    if (hostNodeCount === undefined || hostNodeCount < 0 || typeof result.overlayVisible !== "boolean") {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_PROTOCOL",
        "React highlight state has an unsupported shape",
      );
    }
    return { hostNodeCount, overlayVisible: result.overlayVisible };
  }

  async #reactDevToolsOverlayCount(state: TargetState): Promise<number> {
    const count = integer(
      await this.#evaluate(state.sessionId, `(${countReactDevToolsOverlays.toString()})(document)`),
    );
    if (count === undefined || count < 0) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_PROTOCOL",
        "React highlight overlay count has an unsupported shape",
      );
    }
    return count;
  }

  async #inspect(
    state: TargetState,
    ids: PublicIds,
    lookup: Extract<ReactBrowserOperation, { operation: "inspect" }>["lookup"],
  ): Promise<Readonly<Record<string, unknown>>> {
    let id: number;
    switch (lookup.type) {
      case "component": {
        id = requireElementId(ids, lookup.componentId);
        break;
      }
      case "selector": {
        id = await this.#componentForSelector(state, lookup.selector);
        break;
      }
      case "staged-node": {
        id = await this.#componentForStagedNode(state, lookup.key);
        break;
      }
      default: {
        return lookup satisfies never;
      }
    }
    const store = state.frontend.store;
    const element = invoke(store, "getElementByID", [id]);
    if (!isRecord(element)) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_STALE_COMPONENT",
        "React component is no longer mounted",
      );
    }
    const rendererID = requireRendererId(state, id);
    const inspected = requireRecord(
      await sendReactBridgeRequest({
        state,
        event: "inspectElement",
        responseEvent: "inspectedElement",
        payload: {
          forceFullData: true,
          id,
          path: null,
          rendererID,
        },
      }),
      "React inspected element response",
    );
    if (inspected.type === "not-found") {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_STALE_COMPONENT",
        "React component is no longer mounted",
      );
    }
    if (inspected.type === "error") {
      const message = typeof inspected.message === "string" ? inspected.message : "React inspection failed";
      const stack =
        typeof inspected.stack === "string" ? inspected.stack.split("\n").slice(1, 4).join("\n") : "";
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_UNSUPPORTED_OPERATION",
        stack ? `${message}\n${stack}` : message,
      );
    }
    const value = requireRecord(inspected.value, "React inspected element");
    const graph = normalizationState();
    const canEditContext =
      elementKind(element.type) === "class" && value.context !== null && value.context !== undefined;
    const canEditHooks = value.canEditHooks === true;
    const hooks = this.#hooks(ids, id, unwrapReactBridgeValue(value.hooks), graph, canEditHooks);
    const ownerIds =
      Array.isArray(value.owners) ?
        value.owners.flatMap((owner) => integer(property(owner, "id")) ?? [])
      : [];
    const source = sourceLocation(value.source);
    const revision = integer(property(store, "revision")) ?? 0;
    ids.metadataByElement.set(id, {
      canEditFunctionProps: value.canEditFunctionProps === true,
      canEditHooks,
      hasContext: value.context !== null && value.context !== undefined,
      revision,
      searchable: source === null ? "" : JSON.stringify(source).toLocaleLowerCase("en-US"),
      source,
    });
    await this.#readComponentMetadata(state, store, ids, ownerIds, revision);
    const owners = ownerIds.map((ownerId) => createReactComponent({ state, ids, id: ownerId }));
    const host = await this.#hostNodes(state, ids, rendererID, id);
    const capabilities = readComponentCapabilities({ state, ids, id, element });
    return {
      capabilities,
      component: createReactComponent({ state, ids, id, hostNodeCount: host.count }),
      contexts:
        value.context === null || value.context === undefined ?
          []
        : [
            {
              contextId: mappedHookId(ids, id, -1),
              editable: canEditContext,
              name: null,
              value: normalizeUnknown(unwrapReactBridgeValue(value.context), graph),
            },
          ],
      hooks,
      hostNodeCount: host.count,
      hostNodes: host.nodes,
      hostNodesTruncated: host.truncated,
      owners,
      props: normalizeUnknown(unwrapReactBridgeValue(value.props), graph),
      rendererPackageName: stringOrNull(value.rendererPackageName),
      rendererVersion: stringOrNull(value.rendererVersion),
      source,
      state: normalizeUnknown(unwrapReactBridgeValue(value.state), graph),
      truncated: graph.truncated,
    };
  }

  #hooks(
    ids: PublicIds,
    elementId: number,
    value: unknown,
    graph: NormalizationState,
    canEdit: boolean,
  ): unknown[] {
    if (value instanceof ReactValuePreview) {
      graph.truncated = true;
      return [];
    }
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((hook) => {
      const rawId = integer(property(hook, "id"));
      return {
        editable: canEdit && rawId !== undefined,
        hookId: rawId === undefined ? null : mappedHookId(ids, elementId, rawId),
        name: stringOrNull(property(hook, "name")),
        subHooks: this.#hooks(ids, elementId, property(hook, "subHooks"), graph, canEdit),
        value: normalizeUnknown(property(hook, "value"), graph),
      };
    });
  }

  async #hostNodes(
    state: TargetState,
    ids: PublicIds,
    rendererId: number,
    elementId: number,
  ): Promise<
    Readonly<{
      count: number;
      nodes: readonly Readonly<Record<string, unknown>>[];
      truncated: boolean;
    }>
  > {
    const expression = `globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__.rendererInterfaces.get(${rendererId}).findHostInstancesForElementID(${elementId})`;
    const count = integer(await this.#evaluate(state.sessionId, `${expression}.length`)) ?? 0;
    const nodes: Readonly<Record<string, unknown>>[] = [];
    for (let index = 0; index < Math.min(count, REACT_HOST_NODE_MAX); index += 1) {
      const evaluated = requireRecord(
        await this.#connection.send(
          "Runtime.evaluate",
          {
            expression: `${expression}[${index}]`,
            returnByValue: false,
          },
          state.sessionId,
        ),
        "Runtime.evaluate host node result",
      );
      const remote = requireRecord(evaluated.result, "Runtime remote host node");
      const objectId = typeof remote.objectId === "string" ? remote.objectId : undefined;
      if (!objectId) continue;
      try {
        const described = requireRecord(
          await this.#connection.send("DOM.describeNode", { objectId }, state.sessionId),
          "DOM.describeNode result",
        );
        const node = requireRecord(described.node, "DOM node");
        const backendNodeId = integer(node.backendNodeId);
        if (backendNodeId === undefined) continue;
        const details = await this.#connection.send(
          "Runtime.callFunctionOn",
          {
            functionDeclaration: `function () {
            const selector = (() => {
              if (!(this instanceof Element)) return null;
              if (this.id && document.querySelectorAll('#' + CSS.escape(this.id)).length === 1) return '#' + CSS.escape(this.id);
              const parts = [];
              let current = this;
              while (current && current.nodeType === 1 && parts.length < 8) {
                let part = current.localName;
                const siblings = current.parentElement ? Array.from(current.parentElement.children).filter(node => node.localName === current.localName) : [];
                if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
                parts.unshift(part);
                current = current.parentElement;
              }
              return parts.join(' > ');
            })();
            return { nodeName: this.nodeName, selector, text: (this.textContent || '').slice(0, 500) };
          }`,
            objectId,
            returnByValue: true,
          },
          state.sessionId,
        );
        const detailResult = requireRecord(details, "Runtime.callFunctionOn result");
        const detailRemote = requireRecord(detailResult.result, "Runtime host detail result");
        const detail = isRecord(detailRemote.value) ? detailRemote.value : {};
        let bounds: readonly number[] | null = null;
        try {
          const boxResult = requireRecord(
            await this.#connection.send("DOM.getBoxModel", { backendNodeId }, state.sessionId),
            "DOM.getBoxModel result",
          );
          const model = requireRecord(boxResult.model, "DOM box model");
          bounds =
            Array.isArray(model.border) ?
              model.border.flatMap((coordinate) => finiteNumber(coordinate) ?? [])
            : null;
        } catch {
          bounds = null;
        }

        let nodeName: string | null = null;

        if (typeof detail.nodeName === "string") {
          nodeName = detail.nodeName;
        } else if (typeof node.nodeName === "string") {
          nodeName = node.nodeName;
        }

        nodes.push({
          backendNodeId,
          bounds,
          frameId: typeof node.frameId === "string" ? node.frameId : state.frameId,
          hostNodeId: mappedId(ids.publicIdByHost, ids.hostByPublicId, backendNodeId),
          nodeName,
          selector: typeof detail.selector === "string" ? detail.selector : null,
          textPreview: typeof detail.text === "string" ? detail.text : "",
        });
      } finally {
        await this.#connection
          .send("Runtime.releaseObject", { objectId }, state.sessionId)
          .catch(() => undefined);
      }
    }
    return { count, nodes, truncated: count > REACT_HOST_NODE_MAX };
  }

  async #componentForSelector(state: TargetState, selector: string): Promise<number> {
    const selected = await this.#evaluate(
      state.sessionId,
      `(() => {
        try {
          const nodes = document.querySelectorAll(${JSON.stringify(selector)});
          if (nodes.length === 1) globalThis[${JSON.stringify(state.stateKey)}].select(nodes[0]);
          return { count: nodes.length };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      })()`,
    );
    const selection = requireRecord(selected, "React selector result");
    if (typeof selection.error === "string") {
      throw new ChromeRuntimeError(
        "CHROME_MCP_INVALID_INPUT",
        `React selector is invalid: ${selection.error}`,
      );
    }
    const count = integer(selection.count);
    if (count !== 1) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_INVALID_INPUT",
        `React selector must match exactly one element; matched ${count ?? 0}`,
      );
    }
    return this.#componentForSelectedNode(state);
  }

  async #componentForStagedNode(state: TargetState, key: string): Promise<number> {
    const selected = requireRecord(
      await this.#evaluate(state.sessionId, reactStagedNodeSelectionExpression(key, state.stateKey)),
      "React staged DOM node result",
    );
    if (selected.selected !== true) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_STALE_COMPONENT",
        "Staged DOM node is no longer available",
      );
    }
    return this.#componentForSelectedNode(state);
  }

  async #componentForSelectedNode(state: TargetState): Promise<number> {
    let removeListener: () => void = () => undefined;
    let listening = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopListening = () => {
      if (!listening) return;
      listening = false;
      removeListener();
    };
    try {
      const selectedId = new Promise<number>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new ChromeRuntimeError(
              "CHROME_MCP_REACT_STALE_COMPONENT",
              "Selected DOM node is not owned by React",
            ),
          );
          stopListening();
        }, 5000);
        timer.unref?.();
        removeListener = addListener(state.frontend.bridge, "selectElement", (payload) => {
          const id = integer(payload);
          if (id === undefined) return;
          if (timer) clearTimeout(timer);
          resolve(id);
          stopListening();
        });
        listening = true;
      });
      invoke(state.frontend.bridge, "send", ["syncSelectionFromBuiltinElementsPanel"]);
      return await selectedId;
    } finally {
      if (timer) clearTimeout(timer);
      try {
        stopListening();
      } finally {
        await this.#evaluate(
          state.sessionId,
          `globalThis[${JSON.stringify(state.stateKey)}]?.restoreSelection()`,
        );
      }
    }
  }

  async #update(
    state: TargetState,
    ids: PublicIds,
    request: Extract<ReactBrowserOperation, { operation: "update" }>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const id = requireElementId(ids, request.componentId);
    const store = state.frontend.store;
    const rendererID = requireRendererId(state, id);
    const element = invoke(store, "getElementByID", [id]);
    if (!isRecord(element)) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_STALE_COMPONENT",
        "React component is no longer mounted",
      );
    }
    const beforeValue = await inspectReactUpdateValue({
      elementId: id,
      phase: "before",
      rendererId: rendererID,
      state,
    });
    const kind = elementKind(element.type);
    let canEdit = kind === "class";

    if (request.location.type === "hook-state") {
      canEdit = beforeValue.canEditHooks === true;
    } else if (request.location.type === "props") {
      canEdit = kind === "class" || beforeValue.canEditFunctionProps === true;
    }

    if (!canEdit) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_UNSUPPORTED_OPERATION",
        `The selected renderer cannot edit ${request.location.type}`,
      );
    }

    if (request.location.type === "context") {
      requireHookId(ids, request.location.contextId, id);
    }
    const path = request.location.path;
    const eventsByLocationType = {
      "class-state": "overrideState",
      "hook-state": "overrideHookState",
      context: "overrideContext",
      props: "overrideProps",
    };
    const event = eventsByLocationType[request.location.type];
    const expected = mutationValue(request.value);
    invoke(state.frontend.bridge, "send", [
      event,
      {
        id,
        ...(request.location.type === "hook-state" ?
          { hookID: requireHookId(ids, request.location.hookId, id) }
        : {}),
        path,
        rendererID,
        value: expected,
      },
    ]);
    const inspectedValue = await inspectReactUpdateValue({
      elementId: id,
      phase: "after",
      rendererId: rendererID,
      state,
    });
    let inspectionPath: ReactValuePath;
    switch (request.location.type) {
      case "props": {
        inspectionPath = ["props", ...path];
        break;
      }
      case "class-state": {
        inspectionPath = ["state", ...path];
        break;
      }
      case "context": {
        inspectionPath = ["context", ...path];
        break;
      }
      case "hook-state": {
        const hookPath = this.#hookPath(
          unwrapReactBridgeValue(inspectedValue.hooks),
          requireHookId(ids, request.location.hookId, id),
        );
        if (!hookPath) {
          return {
            observedValue: unavailableValue(
              "React state hook could not be fully inspected after the requested update",
            ),
            requestedValue: request.value,
            status: "unverified",
          };
        }
        inspectionPath = ["hooks", ...hookPath, ...path];
        break;
      }
      default: {
        return request.location satisfies never;
      }
    }

    const verification = await inspectReactMutationValue({
      expected,
      path: inspectionPath,
      inspect: (inspectedPath) =>
        sendReactBridgeRequest({
          state,
          event: "inspectElement",
          responseEvent: "inspectedElement",
          payload: {
            forceFullData: false,
            id,
            path: inspectedPath,
            rendererID,
          },
        }),
    });
    return {
      ...verification,
      requestedValue: request.value,
    };
  }

  #hookPath(hooks: unknown, hookId: number): ReactHydrationPath {
    if (!Array.isArray(hooks)) {
      return undefined;
    }
    for (const [index, hook] of hooks.entries()) {
      if (integer(property(hook, "id")) === hookId) {
        return [index, "value"];
      }
      const nested = this.#hookPath(property(hook, "subHooks"), hookId);
      if (nested) {
        return [index, "subHooks", ...nested];
      }
    }
    return undefined;
  }

  async #highlight(
    state: TargetState,
    ids: PublicIds,
    connectionId: string,
    action: Extract<ReactBrowserOperation, { operation: "highlight" }>["action"],
  ): Promise<Readonly<Record<string, unknown>>> {
    if (action.type === "clear") {
      if (state.highlightConnectionId && state.highlightConnectionId !== connectionId) {
        throw new ChromeRuntimeError(
          "CHROME_MCP_REACT_UNSUPPORTED_OPERATION",
          "React highlight belongs to another connection",
        );
      }
      invoke(state.frontend.bridge, "send", ["clearHostInstanceHighlight"]);
      await Promise.resolve();
      await state.outbound;
      state.highlightConnectionId = undefined;
      return { hostNodeCount: 0, overlayVisible: false };
    }
    const id = requireElementId(ids, action.componentId);
    const store = state.frontend.store;
    const rendererID = requireRendererId(state, id);
    const element = invoke(store, "getElementByID", [id]);
    const highlight = await this.#readHighlightState(state, rendererID, id);
    invoke(state.frontend.bridge, "send", ["clearHostInstanceHighlight"]);
    await Promise.resolve();
    await state.outbound;
    const overlayCountBefore = await this.#reactDevToolsOverlayCount(state);
    invoke(state.frontend.bridge, "send", [
      "highlightHostInstance",
      {
        displayName: stringOrNull(property(element, "displayName")),
        hideAfterTimeout: false,
        id,
        openBuiltinElementsPanel: false,
        rendererID,
        scrollIntoView: false,
      },
    ]);
    await Promise.resolve();
    await state.outbound;
    const overlayVisible =
      highlight.overlayVisible && (await this.#reactDevToolsOverlayCount(state)) > overlayCountBefore;
    state.highlightConnectionId = overlayVisible ? connectionId : undefined;
    return { hostNodeCount: highlight.hostNodeCount, overlayVisible };
  }

  async #profileStart(
    state: TargetState,
    ids: PublicIds,
    connectionId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (state.activeProfile) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_PROFILE_ACTIVE",
        "A React profile is already active for this target",
      );
    }
    const profiler = property(state.frontend.store, "profilerStore");
    if (!profiler || property(state.frontend.store, "rootSupportsBasicProfiling") !== true) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_UNSUPPORTED_OPERATION",
        "The selected React renderer does not support profiling",
      );
    }
    const store = requireRecord(state.frontend.store, "React Store");
    const roots = normalizeIntegerArray(property(state.frontend.store, "roots"));
    const rendererByRootId = new Map<number, number>();
    for (const root of roots) {
      const renderer = integer(invoke(state.frontend.store, "getRendererIDForElement", [root]));
      if (renderer !== undefined) rendererByRootId.set(root, renderer);
    }
    const renderers = [...new Set(rendererByRootId.values())];
    const includedRenderers = renderers.filter((renderer) => state.supportedRendererIds.has(renderer));
    const excludedRenderers = renderers.filter((renderer) => !state.supportedRendererIds.has(renderer));
    const profileId = randomUUID();
    const startedAt = new Date().toISOString();
    state.activeProfile = {
      connectionId,
      displayNamesByElement: new Map(),
      profileId,
      rendererByRootId,
      startedAt,
      supportedRendererIds: new Set(includedRenderers),
    };
    Reflect.set(store, "recordChangeDescriptions", true);
    try {
      invoke(profiler, "startProfiling");
      await waitForReactProperty({
        target: profiler,
        key: "isProfilingBasedOnUserInput",
        expected: true,
        event: "isProfiling",
        timeoutMs: 10_000,
      });
      await state.outbound;
    } catch (error: unknown) {
      if (state.activeProfile?.profileId === profileId) state.activeProfile = undefined;
      this.#expiredProfiles.delete(profileId);
      await stopReactProfiler(state).catch(this.#onError);
      this.#expireTarget(state);
      throw error;
    }
    return {
      excludedRenderers: excludedRenderers.map((renderer) =>
        mappedId(ids.publicIdByRenderer, ids.rendererByPublicId, renderer),
      ),
      includedRendererIds: includedRenderers.map((renderer) =>
        mappedId(ids.publicIdByRenderer, ids.rendererByPublicId, renderer),
      ),
      profileId,
      startedAt,
    };
  }

  async #profileStop(
    state: TargetState,
    ids: PublicIds,
    connectionId: string,
    profileId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const active = state.activeProfile;
    if (!active) {
      throw new ChromeRuntimeError("CHROME_MCP_REACT_PROFILE_NOT_ACTIVE", "No React profile is active");
    }
    if (active.connectionId !== connectionId || active.profileId !== profileId) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_REACT_PROFILE_OWNERSHIP",
        "React profile belongs to another connection or target",
      );
    }
    try {
      const profiler = property(state.frontend.store, "profilerStore");
      const dataReady = waitForProfilerCompletion(profiler);
      invoke(profiler, "stopProfiling");
      await waitForReactProperty({
        target: profiler,
        key: "isProfilingBasedOnUserInput",
        expected: false,
        event: "isProfiling",
        timeoutMs: 10_000,
      });
      await dataReady;
      const profileData = filterSupportedProfileData(
        property(profiler, "profilingData"),
        active.supportedRendererIds,
        active.rendererByRootId,
      );
      const limits = inspectReactProfileLimits(profileData);
      if (limits.incomplete) {
        state.activeProfile = undefined;
        return {
          incompleteReason: "profile limit reached",
          profile: null,
          profileId,
          startedAt: active.startedAt,
          status: "incomplete",
          stoppedAt: new Date().toISOString(),
          summary: { commitCount: limits.commitCount },
          truncated: true,
        };
      }
      const normalized = createReactProfile(profileData, ids, active.displayNamesByElement);
      const encoded = JSON.stringify(normalized);
      const incomplete = byteLength(encoded) > REACT_PROFILE_MAX_BYTES;
      state.activeProfile = undefined;
      return {
        incompleteReason: incomplete ? "profile limit reached" : null,
        profile: incomplete ? null : normalized,
        profileId,
        startedAt: active.startedAt,
        status: incomplete ? "incomplete" : "complete",
        stoppedAt: new Date().toISOString(),
        summary: { commitCount: limits.commitCount },
        truncated: incomplete,
      };
    } catch (error: unknown) {
      this.#expireTarget(state);
      throw error;
    }
  }

  // Activate the bridge at DOMContentLoaded so mounted roots can release the wait while images still load.
  // Async scripts can mount later, so the renderer's separate timeout must not start until a supported root or load arrives.
  // Events before the main-frame commit belong to the old document and cannot release either wait.
  private async waitForReloadedDocument(state: TargetState, source: string): Promise<void> {
    let hasCommitted = false;
    let hasDomContentLoaded = false;
    let hasFinished = false;

    const removeListeners: (() => void)[] = [];
    const documentReady = Promise.withResolvers<void>();
    const applicationReady = Promise.withResolvers<void>();
    const ready = Promise.all([
      documentReady.promise.then(() => this.initializePage(state, source)),
      applicationReady.promise,
    ]);

    try {
      const timer = setTimeout(() => {
        const seconds = HOOK_INSTALL_RELOAD_TIMEOUT_MS / 1000;
        let pending = "start a new document";

        if (hasDomContentLoaded) {
          pending = "mount a supported React root or finish loading";
        } else if (hasCommitted) {
          pending = "reach DOMContentLoaded";
        }

        const error = new ChromeRuntimeError(
          "CHROME_MCP_REACT_INITIALIZATION_FAILED",
          `React DevTools reloaded the page to install its hook, but the reload did not ${pending} within ${seconds} seconds`,
        );
        documentReady.reject(error);
        applicationReady.reject(error);
      }, HOOK_INSTALL_RELOAD_TIMEOUT_MS);
      timer.unref?.();
      removeListeners.push(() => clearTimeout(timer));
      removeListeners.push(
        this.#connection.on("Page.frameNavigated", (payload, eventSessionId) => {
          const isMainFrameNavigation =
            eventSessionId === state.sessionId &&
            isRecord(payload) &&
            isRecord(payload.frame) &&
            payload.frame.parentId === undefined;
          if (!isMainFrameNavigation) return;

          hasCommitted = true;
        }),
      );
      removeListeners.push(
        this.#connection.on("Page.domContentEventFired", (_payload, eventSessionId) => {
          const isReloadedDocument = eventSessionId === state.sessionId && hasCommitted;
          if (!isReloadedDocument) return;

          hasDomContentLoaded = true;
          documentReady.resolve();
        }),
      );
      removeListeners.push(
        this.#connection.on("Page.loadEventFired", (_payload, eventSessionId) => {
          const isReloadedDocument = eventSessionId === state.sessionId && hasCommitted;
          if (!isReloadedDocument) return;

          applicationReady.resolve();
        }),
      );

      let rootChecks = Promise.resolve();

      const finishOnRoot = () => {
        const hasReloadedRoot =
          hasCommitted && normalizeIntegerArray(property(state.frontend.store, "roots")).length > 0;
        if (!hasReloadedRoot) return;

        rootChecks = rootChecks
          .then(async () => {
            if (hasFinished) return;

            const metadata = await this.#readRendererMetadata(state);

            const hasSupportedRoot = normalizeIntegerArray(property(state.frontend.store, "roots")).some(
              (root) => {
                const renderer = integer(invoke(state.frontend.store, "getRendererIDForElement", [root]));
                if (renderer === undefined) return false;

                const version = metadata.get(renderer)?.reactVersion;

                return version !== undefined && isSupportedReactRendererVersion(version);
              },
            );
            if (!hasSupportedRoot) return;

            applicationReady.resolve();
          })
          .catch(applicationReady.reject);
      };

      removeListeners.push(addListener(state.frontend.store, "roots", finishOnRoot));
      removeListeners.push(addListener(state.frontend.store, "mutated", finishOnRoot));

      await ready;
    } finally {
      hasFinished = true;

      for (const removeListener of removeListeners) {
        removeListener();
      }
    }
  }

  async #booleanEvaluation(sessionId: string, expression: string): Promise<boolean> {
    return (await this.#evaluate(sessionId, expression)) === true;
  }

  async #evaluate(sessionId: string, expression: string): Promise<unknown> {
    const result = requireRecord(
      await this.#connection.send(
        "Runtime.evaluate",
        {
          awaitPromise: true,
          expression,
          returnByValue: true,
        },
        sessionId,
      ),
      "Runtime.evaluate result",
    );
    if (result.exceptionDetails !== undefined) {
      const details = isRecord(result.exceptionDetails) ? result.exceptionDetails : {};
      const exception = isRecord(details.exception) ? details.exception : {};
      let message = "React DevTools page script failed";

      if (typeof exception.description === "string") {
        message = exception.description.split("\n", 1)[0] ?? message;
      } else if (typeof details.text === "string") {
        message = details.text;
      }

      throw new ChromeRuntimeError("CHROME_MCP_REACT_INITIALIZATION_FAILED", message);
    }
    return property(result.result, "value");
  }

  #expireActiveProfile(state: TargetState): void {
    if (!state.activeProfile) return;
    this.#expiredProfiles.set(state.activeProfile.profileId, state.activeProfile.connectionId);
    state.activeProfile = undefined;
  }

  #expireTarget(state: TargetState): void {
    if (state.closed) return;
    state.closed = true;
    this.#expireActiveProfile(state);
    state.idsByConnection.clear();
    if (this.#targets.get(state.targetId)) this.#targets.delete(state.targetId);
    this.#closeTarget(state).catch(this.#onError);
  }

  #closeTarget(state: TargetState): Promise<void> {
    if (state.closePromise) return state.closePromise;
    const closing = this.#performTargetCleanup(state);
    state.closePromise = closing;
    return closing;
  }

  async #performTargetCleanup(state: TargetState): Promise<void> {
    state.closed = true;
    for (const remove of state.removeListeners.splice(0)) remove();
    state.bridgeListeners.clear();
    state.idsByConnection.clear();
    const cleanup: Promise<unknown>[] = [];
    cleanup.push(
      this.#connection.send(
        "Runtime.evaluate",
        {
          expression: `globalThis[${JSON.stringify(state.stateKey)}]?.shutdown(); delete globalThis[${JSON.stringify(state.stateKey)}]`,
        },
        state.sessionId,
        5000,
      ),
    );
    if (state.scriptIdentifier) {
      cleanup.push(
        this.#connection.send(
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier: state.scriptIdentifier },
          state.sessionId,
          5000,
        ),
      );
    }
    cleanup.push(
      this.#connection.send("Runtime.removeBinding", { name: state.bindingName }, state.sessionId, 5000),
    );
    const errors: unknown[] = [];
    if (property(state.frontend, "bridge") !== undefined) {
      try {
        invoke(state.frontend.bridge, "shutdown");
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    const settled = await Promise.allSettled(cleanup);
    for (const result of settled) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    try {
      await this.#connection.send("Target.detachFromTarget", { sessionId: state.sessionId }, undefined, 5000);
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "React inspection target cleanup failed");
  }
}
