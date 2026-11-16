import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserMode } from "./modes";
import type { PersistentBrowserMutations } from "./persistent-mutations";
import { type CdpClient, type CdpCommandTimeout, cdpRecord } from "./cdp-connection";
import { ChromeRuntimeError } from "./errors";
import {
  BoundedEventJournal,
  boundedHeaders,
  boundedText,
  type BrowserJournalInput,
  collectConsoleStackTrace,
  JOURNAL_BINARY_PREVIEW_BYTES,
  JOURNAL_CRASH_STATUS_BYTES,
  JOURNAL_ERROR_TEXT_BYTES,
  JOURNAL_FRAME_PREVIEW_BYTES,
} from "./event-journal";
import { ActiveModalRegistry } from "./modals";
import { ChromeTargetRegistry, type GenerationTargetId } from "./target-registry";

type TargetInfo = Readonly<{
  openerId?: string;
  targetId: string;
  title?: string;
  type: string;
  url: string;
}>;

export type DownloadPublication = Readonly<{
  artifactUri?: string;
  byteCount?: number;
}>;

export type DownloadFinishedInput = Readonly<{
  browserMode: BrowserMode;
  connectionId: string;
  downloadId: string;
  ownerGeneration: number;
  path: string;
  suggestedFilename?: string;
  targetId: string;
}>;

export type TargetObserverOptions = Readonly<{
  activeConnectionId?: () => string | undefined;
  browserMode: BrowserMode;
  connection: CdpClient;
  downloadsPath?: string;
  journal: BoundedEventJournal;
  modals: ActiveModalRegistry;
  mutations?: PersistentBrowserMutations;
  onDownloadFinished?: (input: DownloadFinishedInput) => Promise<DownloadPublication>;
  onError: (error: unknown) => void;
  onTargetClosed?: (targetId: string) => void;
  registry: ChromeTargetRegistry;
}>;

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const DOWNLOAD_ATTRIBUTION_LIMIT = 1024;
const MAIN_TARGET_INITIALIZATION_TIMEOUT = {
  milliseconds: 5000,
  onTimeout: "reject",
} as const satisfies CdpCommandTimeout;

type DownloadAttribution = Omit<DownloadFinishedInput, "path">;

const parseTargetInfo = (value: unknown): TargetInfo | undefined => {
  const record = cdpRecord(value);
  if (!record || !isString(record.targetId) || !isString(record.type) || !isString(record.url)) {
    return undefined;
  }
  return Object.freeze({
    ...(isString(record.openerId) ? { openerId: record.openerId } : {}),
    targetId: record.targetId,
    ...(isString(record.title) ? { title: record.title } : {}),
    type: record.type,
    url: record.url,
  });
};

export const normalPageTarget = (target: Pick<TargetInfo, "type" | "url">) =>
  target.type === "page" &&
  !target.url.startsWith("devtools://") &&
  !target.url.startsWith("chrome-extension://") &&
  !target.url.startsWith("chrome-untrusted://");

const stringRecord = (value: unknown): Record<string, string> => {
  const record = cdpRecord(value);
  if (!record) return {};
  const strings: Record<string, string> = {};
  for (const [name, item] of Object.entries(record)) {
    if (typeof item === "string") strings[name] = item;
    else if (typeof item === "number" || typeof item === "boolean") strings[name] = String(item);
  }
  return strings;
};

const targetFromParams = (params: unknown): TargetInfo | undefined =>
  parseTargetInfo(cdpRecord(params)?.targetInfo);

const textPreview = (value: unknown, fallback = ""): string => {
  const record = cdpRecord(value);
  if (!record) return fallback;
  if (typeof record.value === "string") return record.value;
  if (typeof record.description === "string") return record.description;
  if (record.value !== undefined && (typeof record.value === "number" || typeof record.value === "boolean")) {
    return String(record.value);
  }
  return typeof record.type === "string" ? `[${record.type}]` : fallback;
};

type WebSocketFramePayload = Readonly<{
  binaryBytes?: number;
  binaryHexPreview?: string;
  text?: ReturnType<typeof boundedText>;
}>;

const framePayload = (value: string, opcode: number): WebSocketFramePayload => {
  if (opcode === 1) return { text: boundedText(value, JOURNAL_FRAME_PREVIEW_BYTES) };
  const bytes = Buffer.from(value, "base64");
  return {
    binaryBytes: bytes.byteLength,
    binaryHexPreview: bytes.subarray(0, JOURNAL_BINARY_PREVIEW_BYTES).toString("hex"),
  };
};

const createRequestKey = (sessionId: string, requestId: string): string => {
  return `${sessionId}\u0000${requestId}`;
};

