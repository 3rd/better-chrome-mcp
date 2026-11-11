import type { ExecutionBrowserSession, LocatorRecipe, WorkerEvaluationInput } from "./helpers";
import type { ExecutionWorkerRequest, SnapshotRootToken } from "./protocol";
import { isRecord } from "../../platform/records";
import {
  type PageViewportRequest,
  type PageViewportState,
  parseViewportSize,
} from "../runtime/page-viewport";
import { ChromeMcpExecutionError } from "./errors";
import {
  copyJsonObject,
  createJsonResultSerializationFunction,
  type JsonObject,
  type JsonValue,
} from "./json";

type CdpSession = {
  detach: () => Promise<void>;
  send: (method: string, params?: JsonObject) => Promise<unknown>;
};

type PublicLocatorScope = {
  frameLocator: (selector: string) => unknown;
  locator: (selector: string) => unknown;
};

type PublicPage = PublicLocatorScope & {
  context: () => PublicBrowserContext;
  isClosed: () => boolean;
};

type PublicBrowserContext = {
  newCDPSession: (page: unknown) => Promise<CdpSession>;
  pages: () => unknown[];
};

type PublicBrowser = {
  close: () => Promise<void>;
  contexts: () => unknown[];
};

type ChromiumBrowserType = {
  connectOverCDP: (
    endpoint: PublicCdpTransport,
    options: { artifactsDir?: string; isLocal: boolean; noDefaults: boolean; timeout: number },
  ) => Promise<unknown>;
};

export type PublicCdpTransport = {
  close: () => void;
  onclose?: (reason?: string) => void;
  onmessage?: (message: object) => void;
  send: (message: object) => void;
};

export type CdpTransportOpener = (endpoint: string, timeoutMs: number) => Promise<PublicCdpTransport>;

type MarkerElement = {
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  removeAttribute: (name: string) => void;
  setAttribute: (name: string, value: string) => void;
};

type MarkerLocator = {
  evaluate: (
    callback: (element: MarkerElement, argument: JsonObject) => unknown,
    argument: JsonObject,
  ) => Promise<unknown>;
};

type MarkerState = {
  hadAttribute: boolean;
  previousValue: string | null;
};

export type PlaywrightModuleLoader = () => Promise<unknown>;

type OwnerCloseResource = "browser" | "default-context";

type AuthorizedBrowserCloseSender = <Result>(send: () => Result) => Result;

type ExecutionBrowserConnectionOptions = Readonly<{
  authorizeOwnerClose?: (resource: OwnerCloseResource) => Promise<void>;
  dialogHandling?: "preserve";
  emulateMedia?: (targetId: string, options: JsonObject) => Promise<void>;
  pageViewport?: (request: PageViewportRequest) => Promise<PageViewportState>;
  loadPlaywright?: PlaywrightModuleLoader;
  openTransport?: CdpTransportOpener;
}>;

type ExecutionBrowserConnectionRequest = Pick<
  ExecutionWorkerRequest,
  "browserMode" | "cdpEndpoint" | "connectTimeoutMs" | "downloadsPath" | "selectedTargetId"
>;

export type ConnectedExecutionBrowserSession = ExecutionBrowserSession & {
  disconnect: () => Promise<void>;
};

const defaultPlaywrightModuleLoader: PlaywrightModuleLoader = async () => {
  const moduleId = "playwright-core";
  const moduleNamespace: unknown = await import(moduleId);
  return moduleNamespace;
};

