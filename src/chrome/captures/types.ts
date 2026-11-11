import type { BrowserMode } from "../browser-modes";
import type { EventCursor, JournalReadResult } from "../runtime";

export type { BrowserMode } from "../browser-modes";

export const CAPTURE_BODY_LIMITS = {
  defaultBodyBytes: 1 * 1024 * 1024,
  maximumBodyBytes: 10 * 1024 * 1024,
  defaultTotalBytes: 64 * 1024 * 1024,
  maximumTotalBytes: 100 * 1024 * 1024,
};

export const CAPTURE_VIDEO_LIMITS = {
  minimumDimension: 320,
  maximumDimension: 3840,
  minimumFramesPerSecond: 1,
  maximumFramesPerSecond: 30,
};

export const MAX_HAR_BYTES = 100 * 1024 * 1024;
export const MAX_CAPTURE_NETWORK_ENTRIES = 10_000;
export const CAPTURE_FINALIZE_TIMEOUT_MS = 5000;

export type CaptureType = "har" | "network-bodies" | "trace" | "video";
export type CaptureFinishReason = "browser-death" | "disconnect" | "manual" | "shutdown";

export interface BrowserScope {
  connectionId: string;
  browserMode: BrowserMode;
  browserGeneration: number;
  contextId: string;
}

export interface CaptureScope extends BrowserScope {
  targetId: string;
  viewport?: Viewport;
}

export const isSameBrowserOwner = (left: BrowserScope, right: BrowserScope) =>
  left.connectionId === right.connectionId &&
  left.browserMode === right.browserMode &&
  left.browserGeneration === right.browserGeneration &&
  left.contextId === right.contextId;

