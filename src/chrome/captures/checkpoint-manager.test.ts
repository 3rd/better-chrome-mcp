import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { BrowserJournalEvent, EventCursor, JournalReadResult } from "../runtime";
import type {
  ArtifactDescriptor,
  ArtifactPublication,
  ArtifactPublisher,
  CaptureScope,
  CheckpointRuntimeAdapter,
  Clock,
  ComparableSnapshot,
  IdGenerator,
  PageMetadata,
  ScreenshotCapture,
  StorageState,
} from "./types";
import { CheckpointManager, diffCompactSnapshots, diffStorageStates } from "./checkpoint-manager";
import { artifactsFromError } from "./publication-ledger";

class ArtifactQuotaError extends Error {
  readonly code = "CHROME_MCP_ARTIFACT_QUOTA";
  readonly details = Object.freeze({ allowed: 1, measured: 2 });

  constructor() {
    super("Artifact publication quota was exceeded.");
    this.name = "ArtifactQuotaError";
  }
}

class MemoryArtifacts implements ArtifactPublisher {
  readonly publications: ArtifactPublication[] = [];
  private readonly failAt: number | undefined;
  private readonly shouldFailFinish: boolean;

  constructor(failAt?: number, shouldFailFinish = false) {
    this.failAt = failAt;
    this.shouldFailFinish = shouldFailFinish;
  }

  begin() {
    return Promise.resolve({
      publish: this.publish.bind(this),
      finish: () => (this.shouldFailFinish ? Promise.reject(new ArtifactQuotaError()) : Promise.resolve()),
    });
  }

  private publish(publication: ArtifactPublication): Promise<ArtifactDescriptor> {
    this.publications.push(publication);
    if (this.publications.length === this.failAt) return Promise.reject(new ArtifactQuotaError());
    const bytes =
      publication.source.kind === "bytes" ?
        publication.source.bytes
      : new TextEncoder().encode(publication.source.path);
    const artifactId = `artifact-${this.publications.length}`;
    return Promise.resolve({
      artifactId,
      name: publication.name,
      uri: `chrome-artifact://connection/${artifactId}/content`,
      mediaType: publication.mediaType,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      complete: publication.complete,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    });
  }
}

const scope = (overrides: Partial<CaptureScope> = {}): CaptureScope => ({
  connectionId: "connection-1",
  browserMode: "shared",
  browserGeneration: 1,
  contextId: "context-1",
  targetId: "target-1",
  viewport: { width: 800, height: 600 },
  ...overrides,
});

const ids = (): IdGenerator => {
  let next = 0;
  return { next: (prefix) => `${prefix}-${++next}` };
};

const clock = (): Clock => {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) };
};

const initialSnapshot: ComparableSnapshot = {
  snapshot: {
    snapshotId: "snapshot-1",
    text: "button Save ref=first\nheading Dashboard",
    lines: [{ ref: "first", text: "button Save ref=first" }, { text: "heading Dashboard" }],
  },
  byIdentity: new Map([
    [
      "document-1:save",
      {
        comparisonText: "button Save",
        ref: "first",
        text: "button Save ref=first",
      },
    ],
  ]),
};

const initialStorage: StorageState = {
  cookies: [{ name: "session", value: "one", domain: "example.test", path: "/" }],
  origins: [{ origin: "https://example.test", localStorage: [{ name: "theme", value: "light" }] }],
};

class Runtime implements CheckpointRuntimeAdapter {
  page: PageMetadata = {
    url: "https://example.test/one",
    title: "One",
    viewport: { width: 800, height: 600 },
  };
  currentSnapshot = initialSnapshot;
  cursor: EventCursor = { ownerGeneration: 1, sequence: 10 };
  currentStorage = initialStorage;
  screenshotCalls = 0;
  storageCalls = 0;
  events: JournalReadResult = {
    droppedBefore: null,
    events: [],
    nextCursor: this.cursor,
    ownerReset: false,
  };
  discardedScreenshots: ScreenshotCapture[] = [];