export class ChromeTargetObserver {
  readonly browserMode: BrowserMode;
  readonly connection: CdpClient;
  readonly journal: BoundedEventJournal;
  readonly modals: ActiveModalRegistry;
  readonly registry: ChromeTargetRegistry;

  #activeConnectionId: (() => string | undefined) | undefined;
  #downloadAttributions = new Map<string, DownloadAttribution>();
  #downloadTargets = new Map<string, string>();
  #downloadsPath: string | undefined;
  #ensurePagePromise: Promise<GenerationTargetId> | undefined;
  #frameTargets = new Map<string, string>();
  #onDownloadFinished: TargetObserverOptions["onDownloadFinished"];
  #onError: (error: unknown) => void;
  #onTargetClosed: ((targetId: string) => void) | undefined;
  #pendingTargets = new Map<string, Promise<void>>();
  #mutations: PersistentBrowserMutations | undefined;
  #requestUrls = new Map<string, Readonly<{ targetId: string; url: string }>>();
  #sessionTargets = new Map<string, string>();
  #stopped = false;
  #targetLifecycles = new Map<string, symbol>();
  #unlisten: (() => void)[] = [];

  constructor(options: TargetObserverOptions) {
    this.browserMode = options.browserMode;
    this.connection = options.connection;
    this.journal = options.journal;
    this.modals = options.modals;
    this.#mutations = options.mutations;
    this.registry = options.registry;
    this.#activeConnectionId = options.activeConnectionId;
    this.#downloadsPath = options.downloadsPath;
    this.#onDownloadFinished = options.onDownloadFinished;
    this.#onError = options.onError;
    this.#onTargetClosed = options.onTargetClosed;
  }

