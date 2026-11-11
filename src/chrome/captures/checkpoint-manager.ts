import { randomUUID } from "node:crypto";
import type { EventCursor } from "../runtime";
import type {
  ArtifactDescriptor,
  ArtifactPublication,
  ArtifactPublisher,
  BrowserScope,
  CaptureScope,
  CheckpointCreated,
  CheckpointCreateRequest,
  CheckpointDiffReport,
  CheckpointDiffRequest,
  CheckpointDiffResult,
  CheckpointRuntimeAdapter,
  Clock,
  CompactSnapshotLine,
  ComparableSnapshot,
  IdGenerator,
  PageMetadata,
  PixelDiffAdapter,
  PixelDiffResult,
  ScreenshotCapture,
  SnapshotDiff,
  StorageDiff,
  StorageState,
  ValueChange,
  Viewport,
} from "./types";
import { captureError } from "./errors";
import { ArtifactPublicationLedger } from "./publication-ledger";

export interface CheckpointManagerOptions {
  artifacts: ArtifactPublisher;
  runtime: CheckpointRuntimeAdapter;
  pixels?: PixelDiffAdapter;
  clock?: Clock;
  ids?: IdGenerator;
}

interface StoredScreenshot {
  capture: ScreenshotCapture;
  artifact: ArtifactDescriptor;
}

interface StoredCheckpoint {
  checkpointId: string;
  scope: CaptureScope;
  page: PageMetadata;
  snapshot: ComparableSnapshot;
  eventCursor: EventCursor;
  screenshot?: StoredScreenshot;
  storage?: StorageState;
}