const resolveWebSocketEndpoint = async (endpoint: string, timeoutMs: number): Promise<string> => {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch (error: unknown) {
    throw new ChromeMcpExecutionError("CHROME_MCP_BROWSER_DISCONNECTED", "Chrome CDP endpoint is invalid", {
      cause: error,
    });
  }
  if (parsed.protocol === "ws:" || parsed.protocol === "wss:") return parsed.toString();
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_BROWSER_DISCONNECTED",
      "Chrome CDP endpoint must use http, https, ws, or wss",
    );
  }

  const cancellation = new AbortController();
  const timeout = setTimeout(() => cancellation.abort(), timeoutMs);
  try {
    const response = await fetch(new URL("/json/version", parsed), { signal: cancellation.signal });
    if (!response.ok) {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_BROWSER_DISCONNECTED",
        `Chrome CDP version endpoint returned HTTP ${response.status}`,
      );
    }
    const value: unknown = await response.json();
    if (!isRecord(value) || typeof value.webSocketDebuggerUrl !== "string") {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_BROWSER_DISCONNECTED",
        "Chrome CDP version endpoint did not return a WebSocket URL",
      );
    }
    const webSocketUrl = new URL(value.webSocketDebuggerUrl);
    if (webSocketUrl.protocol !== "ws:" && webSocketUrl.protocol !== "wss:") {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_BROWSER_DISCONNECTED",
        "Chrome CDP version endpoint returned an invalid WebSocket URL",
      );
    }
    return webSocketUrl.toString();
  } catch (error: unknown) {
    if (error instanceof ChromeMcpExecutionError) throw error;
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_BROWSER_DISCONNECTED",
      `Chrome CDP WebSocket discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
};

export const openBunCdpTransport: CdpTransportOpener = async (endpoint, timeoutMs) => {
  const webSocketEndpoint = await resolveWebSocketEndpoint(endpoint, timeoutMs);
  const socket = new WebSocket(webSocketEndpoint);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(
        new ChromeMcpExecutionError("CHROME_MCP_BROWSER_DISCONNECTED", "Chrome CDP WebSocket timed out"),
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };

    function onOpen() {
      cleanup();
      resolve();
    }

    function onError() {
      cleanup();
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
      reject(new ChromeMcpExecutionError("CHROME_MCP_BROWSER_DISCONNECTED", "Chrome CDP WebSocket failed"));
    }

    function onClose() {
      cleanup();
      reject(
        new ChromeMcpExecutionError(
          "CHROME_MCP_BROWSER_DISCONNECTED",
          "Chrome CDP WebSocket closed during connection",
        ),
      );
    }

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });

  let closeHandler: PublicCdpTransport["onclose"];
  let closeReason: string | undefined;
  let messageHandler: PublicCdpTransport["onmessage"];
  const pendingMessages: object[] = [];
  const transport: PublicCdpTransport = {
    close: () => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
    },
    get onclose() {
      return closeHandler;
    },
    set onclose(handler) {
      closeHandler = handler;
      if (handler && closeReason !== undefined) handler(closeReason);
    },
    get onmessage() {
      return messageHandler;
    },
    set onmessage(handler) {
      messageHandler = handler;
      if (!handler) return;
      for (const message of pendingMessages.splice(0)) handler(message);
    },
    send: (message) => {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new ChromeMcpExecutionError(
          "CHROME_MCP_BROWSER_DISCONNECTED",
          "Chrome CDP WebSocket is not open",
        );
      }
      socket.send(JSON.stringify(message));
    },
  };
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      transport.close();
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      transport.close();
      return;
    }
    if (!isRecord(message)) {
      transport.close();
      return;
    }
    if (messageHandler) messageHandler(message);
    else pendingMessages.push(message);
  });
  socket.addEventListener("close", (event) => {
    closeReason = event.reason || "Chrome CDP WebSocket closed";
    closeHandler?.(closeReason);
  });
  return transport;
};

const requireBrowser = (value: unknown): PublicBrowser => {
  if (!isRecord(value) || typeof value.close !== "function" || typeof value.contexts !== "function") {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_BROWSER_DISCONNECTED",
      "Playwright did not return a connected Browser",
    );
  }
  const close = value.close;
  const contexts = value.contexts;
  return {
    close: () => Reflect.apply(close, value, []),
    contexts: () => Reflect.apply(contexts, value, []),
  };
};

const requireContext = (value: unknown): PublicBrowserContext => {
  if (!isRecord(value) || typeof value.newCDPSession !== "function" || typeof value.pages !== "function") {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_BROWSER_DISCONNECTED",
      "Playwright browser context is unavailable",
    );
  }
  const newCDPSession = value.newCDPSession;
  const pages = value.pages;
  return {
    newCDPSession: async (page: unknown) => Reflect.apply(newCDPSession, value, [page]),
    pages: () => Reflect.apply(pages, value, []),
  };
};

const requirePage = (value: unknown): PublicPage => {
  if (
    !isRecord(value) ||
    typeof value.context !== "function" ||
    typeof value.frameLocator !== "function" ||
    typeof value.isClosed !== "function" ||
    typeof value.locator !== "function"
  ) {
    throw new ChromeMcpExecutionError("CHROME_MCP_PAGE_CLOSED", "Playwright page is unavailable");
  }
  const context = value.context;
  const frameLocator = value.frameLocator;
  const isClosed = value.isClosed;
  const locator = value.locator;
  return {
    context: () => Reflect.apply(context, value, []),
    frameLocator: (selector: string) => Reflect.apply(frameLocator, value, [selector]),
    isClosed: () => Reflect.apply(isClosed, value, []),
    locator: (selector: string) => Reflect.apply(locator, value, [selector]),
  };
};

const requireLocatorScope = (value: unknown): PublicLocatorScope => {
  if (!isRecord(value) || typeof value.frameLocator !== "function" || typeof value.locator !== "function") {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_BROWSER_DISCONNECTED",
      "Playwright frame locator is unavailable",
    );
  }
  const frameLocator = value.frameLocator;
  const locator = value.locator;
  return {
    frameLocator: (selector: string) => Reflect.apply(frameLocator, value, [selector]),
    locator: (selector: string) => Reflect.apply(locator, value, [selector]),
  };
};

const requireCdpSession = (value: unknown): CdpSession => {
  if (!isRecord(value) || typeof value.detach !== "function" || typeof value.send !== "function") {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_BROWSER_DISCONNECTED",
      "Playwright CDP session is unavailable",
    );
  }
  const detach = value.detach;
  const send = value.send;
  return {
    detach: async () => Reflect.apply(detach, value, []),
    send: async (method: string, params?: JsonObject) =>
      Reflect.apply(send, value, params === undefined ? [method] : [method, params]),
  };
};

const requireChromium = (value: unknown): ChromiumBrowserType => {
  if (!isRecord(value) || !isRecord(value.chromium)) {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_WORKER_CRASH",
      "playwright-core does not expose the public chromium.connectOverCDP API",
    );
  }
  const chromium = value.chromium;
  const connectOverCDP = chromium.connectOverCDP;
  if (typeof connectOverCDP !== "function") {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_WORKER_CRASH",
      "playwright-core does not expose the public chromium.connectOverCDP API",
    );
  }
  return {
    connectOverCDP: async (endpoint, options) => Reflect.apply(connectOverCDP, chromium, [endpoint, options]),
  };
};

type ContextPageEntry = { context: PublicBrowserContext; contextValue: unknown; page: unknown };

const browserContexts = (browser: PublicBrowser): unknown[] => {
  const contexts = browser.contexts();
  if (!Array.isArray(contexts)) {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_BROWSER_DISCONNECTED",
      "Playwright returned an invalid context list",
    );
  }
  return contexts;
};

const contextPages = (browser: PublicBrowser): ContextPageEntry[] => {
  const entries: ContextPageEntry[] = [];
  for (const contextValue of browserContexts(browser)) {
    const context = requireContext(contextValue);
    const pages = context.pages();
    if (!Array.isArray(pages)) continue;
    for (const page of pages) entries.push({ context, contextValue, page });
  }
  return entries;
};

const readTargetId = async (context: PublicBrowserContext, page: unknown): Promise<string> => {
  const pageObject = requirePage(page);
  if (pageObject.isClosed()) {
    throw new ChromeMcpExecutionError("CHROME_MCP_PAGE_CLOSED", "Playwright page is closed");
  }
  const cdp = requireCdpSession(await context.newCDPSession(page));
  try {
    const response = await cdp.send("Target.getTargetInfo");
    if (
      !isRecord(response) ||
      !isRecord(response.targetInfo) ||
      typeof response.targetInfo.targetId !== "string"
    ) {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_BROWSER_DISCONNECTED",
        "Chrome did not return a target ID for the Playwright page",
      );
    }
    return response.targetInfo.targetId;
  } finally {
    await cdp.detach();
  }
};

const findPage = async (
  browser: PublicBrowser,
  targetId: string,
): Promise<{ context: PublicBrowserContext; page: unknown }> => {
  for (const entry of contextPages(browser)) {
    try {
      if ((await readTargetId(entry.context, entry.page)) === targetId) return entry;
    } catch (error: unknown) {
      const page = requirePage(entry.page);
      if (!page.isClosed()) throw error;
    }
  }
  throw new ChromeMcpExecutionError(
    "CHROME_MCP_PAGE_CLOSED",
    `Selected Chrome target is no longer available: ${targetId}`,
  );
};

const requireMarkerLocator = (value: unknown): MarkerLocator => {
  if (!isRecord(value) || typeof value.evaluate !== "function") {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_INVALID_INPUT",
      "Snapshot root must be a Playwright Locator",
    );
  }
  const evaluate = value.evaluate;
  return {
    evaluate: async (callback, argument) => Reflect.apply(evaluate, value, [callback, argument]),
  };
};

const protectOwnerClose = (
  value: unknown,
  resource: OwnerCloseResource,
  closeBrowserOwner: (resource: OwnerCloseResource) => Promise<void>,
): void => {
  if (!isRecord(value) || typeof value.close !== "function") return;
  Object.defineProperty(value, "close", {
    configurable: false,
    enumerable: false,
    value: async () => closeBrowserOwner(resource),
    writable: false,
  });
};

const protectCdpBrowserClose = (
  value: unknown,
  authorize: (resource: OwnerCloseResource) => Promise<void>,
  sendAuthorizedBrowserClose: AuthorizedBrowserCloseSender,
): void => {
  if (!isRecord(value) || typeof value.send !== "function") return;
  const send = value.send;
  Object.defineProperty(value, "send", {
    configurable: false,
    enumerable: false,
    value: async (method: string, params?: JsonObject) => {
      const sendCommand = () =>
        Reflect.apply(send, value, params === undefined ? [method] : [method, params]);
      if (method !== "Browser.close") return sendCommand();
      await authorize("browser");
      return sendAuthorizedBrowserClose(sendCommand);
    },
    writable: false,
  });
};

const protectBrowserCdpSessions = (
  value: unknown,
  authorize: (resource: OwnerCloseResource) => Promise<void>,
  sendAuthorizedBrowserClose: AuthorizedBrowserCloseSender,
): void => {
  if (!isRecord(value) || typeof value.newBrowserCDPSession !== "function") return;
  const newBrowserCDPSession = value.newBrowserCDPSession;
  Object.defineProperty(value, "newBrowserCDPSession", {
    configurable: false,
    enumerable: false,
    value: async () => {
      const session: unknown = await Reflect.apply(newBrowserCDPSession, value, []);
      protectCdpBrowserClose(session, authorize, sendAuthorizedBrowserClose);
      return session;
    },
    writable: false,
  });
};

const retainPageMediaEmulation = (
  browser: PublicBrowser,
  emulateMedia: NonNullable<ExecutionBrowserConnectionOptions["emulateMedia"]>,
): void => {
  const instrumentContext = (contextValue: unknown) => {
    const context = requireContext(contextValue);
    if (!isRecord(contextValue) || typeof contextValue.on !== "function") {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_BROWSER_DISCONNECTED",
        "Playwright browser context events are unavailable",
      );
    }
    const instrumentPage = (page: unknown) => {
      if (!isRecord(page) || typeof page.emulateMedia !== "function") {
        throw new ChromeMcpExecutionError(
          "CHROME_MCP_PAGE_CLOSED",
          "Playwright page media emulation is unavailable",
        );
      }
      Object.defineProperty(page, "emulateMedia", {
        configurable: false,
        enumerable: false,
        value: async (options = {}) => {
          const mediaOptions = copyJsonObject(
            Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
            "Media emulation options",
          );
          await emulateMedia(await readTargetId(context, page), mediaOptions);
        },
        writable: false,
      });
    };
    contextValue.on("page", instrumentPage);
    for (const page of context.pages()) instrumentPage(page);
  };
  for (const context of browser.contexts()) instrumentContext(context);
};

type PageViewportRetentionOptions = {
  browser: PublicBrowser;
  selectedPage: unknown;
  pageViewport: NonNullable<ExecutionBrowserConnectionOptions["pageViewport"]>;
  viewportMode: "emulated" | "native";
};

const retainPageViewports = async ({
  browser,
  selectedPage,
  pageViewport,
  viewportMode,
}: PageViewportRetentionOptions) => {
  for (const contextValue of browser.contexts()) {
    const context = requireContext(contextValue);
    if (!isRecord(contextValue) || typeof contextValue.on !== "function") {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_BROWSER_DISCONNECTED",
        "Playwright browser context events are unavailable",
      );
    }

    const instrumentPage = (page: unknown, initialViewport: PageViewportState = null) => {
      if (
        !isRecord(page) ||
        typeof page.setViewportSize !== "function" ||
        typeof page.viewportSize !== "function"
      ) {
        throw new ChromeMcpExecutionError(
          "CHROME_MCP_PAGE_CLOSED",
          "Playwright page viewport is unavailable",
        );
      }

      if (viewportMode === "native") {
        let nativeViewport = initialViewport;
        Object.defineProperty(page, "setViewportSize", {
          configurable: false,
          value: async (size: unknown) => {
            const viewport = parseViewportSize(size);
            nativeViewport = await pageViewport({
              operation: "set",
              targetId: await readTargetId(context, page),
              viewport,
            });
          },
          writable: false,
        });
        Object.defineProperty(page, "viewportSize", {
          configurable: false,
          value: () => nativeViewport,
          writable: false,
        });
        return;
      }

      const setViewportSize = page.setViewportSize;
      const viewportSize = page.viewportSize;
      Object.defineProperty(page, "setViewportSize", {
        configurable: false,
        value: async (size: unknown) => {
          await Reflect.apply(setViewportSize, page, [size]);
          const viewport = parseViewportSize(Reflect.apply(viewportSize, page, []));
          await pageViewport({
            operation: "set",
            targetId: await readTargetId(context, page),
            viewport,
          });
        },
        writable: false,
      });
    };

    const pages = context.pages();
    contextValue.on("page", instrumentPage);
    await Promise.all(
      pages.map(async (page) => {
        if (!isRecord(page) || typeof page.setViewportSize !== "function") {
          throw new ChromeMcpExecutionError(
            "CHROME_MCP_PAGE_CLOSED",
            "Playwright page viewport is unavailable",
          );
        }

        try {
          const viewport = await pageViewport({
            operation: "read",
            targetId: await readTargetId(context, page),
          });
          if (viewport && viewportMode === "emulated") {
            await page.setViewportSize(viewport);
          }
          instrumentPage(page, viewport);
        } catch (error: unknown) {
          if (page === selectedPage || !requirePage(page).isClosed()) {
            throw error;
          }
        }
      }),
    );
  }
};

const PLAYWRIGHT_BROWSER_CLOSE_MESSAGE_ID = -9999;
const PLAYWRIGHT_DOWNLOAD_EVENTS_MESSAGE_ID = -9998;

const enablePlaywrightDownloadEvents = async (
  transport: PublicCdpTransport,
  send: PublicCdpTransport["send"],
  downloadsPath: string,
): Promise<void> => {
  const forward = transport.onmessage;
  const onclose = transport.onclose;
  await new Promise<void>((resolve, reject) => {
    const restore = () => {
      transport.onmessage = forward;
      transport.onclose = onclose;
    };
    transport.onclose = (reason) => {
      transport.onmessage = forward;
      reject(
        new ChromeMcpExecutionError(
          "CHROME_MCP_BROWSER_DISCONNECTED",
          `Chrome CDP connection closed: ${reason}`,
        ),
      );
      onclose?.(reason);
    };
    transport.onmessage = (message) => {
      if (!isRecord(message) || message.id !== PLAYWRIGHT_DOWNLOAD_EVENTS_MESSAGE_ID) {
        forward?.(message);
        return;
      }
      restore();
      if (isRecord(message.error)) {
        reject(
          new ChromeMcpExecutionError(
            "CHROME_MCP_BROWSER_DISCONNECTED",
            `Chrome rejected Playwright download events: ${String(message.error.message ?? "unknown error")}`,
          ),
        );
        return;
      }
      resolve();
    };
    try {
      Reflect.apply(send, transport, [
        {
          id: PLAYWRIGHT_DOWNLOAD_EVENTS_MESSAGE_ID,
          method: "Browser.setDownloadBehavior",
          params: { behavior: "allowAndName", downloadPath: downloadsPath, eventsEnabled: true },
        },
      ]);
    } catch (error: unknown) {
      restore();
      reject(error);
    }
  });
};

const closeBrowserOwnerThroughCdp = async (
  transport: PublicCdpTransport,
  send: PublicCdpTransport["send"],
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const onclose = transport.onclose;
    transport.onclose = (reason) => {
      resolve();
      onclose?.(reason);
    };
    try {
      Reflect.apply(send, transport, [
        { id: PLAYWRIGHT_BROWSER_CLOSE_MESSAGE_ID, method: "Browser.close", params: {} },
      ]);
    } catch (error: unknown) {
      transport.onclose = onclose;
      reject(error);
    }
  });
};

const protectBrowserCloseCommand = (
  transport: PublicCdpTransport,
  authorize: (resource: OwnerCloseResource) => Promise<void>,
): AuthorizedBrowserCloseSender => {
  const send = transport.send;
  let authorizedBrowserClose = false;
  transport.send = (message) => {
    const request = isRecord(message) ? message : undefined;
    if (request?.method !== "Browser.close") {
      Reflect.apply(send, transport, [message]);
      return;
    }
    if (authorizedBrowserClose) {
      Reflect.apply(send, transport, [message]);
      return;
    }
    authorize("browser")
      .then(() => Reflect.apply(send, transport, [message]))
      .catch((error: unknown) => {
        if (typeof request.id !== "number") return;
        const code = isRecord(error) && typeof error.code === "string" ? `${error.code}: ` : "";
        const errorMessage = error instanceof Error ? error.message : String(error);
        transport.onmessage?.({
          error: { code: -32_000, message: `${code}${errorMessage}` },
          id: request.id,
          ...(typeof request.sessionId === "string" ? { sessionId: request.sessionId } : {}),
        });
      });
  };
  return <Result>(sendBrowserClose: () => Result): Result => {
    authorizedBrowserClose = true;
    try {
      return sendBrowserClose();
    } finally {
      authorizedBrowserClose = false;
    }
  };
};

const parseMarkerState = (value: unknown): MarkerState => {
  if (
    !isRecord(value) ||
    typeof value.hadAttribute !== "boolean" ||
    (value.previousValue !== null && typeof value.previousValue !== "string")
  ) {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_INVALID_INPUT",
      "Snapshot root marker returned invalid state",
    );
  }
  return { hadAttribute: value.hadAttribute, previousValue: value.previousValue };
};

const markElement = (element: MarkerElement, argument: JsonObject): MarkerState => {
  const name = String(argument.attributeName);
  const value = String(argument.attributeValue);
  const state = {
    hadAttribute: element.hasAttribute(name),
    previousValue: element.getAttribute(name),
  };
  element.setAttribute(name, value);
  return state;
};

const restoreElement = (element: MarkerElement, argument: JsonObject): void => {
  const name = String(argument.attributeName);
  const markerValue = String(argument.attributeValue);
  if (element.getAttribute(name) !== markerValue) {
    throw new Error("Snapshot root marker changed before cleanup");
  }
  if (argument.hadAttribute === true) {
    element.setAttribute(name, String(argument.previousValue ?? ""));
  } else {
    element.removeAttribute(name);
  }
};

type WorkerValue = JsonValue | undefined;

const WORKER_EVALUATION_CANCELLED_MESSAGE = "Execution ended during worker evaluation";
const workerResultSerializationFunction = createJsonResultSerializationFunction();

const decodeWorkerValue = (root: unknown) => {
  const references = new Map<number, Record<string, unknown>>();

  const collectReferences = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectReferences(item);
      }
    } else if (isRecord(value)) {
      const referenceId = value.weakLocalObjectReference;
      const hasReferenceValue = typeof referenceId === "number" && Object.hasOwn(value, "value");
      if (hasReferenceValue) {
        references.set(referenceId, value);
      }

      collectReferences(value.value);
    }
  };

  collectReferences(root);

  const ancestors = new Set<object>();

  const decode = (value: unknown): WorkerValue => {
    if (!isRecord(value)) {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_INVALID_INPUT",
        "Worker returned an invalid serialized value",
      );
    }

    const referenceId = value.weakLocalObjectReference;
    const isReference = typeof referenceId === "number" && !Object.hasOwn(value, "value");
    if (isReference) {
      const reference = references.get(referenceId);
      if (!reference) {
        throw new ChromeMcpExecutionError(
          "CHROME_MCP_INVALID_INPUT",
          "Worker returned an unresolved value reference",
        );
      }
      return decode(reference);
    }

    if (ancestors.has(value)) {
      throw new ChromeMcpExecutionError("CHROME_MCP_INVALID_INPUT", "Worker result must not contain cycles");
    }

    if (value.type === "undefined") return undefined;
    if (value.type === "null") return null;

    const serialized = value.value;
    const isString = value.type === "string" && typeof serialized === "string";
    const isBoolean = value.type === "boolean" && typeof serialized === "boolean";
    const isFiniteNumber =
      value.type === "number" && typeof serialized === "number" && Number.isFinite(serialized);
    const isNegativeZero = value.type === "number" && serialized === "-0";
    if (isString) return serialized;
    if (isBoolean) return serialized;
    if (isFiniteNumber) return serialized;
    if (isNegativeZero) return -0;

    const hasContainerValue =
      (value.type === "array" || value.type === "object") && Array.isArray(serialized);
    if (!hasContainerValue) {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_INVALID_INPUT",
        `Worker result contains unsupported ${String(value.type)} data; return finite JSON data explicitly`,
      );
    }

    ancestors.add(value);
    try {
      if (value.type === "array") return serialized.map((item) => decode(item) ?? null);

      const entries: [string, JsonValue][] = [];
      for (const entry of serialized) {
        const isObjectEntry = Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string";
        if (!isObjectEntry) {
          throw new ChromeMcpExecutionError(
            "CHROME_MCP_INVALID_INPUT",
            "Worker returned an invalid object entry",
          );
        }
        const decoded = decode(entry[1]);
        if (decoded === undefined) continue;
        entries.push([entry[0], decoded]);
      }

      return Object.fromEntries(entries);
    } finally {
      ancestors.delete(value);
    }
  };

  return decode(root);
};

const readWorkerEvaluationResult = (response: unknown) => {
  if (!isRecord(response)) {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_EXECUTION_FAILED",
      "Chrome returned an invalid worker evaluation response",
    );
  }

  if (isRecord(response.exceptionDetails)) {
    const exception = response.exceptionDetails.exception;
    const message =
      isRecord(exception) && typeof exception.description === "string" ?
        exception.description
      : String(response.exceptionDetails.text);
    throw new ChromeMcpExecutionError("CHROME_MCP_EXECUTION_FAILED", message);
  }

  if (!isRecord(response.result)) {
    throw new ChromeMcpExecutionError("CHROME_MCP_EXECUTION_FAILED", "Chrome did not return a worker value");
  }
  return response.result;
};

const createWorkerEvaluator = (transport: PublicCdpTransport) => {
  let nextRequestId = -10_000;
  let isClosed = false;
  const ownedSessions = new Set<string>();
  const pending = new Map<
    number,
    {
      method: string;
      params: JsonObject;
      sessionId?: string;
      reject: (error: Error) => void;
      resolve: (value: unknown) => void;
    }
  >();
  const onmessage = transport.onmessage;
  const onclose = transport.onclose;
  transport.onmessage = (message) => {
    if (!isRecord(message)) {
      onmessage?.(message);

      return;
    }

    const callback = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (callback) {
      if (isRecord(message.error)) {
        callback.reject(
          new ChromeMcpExecutionError(
            "CHROME_MCP_EXECUTION_FAILED",
            `Worker CDP ${callback.method} failed: ${String(message.error.message)}`,
          ),
        );
      } else {
        const replySessionId = isRecord(message.result) ? message.result.sessionId : undefined;
        const isWorkerSessionReply =
          callback.method === "Target.attachToTarget" && typeof replySessionId === "string";
        if (isWorkerSessionReply) {
          ownedSessions.add(replySessionId);
        }

        callback.resolve(message.result);
      }

      return;
    }

    const params = isRecord(message.params) ? message.params : undefined;
    const targetInfo = params && isRecord(params.targetInfo) ? params.targetInfo : undefined;
    const attachedSessionId = params?.sessionId;
    const isWorkerAttachment =
      message.method === "Target.attachedToTarget" &&
      message.sessionId === undefined &&
      targetInfo?.type === "worker" &&
      typeof attachedSessionId === "string";
    if (isWorkerAttachment) {
      if (ownedSessions.has(attachedSessionId)) return;

      for (const entry of pending.values()) {
        const isRequestedTarget =
          entry.method === "Target.attachToTarget" && entry.params.targetId === targetInfo.targetId;
        if (!isRequestedTarget) continue;

        ownedSessions.add(attachedSessionId);
        return;
      }
    }

    const isWorkerEvent = typeof message.sessionId === "string" && ownedSessions.has(message.sessionId);
    if (isWorkerEvent) return;

    const isWorkerDetachment =
      message.method === "Target.detachedFromTarget" &&
      typeof attachedSessionId === "string" &&
      ownedSessions.delete(attachedSessionId);
    if (isWorkerDetachment) {
      for (const execution of pending.values()) {
        if (execution.sessionId !== attachedSessionId) continue;

        execution.reject(
          new ChromeMcpExecutionError(
            "CHROME_MCP_EXECUTION_FAILED",
            "Worker target detached during evaluation",
          ),
        );
      }

      return;
    }

    onmessage?.(message);
  };

  transport.onclose = (reason) => {
    isClosed = true;
    for (const callback of pending.values()) {
      callback.reject(
        new ChromeMcpExecutionError(
          "CHROME_MCP_BROWSER_DISCONNECTED",
          reason ?? "Worker CDP connection closed",
        ),
      );
    }

    onclose?.(reason);
  };

  const send = (method: string, params: JsonObject, options: { signal: AbortSignal; sessionId?: string }) =>
    new Promise<unknown>((resolve, reject) => {
      if (isClosed) {
        reject(
          new ChromeMcpExecutionError("CHROME_MCP_BROWSER_DISCONNECTED", "Worker CDP connection closed"),
        );
        return;
      }

      const { signal, sessionId } = options;
      const id = nextRequestId--;

      const cleanup = () => {
        pending.delete(id);
        signal.removeEventListener("abort", cancel);
      };
      function cancel() {
        cleanup();
        reject(new ChromeMcpExecutionError("CHROME_MCP_CANCELLED", WORKER_EVALUATION_CANCELLED_MESSAGE));
      }

      if (signal.aborted) {
        cancel();
        return;
      }

      pending.set(id, {
        method,
        params,
        ...(sessionId === undefined ? {} : { sessionId }),
        reject: (error) => {
          cleanup();
          reject(error);
        },
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
      });
      signal.addEventListener("abort", cancel, { once: true });

      try {
        transport.send({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) });
      } catch (error: unknown) {
        cleanup();
        reject(error);
      }
    });

  return async (input: WorkerEvaluationInput, signal: AbortSignal) => {
    const target = await send("Target.getTargetInfo", { targetId: input.targetId }, { signal });
    const targetInfo = isRecord(target) ? target.targetInfo : undefined;
    const isDedicatedWorker =
      isRecord(targetInfo) && targetInfo.targetId === input.targetId && targetInfo.type === "worker";
    if (!isDedicatedWorker) {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_INVALID_INPUT",
        "Worker target ID must identify a live dedicated worker in the current browser",
      );
    }
    if (targetInfo.url === "") {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_EXECUTION_FAILED",
        `Worker target ${JSON.stringify(input.targetId)} has an empty URL; its script may still be initializing. Wait for the worker's ready signal before evaluating it.`,
      );
    }

    const attached = await send(
      "Target.attachToTarget",
      { targetId: input.targetId, flatten: true },
      { signal },
    );
    const sessionId = isRecord(attached) ? attached.sessionId : undefined;
    const hasSessionId = typeof sessionId === "string";
    if (!hasSessionId) {
      throw new ChromeMcpExecutionError(
        "CHROME_MCP_EXECUTION_FAILED",
        "Chrome did not return a worker session ID",
      );
    }

    ownedSessions.add(sessionId);

    try {
      const evaluated = readWorkerEvaluationResult(
        await send(
          "Runtime.evaluate",
          {
            expression: input.expression,
            awaitPromise: true,
          },
          { signal, sessionId },
        ),
      );
      const objectId = evaluated.objectId;
      if (typeof objectId !== "string") {
        return decodeWorkerValue({
          type: evaluated.subtype === "null" ? "null" : evaluated.type,
          value: evaluated.unserializableValue ?? evaluated.value,
        });
      }

      const serialized = readWorkerEvaluationResult(
        await send(
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration: workerResultSerializationFunction,
            serializationOptions: { serialization: "deep" },
          },
          { signal, sessionId },
        ),
      );
      const checked = decodeWorkerValue(serialized.deepSerializedValue);
      const serializationError = isRecord(checked) ? checked.error : undefined;
      const hasSerializationError =
        isRecord(checked) && checked.isValid === false && typeof serializationError === "string";
      if (hasSerializationError) {
        throw new ChromeMcpExecutionError("CHROME_MCP_INVALID_INPUT", serializationError);
      }

      const hasSerializedValue =
        isRecord(checked) && checked.isValid === true && Object.hasOwn(checked, "value");
      if (!hasSerializedValue) {
        throw new ChromeMcpExecutionError(
          "CHROME_MCP_EXECUTION_FAILED",
          "Chrome returned an invalid worker serialization response",
        );
      }
      return checked.value;
    } finally {
      const canDetach = !signal.aborted && !isClosed && ownedSessions.has(sessionId);
      if (canDetach) {
        await send("Target.detachFromTarget", { sessionId }, { signal });
        ownedSessions.delete(sessionId);
      }

      if (signal.aborted) {
        throw new ChromeMcpExecutionError("CHROME_MCP_CANCELLED", WORKER_EVALUATION_CANCELLED_MESSAGE);
      }
    }
  };
};

