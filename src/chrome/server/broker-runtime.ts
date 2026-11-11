import type { BrowserInstanceOptions } from "../browser-modes";
import type {
  ActiveDialog,
  ActiveFileChooser,
  BrowserCallAdmission,
  BrowserMode,
  BrowserOwnerCloseResource,
  BrowserOwnerSnapshot,
  EventCursor,
  GenerationTargetId,
  JournalReadOptions,
  JournalReadResult,
  PersistentMutationEntry,
  PersistentMutationInput,
  PersistentMutationKind,
} from "../runtime";
import type { PageViewportRequest } from "../runtime/page-viewport";
import type { PwaOperation } from "../runtime/pwa-controller";
import type { ReactBrowserOperation, ReactOperationResult } from "../runtime/react-inspection-protocol";
import type {
  ChromeServiceDownloadPublisher,
  ChromeServiceRuntime,
  ChromeServiceRuntimeSession,
  ServiceSelection,
} from "./service-runtime";
import { type ChromeBrokerClient, connectChromeBroker, type RemoteBrowserSession } from "../broker-rpc";

export type BrokerRuntimeOptions = Readonly<{
  executablePath: string;
  mainUserDataDir?: string;
  runtimeRoot?: string;
  workspacePath: string;
}>;

class BrokerRuntimeSession implements ChromeServiceRuntimeSession {
  readonly #connectionId: string;
  readonly #session: RemoteBrowserSession;

  constructor(session: RemoteBrowserSession, connectionId: string) {
    this.#connectionId = connectionId;
    this.#session = session;
  }

  get browserMode(): BrowserMode {
    return this.#session.browserMode;
  }

  get closed(): boolean {
    return this.#session.closed;
  }

  get connectionId(): string {
    return this.#connectionId;
  }

  get ownerGeneration(): number {
    return this.#session.ownerGeneration;
  }

  get ownerId(): string {
    return this.#session.ownerId;
  }

  activeDialog(): ActiveDialog | undefined {
    return this.#session.activeDialog();
  }

  activeFileChooser(): ActiveFileChooser | undefined {
    return this.#session.activeFileChooser();
  }

  addMutation(input: PersistentMutationInput, target: GenerationTargetId): Promise<PersistentMutationEntry> {
    return this.#session.addMutation(input, target);
  }

  admit<Result>(operation: BrowserCallAdmission<Result>): Promise<Result> {
    return this.#session.admit(operation);
  }

  authorizeOwnerClose(resource: BrowserOwnerCloseResource): Promise<void> {
    return this.#session.authorizeOwnerClose(resource);
  }

  async beginSelection(): Promise<ServiceSelection> {
    const transaction = await this.#session.beginSelection();
    let current = transaction.initialTarget;
    return {
      commit: () => transaction.commit(),
      current: () => current,
      prepare: async () => {
        const prepared = await transaction.prepare();
        current = prepared.target;
        return prepared;
      },
      rollback: () => transaction.rollback(),
      select: async (targetId) => {
        const next = { ownerGeneration: this.ownerGeneration, targetId };
        await transaction.select(next);
        current = next;
      },
    };
  }

  capabilities(): Promise<BrowserOwnerSnapshot> {
    return this.#session.capabilities();
  }

  clearMutations(kind: PersistentMutationKind): Promise<number> {
    return this.#session.clearMutations(kind);
  }

  close(): Promise<void> {
    return this.#session.close();
  }

  currentEventCursor(): Promise<EventCursor> {
    return this.#session.currentEventCursor();
  }

  currentTarget(): GenerationTargetId {
    return this.#session.currentTarget();
  }

  handleDialog(dialogId: string, accept: boolean, promptText?: string): Promise<void> {
    return this.#session.handleDialog(dialogId, accept, promptText);
  }

  enableOwnedDownloads(): Promise<void> {
    return this.#session.enableOwnedDownloads();
  }

  invalidateOwner(): Promise<void> {
    return this.#session.invalidateOwner();
  }

  journalCapabilities() {
    return this.#session.journalCapabilities();
  }

  markEvents(): Promise<EventCursor> {
    return this.#session.markEvents();
  }

