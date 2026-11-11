import { describe, expect, test } from "bun:test";
import type {
  BrowserJournalEvent,
  BrowserMode,
  EventCursor,
  GenerationTargetId,
  JournalReadOptions,
  JournalReadResult,
} from "../runtime";
import { isRecord } from "../../platform/records";
import { type CaptureScope, diffCompactSnapshots } from "../captures";
import {
  ChromePageAdapter,
  type ChromePageSession,
  createChromeSnapshotConnection,
  formatSnapshotResult,
} from "./page-adapter";

class SnapshotSession implements ChromePageSession {
  readonly browserMode: BrowserMode = "isolated";
  readonly connectionId = "snapshot-connection";
  ownerGeneration = 1;
  ownerId = "snapshot-owner";
  locatorAvailable = true;
  locatorCount = 1;
  releaseFailure: Error | undefined;
  stageFailure: Error | undefined;
  activeSnapshotConnections = 0;
  activeSnapshotRefs = 0;
  maximumSnapshotConnections = 0;
  maximumSnapshotRefs = 0;
  currentCursor: EventCursor = { ownerGeneration: 1, sequence: 0 };
  eventRead: JournalReadResult = {
    droppedBefore: null,
    events: [],
    nextCursor: this.currentCursor,
    ownerReset: false,
  };
  eventReads: JournalReadResult[] = [];
  eventReadOptions: JournalReadOptions[] = [];
  locatorProbes = new Map<
    string,
    Readonly<{
      recipe: Readonly<{
        frameChain: readonly string[];
        frameChainSegments: readonly (readonly string[])[];
        selector: string;
        selectorSegments: readonly string[];
      }>;
      state: "available";
    }>
  >();
  releaseCalls: string[] = [];
  stageCalls: string[] = [];
  stageOutcomes = new Map<string, "child-frame" | "collision" | "detached" | "staged">();
  stagedSnapshotNodes = new Map<string, string>();
  snapshotTargets: string[] = [];
  snapshotText = '- button "Save" [ref=e1]';
  snapshotIdentities = new Map<string, string>();
  #selected: GenerationTargetId = { ownerGeneration: 1, targetId: "target-a" };

  currentEventCursor(): Promise<EventCursor> {
    return Promise.resolve(this.currentCursor);
  }

  currentTarget(): GenerationTargetId {
    return this.#selected;
  }

  readEvents(options: JournalReadOptions = {}): Promise<JournalReadResult> {
    this.eventReadOptions.push(options);
    return Promise.resolve(this.eventReads.shift() ?? this.eventRead);
  }

  onCdp(_method: string, _listener: (params: unknown, sessionId: string | undefined) => void): () => void {
    return () => undefined;
  }

  selectTarget(targetId: string): void {
    this.#selected = { ownerGeneration: 1, targetId };
  }

  sendCdp(method: string): Promise<unknown> {
    return Promise.reject(new Error(`Unexpected CDP method ${method}`));
  }

  targetRecord(targetId: string): Promise<Readonly<{ title?: string; url: string }> | undefined> {
    return Promise.resolve({ title: targetId, url: `https://page.test/${targetId}` });
  }

  workerConnection() {
    return Promise.resolve({
      endpoint: "http://127.0.0.1:9222",
      ownerGeneration: 1,
      target: this.currentTarget(),
    });
  }
}

class SnapshotIdentityPage {
  readonly frame = {};
  document = 1;
  disposedRegistries = 0;
  frameDetached: (frame: object) => void = () => {};
  onFrameRead = () => {};
  beforeCreation = (_document: number) => Promise.resolve();
  beforeLookup = (_document: number) => Promise.resolve();

  on(_event: string, listener: (frame: object) => void) {
    this.frameDetached = listener;
  }

  off() {
    this.frameDetached = () => {};
  }

  ariaSnapshot() {
    return Promise.resolve('- button "Stable" [ref=e1]');
  }

  locator() {
    return {
      ariaSnapshot: () => this.ariaSnapshot(),
      count: () => Promise.resolve(1),
      elementHandle: () =>
        Promise.resolve({
          document: this.document,
          dispose: () => Promise.resolve(),
          evaluate: () => Promise.resolve(),
          ownerFrame: () => {
            this.onFrameRead();
            return Promise.resolve(this.frame);
          },
          evaluateHandle: async (_callback: unknown, prefix: string) => {
            const document = this.document;
            await this.beforeCreation(document);
            return {
              dispose: () => {
                this.disposedRegistries += 1;
                return Promise.resolve();
              },
              evaluate: async (_lookupCallback: unknown, element: unknown) => {
                if (!isRecord(element)) throw new Error("Snapshot element is missing");
                const identity = element.document === document ? `${prefix}:stable` : undefined;
                await this.beforeLookup(document);
                return identity;
              },
            };
          },
        }),
    };
  }
}

