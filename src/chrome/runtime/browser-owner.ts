import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ActiveDialog, ActiveFileChooser } from "./modals";
import type { BrowserMode } from "./modes";
import type { ReactBrowserOperation, ReactOperationResult } from "./react-inspection-protocol";
import { isNodeError } from "../../platform/node-errors";
import { getMcpRuntimeDir } from "../../platform/runtime-paths";
import { type AdmissionOperation, OwnerAdmissionQueue } from "./admission";
import {
  assertChromeExecutable,
  type BrowserLauncher,
  diagnoseMainChromeConnectFailure,
  discoverMainChromeEndpoint,
  type LaunchedBrowserHandle,
  loadPlaywrightBrowserLauncher,
  MAIN_CHROME_CONNECT_TIMEOUT_MS,
  modeLaunchOptions,
  prepareLaunchProfile,
  waitForDevToolsEndpoint,
} from "./browser-launcher";
import { type CdpClient, CdpConnection, cdpRecord } from "./cdp-connection";
import { CdpRelay } from "./cdp-relay";
import { ChromeRuntimeError } from "./errors";
import {
  BoundedEventJournal,
  ClientEventCursorStore,
  type EventCursor,
  type JournalReadOptions,
  type JournalReadResult,
} from "./event-journal";
import { ActiveModalRegistry } from "./modals";
import {
  assertMatchingNativeDeviceScaleFactor,
  assertNativeDeviceScaleFactor,
  browserOwnership,
  isHeadlessMode,
  isIsolatedMode,
  isSharedMode,
  parseBrowserMode,
} from "./modes";
import {
  type BrowserOwnerMetadata,
  readBrowserOwnerMetadata,
  readProfileMetadata,
  removeBrowserCrashMarker,
  writeBrowserCrashMarker,
  writeBrowserOwnerMetadata,
  writeProfileMetadata,
} from "./owner-metadata";
import { connectPageViewportController, type PageViewportRequest } from "./page-viewport";
import {
  type ChromeOwnerKey,
  type ChromeRuntimePathOptions,
  type ChromeRuntimePaths,
  createOwnerKey,
  resolveChromeRuntimePaths,
  resolveMainChromeUserDataDir,
  workspaceIdentity,
} from "./paths";
import {
  PersistentBrowserMutations,
  type PersistentMutationCleanupTombstone,
  type PersistentMutationEntry,
  type PersistentMutationInput,
  type PersistentMutationKind,
  PersistentMutationRegistry,
} from "./persistent-mutations";
import {
  currentProcessStartIdentity,
  probeProcessIdentity,
  type ProcessIdentityProbe,
} from "./process-identity";
import { ProfileLease, type ProfileLeaseOptions, profilePathHash } from "./profile-lease";
import { PWA_INSTALL_RECEIPT_FILE, PwaController, readPwaReceipts } from "./pwa-controller";
import { ReactInspectionManager } from "./react-inspection-manager";
import {
  ChromeTargetObserver,
  discoverBrowserProcessId,
  discoverChromeVersion,
  type DownloadFinishedInput,
  type DownloadPublication,
} from "./target-observer";
import {
  ChromeTargetRegistry,
  ClientSelectionStore,
  type GenerationTargetId,
  type SelectionTransaction,
  type UnavailableTarget,
} from "./target-registry";

export type CdpConnector = (endpoint: string, timeoutMs?: number) => Promise<CdpClient>;

export type ProcessExitWaitOptions = Readonly<{
  now?: () => number;
  pollMs?: number;
  processIdentity?: ProcessIdentityProbe;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}>;

export type BrowserCallAdmission<Result> = AdmissionOperation<Result> &
  Readonly<{ modalPolicy?: "allow" | "reject" }>;

export type BrowserLaunchSettings = Readonly<{
  mainUserDataDir?: string;
  nativeDeviceScaleFactor?: number;
}>;

export type BrowserOwnerOptions = Readonly<{
  cdpConnector?: CdpConnector;
  env?: NodeJS.ProcessEnv;
  executablePath: string;
  generationHint?: number;
  key: ChromeOwnerKey;
  launcher?: BrowserLauncher;
  leaseOptions?: ProfileLeaseOptions;
  mainEndpoint?: () => Promise<{ endpoint: string; userDataDir: string }>;
  mainUserDataDir?: string;
  nativeDeviceScaleFactor?: number;
  onDownloadFinished?: (input: DownloadFinishedInput) => Promise<DownloadPublication>;
  onError: (error: unknown) => void;
  paths: ChromeRuntimePaths;
  processExitWaitMs?: number;
  processIdentity?: ProcessIdentityProbe;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  processStartIdentity?: (pid: number) => Promise<string>;
  shutdownGraceMs?: number;
  transferredProfileLease?: ProfileLease;
}>;

export type BrowserOwnerSnapshot = Readonly<{
  browserConnected: boolean;
  chromeProduct?: string;
  clients: number;
  endpointAvailable: true;
  headless: boolean;
  nativeDeviceScaleFactor?: number;
  key: ChromeOwnerKey;
  ownerGeneration: number;
  ownership: "attached" | "launched";
  selectedTargets: number;
  unavailableTargets?: UnavailableTarget[];
}>;

export type BrowserOwnerCloseResource = "browser" | "default-context";

type OpenedBrowser = Readonly<{
  adopted: boolean;
  connection: CdpClient;
  generation: number;
  launchHandle?: LaunchedBrowserHandle;
  profileLease?: ProfileLease;
}>;

type ClientRecoveryState = Readonly<{
  claimedTargetIds: string[];
  selectedTargetId?: string;
}>;

const aggregateCleanup = (primary: unknown, cleanup: PromiseSettledResult<unknown>[]): never => {
  const errors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 0) throw primary;
  throw new AggregateError([primary, ...errors], "Chrome browser setup and cleanup both failed");
};

export const waitForExactProcessExit = async (
  pid: number,
  processStartIdentity: string,
  options: ProcessExitWaitOptions = {},
): Promise<void> => {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 25;
  const processIdentity = options.processIdentity ?? probeProcessIdentity;
  const sleep = options.sleep ?? Bun.sleep;
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = now() + timeoutMs;
  for (;;) {
    const state = await processIdentity(pid, processStartIdentity);
    if (state === "absent" || state === "different") return;
    if (now() >= deadline) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_BROWSER_DISCONNECTED",
        `Chrome PID ${pid} did not exit with its recorded process identity within ${timeoutMs} ms`,
      );
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
};

const closeAdoptedBrowser = async (
  connection: CdpClient,
  metadata: BrowserOwnerMetadata | undefined,
  options: BrowserOwnerOptions,
): Promise<void> => {
  if (!metadata) throw new Error("Adopted Chrome owner metadata is unavailable during shutdown");
  try {
    await connection.send("Browser.close", {}, undefined, 5000);
  } catch (error: unknown) {
    if (!connection.closed) throw error;
  }
  await waitForExactProcessExit(metadata.browserPid, metadata.processStartIdentity, {
    processIdentity: options.processIdentity,
    timeoutMs: options.processExitWaitMs,
  });
};

const signalProcessIfPresent = (
  signalProcess: (pid: number, signal: NodeJS.Signals) => void,
  pid: number,
  signal: NodeJS.Signals,
): void => {
  try {
    signalProcess(pid, signal);
  } catch (error: unknown) {
    if (!isNodeError(error, "ESRCH")) throw error;
  }
};

