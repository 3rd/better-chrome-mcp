import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  CaptureOutput,
  CaptureScope,
  CdpSessionAdapter,
  CdpSessionFactory,
  CheckpointRuntimeAdapter,
  CompactSnapshotLine,
  ComparableSnapshot,
  NetworkExchange,
  PageMetadata,
  PlaywrightTracingAdapter,
  PlaywrightTracingResolver,
  ScreencastFrame,
  ScreenshotCapture,
  SnapshotComparison,
  StorageCookie,
  StorageState,
} from "../captures";
import type {
  BrowserJournalEvent,
  BrowserMode,
  EventCursor,
  GenerationTargetId,
  JournalReadOptions,
  JournalReadResult,
} from "../runtime";
import { isRecord } from "../../platform/records";
import {
  type ArtifactDescriptor,
  ChromeMcpExecutionError,
  connectExecutionBrowserSession,
  copyJsonValue,
  jsonByteLength,
  type JsonObject,
  type JsonValue,
  SNAPSHOT_DEFAULT_DEPTH,
  SNAPSHOT_DEFAULT_MAX_BYTES,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_RETAINED_COUNT,
  type SnapshotRootToken,
} from "../execution";
import { REACT_STAGED_NODE_KEY_PREFIX } from "../runtime/react-inspection-protocol";

type CdpListener = (params: unknown, sessionId: string | undefined) => void;

const MEDIA_EMULATION_PAGE_CLOSED = "The media emulation page is closed";
const AUXILIARY_CONNECT_TIMEOUT_MS = 10_000;

export type ChromePageSession = Readonly<{
  browserMode: BrowserMode;
  connectionId: string;
  currentEventCursor: () => Promise<EventCursor>;
  currentTarget: () => GenerationTargetId;
  readEvents: (options?: JournalReadOptions & Readonly<{ advance?: boolean }>) => Promise<JournalReadResult>;
  ownerGeneration: number;
  sendCdp: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;
  onCdp: (method: string, listener: CdpListener) => () => void;
  ownerId: string;
  targetRecord: (targetId: string) => Promise<Readonly<{ title?: string; url: string }> | undefined>;
  workerConnection: () => Promise<
    Readonly<{ endpoint: string; ownerGeneration: number; target: GenerationTargetId }>
  >;
}>;

export type ChromePageAdapterOptions = Readonly<{
  connectSnapshot?: SnapshotConnector;
  resolveContext: (contextId: string) => ChromePageSession;
  resolveScope: (scope: CaptureScope) => ChromePageSession;
  resolveTarget: (targetId: string) => Promise<ChromePageSession>;
}>;

type SnapshotData = {
  snapshotId: string;
  targetId: string;
  url: string;
  title: string;
  capturedAt: string;
  refs: Record<string, { name: string; role: string }>;
  tree?: string;
  added?: string[];
  removed?: string[];
  changed?: string[];
};

type SnapshotCounts = {
  treeLines: number;
  refs: number;
  added: number;
  removed: number;
  changed: number;
};

type SnapshotArtifacts = {
  artifact?: ArtifactDescriptor;
  dataArtifact?: ArtifactDescriptor;
};

type SnapshotViewResult = Omit<SnapshotData, "title" | "url"> &
  SnapshotArtifacts & {
    view: "bounded" | "full";
    url?: string;
    title?: string;
    totals: SnapshotCounts;
    omitted: SnapshotCounts & { metadataFields: ("title" | "url")[] };
    omissionReason: "maxBytes" | null;
  };

export type HelperSnapshotResult = Readonly<{
  completeText: string;
  maxBytes: number;
  snapshot: ComparableSnapshot;
  value: SnapshotData;
  view: "bounded" | "full";
}>;

type StagedSnapshotElement = Readonly<{
  key: string;
  release: () => Promise<void>;
}>;

type HelperSnapshotInput = Readonly<{
  options: JsonObject;
  root?: SnapshotRootToken;
  target: GenerationTargetId;
}>;

type SnapshotRef = Readonly<{
  dispose: () => Promise<void>;
  locatorProbe: () => Promise<LocatorProbe | undefined>;
  name: string;
  ownerGeneration: number;
  ref: string;
  releaseStaged: (key: string) => Promise<SnapshotStageReleaseResult>;
  role: string;
  stage: (key: string) => Promise<SnapshotStageResult>;
  targetId: string;
}>;

type LocatorRecipe = Readonly<{
  frameChain: readonly string[];
  frameChainSegments: readonly (readonly string[])[];
  selector: string;
  selectorSegments: readonly string[];
}>;

type LocatorProbe =
  | Readonly<{ boundary: "frame-unavailable" | "shadow-unavailable"; state: "unavailable" }>
  | Readonly<{ recipe: LocatorRecipe; state: "available" }>;

type StoredSnapshot = Readonly<{
  byIdentity: ReadonlyMap<string, SnapshotComparison>;
  ownerGeneration: number;
  ownerId: string;
  refs: ReadonlyMap<string, SnapshotRef>;
  snapshotId: string;
  targetId: string;
}>;

type SnapshotCaptureOptions = Readonly<{
  boxes: boolean;
  depth: number;
  root?: SnapshotRootToken;
}>;

type SnapshotCapture = Readonly<{
  refs: ReadonlyMap<string, RetainedSnapshotRef>;
  text: string;
}>;

type RetainedSnapshotRef = Readonly<{
  dispose: () => Promise<void>;
  identity: string;
  locatorProbe: () => Promise<LocatorProbe | undefined>;
  releaseStaged: (key: string) => Promise<SnapshotStageReleaseResult>;
  stage: (key: string) => Promise<SnapshotStageResult>;
}>;

type SnapshotStageResult = "child-frame" | "collision" | "detached" | "staged";
type SnapshotStageReleaseResult = "absent" | "failed" | "released" | "replaced";

const snapshotStageResult = (value: unknown): SnapshotStageResult => {
  if (value === "child-frame" || value === "collision" || value === "detached" || value === "staged") {
    return value;
  }
  throw new Error("Playwright snapshot element returned an invalid staging result");
};

const snapshotStageReleaseResult = (value: unknown): SnapshotStageReleaseResult => {
  if (value === "absent" || value === "failed" || value === "released" || value === "replaced") return value;
  throw new Error("Playwright snapshot element returned an invalid staging release result");
};

type SnapshotConnection = Readonly<{
  capture: (options: SnapshotCaptureOptions) => Promise<SnapshotCapture>;
  disconnect: () => Promise<void>;
}>;

type SnapshotConnector = (session: ChromePageSession, targetId: string) => Promise<SnapshotConnection>;

type SnapshotConnectionEntry = Readonly<{
  ownerGeneration: number;
  ownerId: string;
  promise: Promise<SnapshotConnection>;
}>;

type MediaEmulationConnection = Readonly<{
  disconnect: () => Promise<void>;
  emulateMedia: (targetId: string, options: JsonObject, signal: AbortSignal) => Promise<void>;
  releaseTarget: (targetId: string) => void;
}>;

type MediaEmulationEntry = Readonly<{
  ownerGeneration: number;
  ownerId: string;
  promise: Promise<MediaEmulationConnection>;
}>;

type AttachedTarget = Readonly<{
  detach: () => Promise<void>;
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  sessionId: string;
}>;

type PendingNetworkExchange = {
  monotonicStartedAt?: number;
  request: NetworkExchange["request"];
  response?: NetworkExchange["response"];
  target: Promise<Readonly<{ rootTargetId: string; targetId: string }>>;
};

type NetworkWatcher = {
  dispose: () => void;
  references: number;
};