describe("Chrome snapshot identity initialization", () => {
  test("shares identities across concurrent first captures", async () => {
    const page = new SnapshotIdentityPage();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const secondFrame = Promise.withResolvers<void>();
    let frameReads = 0;
    page.beforeCreation = () => {
      started.resolve();
      return release.promise;
    };
    page.onFrameRead = () => {
      frameReads += 1;
      if (frameReads === 2) secondFrame.resolve();
    };
    const connection = createChromeSnapshotConnection(page, () => Promise.resolve());
    try {
      const first = connection.capture({ boxes: false, depth: 6 });
      await started.promise;
      const second = connection.capture({ boxes: false, depth: 6 });
      await secondFrame.promise;
      release.resolve();
      const captures = await Promise.all([first, second]);
      captures.push(await connection.capture({ boxes: false, depth: 6 }));
      for (const capture of captures) expect(capture.refs.size).toBe(1);
      expect(
        new Set(captures.flatMap((capture) => [...capture.refs.values()].map((ref) => ref.identity))).size,
      ).toBe(1);
    } finally {
      release.resolve();
      await connection.disconnect();
    }
    expect(page.disposedRegistries).toBe(1);
  });

  test("preserves a replacement registry when an older lookup finishes", async () => {
    const page = new SnapshotIdentityPage();
    const connection = createChromeSnapshotConnection(page, () => Promise.resolve());
    const firstLookup = Promise.withResolvers<void>();
    const secondLookup = Promise.withResolvers<void>();
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const oldLookups = [firstLookup, secondLookup];
    const lookupStarted = [firstStarted, secondStarted];
    const creationStarted = Promise.withResolvers<void>();
    const releaseCreation = Promise.withResolvers<void>();
    try {
      await connection.capture({ boxes: false, depth: 6 });
      page.document = 2;
      let lookup = 0;
      page.beforeLookup = (document) => {
        if (document !== 1) return Promise.resolve();
        const started = lookupStarted[lookup];
        const pending = oldLookups[lookup++];
        if (!started || !pending) throw new Error("Unexpected old-document lookup");
        started.resolve();
        return pending.promise;
      };
      page.beforeCreation = () => {
        creationStarted.resolve();
        return releaseCreation.promise;
      };
      const first = connection.capture({ boxes: false, depth: 6 });
      await firstStarted.promise;
      const second = connection.capture({ boxes: false, depth: 6 });
      await secondStarted.promise;
      firstLookup.resolve();
      await creationStarted.promise;
      secondLookup.resolve();
      releaseCreation.resolve();
      const captures = await Promise.all([first, second]);
      captures.push(await connection.capture({ boxes: false, depth: 6 }));
      for (const capture of captures) expect(capture.refs.size).toBe(1);
      expect(
        new Set(captures.flatMap((capture) => [...capture.refs.values()].map((ref) => ref.identity))).size,
      ).toBe(1);
    } finally {
      for (const pending of oldLookups) pending.resolve();
      releaseCreation.resolve();
      await connection.disconnect();
    }
    expect(page.disposedRegistries).toBe(2);
  });

  test("allows a later capture after registry initialization fails", async () => {
    const page = new SnapshotIdentityPage();
    const failure = new Error("Registry initialization failed");
    page.beforeCreation = () => Promise.reject(failure);
    const connection = createChromeSnapshotConnection(page, () => Promise.resolve());
    try {
      expect(connection.capture({ boxes: false, depth: 6 })).rejects.toBe(failure);
      page.beforeCreation = () => Promise.resolve();
      const captured = await connection.capture({ boxes: false, depth: 6 });
      expect(captured.refs.size).toBe(1);
    } finally {
      await connection.disconnect();
    }
    expect(page.disposedRegistries).toBe(1);
  });

  test.each(["frame-detachment", "disconnect"])(
    "disposes pending registry creation after %s",
    async (operation) => {
      const page = new SnapshotIdentityPage();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      page.beforeCreation = () => {
        started.resolve();
        return release.promise;
      };
      const connection = createChromeSnapshotConnection(page, () => Promise.resolve());
      const capture = connection.capture({ boxes: false, depth: 6 });
      await started.promise;
      if (operation === "frame-detachment") page.frameDetached(page.frame);
      const closed = operation === "disconnect" ? connection.disconnect() : Promise.resolve();
      release.resolve();
      await Promise.all([expect(capture).rejects.toMatchObject({ code: "CHROME_MCP_STALE_REF" }), closed]);
      expect(page.disposedRegistries).toBe(1);
      if (operation === "frame-detachment") await connection.disconnect();
    },
  );
});

const createAdapter = (session: SnapshotSession) =>
  new ChromePageAdapter({
    connectSnapshot: (_runtime, targetId) => {
      session.snapshotTargets.push(targetId);
      session.activeSnapshotConnections += 1;
      session.maximumSnapshotConnections = Math.max(
        session.maximumSnapshotConnections,
        session.activeSnapshotConnections,
      );
      let disconnected = false;
      return Promise.resolve({
        capture: () =>
          Promise.resolve({
            refs: new Map(
              [...session.snapshotText.matchAll(/\[ref=([^\]]+)\]/gu)].flatMap((match) => {
                const nativeRef = match[1];
                if (!nativeRef) return [];
                session.activeSnapshotRefs += 1;
                session.maximumSnapshotRefs = Math.max(
                  session.maximumSnapshotRefs,
                  session.activeSnapshotRefs,
                );
                let disposed = false;
                return [
                  [
                    nativeRef,
                    {
                      identity: session.snapshotIdentities.get(nativeRef) ?? nativeRef,
                      dispose: () => {
                        if (!disposed) {
                          disposed = true;
                          session.activeSnapshotRefs -= 1;
                        }
                        return Promise.resolve();
                      },
                      locatorProbe: () => {
                        if (session.locatorCount !== 1 || !session.locatorAvailable) {
                          return Promise.resolve(undefined);
                        }
                        return Promise.resolve(
                          session.locatorProbes.get(nativeRef) ?? {
                            recipe: {
                              frameChain: [],
                              frameChainSegments: [],
                              selector: `css=[data-ref=${JSON.stringify(nativeRef)}]`,
                              selectorSegments: [`[data-ref=${JSON.stringify(nativeRef)}]`],
                            },
                            state: "available" as const,
                          },
                        );
                      },
                      releaseStaged: async (key): Promise<"absent" | "released" | "replaced"> => {
                        session.releaseCalls.push(key);
                        if (session.releaseFailure) throw session.releaseFailure;
                        const retainedRef = session.stagedSnapshotNodes.get(key);
                        if (retainedRef === undefined) return "absent";
                        if (retainedRef !== nativeRef) return "replaced";
                        session.stagedSnapshotNodes.delete(key);
                        return "released";
                      },
                      stage: async (key): Promise<"child-frame" | "collision" | "detached" | "staged"> => {
                        session.stageCalls.push(key);
                        if (session.stageFailure) throw session.stageFailure;
                        const outcome = session.stageOutcomes.get(nativeRef) ?? "staged";
                        if (outcome === "staged") session.stagedSnapshotNodes.set(key, nativeRef);
                        return outcome;
                      },
                    },
                  ] as const,
                ];
              }),
            ),
            text: session.snapshotText,
          }),
        disconnect: () => {
          if (!disconnected) {
            disconnected = true;
            session.activeSnapshotConnections -= 1;
          }
          return Promise.resolve();
        },
      });
    },
    resolveContext: () => session,
    resolveScope: () => session,
    resolveTarget: () => Promise.resolve(session),
  });