export const connectExecutionBrowserSession = async (
  request: ExecutionBrowserConnectionRequest,
  options: ExecutionBrowserConnectionOptions = {},
): Promise<ConnectedExecutionBrowserSession> => {
  const chromium = requireChromium(await (options.loadPlaywright ?? defaultPlaywrightModuleLoader)());
  const startedAt = performance.now();
  const transport = await (options.openTransport ?? openBunCdpTransport)(
    request.cdpEndpoint,
    request.connectTimeoutMs,
  );
  const sendCdpMessage = transport.send;
  const authorizeOwnerClose = options.authorizeOwnerClose;
  const sendAuthorizedBrowserClose =
    authorizeOwnerClose ? protectBrowserCloseCommand(transport, authorizeOwnerClose) : undefined;
  const remainingTimeout = Math.max(1, request.connectTimeoutMs - Math.ceil(performance.now() - startedAt));
  let browserValue: unknown;
  try {
    browserValue = await chromium.connectOverCDP(transport, {
      ...(request.downloadsPath === undefined ? {} : { artifactsDir: request.downloadsPath }),
      isLocal: true,
      noDefaults: true,
      timeout: remainingTimeout,
    });
  } catch (error: unknown) {
    transport.close();
    throw error;
  }
  const browser = requireBrowser(browserValue);
  const disconnect = browser.close;
  if (request.downloadsPath !== undefined) {
    try {
      await enablePlaywrightDownloadEvents(transport, sendCdpMessage, request.downloadsPath);
    } catch (error: unknown) {
      await disconnect();
      throw error;
    }
  }
  let selected: { context: PublicBrowserContext; page: unknown };
  try {
    if (options.dialogHandling === "preserve") {
      for (const context of browser.contexts()) {
        if (!isRecord(context) || typeof context.on !== "function") {
          throw new ChromeMcpExecutionError(
            "CHROME_MCP_BROWSER_DISCONNECTED",
            "Playwright browser context events are unavailable",
          );
        }
        context.on("dialog", () => undefined);
      }
    }
    selected = await findPage(browser, request.selectedTargetId);
    if (options.emulateMedia) retainPageMediaEmulation(browser, options.emulateMedia);
    if (options.pageViewport) {
      await retainPageViewports({
        browser,
        selectedPage: selected.page,
        pageViewport: options.pageViewport,
        viewportMode: request.browserMode === "isolated-virtual-display" ? "native" : "emulated",
      });
    }
  } catch (error: unknown) {
    await disconnect();
    throw error;
  }
  const selectedPage = requirePage(selected.page);
  const selectedContext = selectedPage.context();
  let evaluateWorker: ReturnType<typeof createWorkerEvaluator> | undefined;
  const contextsSurvivingTheCall = new Set(browserContexts(browser));
  if (authorizeOwnerClose && sendAuthorizedBrowserClose) {
    let ownerClosePromise: Promise<void> | undefined;
    const closeBrowserOwner = (resource: OwnerCloseResource): Promise<void> => {
      if (ownerClosePromise) return ownerClosePromise;
      const close = authorizeOwnerClose(resource).then(() =>
        closeBrowserOwnerThroughCdp(transport, sendCdpMessage),
      );
      ownerClosePromise = close;
      close.catch(() => {
        if (ownerClosePromise === close) ownerClosePromise = undefined;
      });
      return close;
    };
    protectOwnerClose(browserValue, "browser", closeBrowserOwner);
    protectOwnerClose(selectedContext, "default-context", closeBrowserOwner);
    protectBrowserCdpSessions(browserValue, authorizeOwnerClose, sendAuthorizedBrowserClose);
  }

  return Object.freeze({
    browser: browserValue,
    context: selectedContext,
    disconnect,
    evaluateWorker: (input: WorkerEvaluationInput, signal: AbortSignal) => {
      evaluateWorker ??= createWorkerEvaluator(transport);
      return evaluateWorker(input, signal);
    },
    locatorFromRecipe: async (recipe: LocatorRecipe) => {
      const target = await findPage(browser, recipe.targetId);
      let scope: PublicLocatorScope = requirePage(target.page);
      for (const frameSelector of recipe.frameChain) {
        scope = requireLocatorScope(scope.frameLocator(frameSelector));
      }
      return scope.locator(recipe.selector);
    },
    markSnapshotRoot: async (locatorValue: unknown, token: SnapshotRootToken) => {
      const locator = requireMarkerLocator(locatorValue);
      const state = parseMarkerState(
        await locator.evaluate(markElement, {
          attributeName: token.attributeName,
          attributeValue: token.attributeValue,
        }),
      );
      return async () => {
        await locator.evaluate(restoreElement, {
          attributeName: token.attributeName,
          attributeValue: token.attributeValue,
          hadAttribute: state.hadAttribute,
          previousValue: state.previousValue,
        });
      };
    },
    page: selected.page,
    pageForTarget: async (targetId: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      const found = Promise.withResolvers<unknown>();
      const removers: (() => void)[] = [];
      let finished = false;
      const inspectPage = async (pageValue: unknown) => {
        if (finished) return;
        const page = requirePage(pageValue);
        if (page.isClosed()) return;
        try {
          if ((await readTargetId(requireContext(page.context()), pageValue)) === targetId) {
            found.resolve(pageValue);
          }
        } catch (error: unknown) {
          if (!page.isClosed()) throw error;
        }
      };
      const onPage = (page: unknown) => inspectPage(page).catch(found.reject);
      const onAbort = () => found.reject(signal.reason);
      try {
        signal.addEventListener("abort", onAbort, { once: true });
        removers.push(() => signal.removeEventListener("abort", onAbort));
        if (
          !isRecord(browserValue) ||
          typeof browserValue.on !== "function" ||
          typeof browserValue.off !== "function"
        ) {
          throw new ChromeMcpExecutionError(
            "CHROME_MCP_BROWSER_DISCONNECTED",
            "Playwright browser events are unavailable",
          );
        }
        const off = browserValue.off;
        const onDisconnect = () =>
          found.reject(
            new ChromeMcpExecutionError(
              "CHROME_MCP_BROWSER_DISCONNECTED",
              "Playwright browser disconnected during page registration",
            ),
          );
        browserValue.on("disconnected", onDisconnect);
        removers.push(() => Reflect.apply(off, browserValue, ["disconnected", onDisconnect]));
        for (const contextValue of browser.contexts()) {
          if (
            !isRecord(contextValue) ||
            typeof contextValue.on !== "function" ||
            typeof contextValue.off !== "function"
          ) {
            throw new ChromeMcpExecutionError(
              "CHROME_MCP_BROWSER_DISCONNECTED",
              "Playwright browser context events are unavailable",
            );
          }
          const removeContextListener = contextValue.off;
          contextValue.on("page", onPage);
          removers.push(() => Reflect.apply(removeContextListener, contextValue, ["page", onPage]));
          for (const page of requireContext(contextValue).pages()) onPage(page);
        }
        return await found.promise;
      } finally {
        finished = true;
        for (const remove of removers) remove();
      }
    },
    targetIdForPage: async (pageValue: unknown) => {
      const entry = contextPages(browser).find((candidate) => candidate.page === pageValue);
      if (!entry) {
        throw new ChromeMcpExecutionError(
          "CHROME_MCP_FOREIGN_PAGE",
          "Selected page does not belong to the current browser owner",
        );
      }
      if (!contextsSurvivingTheCall.has(entry.contextValue)) {
        throw new ChromeMcpExecutionError(
          "CHROME_MCP_FOREIGN_PAGE",
          "Selected page belongs to a browser context created by this call; Playwright disposes that context when the call ends, so it cannot become the session's selected page. Create the page with context.newPage() in the prebound context instead.",
        );
      }
      return readTargetId(entry.context, entry.page);
    },
  });
};
