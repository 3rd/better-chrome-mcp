import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  ArtifactDescriptor,
  ArtifactPublication,
  ArtifactPublisher,
  CaptureScope,
  Clock,
  IdGenerator,
  NetworkExchange,
  TraceAdapter,
  VideoAdapter,
} from "./types";
import { CaptureManager } from "./capture-manager";
import { CaptureFinalizeError } from "./errors";
import { artifactsFromError } from "./publication-ledger";

class ArtifactQuotaError extends Error {
  readonly code = "CHROME_MCP_ARTIFACT_QUOTA";
  readonly details = Object.freeze({ allowed: 1, measured: 2 });

  constructor() {
    super("Artifact publication quota was exceeded.");
    this.name = "ArtifactQuotaError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseObject = (bytes: Uint8Array) => {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(parsed)) throw new Error("Expected a JSON object.");

  return parsed;
};

class MemoryArtifacts implements ArtifactPublisher {
  readonly publications: ArtifactPublication[] = [];
  private readonly failAt: number | undefined;

  constructor(failAt?: number) {
    this.failAt = failAt;
  }

  begin() {
    return Promise.resolve({
      publish: this.publish.bind(this),
      finish: () => Promise.resolve(),
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

  json(publicationIndex = this.publications.length - 1) {
    const publication = this.publications[publicationIndex];
    if (!publication || publication.source.kind !== "bytes") {
      throw new Error("Expected an in-memory artifact.");
    }
    return parseObject(publication.source.bytes);
  }
}

const propertyRecord = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`Expected ${key} to be an object.`);
  return value;
};

const propertyRecords = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`Expected ${key} to be an object array.`);
  }
  return value;
};

const clock: Clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
const ids = (): IdGenerator => {
  let next = 0;
  return { next: (prefix) => `${prefix}-${++next}` };
};

const scope = (overrides: Partial<CaptureScope> = {}): CaptureScope => ({
  connectionId: "connection-1",
  browserMode: "shared",
  browserGeneration: 2,
  contextId: "context-1",
  targetId: "target-1",
  viewport: { width: 1280, height: 720 },
  ...overrides,
});

const exchange = (
  requestId: string,
  body: Uint8Array,
  overrides: Partial<NetworkExchange> = {},
): NetworkExchange => ({
  connectionId: "connection-1",
  browserMode: "shared",
  browserGeneration: 2,
  contextId: "context-1",
  targetId: "frame-target",
  rootTargetId: "target-1",
  sequence: Number(requestId.replace(/\D/g, "")) || 1,
  request: {
    requestId,
    url: `https://example.test/${requestId}`,
    method: "GET",
    startedAt: "2026-01-01T00:00:00.000Z",
  },
  response: {
    status: 200,
    completedAt: "2026-01-01T00:00:00.050Z",
    mediaType: "application/json",
    bodySize: body.byteLength,
  },
  loadBody: () => Promise.resolve({ bytes: body, mediaType: "application/json" }),
  ...overrides,
});

