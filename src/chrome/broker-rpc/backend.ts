import type { BrowserLaunchSettings } from "../runtime/browser-owner";
import type { PageViewportRequest, PageViewportState } from "../runtime/page-viewport";
import type { PwaOperation, PwaResult } from "../runtime/pwa-controller";
import type { ReactBrowserOperation, ReactOperationResult } from "../runtime/react-inspection-protocol";
import type { PreparedSelection } from "./protocol";
import {
  type ActiveDialog,
  type ActiveFileChooser,
  type BrowserCallAdmission,
  type BrowserJournalEvent,
  type BrowserMode,
  type BrowserOwnerCloseResource,
  type BrowserOwnerSnapshot,
  ChromeBrowserBroker,
  type DownloadFinishedInput,
  type DownloadPublication,
  type EventCursor,
  type GenerationTargetId,
  JOURNAL_READ_MAX_LIMIT,
  type JournalReadOptions,
  type JournalReadResult,
  type PersistentMutationEntry,
  type PersistentMutationInput,
  type PersistentMutationKind,
  type SelectionTransaction,
} from "../runtime";

export type BrokerOwnedDownload = DownloadFinishedInput;

export type BrokerDownloadPublisher = (download: BrokerOwnedDownload) => Promise<DownloadPublication>;

export type BrokerBackendSelection = Readonly<{
  commit: () => Promise<GenerationTargetId>;
  initialTarget: GenerationTargetId;
  prepare: () => Promise<PreparedSelection>;
  recordCreated: (target: GenerationTargetId) => void;
  rollback: () => GenerationTargetId;
  select: (target: GenerationTargetId) => Promise<void>;
}>;

export interface BrokerBackendSession {
  readonly connectionId: string;
  readonly mode: BrowserMode;
  readonly ownerGeneration: number;
  readonly ownerId: string;
  readonly pendingAdmissions: number;
  activeDialog: () => ActiveDialog | undefined;
  activeFileChooser: () => ActiveFileChooser | undefined;
  addMutation: (
    input: PersistentMutationInput,
    target: GenerationTargetId,
  ) => Promise<PersistentMutationEntry>;
  admit: <Result>(operation: BrowserCallAdmission<Result>) => Promise<Result>;
  authorizeOwnerClose: (resource: BrowserOwnerCloseResource) => void;
  beginSelection: () => Promise<BrokerBackendSelection>;
  clearMutations: (kind: PersistentMutationKind) => Promise<number>;
  close: () => Promise<void>;
  currentEventCursor: () => EventCursor;
  currentTarget: () => GenerationTargetId;
  enableOwnedDownloads: () => Promise<void>;
  ensureTarget: () => Promise<GenerationTargetId>;
  eventRange: (after: EventCursor, targetId: string) => BrowserJournalEvent[];
  handleDialog: (dialogId: string, accept: boolean, promptText?: string) => Promise<void>;
  invalidateOwner: () => void;
  journalCapabilities: () => Readonly<{
    currentSequence: number;
    eventCount: number;
    firstRetainedSequence: number;
    retainedBytes: number;
  }>;
  listMutations: (kind: PersistentMutationKind) => PersistentMutationEntry[];
  markEvents: () => EventCursor;
  onCdp: (method: string, listener: (params: unknown, sessionId: string | undefined) => void) => () => void;
  pageViewport: (request: PageViewportRequest, signal: AbortSignal) => Promise<PageViewportState>;
  readonly pwa: (input: PwaOperation, signal: AbortSignal) => Promise<PwaResult>;
  readEvents: (options?: JournalReadOptions & Readonly<{ advance?: boolean }>) => JournalReadResult;
  react: (input: ReactBrowserOperation) => Promise<ReactOperationResult>;
  removeMutation: (kind: PersistentMutationKind, id: string) => Promise<boolean>;
  requireNoBlockingModal: () => void;
  sendCdp: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ) => Promise<unknown>;
  setFileChooserFiles: (chooserId: string, files: readonly string[]) => Promise<void>;
  snapshot: () => BrowserOwnerSnapshot;
  targetRecord: (targetId: string) => Readonly<{ title?: string; url: string }> | undefined;
  workerConnection: () => Readonly<{
    downloadsPath?: string;
    endpoint: string;
    executionEndpoint: string;
    ownerGeneration: number;
    target: GenerationTargetId;
  }>;
}

