import { afterEach, describe, expect, test } from "bun:test";
import { ok } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubprocessHeapSnapshotAnalyzer } from "./heap-analysis";
import { analyzeHeapSnapshot, queryHeapSnapshot } from "./heap-analysis-engine";
import {
  type HeapAnalysisWorkerRequest,
  heapQueryRequestSchema,
  normalizeHeapAnalysisOptions,
  parseHeapAnalysisWorkerRequest,
  parseHeapAnalysisWorkerResponse,
} from "./heap-analysis-protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "chrome-heap-analysis-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

const snapshotFixture = (sizes: readonly [number, number, number, number]): string =>
  JSON.stringify({
    edges: [2, 5, 5, 2, 6, 10, 2, 7, 15, 2, 8, 20],
    nodes: [
      0,
      0,
      1,
      0,
      1,
      1,
      1,
      3,
      sizes[0],
      2,
      1,
      2,
      5,
      sizes[1],
      1,
      1,
      3,
      7,
      sizes[2],
      0,
      1,
      4,
      9,
      sizes[3],
      0,
    ],
    snapshot: {
      edge_count: 4,
      meta: {
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [
          ["context", "element", "property", "internal", "hidden", "shortcut", "weak"],
          "string",
          "node",
        ],
        node_fields: ["type", "name", "id", "self_size", "edge_count"],
        node_types: [["synthetic", "object"], "string", "number", "number", "number"],
      },
      node_count: 5,
    },
    strings: ["(root)", "A", "B", "C", "D", "a", "b", "c", "d"],
  });

test("queries retained objects, exact properties, and outgoing edges from a saved snapshot", async () => {
  const snapshotPath = join(await temporaryDirectory(), "query.heapsnapshot");
  await writeFile(snapshotPath, snapshotFixture([100, 50, 30, 20]));
  const objects = await queryHeapSnapshot(
    heapQueryRequestSchema.parse({
      snapshotPath,
      query: { kind: "objects", propertyName: "b", className: "a", minRetainedBytes: 150 },
    }),
  );
  expect(objects.kind).toBe("objects");
  expect(objects.rows).toEqual([{ id: 3, name: "A", type: "object", selfSize: 100, retainedSize: 200 }]);
  expect(objects.totalMatches).toBe(1);
  expect(objects.nextCursor).toBeNull();

  const edges = await queryHeapSnapshot(
    heapQueryRequestSchema.parse({ snapshotPath, query: { kind: "edges", nodeId: 3, minRetainedBytes: 40 } }),
  );
  expect(edges.rows).toEqual([
    {
      name: "b",
      type: "property",
      target: { id: 5, name: "B", type: "object", selfSize: 50, retainedSize: 70 },
    },
  ]);
  const empty = await queryHeapSnapshot(
    heapQueryRequestSchema.parse({ snapshotPath, query: { kind: "objects", propertyName: "B" } }),
  );
  expect(empty.rows).toEqual([]);
  expect(
    queryHeapSnapshot(heapQueryRequestSchema.parse({ snapshotPath, query: { kind: "edges", nodeId: 999 } })),
  ).rejects.toThrow("node");
});

test("paginates deterministically and rejects changed queries or snapshot contents", async () => {
  const snapshotPath = join(await temporaryDirectory(), "pages.heapsnapshot");
  await writeFile(snapshotPath, snapshotFixture([100, 50, 30, 20]));
  const request = heapQueryRequestSchema.parse({
    snapshotPath,
    limit: 2,
    query: { kind: "objects", sort: "id" },
  });
  const first = await queryHeapSnapshot(request);
  ok(first.kind === "objects");
  ok(first.nextCursor);

  expect(first.rows.map((row) => row.id)).toEqual([3, 5]);
  const second = await queryHeapSnapshot({ ...request, cursor: first.nextCursor });
  ok(second.kind === "objects");

  expect(second.rows.map((row) => row.id)).toEqual([7, 9]);
  expect(second.totalMatches).toBe(4);
  expect(second.nextCursor).toBeNull();
  expect(
    queryHeapSnapshot(
      heapQueryRequestSchema.parse({
        ...request,
        cursor: first.nextCursor,
        query: { kind: "objects", sort: "selfSize" },
      }),
    ),
  ).rejects.toThrow("cursor");
  await writeFile(snapshotPath, snapshotFixture([101, 50, 30, 20]));
  expect(queryHeapSnapshot({ ...request, cursor: first.nextCursor })).rejects.toThrow("cursor");
});