const closeLaunchedBrowser = async (
  handle: LaunchedBrowserHandle,
  connection: CdpClient,
  metadata: BrowserOwnerMetadata | undefined,
  options: BrowserOwnerOptions,
): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      handle.close(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Chrome browser context close timed out")),
          options.processExitWaitMs ?? 5000,
        );
      }),
    ]);
  } catch (error: unknown) {
    if (!metadata) throw error;
    connection.close();
    const processIdentity = options.processIdentity ?? probeProcessIdentity;
    const identity = await processIdentity(metadata.browserPid, metadata.processStartIdentity);
    if (identity === "unknown") throw error;
    if (identity === "same") {
      if (metadata.browserPid === process.pid) throw error;
      const signalProcess =
        options.signalProcess ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
      signalProcessIfPresent(signalProcess, metadata.browserPid, "SIGTERM");
      try {
        await waitForExactProcessExit(metadata.browserPid, metadata.processStartIdentity, {
          processIdentity,
          timeoutMs: Math.min(1000, options.processExitWaitMs ?? 5000),
        });
      } catch {
        if ((await processIdentity(metadata.browserPid, metadata.processStartIdentity)) === "same") {
          signalProcessIfPresent(signalProcess, metadata.browserPid, "SIGKILL");
        }
        await waitForExactProcessExit(metadata.browserPid, metadata.processStartIdentity, {
          processIdentity,
          timeoutMs: options.processExitWaitMs,
        });
      }
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const validateSharedProfile = async (options: BrowserOwnerOptions): Promise<void> => {
  if (!isSharedMode(options.key.mode)) return;
  const metadata = await readProfileMetadata(options.paths.metadataPath);
  if (
    metadata &&
    (metadata.workspaceHash !== options.key.workspaceHash || metadata.mode !== options.key.mode)
  ) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_INVALID_PROFILE_METADATA",
      "Chrome profile metadata does not match the requested workspace and browser mode",
    );
  }
};

const tryAdoptSharedBrowser = async (
  options: BrowserOwnerOptions,
  connector: CdpConnector,
  prior: BrowserOwnerMetadata | undefined,
): Promise<CdpClient | undefined> => {
  if (!isSharedMode(options.key.mode) || !prior || prior.cleanShutdown) return undefined;
  if (
    prior.mode !== options.key.mode ||
    prior.profilePathHash !== profilePathHash(options.paths.userDataDir)
  ) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_INVALID_PROFILE_METADATA",
      "Chrome owner metadata does not match its profile",
    );
  }
  const processState = await (options.processIdentity ?? probeProcessIdentity)(
    prior.browserPid,
    prior.processStartIdentity,
  );
  if (processState === "absent" || processState === "different") return undefined;
  if (processState === "unknown") {
    throw new ChromeRuntimeError(
      "CHROME_MCP_PROFILE_IN_USE",
      `Chrome profile still names live PID ${prior.browserPid}, but its exact identity cannot be verified`,
    );
  }
  try {
    return await connector(prior.endpoint, 5000);
  } catch (error: unknown) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_PROFILE_IN_USE",
      `Chrome PID ${prior.browserPid} still owns the profile but its CDP endpoint cannot be adopted`,
      { cause: error },
    );
  }
};

const describeMainUserDataDir = (mainUserDataDir: string | undefined) =>
  mainUserDataDir ?? "Google Chrome's default profile folder";

const assertMatchingMainUserDataDir = (attached: string | undefined, requested: string | undefined) => {
  if (attached === requested) return;

  throw new ChromeRuntimeError(
    "CHROME_MCP_MAIN_UNAVAILABLE",
    `Another session on this workspace has "main" attached to the browser in ${describeMainUserDataDir(attached)}, but this server is configured for ${describeMainUserDataDir(requested)}. Start both servers with the same --main-user-data-dir, or retry after the other session stops using "main"`,
  );
};

const openBrowser = async (options: BrowserOwnerOptions): Promise<OpenedBrowser> => {
  const connector = options.cdpConnector ?? CdpConnection.connect;
  if (options.key.mode === "main") {
    const discovery =
      options.mainEndpoint ??
      (() =>
        discoverMainChromeEndpoint(options.mainUserDataDir ?? resolveMainChromeUserDataDir(options.env)));
    const { endpoint, userDataDir } = await discovery();
    try {
      return Object.freeze({
        adopted: false,
        connection: await connector(endpoint, MAIN_CHROME_CONNECT_TIMEOUT_MS),
        generation: options.generationHint ?? 1,
      });
    } catch (error: unknown) {
      throw await diagnoseMainChromeConnectFailure(endpoint, userDataDir, error);
    }
  }

  let lease = options.transferredProfileLease;
  let launchHandle: LaunchedBrowserHandle | undefined;
  let connection: CdpClient | undefined;
  try {
    await validateSharedProfile(options);
    if (isSharedMode(options.key.mode) && !lease) {
      lease = await ProfileLease.acquire(
        options.paths.leasePath,
        options.paths.userDataDir,
        options.leaseOptions,
      );
    }
    const prior = await readBrowserOwnerMetadata(options.paths.ownerMetadataPath);
    const generation = Math.max(options.generationHint ?? 1, (prior?.ownerGeneration ?? 0) + 1);
    const adoptedConnection = await tryAdoptSharedBrowser(options, connector, prior);
    if (adoptedConnection) {
      return Object.freeze({
        adopted: true,
        connection: adoptedConnection,
        generation,
        ...(lease ? { profileLease: lease } : {}),
      });
    }

    await assertChromeExecutable(options.executablePath);
    await prepareLaunchProfile(options.paths.userDataDir, options.paths.downloadsPath);
    const launcher = options.launcher ?? (await loadPlaywrightBrowserLauncher());
    launchHandle = await launcher.launch(
      modeLaunchOptions({
        mode: options.key.mode,
        executablePath: options.executablePath,
        userDataDir: options.paths.userDataDir,
        downloadsPath: options.paths.downloadsPath,
        nativeDeviceScaleFactor: options.nativeDeviceScaleFactor,
      }),
    );
    const endpoint = await waitForDevToolsEndpoint(options.paths.userDataDir);
    connection = await connector(endpoint);
    return Object.freeze({
      adopted: false,
      connection,
      generation,
      launchHandle,
      ...(lease ? { profileLease: lease } : {}),
    });
  } catch (error: unknown) {
    const pwaReceipts =
      isIsolatedMode(options.key.mode) ?
        await Promise.allSettled([readPwaReceipts(join(options.paths.profileRoot, PWA_INSTALL_RECEIPT_FILE))])
      : [];
    const canRemoveProfile = pwaReceipts.every((result) => {
      if (result.status === "rejected") return false;
      return result.value.length === 0;
    });
    const shouldRemoveIsolatedProfile = isIsolatedMode(options.key.mode) && canRemoveProfile;

    connection?.close();
    const browserCleanup = launchHandle ? await Promise.allSettled([launchHandle.close()]) : [];
    const browserClosed = browserCleanup[0]?.status !== "rejected";
    const releaseLease = browserClosed && !options.transferredProfileLease;
    const storageCleanup =
      browserClosed ?
        await Promise.allSettled([
          ...(lease && releaseLease ? [lease.release()] : []),
          ...(shouldRemoveIsolatedProfile ?
            [rm(options.paths.profileRoot, { force: true, recursive: true })]
          : []),
        ])
      : [];
    const cleanup = [...browserCleanup, ...storageCleanup, ...pwaReceipts];
    if (!canRemoveProfile) {
      cleanup.push({
        status: "rejected",
        reason: new ChromeRuntimeError(
          "CHROME_MCP_PWA_FAILED",
          "The profile was preserved because PWA cleanup could not be confirmed",
        ),
      });
    }

    return aggregateCleanup(error, cleanup);
  }
};