type TraceConnection = {
  disconnect: () => Promise<void>;
  tracing: PlaywrightTracingAdapter;
};

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${label} did not return an object`);
  return value;
};

const attachTarget = async (session: ChromePageSession, targetId: string): Promise<AttachedTarget> => {
  const attached = requireRecord(
    await session.sendCdp("Target.attachToTarget", { flatten: true, targetId }),
    "Target.attachToTarget",
  );
  if (typeof attached.sessionId !== "string") {
    throw new TypeError("Target.attachToTarget did not return a session ID");
  }
  const sessionId = attached.sessionId;
  let detached = false;
  return {
    detach: async () => {
      if (detached) return;
      detached = true;
      await session.sendCdp("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    },
    send: (method, params = {}) => session.sendCdp(method, params, sessionId),
    sessionId,
  };
};

type BrowserDocument = BrowserRoot &
  Readonly<{
    defaultView: BrowserWindow | null;
  }>;

type BrowserElement = Readonly<{
  children: Iterable<BrowserElement>;
  getRootNode: () => BrowserRoot;
  id: string;
  isConnected: boolean;
  localName: string;
  ownerDocument: BrowserDocument;
  parentElement: BrowserElement | null;
}>;

type BrowserRoot = Readonly<{
  children: Iterable<BrowserElement>;
  host?: BrowserElement;
  mode?: string;
  querySelectorAll: (selector: string) => Readonly<{ length: number }>;
}>;

type BrowserWindow = Readonly<{
  frameElement: BrowserElement | null;
  top: BrowserWindow | null;
}>;

const selectorForElement = (start: BrowserElement) => {
  if (!start.isConnected) return undefined;
  const escapeCssIdentifier = (value: string) =>
    value.replace(/[^a-zA-Z0-9_-]/gu, (character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined ? "" : `\\${codePoint.toString(16)} `;
    });
  const segmentFor = (elementValue: BrowserElement, root: BrowserRoot) => {
    const parts: string[] = [];
    let element: BrowserElement | null = elementValue;
    while (element) {
      if (element.id) {
        const idSelector = `#${escapeCssIdentifier(element.id)}`;
        if (root.querySelectorAll(idSelector).length === 1) {
          parts.unshift(idSelector);
          break;
        }
      }

      const localName = element.localName;
      let part = localName;
      const parent: BrowserElement | null = element.parentElement;
      const container = parent ?? root;
      const siblings = [...container.children].filter((candidate) => candidate.localName === localName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(element) + 1})`;
      parts.unshift(part);
      element = parent;
    }
    return parts.join(" > ");
  };
  const recipeFor = (elementValue: BrowserElement) => {
    const segments: string[] = [];
    let element = elementValue;
    for (;;) {
      const root = element.getRootNode();
      if (root.host && root.mode !== "open") {
        return { boundary: "shadow-unavailable" as const };
      }
      const segment = segmentFor(element, root);
      if (!segment) return undefined;
      segments.unshift(segment);
      if (!root.host) break;
      element = root.host;
    }
    return {
      selector: segments.map((segment) => `css=${segment}`).join(" >> "),
      selectorSegments: segments,
    };
  };
  const leaf = recipeFor(start);
  if (!leaf || "boundary" in leaf) return leaf;
  const frameChain: string[] = [];
  const frameChainSegments: string[][] = [];
  try {
    let currentWindow = start.ownerDocument.defaultView;
    while (currentWindow?.frameElement) {
      const frameElement = currentWindow.frameElement;
      const frame = recipeFor(frameElement);
      if (!frame || "boundary" in frame) return frame ?? { boundary: "frame-unavailable" as const };
      frameChain.unshift(frame.selector);
      frameChainSegments.unshift(frame.selectorSegments);
      currentWindow = frameElement.ownerDocument.defaultView;
    }
  } catch {
    return { boundary: "frame-unavailable" as const };
  }
  return {
    frameChain,
    frameChainSegments,
    selector: leaf.selector,
    selectorSegments: leaf.selectorSegments,
  };
};

type AriaSnapshotOwner = Readonly<{
  ariaSnapshot: (options: Readonly<{ boxes: boolean; depth: number; mode: "ai" }>) => Promise<string>;
}>;

type SnapshotPage = AriaSnapshotOwner &
  Readonly<{
    locator: (selector: string) => unknown;
    onFrameDetached: (listener: (frame: object) => void) => () => void;
  }>;

type SnapshotLocator = AriaSnapshotOwner &
  Readonly<{
    count: () => Promise<number>;
    elementHandle: () => Promise<unknown>;
  }>;

type SnapshotElementHandle = Readonly<{
  handle: object;
  createIdentityRegistry: (prefix: string) => Promise<SnapshotIdentityRegistry>;
  dispose: () => Promise<void>;
  evaluate: (callback: (element: BrowserElement) => unknown) => Promise<unknown>;
  evaluateWithString: (
    callback: (element: BrowserElement, argument: string) => unknown,
    argument: string,
  ) => Promise<unknown>;
  ownerFrame: () => Promise<object>;
}>;

type SnapshotIdentityState = {
  document: BrowserDocument;
  identities: WeakMap<BrowserElement, number>;
  nextIdentity: number;
  prefix: string;
};

type SnapshotIdentityRegistry = Readonly<{
  dispose: () => Promise<void>;
  identityFor: (handle: object) => Promise<string | undefined>;
}>;

const createSnapshotIdentityState = (element: BrowserElement, prefix: string) => ({
  document: element.ownerDocument,
  identities: new WeakMap<BrowserElement, number>(),
  nextIdentity: 0,
  prefix,
});

const snapshotElementIdentity = (state: SnapshotIdentityState, element: BrowserElement) => {
  if (!element.isConnected) return null;
  if (state.document !== element.ownerDocument) return undefined;
  let identity = state.identities.get(element);
  if (identity === undefined) {
    identity = ++state.nextIdentity;
    state.identities.set(element, identity);
  }
  return `${state.prefix}:${identity}`;
};

const requireSnapshotIdentityRegistry = (value: unknown): SnapshotIdentityRegistry => {
  if (!isRecord(value) || typeof value.dispose !== "function" || typeof value.evaluate !== "function") {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_STALE_REF",
      "Playwright snapshot identity registry is unavailable",
    );
  }
  const dispose = value.dispose;
  const evaluate = value.evaluate;
  return {
    dispose: async () => Reflect.apply(dispose, value, []),
    identityFor: async (handle) => {
      const identity: unknown = await Reflect.apply(evaluate, value, [snapshotElementIdentity, handle]);
      if (identity === undefined || typeof identity === "string") return identity;
      if (identity === null) {
        throw new ChromeMcpExecutionError("CHROME_MCP_STALE_REF", "Snapshot element detached during capture");
      }
      throw new Error("Playwright snapshot returned an invalid comparison identity");
    },
  };
};

const requireAriaSnapshotOwner = (value: unknown, label: string): AriaSnapshotOwner => {
  if (!isRecord(value) || typeof value.ariaSnapshot !== "function") {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_BROWSER_DISCONNECTED",
      `${label} cannot capture ARIA snapshots`,
    );
  }
  const ariaSnapshot = value.ariaSnapshot;
  return {
    ariaSnapshot: async (options) => {
      const result: unknown = await Reflect.apply(ariaSnapshot, value, [options]);
      if (typeof result !== "string") throw new Error(`${label} returned an invalid ARIA snapshot`);
      return result;
    },
  };
};

const requireSnapshotPage = (value: unknown): SnapshotPage => {
  if (
    !isRecord(value) ||
    typeof value.locator !== "function" ||
    typeof value.on !== "function" ||
    typeof value.off !== "function"
  ) {
    throw new ChromeMcpExecutionError("CHROME_MCP_PAGE_CLOSED", "Playwright snapshot page is unavailable");
  }
  const owner = requireAriaSnapshotOwner(value, "Playwright page");
  const locator = value.locator;
  const on = value.on;
  const off = value.off;
  return {
    ...owner,
    locator: (selector) => Reflect.apply(locator, value, [selector]),
    onFrameDetached: (listener) => {
      Reflect.apply(on, value, ["framedetached", listener]);
      return () => Reflect.apply(off, value, ["framedetached", listener]);
    },
  };
};

const requireSnapshotLocator = (value: unknown): SnapshotLocator => {
  if (!isRecord(value) || typeof value.count !== "function" || typeof value.elementHandle !== "function") {
    throw new ChromeMcpExecutionError("CHROME_MCP_STALE_REF", "Playwright snapshot ref is unavailable");
  }
  const owner = requireAriaSnapshotOwner(value, "Playwright locator");
  const count = value.count;
  const elementHandle = value.elementHandle;
  return {
    ...owner,
    count: async () => Reflect.apply(count, value, []),
    elementHandle: async () => Reflect.apply(elementHandle, value, []),
  };
};

const requireSnapshotElementHandle = (value: unknown): SnapshotElementHandle => {
  if (
    !isRecord(value) ||
    typeof value.dispose !== "function" ||
    typeof value.evaluate !== "function" ||
    typeof value.evaluateHandle !== "function" ||
    typeof value.ownerFrame !== "function"
  ) {
    throw new ChromeMcpExecutionError("CHROME_MCP_STALE_REF", "Playwright snapshot element is unavailable");
  }
  const dispose = value.dispose;
  const evaluate = value.evaluate;
  const evaluateHandle = value.evaluateHandle;
  const ownerFrame = value.ownerFrame;
  return {
    handle: value,
    createIdentityRegistry: async (prefix) =>
      requireSnapshotIdentityRegistry(
        await Reflect.apply(evaluateHandle, value, [createSnapshotIdentityState, prefix]),
      ),
    dispose: async () => Reflect.apply(dispose, value, []),
    evaluate: async (callback) => Reflect.apply(evaluate, value, [callback]),
    evaluateWithString: async (callback, argument) => Reflect.apply(evaluate, value, [callback, argument]),
    ownerFrame: async () => {
      const frame: unknown = await Reflect.apply(ownerFrame, value, []);
      if (!isRecord(frame)) {
        throw new ChromeMcpExecutionError("CHROME_MCP_STALE_REF", "Snapshot element frame is unavailable");
      }
      return frame;
    },
  };
};

const stageSnapshotElement = (element: BrowserElement, key: string): SnapshotStageResult => {
  if (!element.isConnected) return "detached";
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) return "detached";
  if (ownerWindow.top !== ownerWindow) return "child-frame";
  if (Object.hasOwn(ownerWindow, key)) return "collision";
  Object.defineProperty(ownerWindow, key, {
    configurable: true,
    enumerable: false,
    value: element,
    writable: false,
  });
  return "staged";
};

const releaseStagedSnapshotElement = (element: BrowserElement, key: string): SnapshotStageReleaseResult => {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) return "absent";
  const descriptor = Object.getOwnPropertyDescriptor(ownerWindow, key);
  if (!descriptor) return "absent";
  if (descriptor.value !== element) return "replaced";
  return Reflect.deleteProperty(ownerWindow, key) ? "released" : "failed";
};

const isDestroyedSnapshotContextError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return [
    "Execution context was destroyed",
    "Frame was detached",
    "Target page, context or browser has been closed",
  ].some((message) => error.message.includes(message));
};

const locatorProbeFromValue = (value: unknown): LocatorProbe | undefined => {
  const result = isRecord(value) ? value : undefined;
  if (result?.boundary === "frame-unavailable" || result?.boundary === "shadow-unavailable") {
    return { boundary: result.boundary, state: "unavailable" };
  }
  if (
    typeof result?.selector !== "string" ||
    !Array.isArray(result.selectorSegments) ||
    !Array.isArray(result.frameChain) ||
    !Array.isArray(result.frameChainSegments)
  ) {
    return undefined;
  }
  const selectorSegments = result.selectorSegments.filter(
    (segment): segment is string => typeof segment === "string" && segment.length > 0,
  );
  const frameChain = result.frameChain.filter(
    (selector): selector is string => typeof selector === "string" && selector.length > 0,
  );
  if (
    selectorSegments.length !== result.selectorSegments.length ||
    frameChain.length !== result.frameChain.length
  ) {
    return undefined;
  }
  const frameChainSegments: string[][] = [];
  for (const valueSegments of result.frameChainSegments) {
    if (!Array.isArray(valueSegments)) return undefined;
    const segments = valueSegments.filter(
      (segment): segment is string => typeof segment === "string" && segment.length > 0,
    );
    if (segments.length === 0 || segments.length !== valueSegments.length) return undefined;
    frameChainSegments.push(segments);
  }
  if (
    result.selector.length === 0 ||
    selectorSegments.length === 0 ||
    frameChain.length !== frameChainSegments.length
  ) {
    return undefined;
  }
  return {
    recipe: { frameChain, frameChainSegments, selector: result.selector, selectorSegments },
    state: "available",
  };
};

const SNAPSHOT_REF_PATTERN = /\[ref=([^\]]+)\]/gu;

export const createChromeSnapshotConnection = (pageValue: unknown, disconnect: () => Promise<void>) => {
  const page = requireSnapshotPage(pageValue);
  const documentChangedMessage = "Snapshot document changed during capture";
  const identities = new Map<
    object,
    {
      promise: Promise<SnapshotIdentityRegistry>;
      dispose: () => Promise<void>;
    }
  >();
  let disconnected = false;
  const removeFrameListener = page.onFrameDetached((frame) => {
    const entry = identities.get(frame);
    identities.delete(frame);
    if (entry) entry.dispose();
  });
  const registryFor = async (frame: object, handle: SnapshotElementHandle) => {
    if (disconnected) {
      throw new ChromeMcpExecutionError("CHROME_MCP_STALE_REF", documentChangedMessage);
    }
    let entry = identities.get(frame);
    if (!entry) {
      const promise = handle.createIdentityRegistry(randomUUID());
      let disposal: Promise<void> | undefined;
      entry = {
        promise,
        dispose: () => (disposal ??= promise.then((registry) => registry.dispose())),
      };
      identities.set(frame, entry);
    }
    try {
      const registry = await entry.promise;
      if (identities.get(frame) !== entry) {
        throw new ChromeMcpExecutionError("CHROME_MCP_STALE_REF", documentChangedMessage);
      }
      return { entry, registry };
    } catch (error: unknown) {
      if (identities.get(frame) === entry) identities.delete(frame);
      throw error;
    }
  };
  const identityFor = async (handle: SnapshotElementHandle) => {
    const frame = await handle.ownerFrame();
    const previous = identities.get(frame);
    if (previous) {
      try {
        const { registry } = await registryFor(frame, handle);
        const identity = await registry.identityFor(handle.handle);
        if (identity !== undefined && identities.get(frame) === previous) return identity;
      } catch (error: unknown) {
        const documentChanged =
          isDestroyedSnapshotContextError(error) ||
          (error instanceof Error &&
            error.message.includes("Unable to adopt element handle from a different document"));
        if (!documentChanged) throw error;
      }
      if (identities.get(frame) === previous) {
        identities.delete(frame);
        await previous.dispose();
      }
    }
    const { entry, registry } = await registryFor(frame, handle);
    const identity = await registry.identityFor(handle.handle);
    if (identity === undefined || identities.get(frame) !== entry) {
      throw new ChromeMcpExecutionError("CHROME_MCP_STALE_REF", documentChangedMessage);
    }
    return identity;
  };
  return {
    capture: async (options: SnapshotCaptureOptions) => {
      const owner =
        options.root ?
          requireSnapshotLocator(
            page.locator(`[${options.root.attributeName}=${JSON.stringify(options.root.attributeValue)}]`),
          )
        : page;
      const text = await owner.ariaSnapshot({ boxes: options.boxes, depth: options.depth, mode: "ai" });
      const refs = new Map<string, RetainedSnapshotRef>();
      try {
        for (const match of text.matchAll(SNAPSHOT_REF_PATTERN)) {
          const nativeRef = match[1];
          if (!nativeRef || refs.has(nativeRef)) continue;
          const locator = requireSnapshotLocator(page.locator(`aria-ref=${nativeRef}`));
          if ((await locator.count()) !== 1) continue;
          const handle = requireSnapshotElementHandle(await locator.elementHandle());
          let identity: string;
          try {
            identity = await identityFor(handle);
          } catch (error: unknown) {
            await handle.dispose();
            throw error;
          }
          refs.set(nativeRef, {
            dispose: handle.dispose,
            identity,
            locatorProbe: async () => locatorProbeFromValue(await handle.evaluate(selectorForElement)),
            releaseStaged: async (key) =>
              snapshotStageReleaseResult(await handle.evaluateWithString(releaseStagedSnapshotElement, key)),
            stage: async (key) =>
              snapshotStageResult(await handle.evaluateWithString(stageSnapshotElement, key)),
          });
        }
        return { refs, text };
      } catch (error: unknown) {
        await Promise.all([...refs.values()].map((ref) => ref.dispose().catch(() => undefined)));
        throw error;
      }
    },
    disconnect: async () => {
      disconnected = true;
      removeFrameListener();
      const entries = [...identities.values()];
      identities.clear();
      try {
        await Promise.all(entries.map((entry) => entry.dispose()));
      } finally {
        await disconnect();
      }
    },
  };
};

const createOwnerGenerationKey = (ownerId: string, ownerGeneration: number) =>
  `${ownerId}\0${ownerGeneration}`;

const createSessionScopeKey = (session: ChromePageSession) => {
  return `${session.connectionId}\0${session.browserMode}\0${session.ownerId}\0${session.ownerGeneration}`;
};

const isConnectionScopeKey = (key: string, connectionId: string) => key.startsWith(`${connectionId}\0`);

const connectAuxiliaryBrowserSession = async (session: ChromePageSession, targetId: string) => {
  const worker = await session.workerConnection();

  return connectExecutionBrowserSession(
    {
      browserMode: session.browserMode,
      cdpEndpoint: worker.endpoint,
      connectTimeoutMs: AUXILIARY_CONNECT_TIMEOUT_MS,
      selectedTargetId: targetId,
    },
    { dialogHandling: "preserve" },
  );
};

const connectSnapshot = async (session: ChromePageSession, targetId: string): Promise<SnapshotConnection> => {
  const connected = await connectAuxiliaryBrowserSession(session, targetId);

  try {
    return createChromeSnapshotConnection(connected.page, connected.disconnect);
  } catch (error: unknown) {
    await connected.disconnect().catch(() => undefined);
    throw error;
  }
};

const snapshotOptions = (options: JsonObject) => {
  const depth = typeof options.depth === "number" ? options.depth : SNAPSHOT_DEFAULT_DEPTH;
  const includeBoxes = options.includeBoxes === true;
  const maxBytes = typeof options.maxBytes === "number" ? options.maxBytes : SNAPSHOT_DEFAULT_MAX_BYTES;
  const diffFrom = typeof options.diffFrom === "string" ? options.diffFrom : undefined;
  const view: HelperSnapshotResult["view"] = options.view === "full" ? "full" : "bounded";
  return { depth, diffFrom, includeBoxes, maxBytes, view };
};

export const formatSnapshotResult = (snapshot: HelperSnapshotResult, artifacts: SnapshotArtifacts = {}) => {
  const data = snapshot.value;
  const treeLines = data.tree ? data.tree.split("\n") : [];
  const totals: SnapshotCounts = {
    treeLines: treeLines.length,
    refs: Object.keys(data.refs).length,
    added: data.added?.length ?? 0,
    changed: data.changed?.length ?? 0,
    removed: data.removed?.length ?? 0,
  };
  if (snapshot.view === "full") {
    const result: SnapshotViewResult = {
      ...data,
      ...artifacts,
      view: "full",
      totals,
      omitted: { treeLines: 0, refs: 0, added: 0, changed: 0, removed: 0, metadataFields: [] },
      omissionReason: null,
    };
    return result;
  }
  const changes: { added: string[]; changed: string[]; removed: string[] } = {
    added: [],
    changed: [],
    removed: [],
  };
  const result: SnapshotViewResult = {
    snapshotId: data.snapshotId,
    targetId: data.targetId,
    capturedAt: data.capturedAt,
    view: "bounded",
    refs: {},
    ...(data.tree === undefined ? changes : { tree: "" }),
    ...artifacts,
    totals,
    omitted: { ...totals, metadataFields: ["url", "title"] },
    omissionReason: null,
  };
  const displayedTree: string[] = [];
  let retainedBytes = jsonByteLength({ ...result, omitted: {} }) - 2;
  const omissionReasonBytes = jsonByteLength("maxBytes") - jsonByteLength(null);
  const budgetError = "Snapshot metadata and artifact links exceed maxBytes";
  const fits = () => {
    const omitted = result.omitted;
    result.omissionReason =
      (
        omitted.treeLines +
          omitted.refs +
          omitted.added +
          omitted.changed +
          omitted.removed +
          omitted.metadataFields.length >
        0
      ) ?
        "maxBytes"
      : null;
    return (
      retainedBytes + jsonByteLength(omitted) + (result.omissionReason === null ? 0 : omissionReasonBytes) <=
      snapshot.maxBytes
    );
  };
  for (const key of ["url", "title"] as const) {
    const metadataBytes = jsonByteLength(key) + jsonByteLength(data[key]) + 2;
    result[key] = data[key];
    retainedBytes += metadataBytes;
    result.omitted.metadataFields = result.omitted.metadataFields.filter((field) => field !== key);
    if (fits()) continue;
    delete result[key];
    retainedBytes -= metadataBytes;
    result.omitted.metadataFields.push(key);
  }
  if (!fits()) {
    throw new ChromeMcpExecutionError("CHROME_MCP_INVALID_INPUT", budgetError);
  }
  const append = (text: string, kind: "added" | "changed" | "removed" | "treeLines") => {
    const previousBytes = retainedBytes;
    const addedRefs: string[] = [];
    for (const match of text.matchAll(/(?:^|\s)ref=([^\s:]+)/gu)) {
      const ref = match[1];
      if (!ref || result.refs[ref]) continue;
      const metadata = data.refs[ref];
      if (!metadata) continue;
      retainedBytes +=
        jsonByteLength(ref) + jsonByteLength(metadata) + 1 + (totals.refs === result.omitted.refs ? 0 : 1);
      result.refs[ref] = metadata;
      result.omitted.refs -= 1;
      addedRefs.push(ref);
    }
    if (kind === "treeLines") {
      retainedBytes += jsonByteLength(text) - 2 + (displayedTree.length === 0 ? 0 : 2);
      displayedTree.push(text);
    } else {
      retainedBytes += jsonByteLength(text) + (changes[kind].length === 0 ? 0 : 1);
      changes[kind].push(text);
    }
    result.omitted[kind] -= 1;
    if (fits()) return true;
    if (kind === "treeLines") displayedTree.pop();
    else changes[kind].pop();
    retainedBytes = previousBytes;
    result.omitted[kind] += 1;
    for (const ref of addedRefs) delete result.refs[ref];
    result.omitted.refs += addedRefs.length;
    fits();
    return false;
  };
  if (data.tree === undefined) {
    const kinds = ["added", "changed", "removed"] as const;
    const stopped = new Set<(typeof kinds)[number]>();
    let advanced = true;
    while (advanced) {
      advanced = false;
      for (const kind of kinds) {
        if (stopped.has(kind)) continue;
        const text = data[kind]?.[changes[kind].length];
        if (text === undefined || !append(text, kind)) stopped.add(kind);
        else advanced = true;
      }
    }
  } else {
    for (const line of treeLines) {
      if (!append(line, "treeLines")) break;
    }

    result.tree = displayedTree.join("\n");
  }
  if (jsonByteLength(result) > snapshot.maxBytes) {
    throw new ChromeMcpExecutionError("CHROME_MCP_INVALID_INPUT", budgetError);
  }
  return result;
};
const SNAPSHOT_REF_PATTERN_AUTHENTICATED = /^s([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{22})$/u;
const SNAPSHOT_REF_SIGNATURE_BYTES = 16;

type SnapshotRefProvenance = Readonly<{
  browserMode: string;
  element: number;
  ownerGeneration: number;
  sequence: number;
  targetId: string;
}>;

const encodeSnapshotRef = (provenance: SnapshotRefProvenance, key: Buffer): string => {
  const payload = Buffer.from(
    JSON.stringify([
      provenance.browserMode,
      provenance.ownerGeneration,
      provenance.targetId,
      provenance.sequence,
      provenance.element,
    ]),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(payload)
    .digest()
    .subarray(0, SNAPSHOT_REF_SIGNATURE_BYTES)
    .toString("base64url");
  return `s${payload}.${signature}`;
};

const decodeSnapshotRef = (ref: string, key: Buffer): SnapshotRefProvenance | undefined => {
  const match = SNAPSHOT_REF_PATTERN_AUTHENTICATED.exec(ref);
  const payload = match?.[1];
  const signatureValue = match?.[2];
  if (!payload || !signatureValue) return undefined;
  const signature = Buffer.from(signatureValue, "base64url");
  if (signature.toString("base64url") !== signatureValue) return undefined;
  const expected = createHmac("sha256", key)
    .update(payload)
    .digest()
    .subarray(0, SNAPSHOT_REF_SIGNATURE_BYTES);
  if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    typeof value[0] !== "string" ||
    !Number.isSafeInteger(value[1]) ||
    typeof value[2] !== "string" ||
    !Number.isSafeInteger(value[3]) ||
    !Number.isSafeInteger(value[4])
  ) {
    return undefined;
  }
  return {
    browserMode: value[0],
    ownerGeneration: Number(value[1]),
    targetId: value[2],
    sequence: Number(value[3]),
    element: Number(value[4]),
  };
};

const snapshotLineMetadata = (line: string): Readonly<{ name: string; role: string }> => {
  const content = line.trimStart();
  const role = /^-\s+([^\s:]+)/u.exec(content)?.[1] ?? "generic";
  const nameLiteral = /^-\s+[^\s:]+\s+("(?:\\.|[^"])*")/u.exec(content)?.[1];
  if (!nameLiteral) return { name: "", role };
  try {
    const name: unknown = JSON.parse(nameLiteral);
    return { name: typeof name === "string" ? name : "", role };
  } catch {
    return { name: "", role };
  }
};

const localizeSnapshot = (
  input: Readonly<{
    identityPrefix: string;
    issueRef: (element: number) => string;
    ownerGeneration: number;
    retainedRefs: ReadonlyMap<string, RetainedSnapshotRef>;
    targetId: string;
    text: string;
  }>,
) => {
  const refs = new Map<string, SnapshotRef>();
  const byIdentity = new Map<string, SnapshotComparison>();
  const byNativeRef = new Map<string, SnapshotRef>();
  const snapshotLines: CompactSnapshotLine[] = [];
  const lines = input.text.split("\n").map((line) => {
    const metadata = snapshotLineMetadata(line);
    const localized = line.replace(SNAPSHOT_REF_PATTERN, (_match, nativeRefValue: string) => {
      const retained = input.retainedRefs.get(nativeRefValue);
      if (!retained) return "";
      let ref = byNativeRef.get(nativeRefValue);
      if (!ref) {
        const localRef = input.issueRef(refs.size + 1);
        ref = Object.freeze({
          dispose: retained.dispose,
          locatorProbe: retained.locatorProbe,
          name: metadata.name,
          ownerGeneration: input.ownerGeneration,
          ref: localRef,
          releaseStaged: retained.releaseStaged,
          role: metadata.role,
          stage: retained.stage,
          targetId: input.targetId,
        });
        byNativeRef.set(nativeRefValue, ref);
        refs.set(localRef, ref);
      }
      return `ref=${ref.ref}`;
    });
    let lineRef: string | undefined;
    for (const nativeRef of line.matchAll(SNAPSHOT_REF_PATTERN)) {
      const nativeId = nativeRef[1];
      if (!nativeId) continue;
      const ref = byNativeRef.get(nativeId);
      const retained = input.retainedRefs.get(nativeId);
      if (!ref || !retained) continue;
      lineRef ??= ref.ref;
      byIdentity.set(`${input.identityPrefix}\0${retained.identity}`, {
        comparisonText: JSON.stringify([metadata.name, line.replace(SNAPSHOT_REF_PATTERN, "")]),
        ref: ref.ref,
        text: localized,
      });
    }
    if (localized) snapshotLines.push(lineRef ? { ref: lineRef, text: localized } : { text: localized });
    return localized;
  });
  return { byIdentity, refs, snapshotLines, text: lines.join("\n") };
};

const storageCookies = (value: unknown): StorageCookie[] => {
  const response = isRecord(value) ? value : undefined;
  if (!Array.isArray(response?.cookies)) return [];
  const cookies: StorageCookie[] = [];
  for (const item of response.cookies) {
    const cookie = isRecord(item) ? item : undefined;
    if (
      !cookie ||
      typeof cookie.name !== "string" ||
      typeof cookie.value !== "string" ||
      typeof cookie.domain !== "string" ||
      typeof cookie.path !== "string"
    ) {
      continue;
    }
    cookies.push({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      ...(typeof cookie.expires === "number" ? { expires: cookie.expires } : {}),
      ...(typeof cookie.httpOnly === "boolean" ? { httpOnly: cookie.httpOnly } : {}),
      ...(typeof cookie.secure === "boolean" ? { secure: cookie.secure } : {}),
      ...(typeof cookie.sameSite === "string" ? { sameSite: cookie.sameSite } : {}),
    });
  }
  return cookies;
};

const networkHeaders = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (
      typeof headerValue === "string" ||
      typeof headerValue === "number" ||
      typeof headerValue === "boolean"
    ) {
      headers[name.toLowerCase()] = String(headerValue);
    }
  }
  return Object.keys(headers).length === 0 ? undefined : headers;
};

const wallTime = (seconds: unknown): string => {
  if (typeof seconds === "number" && Number.isFinite(seconds)) {
    const milliseconds = seconds * 1000;
    if (milliseconds >= -8_640_000_000_000_000 && milliseconds <= 8_640_000_000_000_000) {
      return new Date(milliseconds).toISOString();
    }
  }
  return new Date().toISOString();
};

const completedWallTime = (startedAt: string, started: number | undefined, completed: unknown): string => {
  if (started !== undefined && typeof completed === "number" && Number.isFinite(completed)) {
    const value = Date.parse(startedAt) + Math.max(0, completed - started) * 1000;
    if (Number.isFinite(value) && value <= 8_640_000_000_000_000) return new Date(value).toISOString();
  }
  return new Date().toISOString();
};

const tracingFromContext = (value: unknown): PlaywrightTracingAdapter => {
  if (!isRecord(value) || !isRecord(value.tracing)) {
    throw new ChromeMcpExecutionError("CHROME_MCP_BROWSER_DISCONNECTED", "Playwright tracing is unavailable");
  }
  const tracing = value.tracing;
  const start = tracing.start;
  const stop = tracing.stop;
  if (typeof start !== "function" || typeof stop !== "function") {
    throw new ChromeMcpExecutionError("CHROME_MCP_BROWSER_DISCONNECTED", "Playwright tracing is unavailable");
  }
  return {
    start: async (options) => {
      await Reflect.apply(start, tracing, [options]);
    },
    stop: async (options) => {
      await Reflect.apply(stop, tracing, [options]);
    },
  };
};

const connectMediaEmulation = async (
  session: ChromePageSession,
  targetId: string,
): Promise<MediaEmulationConnection> => {
  const connected = await connectAuxiliaryBrowserSession(session, targetId);
  const pages = new Map<string, (options: JsonObject) => Promise<void>>();
  const pendingPages = new Set<{ targetId: string; cancellation: AbortController }>();
  const retainPage = (page: unknown, pageTargetId: string) => {
    if (!isRecord(page) || typeof page.emulateMedia !== "function" || typeof page.once !== "function") {
      throw new Error("Playwright page media emulation is unavailable");
    }
    const emulateMedia = page.emulateMedia;
    const applyMedia = async (options: JsonObject) => {
      await Reflect.apply(emulateMedia, page, [options]);
    };
    page.once("close", () => pages.delete(pageTargetId));
    pages.set(pageTargetId, applyMedia);
    return applyMedia;
  };
  try {
    retainPage(connected.page, targetId);
    return {
      disconnect: connected.disconnect,
      emulateMedia: async (pageTargetId, options, signal) => {
        signal.throwIfAborted();
        let emulateMedia = pages.get(pageTargetId);
        if (!emulateMedia) {
          const pending = { targetId: pageTargetId, cancellation: new AbortController() };
          pendingPages.add(pending);
          try {
            if (!(await session.targetRecord(pageTargetId))) {
              throw new ChromeMcpExecutionError("CHROME_MCP_PAGE_CLOSED", MEDIA_EMULATION_PAGE_CLOSED);
            }
            const page = await connected.pageForTarget(
              pageTargetId,
              AbortSignal.any([signal, pending.cancellation.signal]),
            );
            emulateMedia = retainPage(page, pageTargetId);
          } finally {
            pendingPages.delete(pending);
          }
        }
        signal.throwIfAborted();
        await emulateMedia(options);
      },
      releaseTarget: (pageTargetId) => {
        for (const pending of pendingPages) {
          if (pending.targetId === pageTargetId) {
            pending.cancellation.abort(
              new ChromeMcpExecutionError("CHROME_MCP_PAGE_CLOSED", MEDIA_EMULATION_PAGE_CLOSED),
            );
          }
        }
        pages.delete(pageTargetId);
      },
    };
  } catch (error: unknown) {
    await connected.disconnect();
    throw error;
  }
};

const connectTrace = async (session: ChromePageSession): Promise<TraceConnection> => {
  const selected = session.currentTarget();
  const connected = await connectAuxiliaryBrowserSession(session, selected.targetId);

  try {
    return { disconnect: connected.disconnect, tracing: tracingFromContext(connected.context) };
  } catch (error: unknown) {
    await connected.disconnect().catch(() => undefined);
    throw error;
  }
};

const createSnapshotKey = (session: ChromePageSession, targetId: string): string => {
  return `${createSessionScopeKey(session)}\0${targetId}`;
};

const disposeSnapshot = async (snapshot: StoredSnapshot): Promise<void> => {
  await Promise.all([...snapshot.refs.values()].map((ref) => ref.dispose().catch(() => undefined)));
};

export class ChromePageAdapter
  implements CdpSessionFactory, CheckpointRuntimeAdapter, PlaywrightTracingResolver
{
  readonly #connectSnapshot: SnapshotConnector;
  readonly #mediaConnections = new Map<string, MediaEmulationEntry>();
  readonly #networkWatchers = new Map<string, NetworkWatcher>();
  readonly #resolveContext: (contextId: string) => ChromePageSession;
  readonly #resolveScope: (scope: CaptureScope) => ChromePageSession;
  readonly #resolveTarget: (targetId: string) => Promise<ChromePageSession>;
  readonly #snapshotConnections = new Map<string, SnapshotConnectionEntry>();
  readonly #snapshotRefKeys = new Map<string, Buffer>();
  readonly #snapshots = new Map<string, StoredSnapshot[]>();
  readonly #traceConnections = new Map<string, Promise<TraceConnection>>();
  #snapshotSequence = 0;

  constructor(options: ChromePageAdapterOptions) {
    this.#connectSnapshot = options.connectSnapshot ?? connectSnapshot;
    this.#resolveContext = options.resolveContext;
    this.#resolveScope = options.resolveScope;
    this.#resolveTarget = options.resolveTarget;
  }

  async attach(targetId: string): Promise<CdpSessionAdapter> {
    const session = await this.#resolveTarget(targetId);
    const attached = await attachTarget(session, targetId);
    const listeners = new Map<(frame: ScreencastFrame) => void, () => void>();
    return {
      detach: async () => {
        for (const remove of listeners.values()) remove();
        listeners.clear();
        await attached.detach();
      },
      off: (_event, listener) => {
        listeners.get(listener)?.();
        listeners.delete(listener);
      },
      on: (event, listener) => {
        const remove = session.onCdp(event, (payload, incomingSessionId) => {
          if (incomingSessionId !== attached.sessionId || !isRecord(payload)) return;
          if (typeof payload.data !== "string" || typeof payload.sessionId !== "number") return;
          listener({ data: payload.data, sessionId: payload.sessionId });
        });
        listeners.get(listener)?.();
        listeners.set(listener, remove);
      },
      send: attached.send,
    };
  }

  async tracing(contextId: string): Promise<PlaywrightTracingAdapter> {
    const session = this.#resolveContext(contextId);
    const key = createOwnerGenerationKey(contextId, session.ownerGeneration);
    let connection = this.#traceConnections.get(key);
    if (!connection) {
      connection = connectTrace(session);
      this.#traceConnections.set(key, connection);
      connection.catch(() => {
        if (this.#traceConnections.get(key) === connection) this.#traceConnections.delete(key);
      });
    }

    const traceConnection = await connection;

    return traceConnection.tracing;
  }

  async emulateMedia(
    session: ChromePageSession,
    input: { targetId: string; options: JsonObject; signal: AbortSignal },
  ) {
    const { targetId, options, signal } = input;
    signal.throwIfAborted();
    if (!(await session.targetRecord(targetId))) {
      throw new ChromeMcpExecutionError("CHROME_MCP_PAGE_CLOSED", MEDIA_EMULATION_PAGE_CLOSED);
    }
    const key = createSessionScopeKey(session);
    let entry = this.#mediaConnections.get(key);
    if (!entry) {
      const promise = connectMediaEmulation(session, targetId);
      entry = { ownerGeneration: session.ownerGeneration, ownerId: session.ownerId, promise };
      this.#mediaConnections.set(key, entry);
      promise.catch(() => {
        if (this.#mediaConnections.get(key)?.promise === promise) this.#mediaConnections.delete(key);
      });
    }

    const mediaConnection = await entry.promise;
    await mediaConnection.emulateMedia(targetId, options, signal);
  }

  watchNetwork(session: ChromePageSession, record: (exchange: NetworkExchange) => void): () => void {
    const watcherKey = createOwnerGenerationKey(session.ownerId, session.ownerGeneration);
    const existing = this.#networkWatchers.get(watcherKey);
    if (existing) {
      existing.references += 1;
      return this.#networkWatcherRelease(watcherKey, existing);
    }

    const pending = new Map<string, PendingNetworkExchange>();
    const targets = new Map<string, Promise<Readonly<{ rootTargetId: string; targetId: string }>>>();
    let disposed = false;
    const requestKey = (sessionId: string, requestId: string) => `${sessionId}\0${requestId}`;
    const targetForSession = (sessionId: string) => {
      let target = targets.get(sessionId);
      if (!target) {
        target = session.sendCdp("Target.getTargetInfo", {}, sessionId).then(async (value) => {
          const targetInfo = isRecord(value) && isRecord(value.targetInfo) ? value.targetInfo : undefined;
          if (typeof targetInfo?.targetId !== "string" || targetInfo.targetId.length === 0) {
            throw new Error("Target.getTargetInfo did not return the network target ID");
          }
          const targetId = targetInfo.targetId;
          let rootTargetId = targetId;
          let parentId = typeof targetInfo.parentId === "string" ? targetInfo.parentId : undefined;
          const visited = new Set<string>([targetId]);
          while (parentId && !visited.has(parentId)) {
            visited.add(parentId);
            rootTargetId = parentId;
            const parent = await session.sendCdp("Target.getTargetInfo", { targetId: parentId });
            const parentInfo =
              isRecord(parent) && isRecord(parent.targetInfo) ? parent.targetInfo : undefined;
            if (typeof parentInfo?.targetId !== "string" || parentInfo.targetId !== parentId) break;
            parentId = typeof parentInfo.parentId === "string" ? parentInfo.parentId : undefined;
          }
          return { rootTargetId, targetId };
        });
        targets.set(sessionId, target);
        target.catch(() => targets.delete(sessionId));
      }
      return target;
    };
    const complete = (payload: unknown, sessionId: string | undefined, failure: boolean) => {
      if (!sessionId || !isRecord(payload) || typeof payload.requestId !== "string") return;
      const key = requestKey(sessionId, payload.requestId);
      const exchange = pending.get(key);
      if (!exchange) return;
      pending.delete(key);
      const response =
        exchange.response ?
          {
            ...exchange.response,
            ...(typeof payload.encodedDataLength === "number" ? { bodySize: payload.encodedDataLength } : {}),
            completedAt: completedWallTime(
              exchange.request.startedAt,
              exchange.monotonicStartedAt,
              payload.timestamp,
            ),
          }
        : undefined;
      Promise.all([session.currentEventCursor(), exchange.target])
        .then(([cursor, { rootTargetId, targetId }]) => {
          if (disposed) return;
          record({
            browserGeneration: session.ownerGeneration,
            browserMode: session.browserMode,
            connectionId: session.connectionId,
            contextId: session.ownerId,
            ...(failure && typeof payload.errorText === "string" ? { failureText: payload.errorText } : {}),
            ...(response ?
              {
                loadBody: async (signal) => {
                  if (signal.aborted) throw signal.reason;
                  const bodyResult = await session.sendCdp(
                    "Network.getResponseBody",
                    { requestId: exchange.request.requestId },
                    sessionId,
                  );
                  if (!isRecord(bodyResult) || typeof bodyResult.body !== "string") return undefined;
                  return {
                    bytes: Buffer.from(
                      bodyResult.body,
                      bodyResult.base64Encoded === true ? "base64" : "utf8",
                    ),
                    ...(response.mediaType === undefined ? {} : { mediaType: response.mediaType }),
                  };
                },
                response,
              }
            : {}),
            request: exchange.request,
            rootTargetId,
            sequence: cursor.sequence,
            targetId,
          });
        })
        .catch(() => undefined);
    };

    const removeListeners = [
      session.onCdp("Network.requestWillBeSent", (payload, sessionId) => {
        if (!sessionId || !isRecord(payload) || !isRecord(payload.request)) return;
        const request = payload.request;
        if (
          typeof payload.requestId !== "string" ||
          typeof request.url !== "string" ||
          typeof request.method !== "string"
        ) {
          return;
        }
        pending.set(requestKey(sessionId, payload.requestId), {
          ...(typeof payload.timestamp === "number" ? { monotonicStartedAt: payload.timestamp } : {}),
          request: {
            headers: networkHeaders(request.headers),
            method: request.method,
            ...(typeof request.postData === "string" ? { postData: request.postData } : {}),
            requestId: payload.requestId,
            startedAt: wallTime(payload.wallTime),
            url: request.url,
          },
          target: targetForSession(sessionId),
        });
      }),
      session.onCdp("Network.responseReceived", (payload, sessionId) => {
        if (
          !sessionId ||
          !isRecord(payload) ||
          !isRecord(payload.response) ||
          typeof payload.requestId !== "string"
        ) {
          return;
        }
        const exchange = pending.get(requestKey(sessionId, payload.requestId));
        const response = payload.response;
        if (!exchange || typeof response.status !== "number") return;
        exchange.response = {
          ...(typeof response.encodedDataLength === "number" ? { bodySize: response.encodedDataLength } : {}),
          completedAt: completedWallTime(
            exchange.request.startedAt,
            exchange.monotonicStartedAt,
            payload.timestamp,
          ),
          headers: networkHeaders(response.headers),
          ...(typeof response.mimeType === "string" ? { mediaType: response.mimeType } : {}),
          ...(typeof response.protocol === "string" ? { httpVersion: response.protocol } : {}),
          ...(typeof response.remoteIPAddress === "string" && typeof response.remotePort === "number" ?
            { remoteAddress: { ip: response.remoteIPAddress, port: response.remotePort } }
          : {}),
          status: response.status,
          ...(typeof response.statusText === "string" ? { statusText: response.statusText } : {}),
        };
      }),
      session.onCdp("Network.loadingFinished", (payload, sessionId) => complete(payload, sessionId, false)),
      session.onCdp("Network.loadingFailed", (payload, sessionId) => complete(payload, sessionId, true)),
    ];
    const watcher: NetworkWatcher = {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const remove of removeListeners) remove();
        pending.clear();
        targets.clear();
      },
      references: 1,
    };
    this.#networkWatchers.set(watcherKey, watcher);
    return this.#networkWatcherRelease(watcherKey, watcher);
  }

  async snapshotForHelper(
    session: ChromePageSession,
    input: HelperSnapshotInput,
  ): Promise<HelperSnapshotResult> {
    const selected = input.target;
    if (!(await session.targetRecord(selected.targetId))) {
      await this.releaseTarget(session, selected.targetId);
      throw new ChromeMcpExecutionError("CHROME_MCP_PAGE_CLOSED", "The selected page is closed");
    }
    const parsed = snapshotOptions(input.options);
    const diffBase = parsed.diffFrom ? this.#snapshotById(session, parsed.diffFrom) : undefined;
    if (parsed.diffFrom && !diffBase) {
      throw new ChromeMcpExecutionError("CHROME_MCP_UNKNOWN_REF", `Unknown snapshot ${parsed.diffFrom}`);
    }
    if (diffBase && diffBase.targetId !== selected.targetId) {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_SNAPSHOT_TARGET_MISMATCH",
        "Snapshot diff target does not match the selected page",
      );
    }
    const connection = await this.#snapshotConnection(session, selected.targetId);
    const sequence = ++this.#snapshotSequence;
    const capture = await connection.capture({
      boxes: parsed.includeBoxes,
      depth: parsed.depth,
      ...(input.root ? { root: input.root } : {}),
    });
    const targetRecord = await session.targetRecord(selected.targetId);
    if (!targetRecord) {
      await Promise.all([...capture.refs.values()].map((ref) => ref.dispose().catch(() => undefined)));
      await this.releaseTarget(session, selected.targetId);
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_PAGE_CLOSED",
        "The selected page closed during the snapshot",
      );
    }
    const localized = localizeSnapshot({
      identityPrefix: createSnapshotKey(session, selected.targetId),
      issueRef: (element) =>
        encodeSnapshotRef(
          {
            browserMode: session.browserMode,
            element,
            ownerGeneration: session.ownerGeneration,
            sequence,
            targetId: selected.targetId,
          },
          this.#snapshotRefKey(session.connectionId),
        ),
      ownerGeneration: session.ownerGeneration,
      retainedRefs: capture.refs,
      targetId: selected.targetId,
      text: capture.text,
    });
    const snapshotId = `snapshot_${sequence}_${randomUUID().replaceAll("-", "")}`;
    const key = createSnapshotKey(session, selected.targetId);
    const prior = this.#snapshots.get(key) ?? [];
    const stored = Object.freeze({
      byIdentity: localized.byIdentity,
      ownerGeneration: session.ownerGeneration,
      ownerId: session.ownerId,
      refs: localized.refs,
      snapshotId,
      targetId: selected.targetId,
    });
    const snapshot: ComparableSnapshot = {
      byIdentity: localized.byIdentity,
      snapshot: { snapshotId, text: localized.text, lines: localized.snapshotLines },
    };
    const value: SnapshotData = {
      snapshotId,
      targetId: selected.targetId,
      url: targetRecord.url,
      title: targetRecord.title ?? "",
      capturedAt: new Date().toISOString(),
      refs: Object.fromEntries(
        [...localized.refs.values()].map((item) => [item.ref, { name: item.name, role: item.role }]),
      ),
    };

    let completeText = localized.text;
    if (diffBase) {
      const added: string[] = [];
      const removed: string[] = [];
      const changed: string[] = [];
      for (const [identity, current] of localized.byIdentity) {
        const before = diffBase.byIdentity.get(identity);
        if (!before) added.push(current.text);
        else if (before.comparisonText !== current.comparisonText) {
          changed.push(`${before.text} => ${current.text}`);
        }
      }
      for (const [identity, before] of diffBase.byIdentity) {
        if (!localized.byIdentity.has(identity)) removed.push(before.text);
      }
      value.added = added;
      value.removed = removed;
      value.changed = changed;
      completeText = JSON.stringify({ added, changed, removed });
    } else {
      value.tree = localized.text;
    }
    const evicted = prior.slice(0, 1 - SNAPSHOT_RETAINED_COUNT);
    this.#snapshots.set(key, [...prior.slice(1 - SNAPSHOT_RETAINED_COUNT), stored]);
    for (const evictedSnapshot of evicted) disposeSnapshot(evictedSnapshot).catch(() => undefined);

    return { completeText, maxBytes: parsed.maxBytes, snapshot, value, view: parsed.view };
  }

  async stageSnapshotElement(
    session: ChromePageSession,
    selected: GenerationTargetId,
    ref: string,
  ): Promise<StagedSnapshotElement> {
    const record = await this.#snapshotRef(session, selected, ref);
    const key = `${REACT_STAGED_NODE_KEY_PREFIX}${randomBytes(16).toString("hex")}`;
    let result: SnapshotStageResult;
    try {
      result = await record.stage(key);
    } catch (error: unknown) {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_STALE_REF",
        `Snapshot ref ${ref} is no longer available; take a new snapshot and reacquire the ref`,
        { cause: error },
      );
    }
    if (result === "child-frame") {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_REACT_UNSUPPORTED_OPERATION",
        "React snapshot-ref inspection supports only elements in the selected page's main frame",
      );
    }
    if (result === "detached") {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_STALE_REF",
        `Snapshot ref ${ref} is detached; take a new snapshot and reacquire the ref`,
      );
    }
    if (result === "collision") {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_INVALID_STATE",
        "The page already owns the generated React snapshot-ref staging key",
      );
    }
    let releasePromise: Promise<void> | undefined;
    const release = async () => {
      let released: SnapshotStageReleaseResult;
      try {
        released = await record.releaseStaged(key);
      } catch (error: unknown) {
        if (isDestroyedSnapshotContextError(error)) return;
        throw new ChromeMcpExecutionError(
          "CHROME_MCP_REACT_STALE_COMPONENT",
          "React snapshot-ref staging cleanup failed",
          { cause: error },
        );
      }
      if (released === "failed") {
        throw new ChromeMcpExecutionError(
          "CHROME_MCP_REACT_STALE_COMPONENT",
          "React snapshot-ref staging cleanup could not delete the retained element lease",
        );
      }
    };
    return Object.freeze({
      key,
      release: () => {
        releasePromise ??= release();
        return releasePromise;
      },
    });
  }

  async locatorForHelper(
    session: ChromePageSession,
    selected: GenerationTargetId,
    ref: string,
  ): Promise<JsonValue> {
    const record = await this.#snapshotRef(session, selected, ref);
    let probe: LocatorProbe | undefined;
    try {
      probe = await record.locatorProbe();
    } catch (error: unknown) {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_STALE_REF",
        `Snapshot ref ${ref} is no longer available`,
        {
          cause: error,
        },
      );
    }
    if (!probe || probe.state !== "available") {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_STALE_REF",
        `Snapshot ref ${ref} no longer resolves uniquely`,
      );
    }
    return {
      frameChain: [...probe.recipe.frameChain],
      selector: probe.recipe.selector,
      targetId: selected.targetId,
    };
  }

  async pageMetadata(scope: CaptureScope): Promise<PageMetadata> {
    const session = this.#resolveScope(scope);
    const record = await session.targetRecord(scope.targetId);
    const attached = await attachTarget(session, scope.targetId);
    try {
      const evaluated = requireRecord(
        await attached.send("Runtime.evaluate", {
          expression: "({ width: innerWidth, height: innerHeight })",
          returnByValue: true,
        }),
        "Runtime.evaluate",
      );
      const result = isRecord(evaluated.result) ? evaluated.result : undefined;
      const viewport = isRecord(result?.value) ? result.value : undefined;
      return {
        url: record?.url ?? "",
        title: record?.title ?? "",
        viewport:
          typeof viewport?.width === "number" && typeof viewport.height === "number" ?
            { width: viewport.width, height: viewport.height }
          : null,
      };
    } finally {
      await attached.detach();
    }
  }

  async snapshot(scope: CaptureScope): Promise<ComparableSnapshot> {
    const result = await this.snapshotForHelper(this.#resolveScope(scope), {
      options: { maxBytes: SNAPSHOT_MAX_BYTES },
      target: { ownerGeneration: scope.browserGeneration, targetId: scope.targetId },
    });
    return result.snapshot;
  }

  eventCursor(scope: CaptureScope): Promise<EventCursor> {
    return this.#resolveScope(scope).currentEventCursor();
  }

  async eventsSince(scope: CaptureScope, cursor: EventCursor): Promise<JournalReadResult> {
    const session = this.#resolveScope(scope);
    const current = await session.currentEventCursor();
    const events: BrowserJournalEvent[] = [];
    let after = cursor;
    let firstPage: JournalReadResult | undefined;

    for (;;) {
      const page = await session.readEvents({ after, limit: 200, target: scope.targetId });
      firstPage ??= page;
      events.push(...page.events);
      if (
        page.nextCursor.ownerGeneration !== current.ownerGeneration ||
        page.nextCursor.sequence >= current.sequence
      ) {
        return {
          droppedBefore: firstPage.droppedBefore,
          events,
          nextCursor: page.nextCursor,
          ownerReset: firstPage.ownerReset,
        };
      }
      after = page.nextCursor;
    }
  }

  async screenshot(scope: CaptureScope): Promise<ScreenshotCapture> {
    const session = this.#resolveScope(scope);
    const attached = await attachTarget(session, scope.targetId);
    try {
      const response = requireRecord(
        await attached.send("Page.captureScreenshot", {
          captureBeyondViewport: true,
          format: "png",
          fromSurface: true,
        }),
        "Page.captureScreenshot",
      );
      if (typeof response.data !== "string") {
        throw new TypeError("Page.captureScreenshot did not return image data");
      }
      const bytes = Buffer.from(response.data, "base64");
      const output: CaptureOutput = {
        mediaType: "image/png",
        name: `checkpoint-${randomUUID()}.png`,
        source: { kind: "bytes", bytes },
      };
      return { comparison: bytes, output };
    } finally {
      await attached.detach();
    }
  }

  async storage(scope: CaptureScope): Promise<StorageState> {
    const session = this.#resolveScope(scope);
    const attached = await attachTarget(session, scope.targetId);
    try {
      const [cookies, storage] = await Promise.all([
        session.sendCdp("Storage.getCookies"),
        attached.send("Runtime.evaluate", {
          expression:
            "({ origin: location.origin, localStorage: Object.entries(localStorage).map(([name, value]) => ({ name, value })) })",
          returnByValue: true,
        }),
      ]);
      const evaluated = requireRecord(storage, "Runtime.evaluate");
      const result = isRecord(evaluated.result) ? evaluated.result : undefined;
      const value = isRecord(result?.value) ? result.value : undefined;
      const localStorage =
        Array.isArray(value?.localStorage) ?
          copyJsonValue(value.localStorage, "Checkpoint local storage")
        : [];
      const entries =
        Array.isArray(localStorage) ?
          localStorage.flatMap((item) => {
            if (!isRecord(item) || typeof item.name !== "string" || typeof item.value !== "string") return [];
            return [{ name: item.name, value: item.value }];
          })
        : [];
      return {
        cookies: storageCookies(cookies),
        origins:
          typeof value?.origin === "string" && value.origin !== "null" ?
            [{ origin: value.origin, localStorage: entries }]
          : [],
      };
    } finally {
      await attached.detach();
    }
  }

  releaseConnection(connectionId: string): void {
    for (const [key, entry] of this.#mediaConnections) {
      if (!isConnectionScopeKey(key, connectionId)) continue;
      this.#mediaConnections.delete(key);
      entry.promise.then((connection) => connection.disconnect()).catch(() => undefined);
    }
    for (const [key, snapshots] of this.#snapshots) {
      if (!isConnectionScopeKey(key, connectionId)) continue;
      this.#snapshots.delete(key);
      for (const snapshot of snapshots) disposeSnapshot(snapshot).catch(() => undefined);
    }
    for (const [key, entry] of this.#snapshotConnections) {
      if (!isConnectionScopeKey(key, connectionId)) continue;
      this.#snapshotConnections.delete(key);
      entry.promise.then((connection) => connection.disconnect()).catch(() => undefined);
    }
    this.#snapshotRefKeys.delete(connectionId);
  }

  async releaseTarget(session: ChromePageSession, targetId: string): Promise<void> {
    const key = createSnapshotKey(session, targetId);
    const mediaConnection = this.#mediaConnections.get(createSessionScopeKey(session));
    const snapshots = this.#snapshots.get(key) ?? [];
    this.#snapshots.delete(key);
    const connection = this.#snapshotConnections.get(key);
    this.#snapshotConnections.delete(key);
    await Promise.all([
      ...(mediaConnection ?
        [mediaConnection.promise.then((value) => value.releaseTarget(targetId)).catch(() => undefined)]
      : []),
      ...snapshots.map(disposeSnapshot),
      ...(connection ? [connection.promise.then((value) => value.disconnect()).catch(() => undefined)] : []),
    ]);
  }

  async releaseOwner(contextId: string, ownerGeneration: number): Promise<void> {
    const key = createOwnerGenerationKey(contextId, ownerGeneration);
    const connection = this.#traceConnections.get(key);
    if (connection) this.#traceConnections.delete(key);
    const snapshots: Promise<SnapshotConnection>[] = [];
    const retainedRefs: Promise<void>[] = [];
    for (const [mediaKey, entry] of this.#mediaConnections) {
      if (entry.ownerId !== contextId || entry.ownerGeneration !== ownerGeneration) continue;
      this.#mediaConnections.delete(mediaKey);
      retainedRefs.push(entry.promise.then((value) => value.disconnect()).catch(() => undefined));
    }
    for (const [snapshotKey, storedSnapshots] of this.#snapshots) {
      const owned = storedSnapshots.filter(
        (snapshot) => snapshot.ownerId === contextId && snapshot.ownerGeneration === ownerGeneration,
      );
      if (owned.length === 0) continue;
      this.#snapshots.delete(snapshotKey);
      retainedRefs.push(...owned.map(disposeSnapshot));
    }
    for (const [snapshotKey, entry] of this.#snapshotConnections) {
      if (entry.ownerId !== contextId || entry.ownerGeneration !== ownerGeneration) continue;
      this.#snapshotConnections.delete(snapshotKey);
      snapshots.push(entry.promise);
    }
    await Promise.all([
      ...(connection ? [connection.then((value) => value.disconnect()).catch(() => undefined)] : []),
      ...retainedRefs,
      ...snapshots.map((snapshot) => snapshot.then((value) => value.disconnect()).catch(() => undefined)),
    ]);
  }

  async close(): Promise<void> {
    for (const watcher of this.#networkWatchers.values()) watcher.dispose();
    this.#networkWatchers.clear();
    const traces = [...this.#traceConnections.values()];
    this.#traceConnections.clear();
    const snapshots = [...this.#snapshotConnections.values()].map((entry) => entry.promise);
    this.#snapshotConnections.clear();
    const retainedRefs = [...this.#snapshots.values()].flatMap((storedSnapshots) =>
      storedSnapshots.map(disposeSnapshot),
    );
    this.#snapshots.clear();
    this.#snapshotRefKeys.clear();
    const mediaConnections = [...this.#mediaConnections.values()];
    this.#mediaConnections.clear();
    await Promise.all([
      ...mediaConnections.map((entry) =>
        entry.promise.then((value) => value.disconnect()).catch(() => undefined),
      ),
      ...traces.map((connection) => connection.then((value) => value.disconnect()).catch(() => undefined)),
      ...snapshots.map((connection) => connection.then((value) => value.disconnect()).catch(() => undefined)),
      ...retainedRefs,
    ]);
  }

  #networkWatcherRelease(watcherKey: string, watcher: NetworkWatcher): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      watcher.references -= 1;
      if (watcher.references > 0 || this.#networkWatchers.get(watcherKey) !== watcher) return;
      this.#networkWatchers.delete(watcherKey);
      watcher.dispose();
    };
  }

  #snapshotRefKey(connectionId: string): Buffer {
    let key = this.#snapshotRefKeys.get(connectionId);
    if (!key) {
      key = randomBytes(32);
      this.#snapshotRefKeys.set(connectionId, key);
    }
    return key;
  }

  async #snapshotRef(
    session: ChromePageSession,
    selected: GenerationTargetId,
    ref: string,
  ): Promise<SnapshotRef> {
    if (!(await session.targetRecord(selected.targetId))) {
      await this.releaseTarget(session, selected.targetId);
      throw new ChromeMcpExecutionError("CHROME_MCP_PAGE_CLOSED", "The selected page is closed");
    }
    const snapshots = this.#snapshots.get(createSnapshotKey(session, selected.targetId)) ?? [];
    const record = snapshots
      .map((snapshot) => snapshot.refs.get(ref))
      .find((candidate) => candidate !== undefined);
    if (!record) {
      const key = this.#snapshotRefKeys.get(session.connectionId);
      const provenance = key ? decodeSnapshotRef(ref, key) : undefined;
      if (!provenance || provenance.browserMode !== session.browserMode) {
        throw new ChromeMcpExecutionError("CHROME_MCP_UNKNOWN_REF", `Unknown snapshot ref ${ref}`);
      }
      if (provenance.targetId !== selected.targetId) {
        throw new ChromeMcpExecutionError(
          "CHROME_MCP_SNAPSHOT_TARGET_MISMATCH",
          `Snapshot ref ${ref} belongs to another browser target`,
        );
      }
      const reason =
        provenance.ownerGeneration === session.ownerGeneration ?
          "was evicted"
        : "belongs to an older browser generation";
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_STALE_REF",
        `Snapshot ref ${ref} ${reason}; take a new snapshot and reacquire the ref`,
      );
    }
    if (record.ownerGeneration !== session.ownerGeneration || record.targetId !== selected.targetId) {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_STALE_REF",
        `Snapshot ref ${ref} belongs to another browser target`,
      );
    }
    return record;
  }

  #snapshotConnection(session: ChromePageSession, targetId: string): Promise<SnapshotConnection> {
    const key = createSnapshotKey(session, targetId);
    const current = this.#snapshotConnections.get(key);
    if (current) return current.promise;
    const promise = this.#connectSnapshot(session, targetId);
    const entry = { ownerGeneration: session.ownerGeneration, ownerId: session.ownerId, promise };
    this.#snapshotConnections.set(key, entry);
    promise.catch(() => {
      if (this.#snapshotConnections.get(key) === entry) this.#snapshotConnections.delete(key);
    });
    return promise;
  }

  #snapshotById(session: ChromePageSession, snapshotId: string): StoredSnapshot | undefined {
    const namespace = `${createSessionScopeKey(session)}\0`;
    for (const [key, snapshots] of this.#snapshots) {
      if (!key.startsWith(namespace)) continue;
      const snapshot = snapshots.find((candidate) => candidate.snapshotId === snapshotId);
      if (snapshot) return snapshot;
    }
    return undefined;
  }
}