const snapshotTree = (value: Awaited<ReturnType<ChromePageAdapter["snapshotForHelper"]>>): string => {
  if (typeof value.value.tree !== "string") throw new Error("Snapshot did not return a tree");
  return value.value.tree;
};

const snapshotForCurrent = (
  adapter: ChromePageAdapter,
  session: SnapshotSession,
  options: Record<string, boolean | number | string> = {},
) => adapter.snapshotForHelper(session, { options, target: session.currentTarget() });

const locatorForCurrent = (adapter: ChromePageAdapter, session: SnapshotSession, ref: string) =>
  adapter.locatorForHelper(session, session.currentTarget(), ref);

const stageForCurrent = (adapter: ChromePageAdapter, session: SnapshotSession, ref: string) =>
  adapter.stageSnapshotElement(session, session.currentTarget(), ref);

const refOnLine = (tree: string, text: string): string => {
  const line = tree.split("\n").find((candidate) => candidate.includes(text));
  const ref = line ? /(?:^|\s)ref=([^\s]+)(?:\s|$)/u.exec(line)?.[1] : undefined;
  if (!ref) throw new Error(`Snapshot line did not contain a ref: ${text}`);
  return ref;
};

const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error: unknown) {
    expect(error).toMatchObject({ code });
  }
};

describe("ChromePageAdapter checkpoint events", () => {
  test("preserves a cross-generation cursor and journal recovery metadata", async () => {
    const session = new SnapshotSession();
    const adapter = createAdapter(session);
    const checkpointScope: CaptureScope = {
      browserGeneration: 2,
      browserMode: "isolated",
      connectionId: session.connectionId,
      contextId: "context-1",
      targetId: "target-1",
    };
    const checkpointCursor = { ownerGeneration: 1, sequence: 10 };
    const event: BrowserJournalEvent = {
      monotonicTime: 1,
      ownerGeneration: 2,
      popupTargetId: "popup-1",
      sequence: 1,
      targetId: "target-a",
      type: "popup",
      wallTime: "2026-01-01T00:00:01.000Z",
    };
    session.currentCursor = { ownerGeneration: 2, sequence: 1 };
    session.eventRead = {
      droppedBefore: null,
      events: [event],
      nextCursor: session.currentCursor,
      ownerReset: true,
    };

    expect(await adapter.eventCursor(checkpointScope)).toEqual(session.currentCursor);
    expect(await adapter.eventsSince(checkpointScope, checkpointCursor)).toEqual(session.eventRead);
    expect(session.eventReadOptions).toEqual([{ after: checkpointCursor, limit: 200, target: "target-1" }]);
  });

  test("retains first-page recovery metadata while collecting every event page", async () => {
    const session = new SnapshotSession();
    const adapter = createAdapter(session);
    const checkpointScope: CaptureScope = {
      browserGeneration: 2,
      browserMode: "isolated",
      connectionId: session.connectionId,
      contextId: "context-1",
      targetId: "target-1",
    };
    const eventAt = (sequence: number): BrowserJournalEvent => ({
      monotonicTime: sequence,
      ownerGeneration: 2,
      popupTargetId: `popup-${sequence}`,
      sequence,
      targetId: "target-1",
      type: "popup",
      wallTime: "2026-01-01T00:00:01.000Z",
    });
    session.currentCursor = { ownerGeneration: 2, sequence: 201 };
    session.eventReads = [
      {
        droppedBefore: { ownerGeneration: 2, sequence: 200 },
        events: [eventAt(200)],
        nextCursor: { ownerGeneration: 2, sequence: 200 },
        ownerReset: true,
      },
      {
        droppedBefore: null,
        events: [eventAt(201)],
        nextCursor: session.currentCursor,
        ownerReset: false,
      },
    ];

    expect(await adapter.eventsSince(checkpointScope, { ownerGeneration: 1, sequence: 10 })).toEqual({
      droppedBefore: { ownerGeneration: 2, sequence: 200 },
      events: [eventAt(200), eventAt(201)],
      nextCursor: { ownerGeneration: 2, sequence: 201 },
      ownerReset: true,
    });
    expect(session.eventReadOptions).toEqual([
      { after: { ownerGeneration: 1, sequence: 10 }, limit: 200, target: "target-1" },
      { after: { ownerGeneration: 2, sequence: 200 }, limit: 200, target: "target-1" },
    ]);
  });
});