export class BrowserOwner {
  readonly admission = new OwnerAdmissionQueue();
  readonly connection: CdpClient;
  readonly eventCursors = new ClientEventCursorStore();
  readonly journal: BoundedEventJournal;
  readonly key: ChromeOwnerKey;
  readonly modals: ActiveModalRegistry;
  readonly mutations: PersistentBrowserMutations;
  readonly observer: ChromeTargetObserver;
  readonly ownerGeneration: number;
  readonly paths: ChromeRuntimePaths;
  readonly registry: ChromeTargetRegistry;
  readonly react: ReactInspectionManager;
  readonly pwa: PwaController;
  readonly relay: CdpRelay;
  readonly selections: ClientSelectionStore;

  #adopted: boolean;
  #activeConnectionId: string | undefined;
  #admittedCalls = 0;
  #chromeMajorVersion: number | undefined;
  #chromeProduct: string | undefined;
  #clients = new Set<string>();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #launchHandle: LaunchedBrowserHandle | undefined;
  #viewportConnection: ReturnType<typeof connectPageViewportController> | undefined;
  #workerScope: ReturnType<CdpRelay["createScope"]> | undefined;
  #metadata: BrowserOwnerMetadata | undefined;
  #onError: (error: unknown) => void;
  #options: BrowserOwnerOptions;
  #profileLease: ProfileLease | undefined;
  #selectionTransactions = new WeakMap<SelectionTransaction, string>();
  #sharedLeaseHandoffPrepared = false;