test("returns a usable cursor for maximum-length Unicode filters", async () => {
  const snapshotPath = join(await temporaryDirectory(), "unicode.heapsnapshot");
  const className = "漢".repeat(160);
  const propertyName = "名".repeat(160);
  const source = snapshotFixture([100, 50, 30, 20])
    .replace('"A"', JSON.stringify(className))
    .replace('"B"', JSON.stringify(className))
    .replace('"b"', JSON.stringify(propertyName))
    .replace('"d"', JSON.stringify(propertyName));
  await writeFile(snapshotPath, source);
  const request = heapQueryRequestSchema.parse({
    snapshotPath,
    limit: 1,
    query: { kind: "objects", className, propertyName },
  });
  const first = await queryHeapSnapshot(request);
  ok(first.kind === "objects");
  ok(first.nextCursor);
  expect(first.rows.map((row) => row.id)).toEqual([3]);

  const second = await queryHeapSnapshot(
    heapQueryRequestSchema.parse({ ...request, cursor: first.nextCursor }),
  );
  ok(second.kind === "objects");
  expect(second.rows.map((row) => row.id)).toEqual([5]);
  expect(second.nextCursor).toBeNull();
});

test("validates query-specific inputs and cancels a query before starting its worker", async () => {
  expect(() =>
    heapQueryRequestSchema.parse({ snapshotPath: "heap", limit: 51, query: { kind: "contexts" } }),
  ).toThrow();
  expect(() =>
    heapQueryRequestSchema.parse({ snapshotPath: "heap", query: { kind: "contexts", nodeId: 1 } }),
  ).toThrow();
  const controller = new AbortController();
  controller.abort(new Error("Query canceled"));
  expect(
    new SubprocessHeapSnapshotAnalyzer().query(
      heapQueryRequestSchema.parse({ snapshotPath: "missing", query: { kind: "contexts" } }),
      controller.signal,
    ),
  ).rejects.toThrow("Query canceled");
});

test("reaps a running heap query worker before returning cancellation", async () => {
  const workerPath = join(await temporaryDirectory(), "pending-worker.ts");
  const controller = new AbortController();
  const started = Promise.withResolvers<number>();
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const pid = Number(await request.text());
      expect(Number.isSafeInteger(pid)).toBe(true);
      expect(pid).toBeGreaterThan(0);

      started.resolve(pid);
      controller.abort(new Error("Query canceled"));
      return new Response("ready");
    },
  });
  await writeFile(
    workerPath,
    `
    await Bun.stdin.text();
    Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise(() => {}) });
    await fetch(${JSON.stringify(fixture.url.href)}, { method: 'POST', body: String(process.pid) });
  `,
  );
  const analyzer = new SubprocessHeapSnapshotAnalyzer({ workerPath });
  expect(
    analyzer.query(
      heapQueryRequestSchema.parse({ snapshotPath: "unused", query: { kind: "contexts" } }),
      controller.signal,
    ),
  ).rejects.toThrow("Query canceled");

  try {
    const pid = await started.promise;
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort(new Error("Query canceled"));
    await fixture.stop(true);
  }
});

const chainSnapshot = (nodeCount: number): string => {
  const nodeSize = 5;
  const nodes = Array.from({ length: nodeCount * nodeSize });
  const edges = Array.from({ length: (nodeCount - 1) * 3 });
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    const nodeOffset = nodeIndex * nodeSize;
    nodes[nodeOffset] = nodeIndex === 0 ? 0 : 1;
    nodes[nodeOffset + 1] = nodeIndex === 0 ? 0 : 1;
    nodes[nodeOffset + 2] = nodeIndex * 2 + 1;
    nodes[nodeOffset + 3] = nodeIndex === 0 ? 0 : 16;
    nodes[nodeOffset + 4] = nodeIndex + 1 < nodeCount ? 1 : 0;
    if (nodeIndex + 1 >= nodeCount) continue;
    const edgeOffset = nodeIndex * 3;
    edges[edgeOffset] = 2;
    edges[edgeOffset + 1] = 2;
    edges[edgeOffset + 2] = (nodeIndex + 1) * nodeSize;
  }
  return JSON.stringify({
    edges,
    nodes,
    snapshot: {
      edge_count: nodeCount - 1,
      meta: {
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [
          ["context", "element", "property", "internal", "hidden", "shortcut", "weak"],
          "string",
          "node",
        ],
        node_fields: ["type", "name", "id", "self_size", "edge_count"],
        node_types: [["synthetic", "object"], "string", "number", "number", "number"],
      },
      node_count: nodeCount,
    },
    strings: ["(root)", "Object", "child"],
  });
};