export interface BrokerBackend {
  acquire: (
    connectionId: string,
    mode: BrowserMode,
    launch?: BrowserLaunchSettings,
  ) => Promise<BrokerBackendSession>;
  cleanupConnection?: (connectionId: string) => Promise<void>;
  close: () => Promise<void>;
  setDownloadPublisher?: (publisher: BrokerDownloadPublisher | undefined) => void;
}

export type ChromeBrokerBackendOptions = Readonly<{
  executablePath: string;
  runtimeRoot?: string;
  workspacePath: string;
}>;

class ChromeBrokerBackendSession implements BrokerBackendSession {
  readonly #session: Awaited<ReturnType<ChromeBrowserBroker["acquire"]>>;

  constructor(session: Awaited<ReturnType<ChromeBrowserBroker["acquire"]>>) {
    this.#session = session;
  }

  get connectionId(): string {
    return this.#session.connectionId;
  }

  get mode(): BrowserMode {
    return this.#session.mode;
  }

  get ownerGeneration(): number {
    return this.#session.owner.ownerGeneration;
  }

  get ownerId(): string {
    return this.#session.owner.key.id;
  }

  get pendingAdmissions(): number {
    return this.#session.owner.admission.pending + (this.#session.owner.admission.running ? 1 : 0);
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

  authorizeOwnerClose(resource: BrowserOwnerCloseResource): void {
    this.#session.authorizeOwnerClose(resource);
  }

  async beginSelection(): Promise<BrokerBackendSelection> {
    const transaction: SelectionTransaction = await this.#session.beginSelection();
    return Object.freeze({
      commit: () => this.#commitSelection(transaction),
      initialTarget: transaction.initialTarget,
      prepare: async () => {
        await this.recordCreatedTargets(transaction);
        const target = transaction.prepare();
        return { target, hasBlockingDialog: this.#session.owner.modals.dialog(target) !== undefined };
      },
      recordCreated: (target) => this.#session.recordCreatedTarget(transaction, target),
      rollback: () => this.#session.rollbackSelection(transaction),
      select: async (target) => {
        await this.#session.owner.observer.synchronizeTargets();
        transaction.select(target);
      },
    });
  }

  clearMutations(kind: PersistentMutationKind): Promise<number> {
    return this.#session.clearMutations(kind);
  }

  close(): Promise<void> {
    return this.#session.close();
  }

  currentEventCursor(): EventCursor {
    return this.#session.owner.journal.currentCursor;
  }

  currentTarget(): GenerationTargetId {
    return this.#session.selectedTarget();
  }

  enableOwnedDownloads(): Promise<void> {
    return this.#session.enableOwnedDownloads();
  }

  ensureTarget(): Promise<GenerationTargetId> {
    return this.#session.owner.observer.ensurePage();
  }

  eventRange(after: EventCursor, targetId: string): BrowserJournalEvent[] {
    const events: BrowserJournalEvent[] = [];
    let cursor = after;
    for (;;) {
      const result = this.#session.owner.journal.read({
        after: cursor,
        limit: JOURNAL_READ_MAX_LIMIT,
        target: targetId,
      });
      events.push(...result.events);
      if (result.nextCursor.sequence >= this.#session.owner.journal.currentCursor.sequence) return events;
      cursor = result.nextCursor;
    }
  }

  handleDialog(dialogId: string, accept: boolean, promptText?: string): Promise<void> {
    return this.#session.handleDialog(dialogId, accept, promptText);
  }

  invalidateOwner(): void {
    this.#session.invalidateOwner();
  }

  journalCapabilities() {
    const journal = this.#session.owner.journal;
    return Object.freeze({
      currentSequence: journal.currentCursor.sequence,
      eventCount: journal.count,
      firstRetainedSequence: journal.firstRetainedCursor.sequence,
      retainedBytes: journal.byteSize,
    });
  }

  listMutations(kind: PersistentMutationKind): PersistentMutationEntry[] {
    return this.#session.listMutations(kind);
  }

  markEvents(): EventCursor {
    return this.#session.markEvents();
  }

  onCdp(method: string, listener: (params: unknown, sessionId: string | undefined) => void): () => void {
    return this.#session.owner.connection.on(method, listener);
  }

  readEvents(options: JournalReadOptions & Readonly<{ advance?: boolean }> = {}): JournalReadResult {
    return this.#session.readEvents(options);
  }

  react(input: ReactBrowserOperation): Promise<ReactOperationResult> {
    return this.#session.react(input);
  }

  removeMutation(kind: PersistentMutationKind, id: string): Promise<boolean> {
    return this.#session.removeMutation(kind, id);
  }

  requireNoBlockingModal(): void {
    this.#session.requireNoBlockingModal();
  }

  sendCdp(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<unknown> {
    return this.#session.owner.connection.send(method, params, sessionId, timeoutMs);
  }

  pageViewport(request: PageViewportRequest, signal: AbortSignal) {
    return this.#session.owner.pageViewport(request, signal);
  }

  pwa(input: PwaOperation, signal: AbortSignal) {
    return this.#session.owner.pwa.execute(input, signal);
  }

  setFileChooserFiles(chooserId: string, files: readonly string[]): Promise<void> {
    return this.#session.setFileChooserFiles(chooserId, files);
  }

  snapshot(): BrowserOwnerSnapshot {
    return this.#session.owner.snapshot();
  }

  targetRecord(targetId: string): Readonly<{ title?: string; url: string }> | undefined {
    const record = this.#session.owner.registry.record(targetId);
    if (!record || record.closed) return undefined;
    return Object.freeze({ ...(record.title === undefined ? {} : { title: record.title }), url: record.url });
  }

  workerConnection() {
    return this.#session.workerConnection();
  }

  async #commitSelection(transaction: SelectionTransaction): Promise<GenerationTargetId> {
    await this.recordCreatedTargets(transaction);
    return this.#session.commitSelection(transaction);
  }

  private async recordCreatedTargets(transaction: SelectionTransaction) {
    await this.#session.owner.observer.synchronizeTargets();

    for (const record of this.#session.owner.registry.readyRecords()) {
      if (record.creationSequence <= transaction.startCreationSequence) continue;

      this.#session.recordCreatedTarget(transaction, {
        ownerGeneration: record.ownerGeneration,
        targetId: record.targetId,
      });
    }
  }
}

export const createChromeBrokerBackend = async (
  options: ChromeBrokerBackendOptions,
): Promise<BrokerBackend> => {
  let downloadPublisher: BrokerDownloadPublisher | undefined;
  const broker = await ChromeBrowserBroker.create({
    executablePath: options.executablePath,
    onDownloadFinished: async (input) => {
      const publisher = downloadPublisher;
      if (!publisher) return {};
      return publisher(input);
    },
    ...(options.runtimeRoot ? { pathOptions: { runtimeRoot: options.runtimeRoot } } : {}),
    workspacePath: options.workspacePath,
  });
  return Object.freeze({
    acquire: async (connectionId: string, mode: BrowserMode, launch?: BrowserLaunchSettings) =>
      new ChromeBrokerBackendSession(await broker.acquire(connectionId, mode, launch)),
    close: () => broker.close(),
    setDownloadPublisher: (publisher: BrokerDownloadPublisher | undefined) => {
      downloadPublisher = publisher;
    },
  });
};