  private constructor(options: BrowserOwnerOptions, opened: OpenedBrowser) {
    this.key = options.key;
    this.paths = options.paths;
    this.connection = opened.connection;
    this.ownerGeneration = opened.generation;
    this.#adopted = opened.adopted;
    this.#launchHandle = opened.launchHandle;
    this.#profileLease = opened.profileLease;
    this.#onError = options.onError;
    this.#options = options;
    this.registry = new ChromeTargetRegistry(opened.generation);
    this.selections = new ClientSelectionStore(this.registry);
    this.journal = new BoundedEventJournal(opened.generation);
    this.modals = new ActiveModalRegistry(opened.generation);
    this.mutations = new PersistentBrowserMutations(opened.connection, options.onError);
    this.react = new ReactInspectionManager(opened.connection, options.onError);

    this.pwa = new PwaController({
      sendCommand: opened.launchHandle?.sendPwaCommand,
      mode: this.key.mode,
      receiptPath: join(this.paths.profileRoot, PWA_INSTALL_RECEIPT_FILE),
      resolvePageTarget: (targetId, signal) => this.observer.resolvePwaPageTarget(targetId, signal),
    });

    this.relay = CdpRelay.listen(opened.connection, (targetId) => this.registry.unavailableReason(targetId));
    this.observer = new ChromeTargetObserver({
      activeConnectionId: () => {
        const connectionId = this.#activeConnectionId;
        return connectionId && this.#clients.has(connectionId) ? connectionId : undefined;
      },
      browserMode: this.key.mode,
      connection: opened.connection,
      ...(this.key.mode === "main" ? {} : { downloadsPath: this.paths.downloadsPath }),
      journal: this.journal,
      modals: this.modals,
      mutations: this.mutations,
      onDownloadFinished: options.onDownloadFinished,
      onError: options.onError,
      onTargetClosed: (targetId) => {
        const record = this.registry.record(targetId);
        if (record) this.selections.onTargetClosed(record);
        this.react.closeTarget(targetId).catch(this.#onError);
      },
      registry: this.registry,
    });
    opened.profileLease?.waitForFailure().then((error) => {
      this.#onError(error);
      this.close().catch(this.#onError);
    });
    opened.connection.waitForClose().then(() => {
      if (!this.#closing) {
        this.#onError(
          new ChromeRuntimeError("CHROME_MCP_BROWSER_DISCONNECTED", "Chrome browser disconnected"),
        );
      }
    });
  }

  static async create(options: BrowserOwnerOptions): Promise<BrowserOwner> {
    const opened = await openBrowser(options);
    const owner = new BrowserOwner(options, opened);
    try {
      await owner.observer.start();
      if (options.key.mode !== "main") await owner.observer.enableOwnedDownloads(options.paths.downloadsPath);
      await owner.observer.ensurePage();
      await owner.#recordOpenMetadata();

      return owner;
    } catch (error: unknown) {
      const cleanup = await Promise.allSettled([
        owner.#closeOwner(
          options.transferredProfileLease ? { preserveProfileLease: options.transferredProfileLease } : {},
        ),
      ]);
      let failure = error;
      if (options.key.mode === "main") {
        failure = new ChromeRuntimeError(
          error instanceof ChromeRuntimeError ? error.code : "CHROME_MCP_MAIN_UNAVAILABLE",
          `Chrome accepted the main debugging connection, but session initialization failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      return aggregateCleanup(failure, cleanup);
    }
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get disconnected(): boolean {
    return this.#closed || this.connection.closed;
  }

  get nativeDeviceScaleFactor() {
    return this.#options.nativeDeviceScaleFactor;
  }

  get mainUserDataDir() {
    return this.#options.mainUserDataDir;
  }

  getWorkerEndpoints() {
    if (this.#closed || this.connection.closed || this.relay.closed) {
      throw new ChromeRuntimeError("CHROME_MCP_BROWSER_DISCONNECTED", "Chrome browser owner is disconnected");
    }
    if (!this.#workerScope) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_OWNER_CLOSED",
        "Chrome worker connection requires an active owner admission",
      );
    }

    return { endpoint: this.relay.endpoint, executionEndpoint: this.#workerScope.endpoint };
  }

  async pageViewport(request: PageViewportRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    const targetClosed = new AbortController();
    const remove = this.connection.on("Target.targetDestroyed", (params) => {
      if (cdpRecord(params)?.targetId === request.targetId) {
        targetClosed.abort(
          new ChromeRuntimeError(
            "CHROME_MCP_UNKNOWN_TARGET",
            "Chrome viewport target closed during page registration",
          ),
        );
      }
    });

    try {
      const target = { ownerGeneration: this.ownerGeneration, targetId: request.targetId };
      if (!this.registry.ready(target)) {
        await this.observer.synchronizeTargets();
      }
      this.registry.requireReady(target);

      let controller = this.#launchHandle?.pageViewport;
      if (!controller) {
        this.#viewportConnection ??= connectPageViewportController(this.relay.endpoint);
        try {
          const viewportConnection = await this.#viewportConnection;
          controller = viewportConnection.pageViewport;
        } catch (error: unknown) {
          this.#viewportConnection = undefined;
          throw error;
        }
      }

      return await controller(request, AbortSignal.any([signal, targetClosed.signal]));
    } finally {
      remove();
    }
  }

  async #disconnectViewport() {
    const connection = this.#viewportConnection;
    if (connection) {
      const viewportConnection = await connection;
      await viewportConnection.disconnect();
      this.#viewportConnection = undefined;
    }
  }

  async addClient(
    clientId: string,
    mutations: PersistentMutationRegistry,
    recovery?: ClientRecoveryState,
  ): Promise<GenerationTargetId> {
    return this.admission.admit({
      run: async () => {
        if (this.#closed || this.#closing) {
          throw new ChromeRuntimeError("CHROME_MCP_OWNER_CLOSED", "Chrome browser owner is closing");
        }
        if (this.connection.closed) {
          throw new ChromeRuntimeError(
            "CHROME_MCP_BROWSER_DISCONNECTED",
            "Chrome browser owner is disconnected",
          );
        }
        await this.observer.ensurePage();
        this.#clients.add(clientId);
        this.mutations.addClient(clientId, mutations);
        let selected = this.selections.addClient(clientId);
        let recoveredSelected: GenerationTargetId | undefined;
        if (recovery?.selectedTargetId !== undefined) {
          recoveredSelected = { ownerGeneration: this.ownerGeneration, targetId: recovery.selectedTargetId };
        }
        if (recoveredSelected && this.registry.ready(recoveredSelected)) {
          selected = recoveredSelected;
          this.selections.commit(clientId, selected);
        }
        if (!mutations.empty) {
          const recoveredClaims =
            recovery?.claimedTargetIds
              .map((targetId) => ({ ownerGeneration: this.ownerGeneration, targetId }))
              .filter((target) => this.registry.ready(target)) ?? [];
          const claims =
            recoveredClaims.some((target) => target.targetId === selected.targetId) ? recoveredClaims : (
              [...recoveredClaims, selected]
            );
          for (const claimed of claims) await this.mutations.claimTarget(clientId, claimed);
        }
        return selected;
      },
    });
  }

  authorizeClose(clientId: string, resource: BrowserOwnerCloseResource): void {
    this.#requireClient(clientId);
    if (this.#activeConnectionId !== clientId) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
        "Browser-owner close requires an active call",
      );
    }
    const resourceName = resource === "browser" ? "browser" : "broker-owned default context";
    const remediation = "Close pages or additional contexts created by this call instead";
    if (this.key.mode === "main") {
      throw new ChromeRuntimeError(
        "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
        `Cannot close the ${resourceName}: main mode belongs to the user. ${remediation}`,
      );
    }

    const hasPriorHistory = this.#adopted || this.ownerGeneration !== 1 || this.#admittedCalls !== 1;
    const isCloseBlockedByHistory = hasPriorHistory && !isIsolatedMode(this.key.mode);
    if (isCloseBlockedByHistory) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
        `Cannot close the ${resourceName}: this browser has prior owner or call history and may be shared by multiple agents. ${remediation}`,
      );
    }

    if (this.#clients.size > 1 || this.admission.pending > 0) {
      const clientLabel = `${this.#clients.size} MCP ${this.#clients.size === 1 ? "client" : "clients"}`;
      const queuedLabel = `${this.admission.pending} queued ${this.admission.pending === 1 ? "call" : "calls"}`;
      throw new ChromeRuntimeError(
        "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
        `Cannot close the ${resourceName}: ${clientLabel} and ${queuedLabel} share this browser owner. ${remediation}`,
      );
    }
  }

  async removeClient(clientId: string): Promise<void> {
    await this.mutations.removeClient(clientId);
    await this.forgetClient(clientId);
  }

  private async forgetClient(clientId: string) {
    try {
      await this.react.closeConnection(clientId);
    } finally {
      this.#clients.delete(clientId);
      this.selections.removeClient(clientId);
      this.eventCursors.removeClient(clientId);
    }
  }

  recoveryState(clientId: string): ClientRecoveryState {
    const selected = this.selections.recoverableSelection(clientId);
    return {
      claimedTargetIds: this.mutations.claimedTargetIds(clientId),
      ...(selected ? { selectedTargetId: selected.targetId } : {}),
    };
  }

  createMutationCleanupTombstone(clientId: string): PersistentMutationCleanupTombstone | undefined {
    return this.mutations.createCleanupTombstone(clientId);
  }

  async drainMutationCleanupTombstone(tombstone: PersistentMutationCleanupTombstone): Promise<void> {
    await this.mutations.drainCleanupTombstone(tombstone);
    await this.forgetClient(tombstone.clientId);
  }

  selectedTarget(clientId: string): GenerationTargetId {
    this.#requireClient(clientId);
    return this.selections.selected(clientId);
  }

  async beginSelection(clientId: string): Promise<SelectionTransaction> {
    this.#requireClient(clientId);
    await this.observer.ensurePage();
    this.#requireClient(clientId);
    const transaction = this.selections.begin(clientId);
    this.#selectionTransactions.set(transaction, clientId);
    return transaction;
  }

  async commitSelection(clientId: string, transaction: SelectionTransaction): Promise<GenerationTargetId> {
    this.#requireClient(clientId);
    this.#requireSelectionTransaction(clientId, transaction);
    await this.observer.synchronizeTargets();
    const target = transaction.commit();
    this.#selectionTransactions.delete(transaction);
    return target;
  }

  recordCreatedTarget(clientId: string, transaction: SelectionTransaction, target: GenerationTargetId): void {
    this.#requireClient(clientId);
    this.#requireSelectionTransaction(clientId, transaction);
    transaction.recordCreated(target);
  }

  rollbackSelection(clientId: string, transaction: SelectionTransaction): GenerationTargetId {
    this.#requireClient(clientId);
    this.#requireSelectionTransaction(clientId, transaction);
    const target = transaction.rollback();
    this.#selectionTransactions.delete(transaction);
    return target;
  }

  markEvents(clientId: string): EventCursor {
    this.#requireClient(clientId);
    return this.eventCursors.mark(clientId, this.journal);
  }

  readEvents(
    clientId: string,
    options: JournalReadOptions & Readonly<{ advance?: boolean }> = {},
  ): JournalReadResult {
    this.#requireClient(clientId);
    const target = options.target ?? this.selectedTarget(clientId).targetId;
    return this.eventCursors.read(clientId, this.journal, { ...options, target });
  }

  activeDialog(clientId: string): ActiveDialog | undefined {
    return this.modals.dialog(this.selectedTarget(clientId));
  }

  activeFileChooser(clientId: string): ActiveFileChooser | undefined {
    return this.modals.fileChooser(this.selectedTarget(clientId));
  }

  requireNoBlockingModal(clientId: string): void {
    this.modals.requireUnblocked(this.selectedTarget(clientId));
  }

  handleDialog(clientId: string, dialogId: string, accept: boolean, promptText?: string): Promise<void> {
    const target = this.selectedTarget(clientId);
    return this.observer.handleDialog(target, dialogId, accept, promptText);
  }

  enableOwnedDownloads(clientId: string): Promise<void> {
    this.#requireClient(clientId);
    if (this.key.mode === "main") return Promise.resolve();
    return this.observer.enableOwnedDownloads(this.paths.downloadsPath);
  }

  invalidate(clientId: string): void {
    this.#requireClient(clientId);
    this.connection.invalidate();
  }

  setFileChooserFiles(clientId: string, chooserId: string, files: readonly string[]): Promise<void> {
    const target = this.selectedTarget(clientId);
    return this.observer.setFileChooserFiles(target, chooserId, files);
  }

  admit<Result>(clientId: string, operation: BrowserCallAdmission<Result>): Promise<Result> {
    this.#requireClient(clientId);
    if (this.connection.closed) {
      return Promise.reject(
        new ChromeRuntimeError("CHROME_MCP_BROWSER_DISCONNECTED", "Chrome browser owner is disconnected"),
      );
    }
    return this.admission.admit({
      force: operation.force,
      run: async (signal) => {
        this.#activeConnectionId = clientId;
        this.#admittedCalls += 1;
        const workerScope = this.relay.createScope();
        this.#workerScope = workerScope;

        try {
          await this.observer.ensurePage();
          const selected = this.selections.addClient(clientId);
          this.mutations.assertTargetAccessible(clientId, selected);
          await this.mutations.reconcileClient(clientId);
          if (operation.modalPolicy === "reject") this.requireNoBlockingModal(clientId);
          return await operation.run(signal);
        } finally {
          try {
            await workerScope.close();
          } finally {
            this.#workerScope = undefined;

            if (this.#activeConnectionId === clientId) {
              this.#activeConnectionId = undefined;
            }
          }
        }
      },
      signal: operation.signal,
    });
  }

  snapshot(): BrowserOwnerSnapshot {
    const unavailableTargets = this.registry.unavailableTargets();
    return Object.freeze({
      browserConnected: !this.disconnected,
      ...(this.#chromeProduct ? { chromeProduct: this.#chromeProduct } : {}),
      clients: this.#clients.size,
      endpointAvailable: true,
      headless: isHeadlessMode(this.key.mode),
      ...(this.nativeDeviceScaleFactor === undefined ?
        {}
      : { nativeDeviceScaleFactor: this.nativeDeviceScaleFactor }),
      key: this.key,
      ownerGeneration: this.ownerGeneration,
      ownership: browserOwnership(this.key.mode),
      selectedTargets: this.registry.liveRecords().length,
      ...(unavailableTargets.length > 0 ? { unavailableTargets } : {}),
    });
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closePromise) return this.#closePromise;
    const closePromise = this.#closeOwner();
    this.#closePromise = closePromise;
    closePromise.then(undefined, () => {
      if (this.#closePromise === closePromise) this.#closePromise = undefined;
    });
    return closePromise;
  }

  async handoffDisconnectedSharedLease(): Promise<ProfileLease> {
    if (!isSharedMode(this.key.mode) || !this.connection.closed || this.#closed) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_BROWSER_DISCONNECTED",
        "Chrome owner cannot hand off its profile lease",
      );
    }
    const lease = this.#profileLease;
    if (!lease) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_PROFILE_LEASE_LOST",
        "Chrome owner has no profile lease to hand off",
      );
    }
    if (this.#sharedLeaseHandoffPrepared) return lease;
    this.#closing = true;
    const cleanup = await Promise.allSettled([
      this.admission.shutdown(this.#options.shutdownGraceMs),
      this.observer.stop(),
      this.react.close(),
      this.#disconnectViewport(),
    ]);
    this.mutations.stop();
    for (const failure of cleanup) {
      if (failure.status === "rejected") this.#onError(failure.reason);
    }
    this.relay.close();
    this.connection.close();
    if (this.connection.poisoned && this.#launchHandle) {
      await closeLaunchedBrowser(this.#launchHandle, this.connection, this.#metadata, this.#options);
      await this.#recordCleanShutdown();
      this.#launchHandle = undefined;
    }
    this.#sharedLeaseHandoffPrepared = true;
    return lease;
  }

  commitDisconnectedSharedLeaseHandoff(lease: ProfileLease): void {
    if (!this.#sharedLeaseHandoffPrepared || this.#profileLease !== lease) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_PROFILE_LEASE_LOST",
        "Chrome profile lease handoff is no longer current",
      );
    }
    this.#profileLease = undefined;
    this.#launchHandle = undefined;
    this.#clients.clear();
    this.#closed = true;
    this.#closing = false;
  }

  abortRecovery(lease: ProfileLease): Promise<void> {
    if (this.#profileLease !== lease) {
      return Promise.reject(
        new ChromeRuntimeError("CHROME_MCP_PROFILE_LEASE_LOST", "Chrome recovery lease is no longer current"),
      );
    }
    return this.#closeOwner({ preserveMutationRegistries: true, preserveProfileLease: lease });
  }

  closeFailedRecovery(): Promise<void> {
    return this.#closeOwner({ preserveMutationRegistries: true });
  }

  async #closeOwner(
    options: Readonly<{
      preserveMutationRegistries?: boolean;
      preserveProfileLease?: ProfileLease;
    }> = {},
  ): Promise<void> {
    if (options.preserveProfileLease && this.#profileLease !== options.preserveProfileLease) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_PROFILE_LEASE_LOST",
        "Chrome recovery lease is no longer current",
      );
    }
    this.#closing = true;
    const admissionCleanup = await Promise.allSettled([
      this.admission.shutdown(this.#options.shutdownGraceMs),
    ]);
    const pwaCleanup = await Promise.allSettled([this.pwa.close()]);
    const didCleanPwas = pwaCleanup.every((result) => result.status === "fulfilled");

    const mutationCleanup =
      this.connection.closed ?
        []
      : await Promise.allSettled([
          this.mutations.close(options.preserveMutationRegistries ? { preserveRegistries: true } : {}),
        ]);
    const observerCleanup = await Promise.allSettled([this.observer.stop()]);
    const reactCleanup = await Promise.allSettled([this.react.close()]);
    const viewportCleanup = await Promise.allSettled([this.#disconnectViewport()]);
    this.mutations.stop();
    this.relay.close();
    let browserClose: Promise<unknown> = Promise.resolve();
    if (this.key.mode === "main") {
      browserClose = Promise.resolve().then(() => this.connection.close());
    } else if (this.#launchHandle) {
      browserClose = closeLaunchedBrowser(this.#launchHandle, this.connection, this.#metadata, this.#options);
    } else if (this.#adopted) {
      browserClose = closeAdoptedBrowser(this.connection, this.#metadata, this.#options);
    }
    const browserCleanup = await Promise.allSettled([browserClose]);
    const browserClosed = browserCleanup[0]?.status === "fulfilled";
    this.connection.close();
    const shouldRecordCleanShutdown = browserClosed && didCleanPwas;
    const metadataCleanup =
      shouldRecordCleanShutdown ? await Promise.allSettled([this.#recordCleanShutdown()]) : [];
    const leaseCleanup =
      browserClosed && this.#profileLease && !options.preserveProfileLease ?
        await Promise.allSettled([this.#profileLease.release()])
      : [];
    const failures = [
      ...admissionCleanup,
      ...pwaCleanup,
      ...mutationCleanup,
      ...observerCleanup,
      ...reactCleanup,
      ...viewportCleanup,
      ...browserCleanup,
      ...metadataCleanup,
      ...leaseCleanup,
    ].filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (options.preserveProfileLease) this.#profileLease = undefined;
    if (failures.length === 0 || options.preserveProfileLease) {
      this.#clients.clear();
      this.#closed = true;
    }
    this.#closing = false;
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Chrome owner cleanup failed",
      );
    }
  }

  async #recordCleanShutdown(): Promise<void> {
    if (this.key.mode === "main") return;
    if (isIsolatedMode(this.key.mode)) {
      await rm(this.paths.profileRoot, { force: true, recursive: true });
      return;
    }
    if (this.#metadata) {
      await writeBrowserOwnerMetadata(this.paths.ownerMetadataPath, {
        ...this.#metadata,
        cleanShutdown: true,
        updatedAt: new Date().toISOString(),
      });
    }
    if (isSharedMode(this.key.mode)) {
      await writeProfileMetadata(this.paths.metadataPath, {
        ...(this.#chromeMajorVersion === undefined ? {} : { chromeMajorVersion: this.#chromeMajorVersion }),
        cleanShutdown: true,
        mode: this.key.mode,
        workspaceHash: this.key.workspaceHash,
      });
    }
    await removeBrowserCrashMarker(this.paths.crashMarkerPath);
  }

  async #recordOpenMetadata() {
    const version = await discoverChromeVersion(this.connection);
    this.#chromeProduct = version.product;
    this.#chromeMajorVersion = version.major;
    if (this.key.mode === "main") return;
    const browserPid = await discoverBrowserProcessId(this.connection);
    if (!browserPid) {
      throw new Error("Chrome did not report its browser process ID through SystemInfo.getProcessInfo");
    }
    const metadata: BrowserOwnerMetadata = Object.freeze({
      browserPid,
      cleanShutdown: false,
      endpoint: this.connection.endpoint,
      mode: this.key.mode,
      ownerGeneration: this.ownerGeneration,
      processStartIdentity: await (this.#options.processStartIdentity ?? currentProcessStartIdentity)(
        browserPid,
      ),
      profilePathHash: profilePathHash(this.paths.userDataDir),
      updatedAt: new Date().toISOString(),
    });
    await writeBrowserOwnerMetadata(this.paths.ownerMetadataPath, metadata);
    await writeBrowserCrashMarker(this.paths.crashMarkerPath, {
      createdAt: new Date().toISOString(),
      ownerGeneration: this.ownerGeneration,
    });
    this.#metadata = metadata;
    if (isSharedMode(this.key.mode)) {
      await writeProfileMetadata(this.paths.metadataPath, {
        ...(version.major === undefined ? {} : { chromeMajorVersion: version.major }),
        cleanShutdown: false,
        mode: this.key.mode,
        workspaceHash: this.key.workspaceHash,
      });
    }

    return metadata;
  }

  #requireClient(clientId: string): void {
    if (!this.#clients.has(clientId)) {
      throw new ChromeRuntimeError("CHROME_MCP_OWNER_CLOSED", "Chrome client lease is not active");
    }
  }

  #requireSelectionTransaction(clientId: string, transaction: SelectionTransaction): void {
    if (this.#selectionTransactions.get(transaction) !== clientId) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_STALE_TARGET",
        "Selection transaction does not belong to this Chrome client",
      );
    }
  }
}

export type ChromeBrowserBrokerOptions = Readonly<{
  cdpConnector?: CdpConnector;
  env?: NodeJS.ProcessEnv;
  executablePath: string;
  launcher?: BrowserLauncher;
  leaseOptions?: ProfileLeaseOptions;
  mainEndpoint?: () => Promise<{ endpoint: string; userDataDir: string }>;
  onDownloadFinished?: BrowserOwnerOptions["onDownloadFinished"];
  onError?: (error: unknown) => void;
  pathOptions?: ChromeRuntimePathOptions;
  processExitWaitMs?: number;
  processIdentity?: ProcessIdentityProbe;
  signalProcess?: BrowserOwnerOptions["signalProcess"];
  processStartIdentity?: (pid: number) => Promise<string>;
  shutdownGraceMs?: number;
  workspacePath: string;
}>;

type BrokerOwnerEntry = {
  closing?: Promise<void>;
  owner?: BrowserOwner;
  promise: Promise<BrowserOwner>;
  recoveringFrom?: BrowserOwner;
};

export class BrowserClientSession {
  readonly connectionId: string;
  readonly mutationRegistry = new PersistentMutationRegistry();
  readonly sessionKey: string;

  #broker: ChromeBrowserBroker;
  #closed = false;
  #owner: BrowserOwner;

  constructor(broker: ChromeBrowserBroker, owner: BrowserOwner, connectionId: string, sessionKey: string) {
    this.#broker = broker;
    this.#owner = owner;
    this.connectionId = connectionId;
    this.sessionKey = sessionKey;
  }

  get mode(): BrowserMode {
    return this.owner.key.mode;
  }

  get owner(): BrowserOwner {
    return this.#owner;
  }

  selectedTarget(): GenerationTargetId {
    return this.owner.selectedTarget(this.connectionId);
  }

  beginSelection(): Promise<SelectionTransaction> {
    return this.owner.beginSelection(this.connectionId);
  }

  authorizeOwnerClose(resource: BrowserOwnerCloseResource): void {
    this.owner.authorizeClose(this.connectionId, resource);
  }

  commitSelection(transaction: SelectionTransaction): Promise<GenerationTargetId> {
    return this.owner.commitSelection(this.connectionId, transaction).then(async (target) => {
      try {
        this.owner.mutations.assertTargetAccessible(this.connectionId, target);
        if (!this.mutationRegistry.empty) await this.owner.mutations.claimTarget(this.connectionId, target);
        return target;
      } catch (error: unknown) {
        if (this.owner.registry.ready(transaction.initialTarget)) {
          this.owner.selections.commit(this.connectionId, transaction.initialTarget);
        }
        throw error;
      }
    });
  }

  recordCreatedTarget(transaction: SelectionTransaction, target: GenerationTargetId): void {
    this.owner.recordCreatedTarget(this.connectionId, transaction, target);
  }

  rollbackSelection(transaction: SelectionTransaction): GenerationTargetId {
    return this.owner.rollbackSelection(this.connectionId, transaction);
  }

  markEvents(): EventCursor {
    return this.owner.markEvents(this.connectionId);
  }

  readEvents(options: JournalReadOptions & Readonly<{ advance?: boolean }> = {}): JournalReadResult {
    return this.owner.readEvents(this.connectionId, options);
  }

  react(request: ReactBrowserOperation): Promise<ReactOperationResult> {
    const target = this.selectedTarget();
    const record = this.owner.registry.record(target.targetId);
    if (!record) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_STALE_TARGET",
        "Selected Chrome target is no longer available",
      );
    }
    return this.owner.react.execute(
      this.connectionId,
      { targetId: target.targetId, url: record.url },
      request,
    );
  }

  activeDialog(): ActiveDialog | undefined {
    return this.owner.activeDialog(this.connectionId);
  }

  activeFileChooser(): ActiveFileChooser | undefined {
    return this.owner.activeFileChooser(this.connectionId);
  }

  requireNoBlockingModal(): void {
    this.owner.requireNoBlockingModal(this.connectionId);
  }

  handleDialog(dialogId: string, accept: boolean, promptText?: string): Promise<void> {
    return this.owner.handleDialog(this.connectionId, dialogId, accept, promptText);
  }

  enableOwnedDownloads(): Promise<void> {
    return this.owner.enableOwnedDownloads(this.connectionId);
  }

  invalidateOwner(): void {
    this.owner.invalidate(this.connectionId);
  }

  setFileChooserFiles(chooserId: string, files: readonly string[]): Promise<void> {
    return this.owner.setFileChooserFiles(this.connectionId, chooserId, files);
  }

  async addMutation(
    input: PersistentMutationInput,
    target: GenerationTargetId = this.selectedTarget(),
  ): Promise<PersistentMutationEntry> {
    const sharingClients = this.owner.selections
      .clientsSelecting(target)
      .filter((clientId) => clientId !== this.connectionId);
    if (sharingClients.length > 0) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_MUTATION_CONFLICT",
        "Persistent mutations require a page selected only by this MCP connection",
      );
    }
    const entry = await this.mutationRegistry.add(input);
    try {
      await this.owner.mutations.claimTarget(this.connectionId, target);
      await this.owner.mutations.reconcileClient(this.connectionId);
      return entry;
    } catch (error: unknown) {
      this.mutationRegistry.remove(entry.kind, entry.id);
      return this.#failMutationChange(error);
    }
  }