const diamondSnapshot = (secondReferenceType: "property" | "weak"): string =>
  JSON.stringify({
    edges: [2, 4, 5, 2, 5, 15, 2, 6, 10, secondReferenceType === "weak" ? 6 : 2, 7, 10],
    nodes: [0, 0, 1, 0, 2, 1, 1, 3, 100, 1, 1, 2, 5, 50, 0, 1, 3, 7, 80, 1],
    snapshot: {
      edge_count: 4,
      meta: {
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [
          ["context", "element", "property", "internal", "hidden", "shortcut", "weak"],
          "string",
          "node",
        ],
        node_fields: ["type", "name", "id", "self_size", "edge_count"],
        node_types: [["synthetic", "object"], "string", "number", "number", "number"],
      },
      node_count: 4,
    },
    strings: ["(root)", "A", "B", "C", "a", "c", "fromA", "fromC"],
  });

describe("heap snapshot analysis", () => {
  test("returns compact summary, diff, dominators, and target-to-root retaining paths", async () => {
    const directory = await temporaryDirectory();
    const baselinePath = join(directory, "baseline.heapsnapshot");
    const currentPath = join(directory, "current.heapsnapshot");
    await Promise.all([
      writeFile(baselinePath, snapshotFixture([80, 20, 10, 0])),
      writeFile(currentPath, snapshotFixture([100, 50, 25, 10])),
    ]);

    const result = await analyzeHeapSnapshot(
      normalizeHeapAnalysisOptions(
        currentPath,
        {
          baselineFilePath: baselinePath,
          limit: 3,
          maxRetainingPathDepth: 4,
        },
        baselinePath,
      ),
    );

    expect(result.snapshot).toEqual({ edgeCount: 4, nodeCount: 5, totalShallowSize: 185 });
    expect(result.summary?.byType).toEqual([
      { count: 4, shallowSize: 185, type: "object" },
      { count: 1, shallowSize: 0, type: "synthetic" },
    ]);
    expect(result.summary?.topClasses).toEqual([
      { count: 1, name: "A", shallowSize: 100, type: "object" },
      { count: 1, name: "B", shallowSize: 50, type: "object" },
      { count: 1, name: "C", shallowSize: 25, type: "object" },
    ]);
    expect(result.diff).toMatchObject({
      edgeCountDelta: 0,
      nodeCountDelta: 0,
      shallowSizeDelta: 75,
      topChanges: [
        { countDelta: 0, name: "B", shallowSizeDelta: 30 },
        { countDelta: 0, name: "A", shallowSizeDelta: 20 },
        { countDelta: 0, name: "C", shallowSizeDelta: 15 },
      ],
    });
    expect(result.dominators).toEqual([
      { id: 3, name: "A", retainedPercent: 100, retainedSize: 185, selfSize: 100, type: "object" },
      { id: 5, name: "B", retainedPercent: 32.43, retainedSize: 60, selfSize: 50, type: "object" },
      { id: 7, name: "C", retainedPercent: 13.51, retainedSize: 25, selfSize: 25, type: "object" },
    ]);
    expect(result.retainingPaths?.[1]).toEqual({
      target: { id: 5, name: "B", retainedPercent: 32.43, retainedSize: 60, selfSize: 50, type: "object" },
      targetToRoot: [
        { edgeFromParent: { name: "b", type: "property" }, id: 5, name: "B", selfSize: 50, type: "object" },
        { edgeFromParent: { name: "a", type: "property" }, id: 3, name: "A", selfSize: 100, type: "object" },
        { id: 1, name: "(root)", selfSize: 0, type: "synthetic" },
      ],
      truncated: false,
    });
  });

  test("runs analysis in a fresh subprocess and rejects malformed snapshots without exposing their paths", async () => {
    const directory = await temporaryDirectory();
    const snapshotPath = join(directory, "current.heapsnapshot");
    await writeFile(snapshotPath, snapshotFixture([100, 50, 25, 10]));
    const analyzer = new SubprocessHeapSnapshotAnalyzer({ timeoutMs: 10_000 });

    const result = await analyzer.analyze(
      normalizeHeapAnalysisOptions(snapshotPath, {
        limit: 2,
        modes: ["summary", "dominators", "retainers"],
      }),
    );
    expect(result.snapshot).toEqual({ edgeCount: 4, nodeCount: 5, totalShallowSize: 185 });
    expect(result.dominators).toHaveLength(2);

    const malformedPath = join(directory, "private-malformed.heapsnapshot");
    await writeFile(malformedPath, "not JSON");
    let failure: unknown;
    try {
      await analyzer.analyze(normalizeHeapAnalysisOptions(malformedPath, { modes: ["summary"] }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "CHROME_MCP_HEAP_PROTOCOL" });
    expect(failure instanceof Error ? failure.message : "").not.toContain(malformedPath);
  });

  test("computes graph dominators across multiple parents and excludes weak references", async () => {
    const directory = await temporaryDirectory();
    const strongPath = join(directory, "strong-diamond.heapsnapshot");
    const weakPath = join(directory, "weak-diamond.heapsnapshot");
    await Promise.all([
      writeFile(strongPath, diamondSnapshot("property")),
      writeFile(weakPath, diamondSnapshot("weak")),
    ]);

    const strong = await analyzeHeapSnapshot(
      normalizeHeapAnalysisOptions(strongPath, {
        limit: 3,
        modes: ["dominators"],
      }),
    );
    expect(strong.dominators).toEqual([
      { id: 3, name: "A", retainedPercent: 43.48, retainedSize: 100, selfSize: 100, type: "object" },
      { id: 7, name: "C", retainedPercent: 34.78, retainedSize: 80, selfSize: 80, type: "object" },
      { id: 5, name: "B", retainedPercent: 21.74, retainedSize: 50, selfSize: 50, type: "object" },
    ]);

    const weak = await analyzeHeapSnapshot(
      normalizeHeapAnalysisOptions(weakPath, {
        limit: 3,
        modes: ["dominators"],
      }),
    );
    expect(weak.dominators).toEqual([
      { id: 3, name: "A", retainedPercent: 65.22, retainedSize: 150, selfSize: 100, type: "object" },
      { id: 7, name: "C", retainedPercent: 34.78, retainedSize: 80, selfSize: 80, type: "object" },
      { id: 5, name: "B", retainedPercent: 21.74, retainedSize: 50, selfSize: 50, type: "object" },
    ]);
  });

  test("keeps subprocess requests and responses exact and rejects invalid bounds", () => {
    const request: HeapAnalysisWorkerRequest = {
      input: {
        limit: 10,
        maxRetainingPathDepth: 8,
        modes: ["summary"],
        snapshotPath: "/synthetic/current.heapsnapshot",
      },
      operation: "analyze",
    };
    expect(parseHeapAnalysisWorkerRequest(request)).toEqual(request);
    expect(() => parseHeapAnalysisWorkerRequest({ ...request, unexpectedField: true })).toThrow();
    expect(() => normalizeHeapAnalysisOptions("/synthetic/current.heapsnapshot", { limit: 51 })).toThrow();
    expect(() =>
      normalizeHeapAnalysisOptions("/synthetic/current.heapsnapshot", { modes: ["diff"] }),
    ).toThrow();
    expect(() =>
      normalizeHeapAnalysisOptions(
        "/synthetic/current.heapsnapshot",
        { modes: ["diff"] },
        "/synthetic/current.heapsnapshot",
      ),
    ).toThrow();
    expect(() =>
      parseHeapAnalysisWorkerResponse({ ok: true, result: { snapshot: {}, unbounded: [] } }),
    ).toThrow();
  });

  test("bounds output while analyzing a large object graph", async () => {
    const directory = await temporaryDirectory();
    const snapshotPath = join(directory, "large.heapsnapshot");
    await writeFile(snapshotPath, chainSnapshot(100_000));
    const analyzer = new SubprocessHeapSnapshotAnalyzer({ timeoutMs: 60_000 });

    const result = await analyzer.analyze(
      normalizeHeapAnalysisOptions(snapshotPath, {
        limit: 5,
        maxRetainingPathDepth: 4,
        modes: ["summary", "dominators", "retainers"],
      }),
    );

    expect(result.snapshot.nodeCount).toBe(100_000);
    expect(result.dominators).toHaveLength(5);
    expect(result.retainingPaths).toHaveLength(5);
    expect(result.retainingPaths?.every(({ targetToRoot }) => targetToRoot.length <= 4)).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(20_000);
  });
});

const stressTest = process.env.CHROME_MCP_HEAP_ANALYSIS_STRESS === "1" ? test : test.skip;

stressTest("analyzes a 700k-node heap snapshot in a bounded subprocess result", async () => {
  const directory = await temporaryDirectory();
  const baselinePath = join(directory, "700k-baseline.heapsnapshot");
  const snapshotPath = join(directory, "700k.heapsnapshot");
  await writeFile(baselinePath, chainSnapshot(700_000));
  await writeFile(snapshotPath, chainSnapshot(700_000));
  const analyzer = new SubprocessHeapSnapshotAnalyzer({ timeoutMs: 180_000 });

  const result = await analyzer.analyze(
    normalizeHeapAnalysisOptions(
      snapshotPath,
      {
        baselineFilePath: baselinePath,
        limit: 5,
        maxRetainingPathDepth: 4,
        modes: ["summary", "diff", "dominators", "retainers"],
      },
      baselinePath,
    ),
  );

  expect(result.snapshot.nodeCount).toBe(700_000);
  expect(result.diff?.nodeCountDelta).toBe(0);
  expect(result.diff?.topChanges).toEqual([]);
  expect(result.dominators).toHaveLength(5);
  expect(JSON.stringify(result).length).toBeLessThan(20_000);
});