export interface CaptureOutputPathAllocator {
  readonly allocate: (captureId: string, name: string) => Promise<string>;
  readonly discard?: (path: string) => Promise<void>;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface ArtifactDescriptor {
  artifactId: string;
  name: string;
  uri: string;
  mediaType: string;
  size: number;
  sha256: string;
  complete: boolean;
  createdAt: string;
  expiresAt: string | null;
}

export type ArtifactSource = { kind: "bytes"; bytes: Uint8Array } | { kind: "path"; path: string };

export interface ArtifactPublication {
  connectionId: string;
  browserMode: BrowserMode;
  targetId: string;
  name: string;
  mediaType: string;
  complete: boolean;
  origin: "capture" | "checkpoint";
  source: ArtifactSource;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ArtifactPublicationScope {
  connectionId: string;
  kind: "capture" | "checkpoint";
}

export interface ArtifactPublicationSession {
  publish: (publication: ArtifactPublication) => Promise<ArtifactDescriptor>;
  finish: () => Promise<void>;
}

export interface ArtifactPublisher {
  begin: (scope: ArtifactPublicationScope) => Promise<ArtifactPublicationSession>;
}

export interface CaptureOutput {
  name: string;
  mediaType: string;
  source: ArtifactSource;
  metadata?: Record<string, unknown>;
}

export interface TraceCaptureOptions {
  type: "trace";
  screenshots?: boolean;
  snapshots?: boolean;
  sources?: boolean;
}

export interface HarCaptureOptions {
  type: "har";
  content?: "attach" | "embed" | "omit";
  urlFilter?: string;
}

export interface NetworkBodiesCaptureOptions {
  type: "network-bodies";
  maxBodyBytes?: number;
  maxTotalBytes?: number;
  mimeTypes?: string[];
}

export interface VideoCaptureOptions {
  type: "video";
  format?: "webm";
  width?: number;
  height?: number;
  framesPerSecond?: number;
}

export type CaptureStartOptions =
  | HarCaptureOptions
  | NetworkBodiesCaptureOptions
  | TraceCaptureOptions
  | VideoCaptureOptions;

export interface CaptureStartRequest {
  scope: CaptureScope;
  options: CaptureStartOptions;
  eventCursor?: number;
}

export interface CaptureStarted {
  captureId: string;
  type: CaptureType;
  targetId: string;
  startedAt: string;
}

export interface CaptureStopped extends CaptureStarted {
  status: "completed" | "incomplete";
  stoppedAt: string;
  byteCount: number;
  artifact?: ArtifactDescriptor;
  artifacts: ArtifactDescriptor[];
  warnings: string[];
}

export interface CaptureAdapterStart {
  captureId: string;
  scope: CaptureScope;
  signal: AbortSignal;
}

export interface TraceAdapter {
  start: (
    input: CaptureAdapterStart & { options: Required<Omit<TraceCaptureOptions, "type">> },
  ) => Promise<unknown>;
  finish: (
    handle: unknown,
    input: { reason: CaptureFinishReason; signal: AbortSignal },
  ) => Promise<CaptureOutput>;
}

export interface VideoAdapter {
  supported: () => Promise<boolean>;
  start: (
    input: CaptureAdapterStart & {
      options: Required<Omit<VideoCaptureOptions, "type">>;
    },
  ) => Promise<unknown>;
  finish: (
    handle: unknown,
    input: { reason: CaptureFinishReason; signal: AbortSignal },
  ) => Promise<CaptureOutput>;
}

export interface ExternalCaptureConflict {
  find: (scope: CaptureScope, type: CaptureType) => Promise<string | undefined>;
}

export interface NetworkBody {
  bytes: Uint8Array;
  mediaType?: string;
}

export interface NetworkRequestData {
  requestId: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  postData?: string;
  startedAt: string;
  httpVersion?: string;
}

export interface NetworkResponseData {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  mediaType?: string;
  bodySize?: number;
  completedAt: string;
  httpVersion?: string;
  remoteAddress?: { ip: string; port: number };
}

export interface NetworkExchange extends BrowserScope {
  targetId: string;
  rootTargetId: string;
  sequence: number;
  request: NetworkRequestData;
  response?: NetworkResponseData;
  failureText?: string;
  loadBody?: (signal: AbortSignal) => Promise<NetworkBody | undefined>;
}

export interface Clock {
  now: () => Date;
}

export interface IdGenerator {
  next: (prefix: "capture" | "checkpoint") => string;
}

export interface CompactSnapshotLine {
  ref?: string;
  text: string;
}

export interface CompactSnapshot {
  snapshotId: string;
  text: string;
  lines: CompactSnapshotLine[];
}

export interface SnapshotComparison {
  comparisonText: string;
  ref: string;
  text: string;
}

export interface ComparableSnapshot {
  snapshot: CompactSnapshot;
  byIdentity: ReadonlyMap<string, SnapshotComparison>;
}

export interface StorageCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface OriginStorage {
  origin: string;
  localStorage: { name: string; value: string }[];
}

export interface StorageState {
  cookies: StorageCookie[];
  origins: OriginStorage[];
}

export interface PageMetadata {
  url: string;
  title: string;
  viewport: Viewport | null;
}

export interface ScreenshotCapture {
  output: CaptureOutput;
  comparison: unknown;
}

export interface CheckpointRuntimeAdapter {
  pageMetadata: (scope: CaptureScope) => Promise<PageMetadata>;
  snapshot: (scope: CaptureScope) => Promise<ComparableSnapshot>;
  eventCursor: (scope: CaptureScope) => Promise<EventCursor>;
  eventsSince: (scope: CaptureScope, cursor: EventCursor) => Promise<JournalReadResult>;
  screenshot: (scope: CaptureScope) => Promise<ScreenshotCapture>;
  discardScreenshot?: (screenshot: ScreenshotCapture) => Promise<void>;
  storage: (scope: CaptureScope) => Promise<StorageState>;
}

export interface PixelDiffResult {
  width: number;
  height: number;
  changedPixels: number;
  totalPixels: number;
  ratio: number;
  output?: CaptureOutput;
}

export interface PixelDiffAdapter {
  diff: (before: unknown, after: unknown) => Promise<PixelDiffResult>;
}

export interface CheckpointCreateOptions {
  name?: string;
  screenshot?: boolean;
  storage?: boolean;
}

export interface CheckpointCreateRequest {
  scope: CaptureScope;
  options?: CheckpointCreateOptions;
}

export interface CheckpointCreated {
  checkpointId: string;
  targetId: string;
  eventCursor: EventCursor;
  snapshotId: string;
  artifact: ArtifactDescriptor;
  artifacts: ArtifactDescriptor[];
}

export interface CheckpointDiffOptions {
  snapshot?: boolean;
  screenshot?: boolean;
  events?: boolean;
  storage?: boolean;
}

export interface CheckpointDiffRequest {
  scope: CaptureScope;
  checkpointId: string;
  options?: CheckpointDiffOptions;
}

export interface ValueChange<T> {
  changed: boolean;
  before: T;
  after: T;
}

export interface SnapshotDiff {
  added: CompactSnapshotLine[];
  removed: CompactSnapshotLine[];
  changed: { ref: string; before: string; after: string }[];
}

export interface StorageDiff {
  cookies: { added: string[]; removed: string[]; changed: string[] };
  localStorage: { added: string[]; removed: string[]; changed: string[] };
}

export interface CheckpointDiffReport {
  checkpointId: string;
  targetId: string;
  comparedAt: string;
  url: ValueChange<string>;
  title: ValueChange<string>;
  viewport: ValueChange<Viewport | null>;
  snapshot?: SnapshotDiff;
  events?: JournalReadResult;
  storage?: StorageDiff;
  pixels?: Omit<PixelDiffResult, "output">;
}

export interface CheckpointDiffResult {
  checkpointId: string;
  targetId: string;
  artifact: ArtifactDescriptor;
  artifacts: ArtifactDescriptor[];
  report: CheckpointDiffReport;
}