describe("CaptureManager", () => {
  test("keeps traces active across calls and enforces context and owner boundaries", async () => {
    const artifacts = new MemoryArtifacts();
    const finishes: string[] = [];
    const trace: TraceAdapter = {
      start(input) {
        return Promise.resolve(input.captureId);
      },
      finish(handle, input) {
        finishes.push(`${String(handle)}:${input.reason}`);
        return Promise.resolve({
          name: "trace.zip",
          mediaType: "application/zip",
          source: { kind: "bytes", bytes: new Uint8Array([1, 2]) },
        });
      },
    };
    const manager = new CaptureManager({ artifacts, trace, clock, ids: ids() });
    const started = await manager.start({ scope: scope(), options: { type: "trace" } });

    expect(
      manager.start({
        scope: scope({ connectionId: "connection-2", targetId: "target-2" }),
        options: { type: "trace" },
      }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_CAPTURE_CONFLICT" });
    for (const foreignScope of [scope({ connectionId: "connection-2" }), scope({ contextId: "context-2" })]) {
      expect(manager.stop(foreignScope, started.captureId)).rejects.toMatchObject({
        code: "CHROME_MCP_CAPTURE_NOT_FOUND",
      });
    }

    const stopped = await manager.stop(scope(), started.captureId);
    expect(stopped.status).toBe("completed");
    expect(stopped.artifact?.complete).toBe(true);
    expect(finishes).toEqual(["capture-1:manual"]);
    expect(await manager.stop(scope(), started.captureId)).toEqual(stopped);
  });

  test("produces valid HAR omit, embed, and attach content without inventing missing bodies", async () => {
    const contentModes: ("attach" | "embed" | "omit")[] = ["omit", "embed", "attach"];
    for (const content of contentModes) {
      const artifacts = new MemoryArtifacts();
      const manager = new CaptureManager({ artifacts, clock, ids: ids() });
      let bodyReads = 0;
      const started = await manager.start({
        scope: scope(),
        options: { type: "har", content, urlFilter: "**/kept" },
      });
      manager.recordNetwork(
        exchange("1", new TextEncoder().encode('{"ok":true}'), {
          request: {
            requestId: "1",
            url: "https://example.test/kept",
            method: "GET",
            startedAt: "2026-01-01T00:00:00.000Z",
          },
          loadBody: () => {
            bodyReads += 1;
            return Promise.resolve({
              bytes: new TextEncoder().encode('{"ok":true}'),
              mediaType: "application/json",
            });
          },
        }),
      );
      manager.recordNetwork(
        exchange("2", new Uint8Array([9]), {
          request: {
            requestId: "2",
            url: "https://example.test/skipped",
            method: "GET",
            startedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      );
      const stopped = await manager.stop(scope(), started.captureId);
      const harPublication = artifacts.publications.at(-1);
      if (!harPublication || harPublication.source.kind !== "bytes") {
        throw new Error("Missing HAR publication.");
      }
      const har = parseObject(harPublication.source.bytes);
      const log = propertyRecord(har, "log");
      const entries = propertyRecords(log, "entries");
      const responseContent = propertyRecord(propertyRecord(entries[0] ?? {}, "response"), "content");
      expect(log).toMatchObject({
        creator: { name: "chrome-mcp", version: "0.0.0" },
        version: "1.2",
      });
      expect(entries).toHaveLength(1);
      if (content === "omit") {
        expect(bodyReads).toBe(0);
        expect(responseContent).not.toHaveProperty("text");
      } else if (content === "embed") {
        expect(bodyReads).toBe(1);
        expect(responseContent.text).toBe('{"ok":true}');
      } else {
        expect(bodyReads).toBe(1);
        expect(stopped.artifacts).toHaveLength(2);
        expect(responseContent).toHaveProperty("_chromeMcpArtifact");
      }
    }
  });

  test("bounds network bodies by MIME type, per-body size, and total budget", async () => {
    const artifacts = new MemoryArtifacts();
    const manager = new CaptureManager({ artifacts, clock, ids: ids() });
    const started = await manager.start({
      scope: scope(),
      options: { type: "network-bodies", maxBodyBytes: 4, maxTotalBytes: 6, mimeTypes: ["application/json"] },
    });
    manager.recordNetwork(exchange("1", new Uint8Array([1, 2, 3, 4, 5])));
    manager.recordNetwork(exchange("2", new Uint8Array([1, 2, 3, 4])));
    manager.recordNetwork(exchange("3", new Uint8Array([5, 6, 7, 8])));
    manager.recordNetwork(
      exchange("4", new Uint8Array([1]), {
        response: {
          status: 200,
          completedAt: "2026-01-01T00:00:00.050Z",
          mediaType: "text/plain",
          bodySize: 1,
        },
      }),
    );
    const stopped = await manager.stop(scope(), started.captureId);
    const manifest = artifacts.json();
    const bodies = propertyRecords(manifest, "bodies");

    expect(bodies.map((body) => body.omitted ?? "stored")).toEqual([
      "body-too-large",
      "stored",
      "capture-budget-exhausted",
      "mime-type-filtered",
    ]);
    expect(stopped.warnings).toHaveLength(3);
    expect(stopped.artifacts).toHaveLength(2);
  });

  test("fixes video to a target and reports unsupported or owner conflicts", async () => {
    const artifacts = new MemoryArtifacts();
    const unsupported = new CaptureManager({
      artifacts,
      video: {
        supported: () => Promise.resolve(false),
        start: () => Promise.resolve(undefined),
        finish: () => Promise.reject(new Error("unreachable")),
      },
      clock,
      ids: ids(),
    });
    expect(unsupported.start({ scope: scope(), options: { type: "video" } })).rejects.toMatchObject({
      code: "CHROME_MCP_UNSUPPORTED_CAPTURE",
    });

    const reasons: string[] = [];
    const video: VideoAdapter = {
      supported: () => Promise.resolve(true),
      start(input) {
        return Promise.resolve(input.scope.targetId);
      },
      finish(handle, input) {
        reasons.push(`${String(handle)}:${input.reason}`);
        return Promise.resolve({
          name: "video.webm",
          mediaType: "video/webm",
          source: { kind: "bytes", bytes: new Uint8Array([1]) },
        });
      },
    };
    const manager = new CaptureManager({ artifacts, video, clock, ids: ids() });
    const started = await manager.start({ scope: scope(), options: { type: "video" } });
    expect(
      manager.start({ scope: scope({ connectionId: "connection-2" }), options: { type: "video" } }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_CAPTURE_CONFLICT" });
    await manager.stop(scope(), started.captureId);
    expect(reasons).toEqual(["target-1:manual"]);
  });

  test("finalizes disconnects and browser death as incomplete without leaking ownership", async () => {
    const artifacts = new MemoryArtifacts();
    const trace: TraceAdapter = {
      start(input) {
        return Promise.resolve(input.captureId);
      },
      finish(handle, input) {
        if (input.reason === "browser-death") {
          return Promise.reject(
            new CaptureFinalizeError("browser died", {
              partialOutput: {
                name: `${String(handle)}.zip`,
                mediaType: "application/zip",
                source: { kind: "bytes", bytes: new Uint8Array([7]) },
              },
            }),
          );
        }
        return Promise.resolve({
          name: "trace.zip",
          mediaType: "application/zip",
          source: { kind: "bytes", bytes: new Uint8Array([1]) },
        });
      },
    };
    const manager = new CaptureManager({ artifacts, trace, clock, ids: ids() });
    const bodyCapture = await manager.start({ scope: scope(), options: { type: "network-bodies" } });
    await manager.start({
      scope: scope({ connectionId: "unrelated", targetId: "other" }),
      options: { type: "har" },
    });
    const disconnected = await manager.finalizeConnection("connection-1");
    expect(disconnected.map((capture) => capture.captureId)).toEqual([bodyCapture.captureId]);
    expect(disconnected[0]?.status).toBe("incomplete");
    expect(manager.activeConflicts(scope({ connectionId: "unrelated", targetId: "other" })).har).toBe(true);

    const traceCapture = await manager.start({ scope: scope(), options: { type: "trace" } });
    const death = await manager.finalizeBrowser(scope());

    expect(death.map((capture) => capture.captureId)).toEqual([traceCapture.captureId]);
    expect(death.every((capture) => capture.status === "incomplete")).toBe(true);
    expect(death.find((capture) => capture.captureId === traceCapture.captureId)?.artifact?.complete).toBe(
      false,
    );
    expect(manager.activeConflicts(scope({ connectionId: "unrelated", targetId: "other" })).har).toBe(true);
    expect(disconnected[0]?.artifact?.complete).toBe(false);
    expect(artifacts.publications.every((publication) => !publication.complete)).toBe(true);
  });

  test("honors external diagnostic conflicts without leaving an active reservation", async () => {
    const artifacts = new MemoryArtifacts();
    const manager = new CaptureManager({
      artifacts,
      clock,
      ids: ids(),
      externalConflicts: {
        find: (_scope, type) =>
          Promise.resolve(type === "trace" ? "A performance trace is active." : undefined),
      },
    });
    expect(manager.start({ scope: scope(), options: { type: "trace" } })).rejects.toMatchObject({
      code: "CHROME_MCP_CAPTURE_CONFLICT",
    });
    expect(manager.activeConflicts(scope()).trace).toBe(false);
    const har = await manager.start({ scope: scope(), options: { type: "har" } });
    expect(har.captureId).toBe("capture-2");
  });

  test("reserves conflicts before asynchronous adapter checks complete", async () => {
    const gate = Promise.withResolvers<void>();
    const manager = new CaptureManager({
      artifacts: new MemoryArtifacts(),
      clock,
      ids: ids(),
      externalConflicts: {
        async find() {
          await gate.promise;
          return undefined;
        },
      },
    });
    const first = manager.start({ scope: scope(), options: { type: "har" } });
    expect(manager.start({ scope: scope(), options: { type: "har" } })).rejects.toMatchObject({
      code: "CHROME_MCP_CAPTURE_CONFLICT",
    });
    gate.resolve();
    const started = await first;
    await manager.stop(scope(), started.captureId);
  });

  test("aborts body collection when lifecycle finalization exceeds its deadline", async () => {
    const manager = new CaptureManager({
      artifacts: new MemoryArtifacts(),
      clock,
      ids: ids(),
      finalizeTimeoutMs: 5,
    });
    const started = await manager.start({ scope: scope(), options: { type: "network-bodies" } });
    manager.recordNetwork(
      exchange("1", new Uint8Array([1]), {
        loadBody: (signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      }),
    );
    const results = await manager.finalizeConnection("connection-1");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ captureId: started.captureId, status: "incomplete", artifacts: [] });
    expect(results[0]?.warnings).toHaveLength(1);
  });

  test("preserves published descriptors and artifact quota codes when a later publication fails", async () => {
    const artifacts = new MemoryArtifacts(2);
    const manager = new CaptureManager({ artifacts, clock, ids: ids() });
    const started = await manager.start({ scope: scope(), options: { type: "har", content: "attach" } });
    manager.recordNetwork(exchange("1", new Uint8Array([1, 2, 3])));

    try {
      await manager.stop(scope(), started.captureId);
      throw new Error("Expected capture publication to fail.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "CHROME_MCP_ARTIFACT_QUOTA",
        details: { allowed: 1, measured: 2 },
      });
      expect(artifactsFromError(error)).toMatchObject([
        { artifactId: "artifact-1", name: "har-body-1.bin", expiresAt: null },
      ]);
    }
    expect(manager.activeConflicts(scope()).har).toBe(false);
  });

  test("retains a timeout conflict tombstone until deferred finalization settles", async () => {
    const adapterFinish = Promise.withResolvers<void>();
    const publicationFinishStarted = Promise.withResolvers<void>();
    const publicationFinish = Promise.withResolvers<void>();
    const artifacts: ArtifactPublisher = {
      begin() {
        return Promise.resolve({
          publish() {
            throw new Error("The aborted capture must not publish output.");
          },
          finish() {
            publicationFinishStarted.resolve();
            return publicationFinish.promise;
          },
        });
      },
    };
    const trace: TraceAdapter = {
      start: (input) => Promise.resolve(input.captureId),
      async finish() {
        await adapterFinish.promise;
        return {
          name: "trace.zip",
          mediaType: "application/zip",
          source: { kind: "bytes", bytes: new Uint8Array([1]) },
        };
      },
    };
    const manager = new CaptureManager({ artifacts, trace, clock, ids: ids(), finalizeTimeoutMs: 5 });
    const started = await manager.start({ scope: scope(), options: { type: "trace" } });

    expect(manager.stop(scope(), started.captureId)).rejects.toMatchObject({
      code: "CHROME_MCP_CAPTURE_FINALIZE_FAILED",
    });
    expect(
      manager.start({ scope: scope({ targetId: "target-2" }), options: { type: "trace" } }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_CAPTURE_CONFLICT" });

    adapterFinish.resolve();
    await publicationFinishStarted.promise;
    const afterPublicationFinish = publicationFinish.promise.then(() => undefined);
    publicationFinish.resolve();
    await afterPublicationFinish;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(manager.activeConflicts(scope()).trace).toBe(false);

    const replacement = await manager.start({ scope: scope(), options: { type: "trace" } });
    expect(replacement.captureId).toBe("capture-2");
  });

  test("cancels a capture that is still starting when its browser dies", async () => {
    const gate = Promise.withResolvers<void>();
    const manager = new CaptureManager({
      artifacts: new MemoryArtifacts(),
      clock,
      ids: ids(),
      externalConflicts: {
        async find() {
          await gate.promise;
          return undefined;
        },
      },
    });
    const starting = manager.start({ scope: scope(), options: { type: "har" } });
    const finalizing = manager.finalizeBrowser(scope());
    gate.resolve();

    expect(starting).rejects.toMatchObject({ code: "CHROME_MCP_CAPTURE_INVALID_OPTIONS" });
    const results = await finalizing;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "har", status: "incomplete", artifacts: [] });
    expect(manager.activeConflicts(scope()).har).toBe(false);
  });
});