describe("ChromePageAdapter snapshots and refs", () => {
  test("bounds complete JSON while retaining every captured ref for full mode", async () => {
    const session = new SnapshotSession();
    session.snapshotText = Array.from(
      { length: 200 },
      (_, index) =>
        `${index === 1 ? "  " : ""}- button "Action ${index} 😀 \\ path" [ref=e${index}]${index === 0 ? ":" : ""}`,
    ).join("\n");
    const adapter = createAdapter(session);
    try {
      const prepared = await snapshotForCurrent(adapter, session);
      const bounded = formatSnapshotResult(prepared);
      expect(prepared.maxBytes).toBe(16 * 1024);
      expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(16 * 1024);
      expect(bounded.view).toBe("bounded");
      expect(bounded.omissionReason).toBe("maxBytes");
      expect(bounded.totals).toEqual({ treeLines: 200, refs: 200, added: 0, changed: 0, removed: 0 });
      const shown = Object.keys(bounded.refs);
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.length).toBeLessThan(200);
      expect(bounded.omitted.refs + shown.length).toBe(200);
      expect(bounded.tree?.split("\n")).toEqual(prepared.completeText.split("\n").slice(0, shown.length));
      for (const ref of shown) {
        expect(bounded.tree).toContain(ref);
        expect(await locatorForCurrent(adapter, session, ref)).toMatchObject({ targetId: "target-a" });
      }
      const full = formatSnapshotResult({ ...prepared, view: "full" });
      expect(full.tree).toBe(prepared.completeText);
      expect(Object.keys(full.refs)).toHaveLength(200);
      expect(full.omissionReason).toBeNull();
      const lastRef = Object.keys(full.refs).at(-1);
      if (!lastRef) throw new Error("Full snapshot has no final ref");
      expect(await locatorForCurrent(adapter, session, lastRef)).toMatchObject({ targetId: "target-a" });
      const exactBytes = Buffer.byteLength(JSON.stringify({ ...full, view: "bounded" }));
      const exact = formatSnapshotResult({ ...prepared, maxBytes: exactBytes });
      expect(exact.omissionReason).toBeNull();
      expect(Buffer.byteLength(JSON.stringify(exact))).toBe(exactBytes);
      const smaller = formatSnapshotResult({ ...prepared, maxBytes: exactBytes - 1 });
      expect(smaller.omissionReason).toBe("maxBytes");
      expect(Buffer.byteLength(JSON.stringify(smaller))).toBeLessThan(exactBytes);
    } finally {
      await adapter.close();
    }
  });

  test("omits oversized metadata and tree entries whole without losing complete data", async () => {
    const session = new SnapshotSession();
    const title = "界".repeat(5000);
    const url = `https://example.test/${"x".repeat(5000)}`;
    session.targetRecord = () => Promise.resolve({ title, url });
    session.snapshotText = `- button "${title}" [ref=e1]\n- button "Later" [ref=e2]`;
    const adapter = createAdapter(session);
    try {
      const prepared = await snapshotForCurrent(adapter, session, { maxBytes: 4096 });
      const bounded = formatSnapshotResult(prepared);
      expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(4096);
      expect(bounded).toMatchObject({
        tree: "",
        refs: {},
        omitted: { treeLines: 2, refs: 2, metadataFields: ["url", "title"] },
      });
      expect(bounded.url).toBeUndefined();
      expect(bounded.title).toBeUndefined();
      expect(prepared.value).toMatchObject({ url, title });
      expect(prepared.completeText).toContain(title);
      expect(Object.keys(prepared.value.refs)).toHaveLength(2);
      session.snapshotText = "";
      session.targetRecord = () => Promise.resolve({ title: "", url: "" });
      const empty = await snapshotForCurrent(adapter, session, { maxBytes: 4096 });
      const overhead = Buffer.byteLength(JSON.stringify(formatSnapshotResult(empty)));
      session.targetRecord = () => Promise.resolve({ title, url: "u".repeat(4096 - overhead) });
      const nearLimit = formatSnapshotResult(await snapshotForCurrent(adapter, session, { maxBytes: 4096 }));
      expect(Buffer.byteLength(JSON.stringify(nearLimit))).toBeLessThanOrEqual(4096);
      expect(nearLimit.omitted.metadataFields).toEqual(["url", "title"]);
    } finally {
      await adapter.close();
    }
  });

  test("counts repeated refs once across byte boundaries with artifact links", async () => {
    const session = new SnapshotSession();
    session.snapshotText = '- button "界 😀 \\ path" [ref=e1]';
    const adapter = createAdapter(session);
    try {
      const prepared = await snapshotForCurrent(adapter, session);
      const line = snapshotTree(prepared);
      const artifacts = {
        dataArtifact: {
          artifactId: "synthetic",
          complete: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: null,
          mediaType: "application/json",
          name: "snapshot-界.json",
          sha256: "a".repeat(64),
          size: 1234,
          uri: "chrome-artifact://synthetic/content",
        },
      };
      for (const count of [9, 10, 99, 100]) {
        const repeated = {
          ...prepared,
          value: { ...prepared.value, tree: Array.from({ length: count }, () => line).join("\n") },
        };
        const complete: ReturnType<typeof formatSnapshotResult> = {
          ...repeated.value,
          ...artifacts,
          view: "bounded",
          totals: { treeLines: count, refs: 1, added: 0, changed: 0, removed: 0 },
          omitted: { treeLines: 0, refs: 0, added: 0, changed: 0, removed: 0, metadataFields: [] },
          omissionReason: null,
        };
        const bytes = Buffer.byteLength(JSON.stringify(complete));
        expect(formatSnapshotResult({ ...repeated, maxBytes: bytes }, artifacts)).toEqual(complete);
        const bounded = formatSnapshotResult({ ...repeated, maxBytes: bytes - 1 }, artifacts);
        expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(bytes);
        expect(bounded.omissionReason).toBe("maxBytes");
        expect(bounded.omitted.refs).toBe(0);
        expect(Object.keys(bounded.refs)).toHaveLength(1);
        expect(bounded.tree?.split("\n").length).toBe(count - bounded.omitted.treeLines);
        expect(bounded.dataArtifact).toEqual(artifacts.dataArtifact);
      }
    } finally {
      await adapter.close();
    }
  });

  test("bounds each change category in order and exposes only current displayed refs", async () => {
    const session = new SnapshotSession();
    session.snapshotText = Array.from(
      { length: 200 },
      (_, index) => `- button "Before ${index}" [ref=e${index}]`,
    ).join("\n");
    const adapter = createAdapter(session);
    try {
      const before = await snapshotForCurrent(adapter, session);
      session.snapshotText = Array.from({ length: 200 }, (_, index) => {
        const identity = index < 100 ? index : index + 100;
        return `- button "After ${identity}" [ref=e${identity}]`;
      }).join("\n");
      const prepared = await snapshotForCurrent(adapter, session, {
        diffFrom: before.value.snapshotId,
        maxBytes: 4096,
      });
      const bounded = formatSnapshotResult(prepared);
      expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(4096);
      expect(bounded.totals).toMatchObject({ added: 100, changed: 100, removed: 100, refs: 200 });
      for (const kind of ["added", "changed", "removed"] as const) {
        const displayed = bounded[kind];
        const complete = prepared.value[kind];
        if (!displayed || !complete) throw new Error("Snapshot diff category is missing");
        expect(displayed.length).toBeGreaterThan(0);
        expect(displayed).toEqual(complete.slice(0, displayed.length));
        expect(bounded.omitted[kind] + displayed.length).toBe(100);
      }
      const currentText = [...(bounded.added ?? []), ...(bounded.changed ?? [])].join("\n");
      expect(Object.keys(bounded.refs).length).toBeGreaterThan(0);
      for (const ref of Object.keys(bounded.refs)) {
        expect(currentText).toContain(ref);
        expect(before.value.refs[ref]).toBeUndefined();
        expect(await locatorForCurrent(adapter, session, ref)).toMatchObject({ targetId: "target-a" });
      }
    } finally {
      await adapter.close();
    }
  });

  test("compares literal ref markers in accessible names as content", async () => {
    const session = new SnapshotSession();
    session.snapshotText = '- button "Show [ref=alpha]" [ref=e1]';
    session.snapshotIdentities.set("alpha", "same-button");
    session.snapshotIdentities.set("beta", "same-button");
    session.snapshotIdentities.set("e1", "same-button");
    const adapter = createAdapter(session);
    try {
      const first = await snapshotForCurrent(adapter, session);
      session.snapshotText = '- button "Show [ref=beta]" [ref=e1]';
      const second = await snapshotForCurrent(adapter, session, { diffFrom: first.value.snapshotId });
      expect(second.value.added).toEqual([]);
      expect(second.value.removed).toEqual([]);
      expect(second.value.changed).toHaveLength(1);
      const checkpointDiff = diffCompactSnapshots(first.snapshot, second.snapshot);
      expect(checkpointDiff.added).toEqual([]);
      expect(checkpointDiff.removed).toEqual([]);
      expect(checkpointDiff.changed).toHaveLength(1);
    } finally {
      await adapter.close();
    }
  });

  test("compares unchanged nodes independently of fresh action refs", async () => {
    const session = new SnapshotSession();
    const adapter = createAdapter(session);
    try {
      const first = await snapshotForCurrent(adapter, session);
      const snapshotId = first.value.snapshotId;
      if (typeof snapshotId !== "string") throw new Error("Snapshot ID is missing");
      const second = await snapshotForCurrent(adapter, session, { diffFrom: snapshotId });
      expect(second.value).toMatchObject({ added: [], removed: [], changed: [] });
      expect(second.value.refs).not.toEqual(first.value.refs);
      expect(await locatorForCurrent(adapter, session, refOnLine(snapshotTree(first), "Save"))).toMatchObject(
        { targetId: "target-a" },
      );
    } finally {
      await adapter.close();
    }
  });

  test("reports edited nodes and distinguishes identical-looking replacements", async () => {
    const session = new SnapshotSession();
    session.snapshotIdentities.set("e1", "document-a:save");
    const adapter = createAdapter(session);
    try {
      const first = await snapshotForCurrent(adapter, session);
      const snapshotId = first.value.snapshotId;
      if (typeof snapshotId !== "string") throw new Error("Snapshot ID is missing");
      session.snapshotText = '- button "Saved" [ref=e2] [disabled]';
      session.snapshotIdentities.set("e2", "document-a:save");
      const edited = await snapshotForCurrent(adapter, session, { diffFrom: snapshotId });
      expect(edited.value.added).toEqual([]);
      expect(edited.value.removed).toEqual([]);
      expect(edited.value.changed).toEqual([expect.stringContaining('button "Save"')]);
      expect(edited.value.changed).toEqual([expect.stringContaining('button "Saved"')]);

      session.snapshotText = '- button "Save" [ref=e1]';
      session.snapshotIdentities.set("e1", "document-b:save");
      const replacement = await snapshotForCurrent(adapter, session, { diffFrom: snapshotId });
      expect(replacement.value.changed).toEqual([]);
      expect(replacement.value.added).toEqual([expect.stringContaining('button "Save"')]);
      expect(replacement.value.removed).toEqual([expect.stringContaining('button "Save"')]);
    } finally {
      await adapter.close();
    }
  });

  test("compares checkpoints after the original action refs have been evicted", async () => {
    const session = new SnapshotSession();
    const adapter = createAdapter(session);
    const scope: CaptureScope = {
      browserGeneration: session.ownerGeneration,
      browserMode: session.browserMode,
      connectionId: session.connectionId,
      contextId: session.ownerId,
      targetId: session.currentTarget().targetId,
    };
    try {
      const before = await adapter.snapshot(scope);
      for (let index = 0; index < 10; index += 1) await snapshotForCurrent(adapter, session);
      const after = await adapter.snapshot(scope);
      expect(diffCompactSnapshots(before, after)).toEqual({ added: [], removed: [], changed: [] });
    } finally {
      await adapter.close();
    }
  });

  test("uses the staged call target before the session selection commits", async () => {
    const session = new SnapshotSession();
    const adapter = createAdapter(session);
    const stagedTarget = { ownerGeneration: 1, targetId: "target-b" };

    const result = await adapter.snapshotForHelper(session, { options: {}, target: stagedTarget });
    const ref = refOnLine(snapshotTree(result), "Save");

    expect(result.value.targetId).toBe("target-b");
    expect(session.currentTarget().targetId).toBe("target-a");
    expect(session.snapshotTargets).toEqual(["target-b"]);
    expect(await adapter.locatorForHelper(session, stagedTarget, ref)).toMatchObject({
      targetId: "target-b",
    });
  });

  test("localizes Playwright iframe refs and returns a public frame-chain recipe", async () => {
    const session = new SnapshotSession();
    session.snapshotText = ['- iframe "Same frame" [ref=e1]:', '  - button "Child action" [ref=f1e2]'].join(
      "\n",
    );
    session.locatorProbes.set("f1e2", {
      recipe: {
        frameChain: ["css=iframe#same"],
        frameChainSegments: [["iframe#same"]],
        selector: "css=button#child-action",
        selectorSegments: ["button#child-action"],
      },
      state: "available",
    });
    const adapter = createAdapter(session);

    const result = await snapshotForCurrent(adapter, session);
    const tree = snapshotTree(result);
    expect(tree).toContain('iframe "Same frame"');
    expect(tree).toContain('button "Child action"');

    const locator = await locatorForCurrent(adapter, session, refOnLine(tree, "Child action"));
    expect(locator).toEqual({
      frameChain: ["css=iframe#same"],
      selector: "css=button#child-action",
      targetId: "target-a",
    });
  });

  test("returns a public locator recipe for a ref inside an open shadow root", async () => {
    const session = new SnapshotSession();
    session.snapshotText = '- button "Open shadow" [ref=e1]';
    session.locatorProbes.set("e1", {
      recipe: {
        frameChain: [],
        frameChainSegments: [],
        selector: "css=x-actions >> css=button.primary",
        selectorSegments: ["x-actions", "button.primary"],
      },
      state: "available",
    });
    const adapter = createAdapter(session);

    const tree = snapshotTree(await snapshotForCurrent(adapter, session));
    expect(tree).toContain('button "Open shadow"');
    expect(await locatorForCurrent(adapter, session, refOnLine(tree, "Open shadow"))).toEqual({
      frameChain: [],
      selector: "css=x-actions >> css=button.primary",
      targetId: "target-a",
    });
  });

  test("stages each exact retained node under a one-use key and releases it idempotently", async () => {
    const session = new SnapshotSession();
    session.snapshotText = '- button "Save" [ref=e1]\n- button "Save" [ref=e2]';
    const adapter = createAdapter(session);
    const tree = snapshotTree(await snapshotForCurrent(adapter, session));
    const refs = [...tree.matchAll(/(?:^|\s)ref=([^\s]+)(?:\s|$)/gmu)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    );
    if (refs.length !== 2 || !refs[0] || !refs[1]) throw new Error("Expected two localized snapshot refs");

    const first = await stageForCurrent(adapter, session, refs[0]);
    const second = await stageForCurrent(adapter, session, refs[1]);

    expect(first.key).toMatch(/^__chromeMcpReactNode_[0-9a-f]{32}$/u);
    expect(second.key).toMatch(/^__chromeMcpReactNode_[0-9a-f]{32}$/u);
    expect(first.key).not.toBe(second.key);
    expect(session.stagedSnapshotNodes.get(first.key)).toBe("e1");
    expect(session.stagedSnapshotNodes.get(second.key)).toBe("e2");

    await first.release();
    await first.release();
    expect(session.releaseCalls.filter((key) => key === first.key)).toHaveLength(1);
    expect(session.stagedSnapshotNodes.has(first.key)).toBeFalse();
    await second.release();
  });

  test("rejects detached and child-frame retained nodes without selector fallback", async () => {
    const childSession = new SnapshotSession();
    childSession.stageOutcomes.set("e1", "child-frame");
    const childAdapter = createAdapter(childSession);
    const childTree = snapshotTree(await snapshotForCurrent(childAdapter, childSession));
    await expectCode(
      stageForCurrent(childAdapter, childSession, refOnLine(childTree, "Save")),
      "CHROME_MCP_REACT_UNSUPPORTED_OPERATION",
    );

    const detachedSession = new SnapshotSession();
    detachedSession.stageOutcomes.set("e1", "detached");
    const detachedAdapter = createAdapter(detachedSession);
    const detachedTree = snapshotTree(await snapshotForCurrent(detachedAdapter, detachedSession));
    await expectCode(
      stageForCurrent(detachedAdapter, detachedSession, refOnLine(detachedTree, "Save")),
      "CHROME_MCP_STALE_REF",
    );

    const unavailableSession = new SnapshotSession();
    unavailableSession.stageFailure = new Error("injected unavailable retained handle");
    const unavailableAdapter = createAdapter(unavailableSession);
    const unavailableTree = snapshotTree(await snapshotForCurrent(unavailableAdapter, unavailableSession));
    await expectCode(
      stageForCurrent(unavailableAdapter, unavailableSession, refOnLine(unavailableTree, "Save")),
      "CHROME_MCP_STALE_REF",
    );
  });

  test("treats a destroyed staging context as released and surfaces live cleanup failures", async () => {
    const destroyedSession = new SnapshotSession();
    const destroyedAdapter = createAdapter(destroyedSession);
    const destroyedTree = snapshotTree(await snapshotForCurrent(destroyedAdapter, destroyedSession));
    const destroyed = await stageForCurrent(
      destroyedAdapter,
      destroyedSession,
      refOnLine(destroyedTree, "Save"),
    );
    destroyedSession.releaseFailure = new Error(
      "Execution context was destroyed, most likely because of a navigation",
    );
    await destroyed.release();
    await destroyed.release();
    expect(destroyedSession.releaseCalls).toEqual([destroyed.key]);

    const liveSession = new SnapshotSession();
    const liveAdapter = createAdapter(liveSession);
    const liveTree = snapshotTree(await snapshotForCurrent(liveAdapter, liveSession));
    const live = await stageForCurrent(liveAdapter, liveSession, refOnLine(liveTree, "Save"));
    liveSession.releaseFailure = new Error("injected live cleanup failure");
    await expectCode(live.release(), "CHROME_MCP_REACT_STALE_COMPONENT");
  });

  test("rejects a retained ref that no longer produces an exact locator recipe", async () => {
    const session = new SnapshotSession();
    session.snapshotText = '- button "Save" [ref=e1]\n- button "Save" [ref=e2]';
    const adapter = createAdapter(session);
    const tree = snapshotTree(await snapshotForCurrent(adapter, session));
    session.locatorAvailable = false;

    await expectCode(locatorForCurrent(adapter, session, refOnLine(tree, "Save")), "CHROME_MCP_STALE_REF");
  });

  test("rejects replacement and navigation without substituting another node", async () => {
    const replacementSession = new SnapshotSession();
    const replacementAdapter = createAdapter(replacementSession);
    const replacementTree = snapshotTree(await snapshotForCurrent(replacementAdapter, replacementSession));
    replacementSession.locatorAvailable = false;
    await expectCode(
      locatorForCurrent(replacementAdapter, replacementSession, refOnLine(replacementTree, "Save")),
      "CHROME_MCP_STALE_REF",
    );

    const navigatedSession = new SnapshotSession();
    const navigatedAdapter = createAdapter(navigatedSession);
    const navigatedTree = snapshotTree(await snapshotForCurrent(navigatedAdapter, navigatedSession));
    navigatedSession.locatorCount = 0;
    await expectCode(
      locatorForCurrent(navigatedAdapter, navigatedSession, refOnLine(navigatedTree, "Save")),
      "CHROME_MCP_STALE_REF",
    );
  });

  test("distinguishes a target mismatch from an unknown snapshot or ref", async () => {
    const session = new SnapshotSession();
    const adapter = createAdapter(session);
    const first = await snapshotForCurrent(adapter, session);
    const firstRef = refOnLine(snapshotTree(first), "Save");
    const firstSnapshotId = first.value.snapshotId;
    if (typeof firstSnapshotId !== "string") throw new Error("Snapshot ID is missing");
    session.selectTarget("target-b");
    await expectCode(
      snapshotForCurrent(adapter, session, { diffFrom: firstSnapshotId }),
      "CHROME_MCP_SNAPSHOT_TARGET_MISMATCH",
    );
    await expectCode(locatorForCurrent(adapter, session, firstRef), "CHROME_MCP_SNAPSHOT_TARGET_MISMATCH");
    await expectCode(stageForCurrent(adapter, session, firstRef), "CHROME_MCP_SNAPSHOT_TARGET_MISMATCH");
    await expectCode(snapshotForCurrent(adapter, session, { diffFrom: "missing" }), "CHROME_MCP_UNKNOWN_REF");
    await expectCode(locatorForCurrent(adapter, session, "s999e999"), "CHROME_MCP_UNKNOWN_REF");
    expect(session.snapshotTargets).toEqual(["target-a"]);
  });

  test("keeps evicted refs stale after arbitrary later snapshot eviction", async () => {
    const session = new SnapshotSession();
    const adapter = createAdapter(session);
    const firstRef = refOnLine(snapshotTree(await snapshotForCurrent(adapter, session)), "Save");
    let latestRef = firstRef;
    for (let index = 0; index < 80; index += 1) {
      latestRef = refOnLine(snapshotTree(await snapshotForCurrent(adapter, session)), "Save");
    }

    await expectCode(locatorForCurrent(adapter, session, firstRef), "CHROME_MCP_STALE_REF");
    await expectCode(stageForCurrent(adapter, session, firstRef), "CHROME_MCP_STALE_REF");
    expect(await locatorForCurrent(adapter, session, latestRef)).toMatchObject({ targetId: "target-a" });
  });

  test("keeps evicted refs target-mismatched on another target", async () => {
    const session = new SnapshotSession();
    const adapter = createAdapter(session);
    const firstRef = refOnLine(snapshotTree(await snapshotForCurrent(adapter, session)), "Save");
    for (let index = 0; index < 80; index += 1) await snapshotForCurrent(adapter, session);

    session.selectTarget("target-b");

    await expectCode(locatorForCurrent(adapter, session, firstRef), "CHROME_MCP_SNAPSHOT_TARGET_MISMATCH");
  });

  test("keeps fabricated refs unknown", async () => {
    const session = new SnapshotSession();
    const adapter = createAdapter(session);
    const issuedRef = refOnLine(snapshotTree(await snapshotForCurrent(adapter, session)), "Save");
    const finalCharacter = issuedRef.at(-1);
    const fabricatedRef = `${issuedRef.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;

    await expectCode(locatorForCurrent(adapter, session, "s999e999"), "CHROME_MCP_UNKNOWN_REF");
    await expectCode(locatorForCurrent(adapter, session, fabricatedRef), "CHROME_MCP_UNKNOWN_REF");
    await expectCode(stageForCurrent(adapter, session, fabricatedRef), "CHROME_MCP_UNKNOWN_REF");
  });

  test("keeps refs stale after their browser owner generation changes", async () => {
    const session = new SnapshotSession();
    const adapter = createAdapter(session);
    const ref = refOnLine(snapshotTree(await snapshotForCurrent(adapter, session)), "Save");

    session.ownerGeneration = 2;

    await expectCode(stageForCurrent(adapter, session, ref), "CHROME_MCP_STALE_REF");
  });

  test("releases snapshot connections and retained refs when each target closes", async () => {
    const session = new SnapshotSession();
    const adapter = createAdapter(session);

    for (let index = 0; index < 12; index += 1) {
      const targetId = `target-${index}`;
      session.selectTarget(targetId);
      const result = await snapshotForCurrent(adapter, session);
      const ref = refOnLine(snapshotTree(result), "Save");
      expect(await locatorForCurrent(adapter, session, ref)).toMatchObject({ targetId });
      expect(session.activeSnapshotConnections).toBe(1);
      expect(session.activeSnapshotRefs).toBe(1);

      await adapter.releaseTarget(session, targetId);

      expect(session.activeSnapshotConnections).toBe(0);
      expect(session.activeSnapshotRefs).toBe(0);
      await expectCode(locatorForCurrent(adapter, session, ref), "CHROME_MCP_STALE_REF");
    }

    expect(session.maximumSnapshotConnections).toBe(1);
    expect(session.maximumSnapshotRefs).toBe(1);
    await adapter.close();
  });

  test("releases snapshots for one browser owner without touching a sibling owner", async () => {
    const session = new SnapshotSession();
    const adapter = createAdapter(session);
    await snapshotForCurrent(adapter, session);

    session.ownerId = "snapshot-owner-2";
    const sibling = await snapshotForCurrent(adapter, session);
    const siblingRef = refOnLine(snapshotTree(sibling), "Save");
    expect(session.activeSnapshotConnections).toBe(2);
    expect(session.activeSnapshotRefs).toBe(2);

    await adapter.releaseOwner("snapshot-owner", 1);

    expect(session.activeSnapshotConnections).toBe(1);
    expect(session.activeSnapshotRefs).toBe(1);
    expect(await locatorForCurrent(adapter, session, siblingRef)).toMatchObject({ targetId: "target-a" });
    await adapter.close();
  });

  test("releases closed-page snapshot refs even when a pending media connection fails", async () => {
    const session = new SnapshotSession();
    const adapter = createAdapter(session);
    const started = Promise.withResolvers<void>();
    const connection = Promise.withResolvers<Awaited<ReturnType<SnapshotSession["workerConnection"]>>>();
    session.workerConnection = () => {
      started.resolve();
      return connection.promise;
    };
    try {
      const snapshot = await snapshotForCurrent(adapter, session);
      const ref = refOnLine(snapshotTree(snapshot), "Save");
      const media = adapter.emulateMedia(session, {
        targetId: session.currentTarget().targetId,
        options: { reducedMotion: "reduce" },
        signal: new AbortController().signal,
      });
      await started.promise;
      const released = adapter.releaseTarget(session, session.currentTarget().targetId);
      connection.reject(new Error("Page closed during attachment"));
      expect(media).rejects.toThrow("Page closed during attachment");
      await released;

      expect(session.activeSnapshotConnections).toBe(0);
      expect(session.activeSnapshotRefs).toBe(0);
      await expectCode(locatorForCurrent(adapter, session, ref), "CHROME_MCP_STALE_REF");
    } finally {
      await adapter.close();
    }
  });
});