const encoder = new TextEncoder();
const systemClock: Clock = { now: () => new Date() };
const randomIds: IdGenerator = { next: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}` };

const cloneScope = (scope: CaptureScope): CaptureScope => ({
  ...scope,
  viewport: scope.viewport && { ...scope.viewport },
});

const assertScope = (scope: CaptureScope) => {
  if (
    scope.connectionId.length === 0 ||
    scope.targetId.length === 0 ||
    scope.contextId.length === 0 ||
    !Number.isInteger(scope.browserGeneration) ||
    scope.browserGeneration < 0
  ) {
    throw captureError("CHROME_MCP_CHECKPOINT_INVALID_OPTIONS", "Checkpoint scope is incomplete.");
  }
};

const changedValue = <T>(
  before: T,
  after: T,
  equal: (left: T, right: T) => boolean = Object.is,
): ValueChange<T> => ({
  changed: !equal(before, after),
  before,
  after,
});

const sameViewport = (left: Viewport | null, right: Viewport | null) =>
  left === right ||
  (left !== null && right !== null && left.width === right.width && left.height === right.height);

const lineCounts = (lines: CompactSnapshotLine[]) => {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (line.ref) continue;
    counts.set(line.text, (counts.get(line.text) ?? 0) + 1);
  }
  return counts;
};

export const diffCompactSnapshots = (before: ComparableSnapshot, after: ComparableSnapshot): SnapshotDiff => {
  const added: CompactSnapshotLine[] = [];
  const removed: CompactSnapshotLine[] = [];
  const changed: SnapshotDiff["changed"] = [];

  for (const [identity, line] of before.byIdentity) {
    const current = after.byIdentity.get(identity);
    if (!current) removed.push({ ref: line.ref, text: line.text });
    else if (current.comparisonText !== line.comparisonText) {
      changed.push({ ref: current.ref, before: line.text, after: current.text });
    }
  }
  for (const [identity, line] of after.byIdentity) {
    if (!before.byIdentity.has(identity)) added.push({ ref: line.ref, text: line.text });
  }

  const beforeCounts = lineCounts(before.snapshot.lines);
  const afterCounts = lineCounts(after.snapshot.lines);
  for (const [text, count] of beforeCounts) {
    const difference = count - (afterCounts.get(text) ?? 0);
    for (let index = 0; index < difference; index += 1) removed.push({ text });
  }
  for (const [text, count] of afterCounts) {
    const difference = count - (beforeCounts.get(text) ?? 0);
    for (let index = 0; index < difference; index += 1) added.push({ text });
  }
  return { added, removed, changed };
};

const cookieIdentity = (cookie: StorageState["cookies"][number]) =>
  `${cookie.name}@${cookie.domain}${cookie.path}`;
const cookieValue = (cookie: StorageState["cookies"][number]) => JSON.stringify(cookie);
const localStorageIdentity = (origin: string, name: string) => `${name}@${origin}`;

const compareMaps = (before: Map<string, string>, after: Map<string, string>) => {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, value] of before) {
    const current = after.get(key);
    if (current === undefined) removed.push(key);
    else if (current !== value) changed.push(key);
  }
  for (const key of after.keys()) {
    if (!before.has(key)) added.push(key);
  }
  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed };
};

export const diffStorageStates = (before: StorageState, after: StorageState): StorageDiff => {
  const beforeCookies = new Map(
    before.cookies.map((cookie) => [cookieIdentity(cookie), cookieValue(cookie)]),
  );
  const afterCookies = new Map(after.cookies.map((cookie) => [cookieIdentity(cookie), cookieValue(cookie)]));
  const beforeStorage = new Map<string, string>();
  const afterStorage = new Map<string, string>();
  for (const origin of before.origins) {
    for (const item of origin.localStorage) {
      beforeStorage.set(localStorageIdentity(origin.origin, item.name), item.value);
    }
  }
  for (const origin of after.origins) {
    for (const item of origin.localStorage) {
      afterStorage.set(localStorageIdentity(origin.origin, item.name), item.value);
    }
  }
  return {
    cookies: compareMaps(beforeCookies, afterCookies),
    localStorage: compareMaps(beforeStorage, afterStorage),
  };
};

const checkpointPublicationBase = (
  scope: CaptureScope,
): Pick<ArtifactPublication, "browserMode" | "connectionId" | "origin" | "targetId"> => ({
  connectionId: scope.connectionId,
  browserMode: scope.browserMode,
  targetId: scope.targetId,
  origin: "checkpoint",
});

type CheckpointScreenshotOptions = {
  ledger: ArtifactPublicationLedger;
  scope: CaptureScope;
  checkpointId: string;
  screenshot: ScreenshotCapture | undefined;
};

const publishCheckpointScreenshot = async ({
  ledger,
  scope,
  checkpointId,
  screenshot,
}: CheckpointScreenshotOptions) => {
  if (!screenshot) return undefined;

  const artifact = await ledger.publish({
    ...checkpointPublicationBase(scope),
    name: screenshot.output.name,
    mediaType: screenshot.output.mediaType,
    complete: true,
    source: screenshot.output.source,
    metadata: { checkpointId, kind: "screenshot", ...screenshot.output.metadata },
  });

  return { capture: screenshot, artifact };
};

export class CheckpointManager {
  private readonly artifacts: ArtifactPublisher;
  private readonly runtime: CheckpointRuntimeAdapter;
  private readonly pixels?: PixelDiffAdapter;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly checkpoints = new Map<string, StoredCheckpoint>();

  constructor(options: CheckpointManagerOptions) {
    this.artifacts = options.artifacts;
    this.runtime = options.runtime;
    this.pixels = options.pixels;
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIds;
  }

  async create(request: CheckpointCreateRequest): Promise<CheckpointCreated> {
    assertScope(request.scope);
    const options = request.options ?? {};
    if (
      options.name !== undefined &&
      (options.name.length === 0 || encoder.encode(options.name).byteLength > 128)
    ) {
      throw captureError(
        "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
        "Checkpoint name must contain from 1 through 128 UTF-8 bytes.",
      );
    }
    const checkpointId = this.ids.next("checkpoint");
    const [page, snapshot, eventCursor, storage] = await Promise.all([
      this.runtime.pageMetadata(request.scope),
      this.runtime.snapshot(request.scope),
      this.runtime.eventCursor(request.scope),
      options.storage ? this.runtime.storage(request.scope) : Promise.resolve(undefined),
    ]);
    if (
      !Number.isSafeInteger(eventCursor.ownerGeneration) ||
      eventCursor.ownerGeneration < 1 ||
      !Number.isSafeInteger(eventCursor.sequence) ||
      eventCursor.sequence < 0
    ) {
      throw captureError(
        "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
        "Checkpoint event cursor must contain a positive owner generation and a non-negative sequence.",
      );
    }
    const screenshot = options.screenshot ? await this.runtime.screenshot(request.scope) : undefined;
    const capturedAt = this.clock.now().toISOString();
    const ledger = new ArtifactPublicationLedger(this.artifacts, {
      connectionId: request.scope.connectionId,
      kind: "checkpoint",
    });
    try {
      const publication = await ledger.run(async (publicationLedger) => {
        const storedScreenshot = await publishCheckpointScreenshot({
          ledger: publicationLedger,
          scope: request.scope,
          checkpointId,
          screenshot,
        });
        const recordBody = {
          checkpointId,
          name: options.name,
          targetId: request.scope.targetId,
          capturedAt,
          eventCursor,
          page,
          snapshot: snapshot.snapshot,
          screenshot: storedScreenshot?.artifact,
          storage,
        };
        const artifact = await publicationLedger.publish({
          ...checkpointPublicationBase(request.scope),
          name: `${checkpointId}.json`,
          mediaType: "application/json",
          complete: true,
          source: { kind: "bytes", bytes: encoder.encode(JSON.stringify(recordBody)) },
          metadata: {
            checkpointId,
            checkpointName: options.name,
            includesScreenshot: storedScreenshot !== undefined,
            includesStorage: storage !== undefined,
          },
        });
        return {
          checkpoint: {
            checkpointId,
            scope: cloneScope(request.scope),
            page,
            snapshot,
            eventCursor,
            screenshot: storedScreenshot,
            storage,
          },
          result: {
            checkpointId,
            targetId: request.scope.targetId,
            eventCursor,
            snapshotId: snapshot.snapshot.snapshotId,
            artifact,
            artifacts: [...publicationLedger.artifacts],
          },
        };
      });
      this.checkpoints.set(checkpointId, publication.checkpoint);
      return publication.result;
    } catch (error) {
      if (screenshot) await this.runtime.discardScreenshot?.(screenshot);
      throw error;
    }
  }

  async diff(request: CheckpointDiffRequest): Promise<CheckpointDiffResult> {
    assertScope(request.scope);
    const checkpoint = this.checkpoints.get(request.checkpointId);
    if (
      !checkpoint ||
      checkpoint.scope.connectionId !== request.scope.connectionId ||
      checkpoint.scope.browserMode !== request.scope.browserMode ||
      checkpoint.scope.contextId !== request.scope.contextId
    ) {
      throw captureError(
        "CHROME_MCP_CHECKPOINT_NOT_FOUND",
        `Checkpoint ${request.checkpointId} was not found for this browser owner.`,
      );
    }
    const options = {
      snapshot: request.options?.snapshot ?? true,
      screenshot: request.options?.screenshot ?? false,
      events: request.options?.events ?? true,
      storage: request.options?.storage ?? false,
    };
    if (options.screenshot && (!checkpoint.screenshot || !this.pixels)) {
      throw captureError(
        "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
        checkpoint.screenshot ?
          "Screenshot comparison is unavailable because no pixel-diff adapter is configured."
        : "The checkpoint does not contain a screenshot.",
      );
    }
    if (options.storage && !checkpoint.storage) {
      throw captureError(
        "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
        "The checkpoint does not contain storage state.",
      );
    }

    const [page, snapshot, events, storage, screenshot] = await Promise.all([
      this.runtime.pageMetadata(request.scope),
      options.snapshot ? this.runtime.snapshot(request.scope) : Promise.resolve(undefined),
      options.events ?
        this.runtime.eventsSince(request.scope, checkpoint.eventCursor)
      : Promise.resolve(undefined),
      options.storage ? this.runtime.storage(request.scope) : Promise.resolve(undefined),
      options.screenshot ? this.runtime.screenshot(request.scope) : Promise.resolve(undefined),
    ]);
    let pixelResult: PixelDiffResult | undefined;
    if (screenshot && checkpoint.screenshot && this.pixels) {
      try {
        pixelResult = await this.pixels.diff(checkpoint.screenshot.capture.comparison, screenshot.comparison);
      } finally {
        await this.runtime.discardScreenshot?.(screenshot);
      }
    }
    const report: CheckpointDiffReport = {
      checkpointId: checkpoint.checkpointId,
      targetId: request.scope.targetId,
      comparedAt: this.clock.now().toISOString(),
      url: changedValue(checkpoint.page.url, page.url),
      title: changedValue(checkpoint.page.title, page.title),
      viewport: changedValue(checkpoint.page.viewport, page.viewport, sameViewport),
      ...(snapshot ? { snapshot: diffCompactSnapshots(checkpoint.snapshot, snapshot) } : {}),
      ...(events ? { events } : {}),
      ...(storage && checkpoint.storage ? { storage: diffStorageStates(checkpoint.storage, storage) } : {}),
      ...(pixelResult ?
        {
          pixels: {
            width: pixelResult.width,
            height: pixelResult.height,
            changedPixels: pixelResult.changedPixels,
            totalPixels: pixelResult.totalPixels,
            ratio: pixelResult.ratio,
          },
        }
      : {}),
    };

    const ledger = new ArtifactPublicationLedger(this.artifacts, {
      connectionId: request.scope.connectionId,
      kind: "checkpoint",
    });
    return ledger.run(async (publicationLedger) => {
      if (pixelResult?.output) {
        await publicationLedger.publish({
          ...checkpointPublicationBase(request.scope),
          name: pixelResult.output.name,
          mediaType: pixelResult.output.mediaType,
          complete: true,
          source: pixelResult.output.source,
          metadata: {
            checkpointId: checkpoint.checkpointId,
            kind: "pixel-diff",
            ...pixelResult.output.metadata,
          },
        });
      }
      const artifact = await publicationLedger.publish({
        ...checkpointPublicationBase(request.scope),
        name: `${checkpoint.checkpointId}-diff.json`,
        mediaType: "application/json",
        complete: true,
        source: { kind: "bytes", bytes: encoder.encode(JSON.stringify(report)) },
        metadata: {
          checkpointId: checkpoint.checkpointId,
          kind: "diff",
          comparedTargetId: request.scope.targetId,
        },
      });
      return {
        checkpointId: checkpoint.checkpointId,
        targetId: request.scope.targetId,
        artifact,
        artifacts: [...publicationLedger.artifacts],
        report,
      };
    });
  }

  async releaseConnection(connectionId: string) {
    const discarded: Promise<void>[] = [];
    for (const [checkpointId, checkpoint] of this.checkpoints) {
      if (checkpoint.scope.connectionId !== connectionId) continue;
      this.checkpoints.delete(checkpointId);
      if (checkpoint.screenshot && this.runtime.discardScreenshot) {
        discarded.push(this.runtime.discardScreenshot(checkpoint.screenshot.capture));
      }
    }
    await Promise.allSettled(discarded);
  }

  async releaseBrowser(browser: BrowserScope) {
    const discarded: Promise<void>[] = [];
    for (const [checkpointId, checkpoint] of this.checkpoints) {
      if (
        checkpoint.scope.connectionId !== browser.connectionId ||
        checkpoint.scope.browserMode !== browser.browserMode ||
        checkpoint.scope.browserGeneration !== browser.browserGeneration ||
        checkpoint.scope.contextId !== browser.contextId
      ) {
        continue;
      }
      this.checkpoints.delete(checkpointId);
      if (checkpoint.screenshot && this.runtime.discardScreenshot) {
        discarded.push(this.runtime.discardScreenshot(checkpoint.screenshot.capture));
      }
    }
    await Promise.allSettled(discarded);
  }
}