  listMutations(kind: PersistentMutationKind): Promise<PersistentMutationEntry[]> {
    return this.#session.listMutations(kind);
  }

  onCdp(method: string, listener: (params: unknown, sessionId: string | undefined) => void): () => void {
    return this.#session.onCdp(method, listener);
  }

  readEvents(options: JournalReadOptions & Readonly<{ advance?: boolean }> = {}): Promise<JournalReadResult> {
    return this.#session.readEvents(options);
  }

  react(input: ReactBrowserOperation): Promise<ReactOperationResult> {
    return this.#session.react(input);
  }

  removeMutation(kind: PersistentMutationKind, id: string): Promise<boolean> {
    return this.#session.removeMutation(kind, id);
  }

  sendCdp(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    return this.#session.sendCdp(method, params, sessionId);
  }

  pageViewport(request: PageViewportRequest) {
    return this.#session.pageViewport(request);
  }

  pwa(input: PwaOperation) {
    return this.#session.pwa(input);
  }

  setFileChooserFiles(chooserId: string, files: readonly string[]): Promise<void> {
    return this.#session.setFileChooserFiles(chooserId, files);
  }

  targetRecord(targetId: string) {
    return this.#session.targetRecord(targetId);
  }

  async workerConnection() {
    const connection = await this.#session.workerConnection();
    return Object.freeze({
      ...(connection.downloadsPath === undefined ? {} : { downloadsPath: connection.downloadsPath }),
      endpoint: connection.endpoint.value,
      executionEndpoint: connection.executionEndpoint.value,
      ownerGeneration: connection.ownerGeneration,
      target: connection.target,
    });
  }
}

export class BrokerRuntime implements ChromeServiceRuntime {
  readonly #brokerConnectionIdsByConnectionId = new Map<string, Set<string>>();
  readonly #clients = new Map<string, Promise<ChromeBrokerClient>>();
  readonly #downloadSubscriptions = new Map<string, () => void>();
  private readonly options: BrokerRuntimeOptions;
  #closed = false;
  #downloadPublisher: ChromeServiceDownloadPublisher | undefined;

  private constructor(options: BrokerRuntimeOptions) {
    this.options = options;
  }

  static create(options: BrokerRuntimeOptions): BrokerRuntime {
    return new BrokerRuntime(options);
  }

  async acquire(
    connectionId: string,
    mode: BrowserMode,
    options: BrowserInstanceOptions = {},
  ): Promise<ChromeServiceRuntimeSession> {
    const { browserInstanceId, nativeDeviceScaleFactor } = options;
    const brokerConnectionId =
      browserInstanceId === undefined ? connectionId : `${connectionId}\0${browserInstanceId}`;
    let client = await this.#client(connectionId, brokerConnectionId);
    try {
      return new BrokerRuntimeSession(await client.acquire(mode, nativeDeviceScaleFactor), connectionId);
    } catch (error: unknown) {
      if (!client.closed) throw error;
      await this.#releaseClosedClient(connectionId, brokerConnectionId, client);
      client = await this.#client(connectionId, brokerConnectionId);
      return new BrokerRuntimeSession(await client.acquire(mode, nativeDeviceScaleFactor), connectionId);
    }
  }