  async pageMetadata() {
    return this.page;
  }
  async snapshot() {
    return this.currentSnapshot;
  }
  async eventCursor() {
    return this.cursor;
  }
  async eventsSince(_scope: CaptureScope, cursor: EventCursor) {
    expect(cursor).toEqual({ ownerGeneration: 1, sequence: 10 });
    return this.events;
  }
  async screenshot(): Promise<ScreenshotCapture> {
    this.screenshotCalls += 1;
    return {
      output: {
        name: `screenshot-${this.screenshotCalls}.png`,
        mediaType: "image/png",
        source: { kind: "bytes", bytes: new Uint8Array([this.screenshotCalls]) },
      },
      comparison: `pixels-${this.screenshotCalls}`,
    };
  }
  async storage() {
    this.storageCalls += 1;
    return this.currentStorage;
  }
  discardScreenshot(screenshot: ScreenshotCapture) {
    this.discardedScreenshots.push(screenshot);
    return Promise.resolve();
  }
}

describe("CheckpointManager", () => {
  test("creates the default observation without reading screenshot or storage", async () => {
    const artifacts = new MemoryArtifacts();
    const runtime = new Runtime();
    const manager = new CheckpointManager({ artifacts, runtime, clock: clock(), ids: ids() });
    const created = await manager.create({ scope: scope() });

    expect(created).toMatchObject({
      checkpointId: "checkpoint-1",
      targetId: "target-1",
      eventCursor: { ownerGeneration: 1, sequence: 10 },
      snapshotId: "snapshot-1",
    });
    const publication = artifacts.publications[0];
    if (!publication || publication.source.kind !== "bytes") {
      throw new Error("Checkpoint manifest bytes are missing");
    }
    expect(JSON.parse(new TextDecoder().decode(publication.source.bytes))).toMatchObject({
      eventCursor: { ownerGeneration: 1, sequence: 10 },
    });
    expect(JSON.parse(new TextDecoder().decode(publication.source.bytes)).snapshot).toEqual(
      initialSnapshot.snapshot,
    );
    expect(runtime.screenshotCalls).toBe(0);
    expect(runtime.storageCalls).toBe(0);
    expect(artifacts.publications).toHaveLength(1);
    expect(artifacts.publications[0]?.metadata).toMatchObject({
      includesScreenshot: false,
      includesStorage: false,
    });
  });

  test("diffs every selected dimension and publishes report and pixel artifacts", async () => {
    const artifacts = new MemoryArtifacts();
    const runtime = new Runtime();
    const manager = new CheckpointManager({
      artifacts,
      runtime,
      clock: clock(),
      ids: ids(),
      pixels: {
        async diff(before, after) {
          expect([before, after]).toEqual(["pixels-1", "pixels-2"]);
          return {
            width: 800,
            height: 600,
            changedPixels: 120,
            totalPixels: 480_000,
            ratio: 0.000_25,
            output: {
              name: "pixel-diff.png",
              mediaType: "image/png",
              source: { kind: "bytes", bytes: new Uint8Array([9]) },
            },
          };
        },
      },
    });
    const created = await manager.create({
      scope: scope(),
      options: { name: "before", screenshot: true, storage: true },
    });
    runtime.page = { url: "https://example.test/two", title: "Two", viewport: { width: 1024, height: 768 } };
    runtime.currentSnapshot = {
      snapshot: {
        snapshotId: "snapshot-2",
        text: "button Saved ref=second\nheading Reports",
        lines: [{ ref: "second", text: "button Saved ref=second" }, { text: "heading Reports" }],
      },
      byIdentity: new Map([
        [
          "document-2:save",
          {
            comparisonText: "button Saved",
            ref: "second",
            text: "button Saved ref=second",
          },
        ],
      ]),
    };
    runtime.currentStorage = {
      cookies: [
        { name: "session", value: "two", domain: "example.test", path: "/" },
        { name: "new", value: "yes", domain: "example.test", path: "/" },
      ],
      origins: [{ origin: "https://example.test", localStorage: [{ name: "theme", value: "dark" }] }],
    };
    const newGenerationEvent: BrowserJournalEvent = {
      monotonicTime: 1,
      ownerGeneration: 2,
      popupTargetId: "popup-1",
      sequence: 1,
      targetId: "target-2",
      type: "popup",
      wallTime: "2026-01-01T00:00:01.000Z",
    };
    runtime.events = {
      droppedBefore: null,
      events: [newGenerationEvent],
      nextCursor: { ownerGeneration: 2, sequence: 1 },
      ownerReset: true,
    };

    const result = await manager.diff({
      scope: scope({ targetId: "target-2", browserGeneration: 2 }),
      checkpointId: created.checkpointId,
      options: { snapshot: true, screenshot: true, events: true, storage: true },
    });

    expect(result.report.url).toEqual({
      changed: true,
      before: "https://example.test/one",
      after: "https://example.test/two",
    });
    expect(result.report.title.changed).toBe(true);
    expect(result.report.viewport.changed).toBe(true);
    expect(result.report.snapshot).toEqual({
      added: [{ ref: "second", text: "button Saved ref=second" }, { text: "heading Reports" }],
      removed: [{ ref: "first", text: "button Save ref=first" }, { text: "heading Dashboard" }],
      changed: [],
    });
    expect(result.report.events).toEqual({
      droppedBefore: null,
      events: [newGenerationEvent],
      nextCursor: { ownerGeneration: 2, sequence: 1 },
      ownerReset: true,
    });
    expect(result.report.storage).toEqual({
      cookies: { added: ["new@example.test/"], removed: [], changed: ["session@example.test/"] },
      localStorage: { added: [], removed: [], changed: ["theme@https://example.test"] },
    });
    expect(result.report.pixels).toMatchObject({ changedPixels: 120, ratio: 0.000_25 });
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual([
      "pixel-diff.png",
      "checkpoint-1-diff.json",
    ]);
    expect(runtime.screenshotCalls).toBe(2);
    expect(runtime.storageCalls).toBe(2);
  });

  test("hides checkpoints across browser owners and releases only the requested owner", async () => {
    const artifacts = new MemoryArtifacts();
    const manager = new CheckpointManager({ artifacts, runtime: new Runtime(), clock: clock(), ids: ids() });
    const created = await manager.create({ scope: scope() });
    const siblingScope = scope({ contextId: "context-2", targetId: "target-2" });
    const sibling = await manager.create({ scope: siblingScope });
    for (const foreignScope of [
      scope({ connectionId: "connection-2" }),
      scope({ browserMode: "isolated" }),
      siblingScope,
    ]) {
      expect(manager.diff({ scope: foreignScope, checkpointId: created.checkpointId })).rejects.toMatchObject(
        {
          code: "CHROME_MCP_CHECKPOINT_NOT_FOUND",
        },
      );
    }

    await manager.releaseBrowser(scope());
    await manager.diff({ scope: siblingScope, checkpointId: sibling.checkpointId });
    expect(manager.diff({ scope: scope(), checkpointId: created.checkpointId })).rejects.toMatchObject({
      code: "CHROME_MCP_CHECKPOINT_NOT_FOUND",
    });

    await manager.releaseConnection("connection-1");
    expect(manager.diff({ scope: siblingScope, checkpointId: sibling.checkpointId })).rejects.toMatchObject({
      code: "CHROME_MCP_CHECKPOINT_NOT_FOUND",
    });
    expect("restore" in manager).toBe(false);
  });

  test("requires checkpoint opt-ins before screenshot or storage comparison", async () => {
    const manager = new CheckpointManager({
      artifacts: new MemoryArtifacts(),
      runtime: new Runtime(),
      clock: clock(),
      ids: ids(),
    });
    const created = await manager.create({ scope: scope() });
    expect(
      manager.diff({ scope: scope(), checkpointId: created.checkpointId, options: { screenshot: true } }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS" });
    expect(
      manager.diff({ scope: scope(), checkpointId: created.checkpointId, options: { storage: true } }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS" });
  });

  test("retains a published screenshot descriptor when the checkpoint manifest exceeds artifact quota", async () => {
    const artifacts = new MemoryArtifacts(2);
    const runtime = new Runtime();
    const manager = new CheckpointManager({ artifacts, runtime, clock: clock(), ids: ids() });

    try {
      await manager.create({ scope: scope(), options: { screenshot: true } });
      throw new Error("Expected checkpoint publication to fail.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "CHROME_MCP_ARTIFACT_QUOTA",
        details: { allowed: 1, measured: 2 },
      });
      expect(artifactsFromError(error)).toMatchObject([
        { artifactId: "artifact-1", name: "screenshot-1.png", expiresAt: null },
      ]);
    }
    expect(runtime.discardedScreenshots).toHaveLength(1);
  });

  test("retains every descriptor and withholds checkpoint state when publication finalization fails", async () => {
    const artifacts = new MemoryArtifacts(undefined, true);
    const runtime = new Runtime();
    const manager = new CheckpointManager({ artifacts, runtime, clock: clock(), ids: ids() });

    try {
      await manager.create({ scope: scope(), options: { screenshot: true } });
      throw new Error("Expected checkpoint publication finalization to fail.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "CHROME_MCP_ARTIFACT_QUOTA",
        details: { allowed: 1, measured: 2 },
      });
      expect(artifactsFromError(error).map((artifact) => artifact.name)).toEqual([
        "screenshot-1.png",
        "checkpoint-1.json",
      ]);
    }
    expect(manager.diff({ scope: scope(), checkpointId: "checkpoint-1" })).rejects.toMatchObject({
      code: "CHROME_MCP_CHECKPOINT_NOT_FOUND",
    });
    expect(runtime.discardedScreenshots).toHaveLength(1);
  });
});

describe("checkpoint diff helpers", () => {
  test("ignores action-ref rotation and reports edits using the current action ref", () => {
    const after: ComparableSnapshot = {
      snapshot: {
        snapshotId: "snapshot-2",
        text: "button Save ref=second\nheading Dashboard",
        lines: [{ ref: "second", text: "button Save ref=second" }, { text: "heading Dashboard" }],
      },
      byIdentity: new Map([
        [
          "document-1:save",
          {
            comparisonText: "button Save",
            ref: "second",
            text: "button Save ref=second",
          },
        ],
      ]),
    };
    expect(diffCompactSnapshots(initialSnapshot, after)).toEqual({ added: [], removed: [], changed: [] });

    after.byIdentity = new Map([
      [
        "document-1:save",
        {
          comparisonText: "button Saved",
          ref: "third",
          text: "button Saved ref=third",
        },
      ],
    ]);
    expect(diffCompactSnapshots(initialSnapshot, after)).toEqual({
      added: [],
      removed: [],
      changed: [{ ref: "third", before: "button Save ref=first", after: "button Saved ref=third" }],
    });
  });

  test("preserves duplicate unreferenced snapshot lines", () => {
    const before = {
      snapshot: { snapshotId: "one", text: "", lines: [{ text: "row" }, { text: "row" }] },
      byIdentity: new Map(),
    };
    const after = {
      snapshot: { snapshotId: "two", text: "", lines: [{ text: "row" }] },
      byIdentity: new Map(),
    };
    expect(diffCompactSnapshots(before, after).removed).toEqual([{ text: "row" }]);
  });

  test("reports storage identities without exposing changed values", () => {
    const after: StorageState = {
      cookies: [{ name: "session", value: "secret-two", domain: "example.test", path: "/" }],
      origins: [{ origin: "https://example.test", localStorage: [{ name: "token", value: "secret-two" }] }],
    };
    const before: StorageState = {
      cookies: [{ name: "session", value: "secret-one", domain: "example.test", path: "/" }],
      origins: [{ origin: "https://example.test", localStorage: [{ name: "token", value: "secret-one" }] }],
    };
    const diff = diffStorageStates(before, after);
    expect(diff).toEqual({
      cookies: { added: [], removed: [], changed: ["session@example.test/"] },
      localStorage: { added: [], removed: [], changed: ["token@https://example.test"] },
    });
    expect(JSON.stringify(diff)).not.toContain("secret");
  });
});