  async start(): Promise<void> {
    this.#listen("Target.targetCreated", (params) => {
      const target = targetFromParams(params);
      if (target) this.#armTarget(target).catch(this.#onError);
    });
    this.#listen("Target.targetInfoChanged", (params) => this.#targetInfoChanged(params));
    this.#listen("Target.targetActivated", (params) => this.#targetActivated(params));
    this.#listen("Target.targetDestroyed", (params) => this.#targetDestroyed(params));
    this.#listen("Target.targetCrashed", (params) => this.#targetCrashed(params));
    this.#listen("Target.detachedFromTarget", (params) => {
      const sessionId = cdpRecord(params)?.sessionId;
      const targetId = isString(sessionId) ? this.#sessionTargets.get(sessionId) : undefined;
      if (targetId) this.#targetDestroyed({ targetId });
    });
    this.#listenPageEvents();
    this.#listen("Browser.downloadWillBegin", (params) => this.#downloadStarted(params));
    this.#listen("Browser.downloadProgress", (params) => this.#downloadProgress(params));

    await this.connection.send("Target.setDiscoverTargets", { discover: true });
    await this.synchronizeTargets();
  }

  async synchronizeTargets(): Promise<void> {
    const result = cdpRecord(await this.connection.send("Target.getTargets"));
    const targetInfos = result?.targetInfos;
    if (Array.isArray(targetInfos)) {
      await Promise.all(
        targetInfos.map(async (value) => {
          const target = parseTargetInfo(value);
          if (target) await this.#armTarget(target);
        }),
      );
    }
    await Promise.all(this.#pendingTargets.values());
  }

  ensurePage(): Promise<GenerationTargetId> {
    if (this.#ensurePagePromise) return this.#ensurePagePromise;
    const operation = this.#ensurePage();
    this.#ensurePagePromise = operation;
    const clear = () => {
      if (this.#ensurePagePromise === operation) this.#ensurePagePromise = undefined;
    };
    operation.then(clear, clear);
    return operation;
  }

  async #ensurePage(): Promise<GenerationTargetId> {
    let existing = this.registry.mostRecentlyActive() ?? this.registry.first();
    if (existing) return existing;
    const pendingAtEntry = [...this.#pendingTargets.values()];
    await Promise.allSettled(pendingAtEntry);
    existing = this.registry.mostRecentlyActive() ?? this.registry.first();
    if (existing) return existing;
    if (this.browserMode === "main" && this.registry.unavailableTargets().length > 0) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_MAIN_UNAVAILABLE",
        "Chrome accepted the connection, but no existing tab responded to initialization. Reload an unresponsive tab in Chrome, then retry.",
      );
    }
    const result = cdpRecord(await this.connection.send("Target.createTarget", { url: "about:blank" }));
    const targetId = result?.targetId;
    if (!isString(targetId)) throw new Error("Target.createTarget did not return a target ID");
    const infoResult = cdpRecord(await this.connection.send("Target.getTargetInfo", { targetId }));
    const target = parseTargetInfo(infoResult?.targetInfo);
    if (!target) throw new Error("Target.getTargetInfo did not return a page target");
    await this.#armTarget(target);
    const identity = this.registry.identity(targetId);
    this.registry.requireReady(identity);
    return identity;
  }

  async resolvePwaPageTarget(targetId: string, signal: AbortSignal) {
    signal.throwIfAborted();

    const info = cdpRecord(await this.connection.send("Target.getTargetInfo", { targetId }))?.targetInfo;
    const target = parseTargetInfo(info);
    if (!target) {
      throw new ChromeRuntimeError("CHROME_MCP_PWA_FAILED", "PWA launch returned an invalid target");
    }
    if (target.type === "page") {
      await this.#armTarget(target);
      return target.targetId;
    }
    if (target.type !== "tab") {
      throw new ChromeRuntimeError("CHROME_MCP_PWA_FAILED", "PWA launch did not return a browser tab");
    }

    const attached = cdpRecord(
      await this.connection.send("Target.attachToTarget", { targetId, flatten: true }),
    );
    const sessionId = attached?.sessionId;
    if (!isString(sessionId)) {
      throw new ChromeRuntimeError("CHROME_MCP_PWA_FAILED", "PWA tab did not provide a CDP session");
    }

    const page = Promise.withResolvers<TargetInfo>();
    const removeListener = this.connection.on("Target.attachedToTarget", (params, envelope) => {
      if (envelope !== sessionId) return;

      const child = parseTargetInfo(cdpRecord(params)?.targetInfo);
      if (child?.type === "page") {
        page.resolve(child);
      }
    });
    const onAbort = () => page.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });

    if (signal.aborted) {
      onAbort();
    }

    try {
      const [, pageTarget] = await Promise.all([
        this.connection.send(
          "Target.setAutoAttach",
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          sessionId,
        ),
        page.promise,
      ]);

      signal.throwIfAborted();
      await this.#armTarget(pageTarget);
      return pageTarget.targetId;
    } finally {
      removeListener();
      signal.removeEventListener("abort", onAbort);
      await this.connection.send("Target.detachFromTarget", { sessionId });
    }
  }

  async enableOwnedDownloads(downloadsPath: string): Promise<void> {
    await this.connection.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: downloadsPath,
      eventsEnabled: true,
    });
  }

  async handleDialog(
    target: GenerationTargetId,
    dialogId: string,
    accept: boolean,
    promptText?: string,
  ): Promise<void> {
    const dialog = this.modals.closeDialog(target, dialogId);
    try {
      await this.connection.send(
        "Page.handleJavaScriptDialog",
        { accept, ...(promptText === undefined ? {} : { promptText }) },
        dialog.sessionId,
      );
    } catch (error: unknown) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_STALE_MODAL",
        "The JavaScript dialog changed before Chrome handled it",
        {
          cause: error,
        },
      );
    }
    this.journal.append(target.targetId, {
      accepted: accept,
      dialogId,
      ...(promptText === undefined ? {} : { promptText }),
      type: "dialog_closed",
    });
  }

  async setFileChooserFiles(
    target: GenerationTargetId,
    chooserId: string,
    files: readonly string[],
  ): Promise<void> {
    const chooser = this.modals.closeFileChooser(target, chooserId);
    try {
      await this.connection.send(
        "DOM.setFileInputFiles",
        { backendNodeId: chooser.backendNodeId, files: [...files] },
        chooser.sessionId,
      );
    } catch (error: unknown) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_STALE_MODAL",
        "The file chooser changed before Chrome handled it",
        {
          cause: error,
        },
      );
    }
    this.journal.append(target.targetId, { chooserId, type: "file_chooser_closed" });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const unlisten of this.#unlisten.splice(0)) unlisten();
    const sessionIds = [...this.#sessionTargets.keys()];
    this.#sessionTargets.clear();
    this.#downloadAttributions.clear();
    this.#downloadTargets.clear();
    this.#frameTargets.clear();
    this.#requestUrls.clear();
    this.#targetLifecycles.clear();
    await Promise.all(
      sessionIds.map((sessionId) =>
        this.connection.send("Target.detachFromTarget", { sessionId }).catch((error: unknown) => {
          if (!this.connection.closed) this.#onError(error);
        }),
      ),
    );
  }

  #listen(method: string, listener: (params: unknown, sessionId?: string) => void): void {
    this.#unlisten.push(this.connection.on(method, listener));
  }

  #listenPageEvents(): void {
    this.#listen("Runtime.consoleAPICalled", (params, sessionId) => this.#console(params, sessionId));
    this.#listen("Runtime.exceptionThrown", (params, sessionId) => this.#exception(params, sessionId));
    this.#listen("Network.requestWillBeSent", (params, sessionId) => this.#request(params, sessionId));
    this.#listen("Network.responseReceived", (params, sessionId) => this.#response(params, sessionId));
    this.#listen("Network.loadingFinished", (params, sessionId) => this.#requestFinished(params, sessionId));
    this.#listen("Network.loadingFailed", (params, sessionId) => this.#requestFailed(params, sessionId));
    this.#listen("Network.webSocketCreated", (params, sessionId) => this.#webSocketOpened(params, sessionId));
    this.#listen("Network.webSocketFrameSent", (params, sessionId) =>
      this.#webSocketFrame(params, sessionId, "websocket_frame_sent"),
    );
    this.#listen("Network.webSocketFrameReceived", (params, sessionId) =>
      this.#webSocketFrame(params, sessionId, "websocket_frame_received"),
    );
    this.#listen("Network.webSocketFrameError", (params, sessionId) =>
      this.#webSocketError(params, sessionId),
    );
    this.#listen("Network.webSocketClosed", (params, sessionId) => this.#webSocketClosed(params, sessionId));
    this.#listen("Page.frameNavigated", (params, sessionId) => this.#frameNavigated(params, sessionId));
    this.#listen("Page.frameDetached", (params) => this.#frameDetached(params));
    // a dialog can open while its target is still arming; an unregistered-target throw would
    // escape the CDP dispatch loop and take down the whole broker process
    this.#listen("Page.javascriptDialogOpening", (params, sessionId) => {
      try {
        this.#dialogOpened(params, sessionId);
      } catch (error: unknown) {
        this.#onError(error);
      }
    });
    this.#listen("Page.javascriptDialogClosed", (params, sessionId) => {
      try {
        this.#dialogClosed(params, sessionId);
      } catch (error: unknown) {
        this.#onError(error);
      }
    });
    this.#listen("Page.fileChooserOpened", (params, sessionId) => {
      this.#fileChooserOpened(params, sessionId).catch(this.#onError);
    });
  }

  #armTarget(target: TargetInfo): Promise<void> {
    if (this.#stopped || !normalPageTarget(target)) return Promise.resolve();
    const identity = { ownerGeneration: this.registry.ownerGeneration, targetId: target.targetId };
    const previous = this.registry.get(identity);
    if (previous) {
      const unavailableNavigation =
        this.registry.unavailableReason(target.targetId) &&
        (previous.url !== target.url || previous.title !== target.title);
      const pending = this.#pendingTargets.get(target.targetId);
      if (!unavailableNavigation) {
        this.registry.update(target.targetId, {
          openerTargetId: target.openerId,
          title: target.title,
          url: target.url,
        });
        return pending ?? Promise.resolve();
      }

      if (pending) return pending.then(() => this.#armTarget(target));
      this.registry.close(target.targetId);
    }

    const pending = this.#pendingTargets.get(target.targetId);
    if (pending) return pending;
    const lifecycle = this.#targetLifecycles.get(target.targetId) ?? Symbol(target.targetId);
    this.#targetLifecycles.set(target.targetId, lifecycle);
    const operation = this.#armNewTarget(target, lifecycle).finally(() =>
      this.#pendingTargets.delete(target.targetId),
    );
    this.#pendingTargets.set(target.targetId, operation);
    return operation;
  }

  async #armNewTarget(target: TargetInfo, lifecycle: symbol): Promise<void> {
    let attachedSessionId: string | undefined;
    try {
      const attached = cdpRecord(
        await this.connection.send("Target.attachToTarget", { flatten: true, targetId: target.targetId }),
      );
      const sessionId = attached?.sessionId;
      if (!isString(sessionId)) throw new Error(`Could not attach to Chrome target ${target.targetId}`);
      attachedSessionId = sessionId;
      if (!this.#isCurrentTargetLifecycle(target.targetId, lifecycle)) return;
      this.#sessionTargets.set(sessionId, target.targetId);
      this.registry.beginArming({
        ...(target.openerId ? { openerTargetId: target.openerId } : {}),
        targetId: target.targetId,
        ...(target.title === undefined ? {} : { title: target.title }),
        url: target.url,
      });
      const initializationTimeout =
        this.browserMode === "main" ? MAIN_TARGET_INITIALIZATION_TIMEOUT : undefined;
      await Promise.all([
        this.connection.send("Runtime.enable", {}, sessionId, initializationTimeout),
        this.connection.send("Network.enable", {}, sessionId, initializationTimeout),
        this.connection.send("Page.enable", {}, sessionId, initializationTimeout),
        this.connection.send(
          "Page.setInterceptFileChooserDialog",
          { enabled: true },
          sessionId,
          initializationTimeout,
        ),
      ]);
      if (!this.#isCurrentTargetLifecycle(target.targetId, lifecycle)) return;
      const frameTree = cdpRecord(
        await this.connection.send("Page.getFrameTree", {}, sessionId, initializationTimeout),
      )?.frameTree;
      if (!this.#isCurrentTargetLifecycle(target.targetId, lifecycle)) return;
      this.#seedFrameTree(frameTree, target.targetId);
      const activeConnectionId = this.#activeConnectionId?.();
      await this.#mutations?.attachTarget({
        ...(activeConnectionId ? { activeConnectionId } : {}),
        ...(target.openerId ? { openerTargetId: target.openerId } : {}),
        sessionId,
        targetId: target.targetId,
      });
      if (!this.#isCurrentTargetLifecycle(target.targetId, lifecycle)) return;
      if (target.openerId) {
        this.journal.append(target.targetId, {
          openerTargetId: target.openerId,
          popupTargetId: target.targetId,
          type: "popup",
        });
      }
      this.registry.markReady(target.targetId);
    } catch (error: unknown) {
      const unavailable =
        this.browserMode === "main" &&
        error instanceof ChromeRuntimeError &&
        error.code === "CHROME_MCP_TIMEOUT";
      if (unavailable && this.#isCurrentTargetLifecycle(target.targetId, lifecycle)) {
        this.registry.markUnavailable(target.targetId, error.message);
      } else {
        this.registry.close(target.targetId);
      }
      this.modals.clearTarget(target.targetId);
      this.#mutations?.detachTarget(target.targetId);
      for (const [sessionId, targetId] of this.#sessionTargets.entries()) {
        if (targetId === target.targetId) this.#sessionTargets.delete(sessionId);
      }
      if (!this.#isCurrentTargetLifecycle(target.targetId, lifecycle)) return;
      if (attachedSessionId && !this.connection.closed) {
        try {
          await this.connection.send("Target.detachFromTarget", { sessionId: attachedSessionId });
        } catch (detachError: unknown) {
          throw new AggregateError(
            [error, detachError],
            `Chrome target ${target.targetId} failed to arm and detach`,
          );
        }
      }
      if (unavailable) return;
      throw error;
    }
  }

  #targetInfoChanged(params: unknown): void {
    const target = targetFromParams(params);
    if (!target || !normalPageTarget(target)) return;
    const previous = this.registry.get({
      ownerGeneration: this.registry.ownerGeneration,
      targetId: target.targetId,
    });
    if (!previous) return;
    if (this.registry.unavailableReason(target.targetId)) {
      this.#armTarget(target).catch(this.#onError);
      return;
    }
    this.registry.update(target.targetId, {
      openerTargetId: target.openerId,
      title: target.title,
      url: target.url,
    });
  }

  #targetActivated(params: unknown): void {
    const targetId = cdpRecord(params)?.targetId;
    if (!isString(targetId)) return;
    if (this.registry.get({ ownerGeneration: this.registry.ownerGeneration, targetId })) {
      this.registry.activate(targetId);
    }
  }

  #targetCrashed(params: unknown) {
    const record = cdpRecord(params);
    if (!record || !isString(record.targetId) || !isString(record.status) || !isNumber(record.errorCode)) {
      return;
    }
    if (!Number.isSafeInteger(record.errorCode) || !this.registry.record(record.targetId)) {
      return;
    }

    this.journal.append(record.targetId, {
      errorCode: record.errorCode,
      status: boundedText(record.status, JOURNAL_CRASH_STATUS_BYTES),
      type: "target_crashed",
    });
  }

  #targetDestroyed(params: unknown): void {
    const targetId = cdpRecord(params)?.targetId;
    if (!isString(targetId)) return;
    if (!this.#targetLifecycles.delete(targetId)) return;
    this.registry.close(targetId);
    this.#mutations?.detachTarget(targetId);
    this.#onTargetClosed?.(targetId);
    this.modals.clearTarget(targetId);
    for (const [frameId, frameTargetId] of this.#frameTargets) {
      if (frameTargetId === targetId) this.#frameTargets.delete(frameId);
    }
    for (const [requestKey, request] of this.#requestUrls) {
      if (request.targetId === targetId) this.#requestUrls.delete(requestKey);
    }
    for (const [downloadId, downloadTargetId] of this.#downloadTargets) {
      if (downloadTargetId !== targetId) continue;
      this.#downloadAttributions.delete(downloadId);
      this.#downloadTargets.delete(downloadId);
    }
    for (const [sessionId, sessionTargetId] of this.#sessionTargets) {
      if (sessionTargetId === targetId) this.#sessionTargets.delete(sessionId);
    }
  }

  #isCurrentTargetLifecycle(targetId: string, lifecycle: symbol): boolean {
    return !this.#stopped && this.#targetLifecycles.get(targetId) === lifecycle;
  }

  #targetId(sessionId: string | undefined): string | undefined {
    return sessionId ? this.#sessionTargets.get(sessionId) : undefined;
  }

  #append(sessionId: string | undefined, input: BrowserJournalInput): void {
    const targetId = this.#targetId(sessionId);
    if (targetId) this.journal.append(targetId, input);
  }

  #console(params: unknown, sessionId: string | undefined): void {
    const record = cdpRecord(params);
    if (!record) return;
    const args = Array.isArray(record.args) ? record.args : [];
    const previews = args.slice(0, 10).map((value) => boundedText(textPreview(value), 2 * 1024));
    const stack = cdpRecord(record.stackTrace);
    const callFrames = Array.isArray(stack?.callFrames) ? stack.callFrames : [];
    const frame = cdpRecord(callFrames[0]);
    const stackTrace = collectConsoleStackTrace(record.stackTrace);
    this.#append(sessionId, {
      argumentPreviews: previews,
      ...(isNumber(frame?.columnNumber) ? { column: frame.columnNumber } : {}),
      level: isString(record.type) ? record.type : "log",
      ...(isNumber(frame?.lineNumber) ? { line: frame.lineNumber } : {}),
      ...(isString(frame?.url) ? { sourceUrl: frame.url } : {}),
      ...(stackTrace === undefined ? {} : { stackTrace }),
      text: boundedText(previews.map((preview) => preview.preview).join(" "), JOURNAL_ERROR_TEXT_BYTES),
      type: "console",
    });
  }

  #exception(params: unknown, sessionId: string | undefined): void {
    const details = cdpRecord(cdpRecord(params)?.exceptionDetails);
    if (!details) return;
    const exception = cdpRecord(details.exception);
    const message = isString(details.text) ? details.text : textPreview(exception, "Uncaught exception");
    const description = isString(exception?.description) ? exception.description : undefined;
    this.#append(sessionId, {
      message: boundedText(message, JOURNAL_ERROR_TEXT_BYTES),
      name: isString(exception?.className) ? exception.className : "Error",
      ...(description ? { stack: boundedText(description, JOURNAL_ERROR_TEXT_BYTES) } : {}),
      type: "page_error",
    });
  }

  #request(params: unknown, sessionId: string | undefined): void {
    const record = cdpRecord(params);
    const request = cdpRecord(record?.request);
    if (
      !record ||
      !request ||
      !isString(record.requestId) ||
      !isString(request.url) ||
      !isString(request.method)
    ) {
      return;
    }
    const targetId = this.#targetId(sessionId);
    if (targetId && sessionId) {
      this.#requestUrls.set(createRequestKey(sessionId, record.requestId), { targetId, url: request.url });
    }
    this.#append(sessionId, {
      headers: boundedHeaders(stringRecord(request.headers)),
      isNavigation: isString(record.loaderId) && record.loaderId === record.requestId,
      method: request.method,
      requestId: record.requestId,
      resourceType: isString(record.type) ? record.type : "Other",
      type: "request",
      url: request.url,
    });
  }

  #response(params: unknown, sessionId: string | undefined): void {
    const record = cdpRecord(params);
    const response = cdpRecord(record?.response);
    if (
      !record ||
      !response ||
      !isString(record.requestId) ||
      !isString(response.url) ||
      !isNumber(response.status)
    ) {
      return;
    }
    this.#append(sessionId, {
      ...(isNumber(response.encodedDataLength) && response.encodedDataLength >= 0 ?
        { encodedDataLength: response.encodedDataLength }
      : {}),
      headers: boundedHeaders(stringRecord(response.headers)),
      requestId: record.requestId,
      status: response.status,
      statusText: isString(response.statusText) ? response.statusText : "",
      type: "response",
      url: response.url,
    });
  }

  #requestFailed(params: unknown, sessionId: string | undefined): void {
    const record = cdpRecord(params);
    if (!record || !isString(record.requestId) || !isString(record.errorText)) return;
    const requestKey = sessionId ? createRequestKey(sessionId, record.requestId) : undefined;
    const url = requestKey ? this.#requestUrls.get(requestKey)?.url : undefined;
    if (requestKey) this.#requestUrls.delete(requestKey);
    this.#append(sessionId, {
      failureText: boundedText(record.errorText, JOURNAL_ERROR_TEXT_BYTES),
      requestId: record.requestId,
      type: "request_failed",
      ...(url ? { url } : {}),
    });
  }

  #requestFinished(params: unknown, sessionId: string | undefined): void {
    const requestId = cdpRecord(params)?.requestId;
    if (sessionId && isString(requestId)) this.#requestUrls.delete(createRequestKey(sessionId, requestId));
  }

  #webSocketOpened(params: unknown, sessionId: string | undefined): void {
    const record = cdpRecord(params);
    if (!record || !isString(record.requestId) || !isString(record.url)) return;
    this.#append(sessionId, { socketId: record.requestId, type: "websocket_open", url: record.url });
  }

  #webSocketFrame(
    params: unknown,
    sessionId: string | undefined,
    type: "websocket_frame_received" | "websocket_frame_sent",
  ): void {
    const record = cdpRecord(params);
    const response = cdpRecord(record?.response);
    if (
      !record ||
      !response ||
      !isString(record.requestId) ||
      !isNumber(response.opcode) ||
      !isString(response.payloadData)
    ) {
      return;
    }
    this.#append(sessionId, {
      ...framePayload(response.payloadData, response.opcode),
      opcode: response.opcode,
      socketId: record.requestId,
      type,
    });
  }

  #webSocketError(params: unknown, sessionId: string | undefined): void {
    const record = cdpRecord(params);
    if (!record || !isString(record.requestId) || !isString(record.errorMessage)) return;
    this.#append(sessionId, {
      error: boundedText(record.errorMessage, JOURNAL_ERROR_TEXT_BYTES),
      socketId: record.requestId,
      type: "websocket_error",
    });
  }

  #webSocketClosed(params: unknown, sessionId: string | undefined): void {
    const requestId = cdpRecord(params)?.requestId;
    if (isString(requestId)) this.#append(sessionId, { socketId: requestId, type: "websocket_closed" });
  }

  #frameNavigated(params: unknown, sessionId: string | undefined): void {
    const frame = cdpRecord(cdpRecord(params)?.frame);
    const targetId = this.#targetId(sessionId);
    if (targetId && isString(frame?.id)) this.#frameTargets.set(frame.id, targetId);
  }

  #seedFrameTree(value: unknown, targetId: string): void {
    const tree = cdpRecord(value);
    const frame = cdpRecord(tree?.frame);
    if (isString(frame?.id)) this.#frameTargets.set(frame.id, targetId);
    const children = tree?.childFrames;
    if (!Array.isArray(children)) return;
    for (const child of children) this.#seedFrameTree(child, targetId);
  }

  #frameDetached(params: unknown): void {
    const frameId = cdpRecord(params)?.frameId;
    if (isString(frameId)) this.#frameTargets.delete(frameId);
  }

  #dialogOpened(params: unknown, sessionId: string | undefined): void {
    const targetId = this.#targetId(sessionId);
    const record = cdpRecord(params);
    if (!targetId || !sessionId || !record || !isString(record.message) || !isString(record.type)) return;
    const dialog = this.modals.openDialog(this.registry.identity(targetId), sessionId, {
      defaultValue: isString(record.defaultPrompt) ? record.defaultPrompt : "",
      dialogType: record.type,
      message: record.message,
    });
    this.journal.append(targetId, {
      defaultValue: dialog.defaultValue,
      dialogId: dialog.dialogId,
      dialogType: dialog.dialogType,
      message: boundedText(dialog.message, JOURNAL_ERROR_TEXT_BYTES),
      type: "dialog_opened",
    });
  }

  #dialogClosed(params: unknown, sessionId: string | undefined): void {
    const targetId = this.#targetId(sessionId);
    const record = cdpRecord(params);
    if (!targetId || !record || typeof record.result !== "boolean") return;
    const target = this.registry.identity(targetId);
    const active = this.modals.dialog(target);
    if (!active) return;
    this.modals.closeDialog(target, active.dialogId);
    this.journal.append(targetId, {
      accepted: record.result,
      dialogId: active.dialogId,
      ...(isString(record.userInput) ? { promptText: record.userInput } : {}),
      type: "dialog_closed",
    });
  }

  async #fileChooserOpened(params: unknown, sessionId: string | undefined): Promise<void> {
    const targetId = this.#targetId(sessionId);
    const record = cdpRecord(params);
    if (!targetId || !sessionId || !record || !isNumber(record.backendNodeId) || !isString(record.mode)) {
      return;
    }
    const rawDescription = await this.connection
      .send("DOM.describeNode", { backendNodeId: record.backendNodeId, depth: 0 }, sessionId)
      .catch((error: unknown) => {
        this.#onError(error);
        return undefined;
      });
    const description = cdpRecord(rawDescription);
    const node = cdpRecord(description?.node);
    const attributes = Array.isArray(node?.attributes) ? node.attributes : [];
    let accept: string | undefined;
    for (let index = 0; index < attributes.length - 1; index += 2) {
      if (attributes[index] === "accept" && isString(attributes[index + 1])) accept = attributes[index + 1];
    }
    const chooser = this.modals.openFileChooser(this.registry.identity(targetId), sessionId, {
      ...(accept === undefined ? {} : { accept }),
      backendNodeId: record.backendNodeId,
      multiple: record.mode === "selectMultiple",
    });
    this.journal.append(targetId, {
      ...(chooser.accept === undefined ? {} : { accept: chooser.accept }),
      chooserId: chooser.chooserId,
      multiple: chooser.multiple,
      type: "file_chooser_opened",
    });
  }

  #downloadStarted(params: unknown): void {
    const record = cdpRecord(params);
    if (!record || !isString(record.guid) || !isString(record.url) || !isString(record.suggestedFilename)) {
      return;
    }
    const targetId = isString(record.frameId) ? this.#frameTargets.get(record.frameId) : undefined;
    if (!targetId) return;
    this.#downloadTargets.set(record.guid, targetId);
    this.#downloadAttributions.delete(record.guid);
    const connectionId = this.#activeConnectionId?.();
    if (connectionId) {
      while (this.#downloadAttributions.size >= DOWNLOAD_ATTRIBUTION_LIMIT) {
        const oldestDownloadId = this.#downloadAttributions.keys().next().value;
        if (!oldestDownloadId) break;
        this.#downloadAttributions.delete(oldestDownloadId);
      }
      this.#downloadAttributions.set(
        record.guid,
        Object.freeze({
          browserMode: this.browserMode,
          connectionId,
          downloadId: record.guid,
          ownerGeneration: this.registry.ownerGeneration,
          suggestedFilename: record.suggestedFilename,
          targetId,
        }),
      );
    }
    this.journal.append(targetId, {
      downloadId: record.guid,
      suggestedFilename: record.suggestedFilename,
      type: "download_started",
      url: record.url,
    });
  }

  #downloadProgress(params: unknown): void {
    const record = cdpRecord(params);
    if (!record || !isString(record.guid) || !isString(record.state)) return;
    const targetId = this.#downloadTargets.get(record.guid);
    if (!targetId || record.state === "inProgress") return;
    this.#downloadTargets.delete(record.guid);
    const attribution = this.#downloadAttributions.get(record.guid);
    this.#downloadAttributions.delete(record.guid);
    if (record.state === "completed") {
      this.#publishDownload(targetId, record.guid, attribution).catch(this.#onError);
      return;
    }
    this.journal.append(targetId, {
      downloadId: record.guid,
      failureText: boundedText("Chrome canceled the download", JOURNAL_ERROR_TEXT_BYTES),
      status: "canceled",
      type: "download_finished",
    });
  }

  async #publishDownload(
    targetId: string,
    downloadId: string,
    attribution: DownloadAttribution | undefined,
  ): Promise<void> {
    const path = this.#downloadsPath ? join(this.#downloadsPath, downloadId) : undefined;
    let byteCount: number | undefined;
    let artifactUri: string | undefined;
    if (path) {
      try {
        const metadata = await stat(path);
        byteCount = metadata.size;
        const publication =
          attribution && !this.#stopped ?
            await this.#onDownloadFinished?.({ ...attribution, path })
          : undefined;
        artifactUri = publication?.artifactUri;
        byteCount = publication?.byteCount ?? byteCount;
      } catch (error: unknown) {
        this.journal.append(targetId, {
          downloadId,
          failureText: boundedText(
            error instanceof Error ? error.message : String(error),
            JOURNAL_ERROR_TEXT_BYTES,
          ),
          status: "failed",
          type: "download_finished",
        });
        return;
      }
    }
    this.journal.append(targetId, {
      ...(artifactUri ? { artifactUri } : {}),
      ...(byteCount === undefined ? {} : { byteCount }),
      downloadId,
      status: "completed",
      type: "download_finished",
    });
  }
}

export const discoverBrowserProcessId = async (connection: CdpClient): Promise<number | undefined> => {
  const result = cdpRecord(await connection.send("SystemInfo.getProcessInfo"));
  const processInfo = result?.processInfo;
  if (!Array.isArray(processInfo)) return undefined;
  for (const value of processInfo) {
    const record = cdpRecord(value);
    if (record?.type === "browser" && isNumber(record.id) && Number.isSafeInteger(record.id)) {
      return record.id;
    }
  }
  return undefined;
};

export const discoverChromeVersion = async (
  connection: CdpClient,
): Promise<{ major?: number; product?: string }> => {
  const result = cdpRecord(await connection.send("Browser.getVersion"));
  const product = isString(result?.product) ? result.product : undefined;
  const version = product?.match(/\/(\d+)/)?.[1];
  return {
    ...(version ? { major: Number(version) } : {}),
    ...(product ? { product } : {}),
  };
};