  async closeConnection(connectionId: string): Promise<void> {
    const brokerConnectionIds = [...(this.#brokerConnectionIdsByConnectionId.get(connectionId) ?? [])];
    const [firstBrokerConnectionId] = brokerConnectionIds;
    if (firstBrokerConnectionId === undefined) return;
    if (brokerConnectionIds.length === 1) {
      await this.#closeBrokerConnection(connectionId, firstBrokerConnectionId);
      return;
    }
    const results = await Promise.allSettled(
      brokerConnectionIds.map((brokerConnectionId) =>
        this.#closeBrokerConnection(connectionId, brokerConnectionId),
      ),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Chrome broker connection failed to close",
      );
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#downloadPublisher = undefined;
    for (const remove of this.#downloadSubscriptions.values()) remove();
    this.#downloadSubscriptions.clear();
    const clients = await Promise.allSettled(this.#clients.values());
    this.#clients.clear();
    this.#brokerConnectionIdsByConnectionId.clear();
    const cleanup = await Promise.allSettled(
      clients.flatMap((result) => (result.status === "fulfilled" ? [result.value.close()] : [])),
    );
    const failures = [
      ...clients.filter((result): result is PromiseRejectedResult => result.status === "rejected"),
      ...cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected"),
    ];
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Chrome broker clients failed to close",
      );
    }
  }

  setDownloadPublisher(publisher: ChromeServiceDownloadPublisher | undefined): void {
    this.#downloadPublisher = publisher;
  }

  #client(connectionId: string, brokerConnectionId: string): Promise<ChromeBrokerClient> {
    if (this.#closed) return Promise.reject(new Error("Chrome service runtime is closed"));
    let pending = this.#clients.get(brokerConnectionId);
    if (!pending) {
      pending = connectChromeBroker({
        connectionId: brokerConnectionId,
        ...this.options,
      }).then((client) => {
        if (this.#closed || this.#clients.get(brokerConnectionId) !== pending) {
          return client.close().then(() => {
            throw new Error("Chrome service connection closed during broker startup");
          });
        }
        const removeDownload = client.onDownloadFinished(async (download) => {
          if (download.connectionId !== brokerConnectionId) {
            throw new Error("Chrome broker delivered a download for another MCP connection");
          }
          const publisher = this.#downloadPublisher;
          if (!publisher) throw new Error("Chrome download artifact publisher is unavailable");
          return publisher({ ...download, connectionId });
        });
        const removeClose = client.onClose(() =>
          this.#releaseClient(connectionId, brokerConnectionId, pending),
        );
        if (client.closed || this.#clients.get(brokerConnectionId) !== pending) {
          removeDownload();
          removeClose();
          throw new Error("Chrome broker connection closed during startup");
        }
        this.#downloadSubscriptions.set(brokerConnectionId, () => {
          removeDownload();
          removeClose();
        });
        return client;
      });
      this.#clients.set(brokerConnectionId, pending);
      const brokerConnectionIds = this.#brokerConnectionIdsByConnectionId.get(connectionId) ?? new Set();
      brokerConnectionIds.add(brokerConnectionId);
      this.#brokerConnectionIdsByConnectionId.set(connectionId, brokerConnectionIds);
      pending.catch(() => {
        this.#releaseClient(connectionId, brokerConnectionId, pending);
      });
    }
    const selected = pending;
    return selected.then((client) => {
      if (!client.closed) return client;
      this.#releaseClient(connectionId, brokerConnectionId, selected);
      return this.#client(connectionId, brokerConnectionId);
    });
  }

  #releaseClient(
    connectionId: string,
    brokerConnectionId: string,
    expected: Promise<ChromeBrokerClient> | undefined,
  ): void {
    if (!expected || this.#clients.get(brokerConnectionId) !== expected) return;
    this.#clients.delete(brokerConnectionId);
    const remove = this.#downloadSubscriptions.get(brokerConnectionId);
    this.#downloadSubscriptions.delete(brokerConnectionId);
    remove?.();
    const brokerConnectionIds = this.#brokerConnectionIdsByConnectionId.get(connectionId);
    brokerConnectionIds?.delete(brokerConnectionId);
    if (brokerConnectionIds?.size === 0) this.#brokerConnectionIdsByConnectionId.delete(connectionId);
  }

  async #releaseClosedClient(
    connectionId: string,
    brokerConnectionId: string,
    client: ChromeBrokerClient,
  ): Promise<void> {
    const expected = this.#clients.get(brokerConnectionId);
    if (!expected) return;
    const current = await expected.catch(() => undefined);
    if (current === client) this.#releaseClient(connectionId, brokerConnectionId, expected);
  }

  async #closeBrokerConnection(connectionId: string, brokerConnectionId: string) {
    const pending = this.#clients.get(brokerConnectionId);
    if (!pending) return;
    this.#releaseClient(connectionId, brokerConnectionId, pending);
    const client = await pending;
    await client.close();
  }
}
