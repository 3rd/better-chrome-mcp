import type { RemoteDownloadFinished, RemoteDownloadPublication } from "../broker-rpc";
import type { PreparedSelection } from "../broker-rpc/protocol";
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
import type { PageViewportRequest, PageViewportState } from "../runtime/page-viewport";
import type { PwaOperation, PwaResult } from "../runtime/pwa-controller";
import type { ReactBrowserOperation, ReactOperationResult } from "../runtime/react-inspection-protocol";
import type { ChromePageSession } from "./page-adapter";

export type ServiceSelection = Readonly<{
  commit: () => Promise<GenerationTargetId>;
  current: () => GenerationTargetId;
  prepare: () => Promise<PreparedSelection>;
  rollback: () => Promise<GenerationTargetId>;
  select: (targetId: string) => Promise<void>;
}>;

export type ChromeServiceDownloadPublisher = (
  download: RemoteDownloadFinished,
) => Promise<RemoteDownloadPublication>;

export interface ChromeServiceRuntimeSession extends ChromePageSession {
  readonly closed: boolean;
  readonly ownerId: string;
  activeDialog: () => ActiveDialog | undefined;
  activeFileChooser: () => ActiveFileChooser | undefined;
  addMutation: (
    input: PersistentMutationInput,
    target: GenerationTargetId,
  ) => Promise<PersistentMutationEntry>;
  admit: <Result>(operation: BrowserCallAdmission<Result>) => Promise<Result>;
  authorizeOwnerClose: (resource: BrowserOwnerCloseResource) => Promise<void>;
  beginSelection: () => Promise<ServiceSelection>;
  capabilities: () => Promise<BrowserOwnerSnapshot>;
  cdpMethods?: () => Promise<ReadonlySet<string>>;
  clearMutations: (kind: PersistentMutationKind) => Promise<number>;
  close: () => Promise<void>;
  enableOwnedDownloads: () => Promise<void>;
  handleDialog: (dialogId: string, accept: boolean, promptText?: string) => Promise<void>;
  invalidateOwner: () => Promise<void>;
  journalCapabilities: () => Promise<
    Readonly<{
      currentSequence: number;
      eventCount: number;
      firstRetainedSequence: number;
      retainedBytes: number;
    }>
  >;
  markEvents: () => Promise<EventCursor>;
  listMutations: (kind: PersistentMutationKind) => Promise<PersistentMutationEntry[]>;
  readEvents: (options?: JournalReadOptions & Readonly<{ advance?: boolean }>) => Promise<JournalReadResult>;
  removeMutation: (kind: PersistentMutationKind, id: string) => Promise<boolean>;
  react: (input: ReactBrowserOperation) => Promise<ReactOperationResult>;
  pageViewport: (request: PageViewportRequest) => Promise<PageViewportState>;
  readonly pwa: (input: PwaOperation) => Promise<PwaResult>;
  setFileChooserFiles: (chooserId: string, files: readonly string[]) => Promise<void>;
  workerConnection: () => Promise<
    Readonly<{
      downloadsPath?: string;
      endpoint: string;
      executionEndpoint: string;
      ownerGeneration: number;
      target: GenerationTargetId;
    }>
  >;
}

export type ChromeServiceRuntime = Readonly<{
  acquire: (
    connectionId: string,
    mode: BrowserMode,
    options?: BrowserInstanceOptions,
  ) => Promise<ChromeServiceRuntimeSession>;
  close: () => Promise<void>;
  closeConnection: (connectionId: string) => Promise<void>;
  setDownloadPublisher: (publisher: ChromeServiceDownloadPublisher | undefined) => void;
}>;