  async clearMutations(kind: PersistentMutationKind): Promise<number> {
    const removed = this.mutationRegistry.clear(kind);
    try {
      await this.reconcileOwnerMutations();

      return removed.length;
    } catch (error: unknown) {
      this.mutationRegistry.restore(removed);
      return this.#failMutationChange(error);
    }
  }

  listMutations(kind: PersistentMutationKind): PersistentMutationEntry[] {
    return this.mutationRegistry.entries(kind);
  }

  async removeMutation(kind: PersistentMutationKind, id: string): Promise<boolean> {
    const removed = this.mutationRegistry.remove(kind, id);
    if (!removed) return false;
    try {
      await this.reconcileOwnerMutations();

      return true;
    } catch (error: unknown) {
      this.mutationRegistry.restore([removed]);
      return this.#failMutationChange(error);
    }
  }

  admit<Result>(operation: BrowserCallAdmission<Result>): Promise<Result> {
    return this.#broker.admit(this, operation);
  }

  workerConnection(): Readonly<{
    downloadsPath?: string;
    endpoint: string;
    executionEndpoint: string;
    ownerGeneration: number;
    target: GenerationTargetId;
  }> {
    return Object.freeze({
      ...(this.owner.key.mode === "main" ? {} : { downloadsPath: this.owner.paths.downloadsPath }),
      ...this.owner.getWorkerEndpoints(),
      ownerGeneration: this.owner.ownerGeneration,
      target: this.selectedTarget(),
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#broker.release(this);
  }

  rebindOwner(expected: BrowserOwner, replacement: BrowserOwner): void {
    if (this.#owner !== expected) return;
    this.#owner = replacement;
  }

  private async reconcileOwnerMutations() {
    await this.owner.mutations.reconcileClient(this.connectionId);

    if (!this.mutationRegistry.empty) return;

    this.owner.mutations.releaseClientTargets(this.connectionId);
  }

  async #failMutationChange(error: unknown): Promise<never> {
    try {
      await this.reconcileOwnerMutations();
    } catch (rollbackError: unknown) {
      throw new ChromeRuntimeError("CHROME_MCP_MUTATION_FAILED", "Persistent mutation rollback failed", {
        cause: new AggregateError([error, rollbackError]),
      });
    }
    throw error;
  }
}

export class ChromeBrowserBroker {
  readonly workspaceHash: string;

  #closed = false;
  #closePromise: Promise<void> | undefined;
  #cleanupTombstones = new Map<string, Map<string, PersistentMutationCleanupTombstone>>();
  #generations = new Map<string, number>();
  #options: ChromeBrowserBrokerOptions;
  #owners = new Map<string, BrokerOwnerEntry>();
  #sessions = new Map<string, BrowserClientSession>();
  #shuttingDown = false;

  private constructor(options: ChromeBrowserBrokerOptions, workspaceHash: string) {
    this.#options = options;
    this.workspaceHash = workspaceHash;
  }

  static async create(options: ChromeBrowserBrokerOptions): Promise<ChromeBrowserBroker> {
    const workspace = await workspaceIdentity(options.workspacePath);
    return new ChromeBrowserBroker(options, workspace.hash);
  }

  async acquire(
    connectionId: string,
    modeValue: unknown = "isolated",
    launch: BrowserLaunchSettings = {},
  ): Promise<BrowserClientSession> {
    if (this.#shuttingDown) {
      throw new ChromeRuntimeError("CHROME_MCP_OWNER_CLOSED", "Chrome browser broker is closed");
    }
    const mode = parseBrowserMode(modeValue);
    assertNativeDeviceScaleFactor(mode, launch.nativeDeviceScaleFactor);
    const key = createOwnerKey(mode, this.workspaceHash, connectionId);
    const sessionKey = `${key.id}\u0000${connectionId}`;
    const existingSession = this.#sessions.get(sessionKey);
    if (existingSession) {
      assertMatchingNativeDeviceScaleFactor(
        existingSession.owner.nativeDeviceScaleFactor,
        launch.nativeDeviceScaleFactor,
      );
      await this.#recoverSession(existingSession);
      return existingSession;
    }

    let entry = this.#owners.get(key.id);
    if (entry?.closing) {
      await entry.closing;
      return this.acquire(connectionId, mode, launch);
    }
    if (!entry) {
      const promise = this.#createOwner(key, launch);
      entry = { promise };
      this.#owners.set(key.id, entry);
      promise.then(
        (owner) => {
          const current = this.#owners.get(key.id);
          if (current?.promise === promise) current.owner = owner;
        },
        () => {
          const current = this.#owners.get(key.id);
          if (current?.promise === promise) this.#owners.delete(key.id);
        },
      );
    }
    let owner = await entry.promise;
    assertMatchingNativeDeviceScaleFactor(owner.nativeDeviceScaleFactor, launch.nativeDeviceScaleFactor);
    assertMatchingMainUserDataDir(owner.mainUserDataDir, launch.mainUserDataDir);

    if (owner.disconnected) owner = await this.#recoverOwner(owner);
    await this.#drainCleanupTombstones(owner);
    if (this.#shuttingDown) {
      await owner.close();
      throw new ChromeRuntimeError(
        "CHROME_MCP_OWNER_CLOSED",
        "Chrome browser broker closed during owner startup",
      );
    }
    const session = new BrowserClientSession(this, owner, connectionId, sessionKey);
    await owner.addClient(connectionId, session.mutationRegistry);
    this.#sessions.set(sessionKey, session);
    return session;
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closePromise) return this.#closePromise;
    this.#shuttingDown = true;
    const closePromise = this.#closeBroker();
    this.#closePromise = closePromise;
    closePromise.then(undefined, () => {
      if (this.#closePromise === closePromise) this.#closePromise = undefined;
    });
    return closePromise;
  }

  async release(session: BrowserClientSession): Promise<void> {
    if (this.#sessions.get(session.sessionKey) !== session) return;
    this.#sessions.delete(session.sessionKey);
    const owner = session.owner;
    const cleanup = await Promise.allSettled([owner.removeClient(session.connectionId)]);
    const closing = await Promise.allSettled([this.#closeOwnerWithoutSessions(owner)]);
    const tombstone = owner.createMutationCleanupTombstone(session.connectionId);
    if (tombstone) this.#rememberCleanupTombstone(owner.key.id, session.sessionKey, tombstone);
    else this.#forgetCleanupTombstone(owner.key.id, session.sessionKey);
    const failures = [...cleanup, ...closing].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Chrome owner cleanup failed",
      );
    }
  }

  async #closeOwnerWithoutSessions(owner: BrowserOwner): Promise<void> {
    if ([...this.#sessions.values()].some((session) => session.owner === owner)) return;
    const entry = this.#owners.get(owner.key.id);
    if (entry?.owner !== owner) {
      await owner.close();
      return;
    }
    const closing = owner.close().then(
      () => {
        const current = this.#owners.get(owner.key.id);
        if (current === entry) this.#owners.delete(owner.key.id);
      },
      (error: unknown) => {
        const current = this.#owners.get(owner.key.id);
        if (current === entry) entry.closing = undefined;
        throw error;
      },
    );
    entry.closing = closing;
    await closing;
  }

  async admit<Result>(
    session: BrowserClientSession,
    operation: BrowserCallAdmission<Result>,
  ): Promise<Result> {
    if (this.#shuttingDown) {
      throw new ChromeRuntimeError("CHROME_MCP_OWNER_CLOSED", "Chrome browser broker is closed");
    }
    if (this.#sessions.get(session.sessionKey) !== session) {
      throw new ChromeRuntimeError("CHROME_MCP_OWNER_CLOSED", "Chrome client lease is not active");
    }
    const owner = await this.#recoverSession(session);
    return owner.admit(session.connectionId, operation);
  }

  async #recoverSession(session: BrowserClientSession): Promise<BrowserOwner> {
    const owner = session.owner;
    if (!owner.disconnected) return owner;
    return this.#recoverOwner(owner);
  }

  async #recoverOwner(disconnectedOwner: BrowserOwner): Promise<BrowserOwner> {
    if (this.#closed) {
      throw new ChromeRuntimeError("CHROME_MCP_OWNER_CLOSED", "Chrome browser broker is closed");
    }
    const key = disconnectedOwner.key;
    let entry = this.#owners.get(key.id);
    if (entry?.owner === disconnectedOwner && entry.recoveringFrom !== disconnectedOwner) {
      const promise = (async () => {
        const affectedSessions = [...this.#sessions.values()].filter(
          (session) => session.owner === disconnectedOwner,
        );
        const recoveryStates = new Map(
          affectedSessions.map((session) => [session, disconnectedOwner.recoveryState(session.connectionId)]),
        );
        let transferredProfileLease: ProfileLease | undefined;
        if (isSharedMode(key.mode)) {
          transferredProfileLease = await disconnectedOwner.handoffDisconnectedSharedLease();
        } else await disconnectedOwner.close();
        let replacement: BrowserOwner | undefined;
        try {
          replacement = await this.#createOwner(key, {
            transferredProfileLease,
            mainUserDataDir: disconnectedOwner.mainUserDataDir,
            nativeDeviceScaleFactor: disconnectedOwner.nativeDeviceScaleFactor,
          });
          await this.#drainCleanupTombstones(replacement);
          for (const session of affectedSessions) {
            await replacement.addClient(
              session.connectionId,
              session.mutationRegistry,
              recoveryStates.get(session),
            );
          }
          if (transferredProfileLease) {
            disconnectedOwner.commitDisconnectedSharedLeaseHandoff(transferredProfileLease);
          }
          for (const session of affectedSessions) session.rebindOwner(disconnectedOwner, replacement);
          return replacement;
        } catch (error: unknown) {
          const cleanup =
            replacement ?
              await Promise.allSettled([
                transferredProfileLease ?
                  replacement.abortRecovery(transferredProfileLease)
                : replacement.closeFailedRecovery(),
              ])
            : [];
          return aggregateCleanup(error, cleanup);
        }
      })();
      entry = { owner: disconnectedOwner, promise, recoveringFrom: disconnectedOwner };
      this.#owners.set(key.id, entry);
      promise.then(
        (owner) => {
          const current = this.#owners.get(key.id);
          if (current?.promise === promise) {
            current.owner = owner;
            current.recoveringFrom = undefined;
          }
        },
        () => {
          const current = this.#owners.get(key.id);
          if (current?.promise === promise) {
            current.owner = disconnectedOwner;
            current.promise = Promise.resolve(disconnectedOwner);
            current.recoveringFrom = undefined;
          }
        },
      );
    }
    if (!entry) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_BROWSER_DISCONNECTED",
        "Disconnected Chrome owner is no longer registered",
      );
    }
    const replacement = await entry.promise;
    if (replacement === disconnectedOwner) {
      throw new ChromeRuntimeError("CHROME_MCP_BROWSER_DISCONNECTED", "Chrome browser owner did not recover");
    }
    return replacement;
  }

  async #drainCleanupTombstones(owner: BrowserOwner): Promise<void> {
    const tombstones = this.#cleanupTombstones.get(owner.key.id);
    if (!tombstones) return;
    for (const [sessionKey, tombstone] of tombstones) {
      await owner.drainMutationCleanupTombstone(tombstone);
      tombstones.delete(sessionKey);
    }
    if (tombstones.size === 0) this.#cleanupTombstones.delete(owner.key.id);
  }

  async #closeBroker(): Promise<void> {
    const tombstoneCleanup = await Promise.allSettled([this.#drainMainCleanupTombstones()]);
    const owners = await Promise.allSettled([...this.#owners.values()].map((entry) => entry.promise));
    const ownerCleanup = await Promise.allSettled(
      owners.flatMap((result) => (result.status === "fulfilled" ? [result.value.close()] : [])),
    );
    const failures = [...tombstoneCleanup, ...owners, ...ownerCleanup]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((failure) => failure.reason);
    if (failures.length > 0) throw new AggregateError(failures, "Chrome broker cleanup failed");
    this.#sessions.clear();
    this.#owners.clear();
    this.#cleanupTombstones.clear();
    this.#closed = true;
  }

  async #drainMainCleanupTombstones(): Promise<void> {
    const failures: unknown[] = [];
    for (const ownerKey of this.#cleanupTombstones.keys()) {
      const entry = this.#owners.get(ownerKey);
      if (!entry) {
        failures.push(
          new ChromeRuntimeError(
            "CHROME_MCP_MUTATION_FAILED",
            `Chrome owner is unavailable for persistent mutation cleanup: ${ownerKey}`,
          ),
        );
        continue;
      }
      try {
        let owner = await entry.promise;
        if (owner.key.mode !== "main") continue;
        if (owner.disconnected) owner = await this.#recoverOwner(owner);
        await this.#drainCleanupTombstones(owner);
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Chrome main mutation cleanup failed");
    }
  }

  #rememberCleanupTombstone(
    ownerKey: string,
    sessionKey: string,
    tombstone: PersistentMutationCleanupTombstone,
  ): void {
    let tombstones = this.#cleanupTombstones.get(ownerKey);
    if (!tombstones) {
      tombstones = new Map();
      this.#cleanupTombstones.set(ownerKey, tombstones);
    }
    tombstones.set(sessionKey, tombstone);
  }

  #forgetCleanupTombstone(ownerKey: string, sessionKey: string): void {
    const tombstones = this.#cleanupTombstones.get(ownerKey);
    if (!tombstones) return;
    tombstones.delete(sessionKey);
    if (tombstones.size === 0) this.#cleanupTombstones.delete(ownerKey);
  }

  async #createOwner(
    key: ChromeOwnerKey,
    launch: Readonly<{
      mainUserDataDir?: string;
      nativeDeviceScaleFactor?: number;
      transferredProfileLease?: ProfileLease;
    }> = {},
  ): Promise<BrowserOwner> {
    const env = this.#options.env ?? process.env;
    const runtimeRoot = this.#options.pathOptions?.runtimeRoot ?? getMcpRuntimeDir(env);
    const paths = resolveChromeRuntimePaths(key, {
      dataHome: this.#options.pathOptions?.dataHome ?? env.XDG_DATA_HOME,
      home: this.#options.pathOptions?.home ?? env.HOME,
      runtimeRoot,
    });
    await mkdir(paths.runtimeRoot, { recursive: true, mode: 0o700 });
    const generationHint = (this.#generations.get(key.id) ?? 0) + 1;
    const owner = await BrowserOwner.create({
      cdpConnector: this.#options.cdpConnector,
      env,
      executablePath: this.#options.executablePath,
      generationHint,
      key,
      launcher: this.#options.launcher,
      leaseOptions: this.#options.leaseOptions,
      mainEndpoint: this.#options.mainEndpoint,
      mainUserDataDir: launch.mainUserDataDir,
      onDownloadFinished: this.#options.onDownloadFinished,
      onError: this.#options.onError ?? ((error) => console.error("[chrome-mcp] browser owner error", error)),
      paths,
      processExitWaitMs: this.#options.processExitWaitMs,
      processIdentity: this.#options.processIdentity,
      signalProcess: this.#options.signalProcess,
      processStartIdentity: this.#options.processStartIdentity,
      shutdownGraceMs: this.#options.shutdownGraceMs,
      nativeDeviceScaleFactor: launch.nativeDeviceScaleFactor,
      transferredProfileLease: launch.transferredProfileLease,
    });
    this.#generations.set(key.id, owner.ownerGeneration);
    return owner;
  }
}
