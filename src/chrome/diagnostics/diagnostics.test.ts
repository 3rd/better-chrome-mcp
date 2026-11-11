import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { HeapSnapshotAnalyzer } from "./heap-analysis";
import type { HeapAnalysisRequest } from "./heap-analysis-protocol";
import type {
  DiagnosticCall,
  DiagnosticCdpSession,
  LighthouseEngineResult,
  LighthouseRunner,
  SelectedDiagnosticPage,
  SelectedPageProvider,
  TraceAnalyzer,
} from "./types";
import { readTraceStream } from "./cdp";
import {
  type AtomicDiagnosticFile,
  type DiagnosticFileSystem,
  NodeDiagnosticFileSystem,
  replaceExtension,
} from "./file-system";
import { HeapSnapshotDiagnostics } from "./heap-snapshot";
import { LighthouseDiagnostics } from "./lighthouse";
import { createDiagnosticOutputPathResolver } from "./output-path";
import { PERFORMANCE_TRACE_CATEGORIES, PerformanceDiagnostics } from "./performance";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "chrome-diagnostics-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

const outputPaths = (directory: string) => createDiagnosticOutputPathResolver({ baseDirectory: directory });

type CdpCall = {
  method: string;
  parameters?: Record<string, unknown>;
};

class SyntheticCdpSession implements DiagnosticCdpSession {
  readonly calls: CdpCall[] = [];
  dataLossOccurred = false;
  readonly failures = new Map<string, Error>();
  heapChunks = ['{"snapshot":', '"complete"}'];
  invalidHeapChunk = false;
  lateHeapChunk = false;
  invalidTraceRead = false;
  traceChunks = ['{"traceEvents":', "[]}"];
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();

  off(event: string, listener: (payload: unknown) => void): void {
    this.#listeners.get(event)?.delete(listener);
  }

  on(event: string, listener: (payload: unknown) => void): void {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
  }

  async send(method: string, parameters?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, ...(parameters ? { parameters } : {}) });
    const failure = this.failures.get(method);
    if (failure) throw failure;
    if (method === "Tracing.end") {
      this.#emit("Tracing.tracingComplete", { dataLossOccurred: this.dataLossOccurred, stream: "trace-1" });
    }
    if (method === "IO.read") {
      if (this.invalidTraceRead) return {};
      const data = this.traceChunks.shift() ?? "";
      return { data, eof: this.traceChunks.length === 0 };
    }
    if (method === "HeapProfiler.takeHeapSnapshot") {
      if (this.invalidHeapChunk) this.#emit("HeapProfiler.addHeapSnapshotChunk", { invalid: true });
      else for (const chunk of this.heapChunks) this.#emit("HeapProfiler.addHeapSnapshotChunk", { chunk });
    }
    if (method === "HeapProfiler.disable" && this.lateHeapChunk) {
      this.#emit("HeapProfiler.addHeapSnapshotChunk", { chunk: "late" });
    }
    return {};
  }

  #emit(event: string, payload: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(payload);
  }
}

class SyntheticPageProvider implements SelectedPageProvider {
  acquired = 0;
  released = 0;
  restored = 0;
  readonly navigations: { url: string; waitUntil: "load" }[] = [];
  readonly page: SelectedDiagnosticPage;
  releaseFailure: Error | undefined;
  restoreFailure: Error | undefined;

  constructor(cdp = new SyntheticCdpSession()) {
    this.page = {
      cdp,
      cpuThrottling: 4,
      deviceScope: "DESKTOP",
      engineTarget: { targetId: "target-1", endpointToken: "internal" },
      navigate: async (url, options) => {
        this.navigations.push({ url, waitUntil: options.waitUntil });
        this.page.url = url;
      },
      networkThrottling: { downloadThroughput: 1000, latency: 20 },
      ownerGeneration: 1,
      ownerId: "shared-owner",
      restoreEmulation: async () => {
        this.restored += 1;
        if (this.restoreFailure) throw this.restoreFailure;
      },
      targetId: "target-1",
      url: "https://example.test/app",
    };
  }

  async acquire(_call: DiagnosticCall): Promise<SelectedDiagnosticPage> {
    this.acquired += 1;
    return this.page;
  }

  async release(_page: SelectedDiagnosticPage): Promise<void> {
    this.released += 1;
    if (this.releaseFailure) throw this.releaseFailure;
  }
}

const call = (
  connectionId = "connection-a",
  browserMode: DiagnosticCall["browserMode"] = "shared",
  browserInstanceId?: string,
): DiagnosticCall => ({
  ...(browserInstanceId === undefined ? {} : { browserInstanceId }),
  browserMode,
  connectionId,
});

const traceAnalyzer = () => {
  const traceInputs: Parameters<TraceAnalyzer["analyzeTrace"]>[0][] = [];
  const insightInputs: Parameters<TraceAnalyzer["analyzeInsight"]>[0][] = [];
  const analyzer: TraceAnalyzer = {
    analyzeInsight: async (input) => {
      insightInputs.push(input);
      return { output: `Insight ${input.insightSetId}/${input.insightName}` };
    },
    analyzeTrace: async (input) => {
      traceInputs.push(input);
      return {
        summary: "## Summary of Performance trace findings:\nSynthetic summary",
        insights: [{ insightKey: "LCPBreakdown", insightName: "LCPBreakdown", insightSetId: "set-1" }],
      };
    },
  };
  return { analyzer, insightInputs, traceInputs };
};

describe("PerformanceDiagnostics", () => {
  test("captures, streams, saves, and analyzes an automatic trace", async () => {
    const directory = await temporaryDirectory();
    const provider = new SyntheticPageProvider();
    const analyzer = traceAnalyzer();
    const delays: number[] = [];
    const diagnostics = new PerformanceDiagnostics({
      analyzer: analyzer.analyzer,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      outputPaths: await outputPaths(directory),
      pageProvider: provider,
    });
    const requestedPath = join(directory, "performance.gz");

    const result = await diagnostics.startTrace(call(), { filePath: requestedPath });
    const savedPath = replaceExtension(requestedPath, ".json.gz");

    expect(delays).toEqual([5000]);
    expect(provider.navigations).toEqual([
      { url: "about:blank", waitUntil: "load" },
      { url: "https://example.test/app", waitUntil: "load" },
    ]);
    const start =
      provider.page.cdp instanceof SyntheticCdpSession ?
        provider.page.cdp.calls.find(({ method }) => method === "Tracing.start")
      : undefined;
    expect(start?.parameters).toEqual({
      streamFormat: "json",
      traceConfig: {
        excludedCategories: ["*"],
        includedCategories: PERFORMANCE_TRACE_CATEGORIES.slice(1),
      },
      transferMode: "ReturnAsStream",
    });
    expect(gunzipSync(await readFile(savedPath)).toString()).toBe('{"traceEvents":[]}');
    expect(analyzer.traceInputs).toHaveLength(1);
    expect(analyzer.traceInputs[0]).toMatchObject({
      deviceScope: "DESKTOP",
      metadata: {
        cpuThrottling: 4,
        networkThrottling: { downloadThroughput: 1000, latency: 20 },
      },
    });
    expect(result.structuredContent).toMatchObject({
      traceSummary: "## Summary of Performance trace findings:\nSynthetic summary",
      traceInsights: [{ insightKey: "LCPBreakdown", insightName: "LCPBreakdown", insightSetId: "set-1" }],
    });
    expect(provider.acquired).toBe(provider.released);
  });

  test("keeps an explicit trace across calls and enforces connection ownership", async () => {
    const provider = new SyntheticPageProvider();
    const analyzer = traceAnalyzer();
    const diagnostics = new PerformanceDiagnostics({ analyzer: analyzer.analyzer, pageProvider: provider });

    await diagnostics.startTrace(call("owner"), { autoStop: false, reload: false });
    expect(diagnostics.stopTrace(call("other"), {})).rejects.toMatchObject({
      code: "CHROME_MCP_TRACE_OWNERSHIP",
    });

    await diagnostics.stopTrace(call("owner"), {});
    expect(diagnostics.stopTrace(call("owner"), {})).rejects.toMatchObject({
      code: "CHROME_MCP_TRACE_NOT_ACTIVE",
    });
  });

  test("keeps the latest trace and insight lookup scoped to connection, mode, and browser instance", async () => {
    const provider = new SyntheticPageProvider();
    const analyzer = traceAnalyzer();
    const diagnostics = new PerformanceDiagnostics({
      analyzer: analyzer.analyzer,
      delay: async () => undefined,
      pageProvider: provider,
    });
    await diagnostics.startTrace(call("owner", "isolated-headless", "first"), { reload: false });

    expect(
      diagnostics.analyzeInsight(call("other", "isolated-headless", "first"), {
        insightName: "LCPBreakdown",
        insightSetId: "set-1",
      }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_TRACE_NOT_ACTIVE" });
    expect(
      diagnostics.analyzeInsight(call("owner", "isolated-headless", "second"), {
        insightName: "LCPBreakdown",
        insightSetId: "set-1",
      }),
    ).rejects.toMatchObject({
      code: "CHROME_MCP_TRACE_NOT_ACTIVE",
      message: "No completed performance trace is available for this browser owner.",
    });

    await diagnostics.analyzeInsight(call("owner", "isolated-headless", "first"), {
      insightName: "LCPBreakdown",
      insightSetId: "set-1",
    });
    expect(analyzer.insightInputs[0]).toMatchObject({
      deviceScope: "DESKTOP",
      insightName: "LCPBreakdown",
      insightSetId: "set-1",
    });
  });

  test("lists exact insight pairs and treats an empty list as a valid result", async () => {
    const provider = new SyntheticPageProvider();
    const available = traceAnalyzer();
    const diagnostics = new PerformanceDiagnostics({
      analyzer: available.analyzer,
      delay: async () => undefined,
      pageProvider: provider,
    });
    await diagnostics.startTrace(call("available"), { reload: false });

    const listed = await diagnostics.analyzeInsight(call("available"), {});
    expect(listed.structuredContent).toMatchObject({
      traceInsights: [{ insightKey: "LCPBreakdown", insightName: "LCPBreakdown", insightSetId: "set-1" }],
    });
    expect(available.insightInputs).toEqual([]);

    const emptyFixture = traceAnalyzer();
    const empty: TraceAnalyzer = {
      ...emptyFixture.analyzer,
      analyzeTrace: async (input) => ({
        ...(await emptyFixture.analyzer.analyzeTrace(input)),
        insights: [],
      }),
    };
    const emptyDiagnostics = new PerformanceDiagnostics({
      analyzer: empty,
      delay: async () => undefined,
      pageProvider: provider,
    });
    await emptyDiagnostics.startTrace(call("empty"), { reload: false });
    const noInsights = await emptyDiagnostics.analyzeInsight(call("empty"), {});
    expect(noInsights.structuredContent).toMatchObject({
      traceInsights: [],
    });
  });

  test("rejects an empty insight report instead of returning an empty tool result", async () => {
    const provider = new SyntheticPageProvider();
    const fixture = traceAnalyzer();
    const analyzer: TraceAnalyzer = {
      ...fixture.analyzer,
      analyzeInsight: async () => ({ output: "" }),
    };
    const diagnostics = new PerformanceDiagnostics({
      analyzer,
      delay: async () => undefined,
      pageProvider: provider,
    });
    await diagnostics.startTrace(call("owner"), { reload: false });

    expect(
      diagnostics.analyzeInsight(call("owner"), {
        insightName: "LCPBreakdown",
        insightSetId: "set-1",
      }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_TRACE_PROTOCOL" });
  });

  test("rejects an unavailable insight before invoking the analyzer", async () => {
    const provider = new SyntheticPageProvider();
    const fixture = traceAnalyzer();
    const analyzer: TraceAnalyzer = {
      ...fixture.analyzer,
      analyzeInsight: async () => ({ error: "No Insight with name LayoutShift was found." }),
    };
    const diagnostics = new PerformanceDiagnostics({
      analyzer,
      delay: async () => undefined,
      pageProvider: provider,
    });
    await diagnostics.startTrace(call("owner"), { reload: false });

    expect(
      diagnostics.analyzeInsight(call("owner"), {
        insightName: "LayoutShift",
        insightSetId: "set-1",
      }),
    ).rejects.toMatchObject({
      code: "CHROME_MCP_INVALID_INPUT",
    });
    expect(fixture.insightInputs).toEqual([]);
  });

  test("rejects an explicit trace output without a session path resolver", async () => {
    const provider = new SyntheticPageProvider();
    const diagnostics = new PerformanceDiagnostics({
      analyzer: traceAnalyzer().analyzer,
      pageProvider: provider,
    });

    expect(diagnostics.startTrace(call(), { filePath: "/explicit/trace.json" })).rejects.toMatchObject({
      code: "CHROME_MCP_OUTPUT_PATH",
    });
    expect(provider.acquired).toBe(0);
    expect(provider.page.cdp instanceof SyntheticCdpSession ? provider.page.cdp.calls : []).toEqual([]);
  });

  test("rejects an explicit stop destination without a session path resolver", async () => {
    const provider = new SyntheticPageProvider();
    const diagnostics = new PerformanceDiagnostics({
      analyzer: traceAnalyzer().analyzer,
      pageProvider: provider,
    });
    await diagnostics.startTrace(call(), { autoStop: false, reload: false });
    const acquiredBeforeStop = provider.acquired;
    const callsBeforeStop =
      provider.page.cdp instanceof SyntheticCdpSession ? [...provider.page.cdp.calls] : [];

    expect(diagnostics.stopTrace(call(), { filePath: "/explicit/trace.json" })).rejects.toMatchObject({
      code: "CHROME_MCP_OUTPUT_PATH",
    });
    expect(provider.acquired).toBe(acquiredBeforeStop);
    expect(provider.page.cdp instanceof SyntheticCdpSession ? provider.page.cdp.calls : []).toEqual(
      callsBeforeStop,
    );

    await diagnostics.stopTrace(call(), {});
  });

  test("reports an incomplete trace when the browser owner generation changes", async () => {
    const provider = new SyntheticPageProvider();
    const analyzer = traceAnalyzer();
    const diagnostics = new PerformanceDiagnostics({ analyzer: analyzer.analyzer, pageProvider: provider });
    await diagnostics.startTrace(call(), { autoStop: false, reload: false });
    provider.page.ownerGeneration = 2;

    expect(diagnostics.stopTrace(call(), {})).rejects.toMatchObject({
      code: "CHROME_MCP_TRACE_INCOMPLETE",
    });
  });

  test("rejects Chrome trace data loss without analysis or registration and preserves it through cleanup failures", async () => {
    const cdp = new SyntheticCdpSession();
    cdp.dataLossOccurred = true;
    const provider = new SyntheticPageProvider(cdp);
    const analyzer = traceAnalyzer();
    let aborts = 0;
    let removals = 0;
    const files: DiagnosticFileSystem = {
      createTemporaryPath: async () => "/synthetic/trace.json",
      materializeTrace: async () => undefined,
      openAtomic: async () => ({
        abort: async () => {
          aborts += 1;
          throw new Error("synthetic trace abort cleanup failure");
        },
        commit: async () => undefined,
        write: async () => undefined,
      }),
      remove: async () => {
        removals += 1;
        throw new Error("synthetic trace remove cleanup failure");
      },
      writeAtomic: async () => undefined,
    };
    const diagnostics = new PerformanceDiagnostics({
      analyzer: analyzer.analyzer,
      delay: async () => undefined,
      files,
      pageProvider: provider,
    });

    expect(diagnostics.startTrace(call("loss"), { reload: false })).rejects.toMatchObject({
      code: "CHROME_MCP_TRACE_INCOMPLETE",
    });
    expect(cdp.calls.some(({ method }) => method === "IO.close")).toBe(true);
    expect(aborts).toBe(1);
    expect(removals).toBe(1);
    expect(analyzer.traceInputs).toHaveLength(0);
    expect(
      diagnostics.analyzeInsight(call("loss"), {
        insightName: "LCPBreakdown",
        insightSetId: "set-1",
      }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_TRACE_NOT_ACTIVE" });
  });

  test("removes active and completed trace ownership when a connection ends", async () => {
    const provider = new SyntheticPageProvider();
    const analyzer = traceAnalyzer();
    const diagnostics = new PerformanceDiagnostics({
      analyzer: analyzer.analyzer,
      delay: async () => undefined,
      pageProvider: provider,
    });
    await diagnostics.startTrace(call("closing"), { reload: false });
    await diagnostics.releaseConnection("closing");

    expect(
      diagnostics.analyzeInsight(call("closing"), {
        insightName: "LCPBreakdown",
        insightSetId: "set-1",
      }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_TRACE_NOT_ACTIVE" });
  });

  test("releases one browser owner's trace without touching a sibling instance", async () => {
    const first = new SyntheticPageProvider();
    first.page.ownerId = "owner-first";
    const second = new SyntheticPageProvider();
    second.page.ownerId = "owner-second";
    const provider: SelectedPageProvider = {
      acquire: (requestedCall) =>
        Promise.resolve(requestedCall.browserInstanceId === "first" ? first.page : second.page),
      release: () => Promise.resolve(),
    };
    const analyzer = traceAnalyzer();
    const diagnostics = new PerformanceDiagnostics({
      analyzer: analyzer.analyzer,
      delay: async () => undefined,
      pageProvider: provider,
    });
    const firstCall = call("owner", "isolated-headless", "first");
    const secondCall = call("owner", "isolated-headless", "second");
    await diagnostics.startTrace(firstCall, { autoStop: false, reload: false });
    await diagnostics.startTrace(secondCall, { reload: false });

    await diagnostics.releaseOwner(firstCall, "owner-first", 1);

    await diagnostics.analyzeInsight(secondCall, {
      insightName: "LCPBreakdown",
      insightSetId: "set-1",
    });
    expect(diagnostics.stopTrace(firstCall, {})).rejects.toMatchObject({
      code: "CHROME_MCP_TRACE_NOT_ACTIVE",
      message: "No performance trace is active for this browser owner.",
    });
  });
});

const lighthouseResult = (): LighthouseEngineResult => ({
  audits: [{ score: 1 }, { score: 0.5 }, { score: null }, { score: 0 }],
  categories: [
    { id: "accessibility", score: 0.97, title: "Accessibility" },
    { id: "seo", score: null, title: "SEO" },
    { id: "best-practices", score: 0, title: "Best Practices" },
  ],
  mainDocumentUrl: "https://example.test/app",
  reports: { html: "<html>report</html>", json: '{"report":true}' },
  totalTiming: 125.5,
});

describe("LighthouseDiagnostics", () => {
  test("preserves audit outputs and distinguishes unavailable scores from zero", async () => {
    const directory = await temporaryDirectory();
    const provider = new SyntheticPageProvider();
    const inputs: Parameters<LighthouseRunner["run"]>[0][] = [];
    const runner: LighthouseRunner = {
      run: async (input) => {
        inputs.push(input);
        return lighthouseResult();
      },
    };
    const diagnostics = new LighthouseDiagnostics({
      outputPaths: await outputPaths(directory),
      pageProvider: provider,
      runner,
    });

    const result = await diagnostics.audit(call(), {
      device: "mobile",
      mode: "snapshot",
      outputDirPath: directory,
    });
    const jsonPath = join(directory, "report.json");
    const htmlPath = join(directory, "report.html");

    expect(inputs).toEqual([
      {
        categories: ["accessibility", "seo", "best-practices", "agentic-browsing"],
        device: "mobile",
        engineTarget: { targetId: "target-1", endpointToken: "internal" },
        maxWaitForLoadMs: 30_000,
        mode: "snapshot",
        screenEmulation: {
          deviceScaleFactor: 1.75,
          disabled: false,
          height: 823,
          mobile: true,
          width: 412,
        },
      },
    ]);
    expect(await readFile(jsonPath, "utf8")).toBe('{"report":true}');
    expect(await readFile(htmlPath, "utf8")).toBe("<html>report</html>");
    expect(result.structuredContent).toEqual({
      lighthouseResult: {
        summary: {
          mode: "snapshot",
          device: "mobile",
          url: "https://example.test/app",
          scores: [
            { id: "accessibility", score: 0.97, title: "Accessibility" },
            { id: "seo", score: null, title: "SEO" },
            { id: "best-practices", score: 0, title: "Best Practices" },
          ],
          audits: { failed: 2, passed: 1 },
          timing: { total: 125.5 },
        },
        reports: [jsonPath, htmlPath],
      },
    });
    expect(result.content[0].text).toContain(`- Accessibility: 97 (accessibility)
- SEO: unavailable (seo)
- Best Practices: 0 (best-practices)`);
    expect(provider.restored).toBe(1);
    expect(provider.acquired).toBe(provider.released);
  });

  test("restores emulation and releases the selected page after a runner failure", async () => {
    const provider = new SyntheticPageProvider();
    provider.restoreFailure = new Error("synthetic restore cleanup failure");
    provider.releaseFailure = new Error("synthetic release cleanup failure");
    const runner: LighthouseRunner = {
      run: async () => undefined,
    };
    const diagnostics = new LighthouseDiagnostics({ pageProvider: provider, runner });

    expect(diagnostics.audit(call(), {})).rejects.toMatchObject({
      code: "CHROME_MCP_LIGHTHOUSE_FAILED",
    });
    expect(provider.restored).toBe(1);
    expect(provider.acquired).toBe(provider.released);
  });

  test("removes default reports when their connection closes", async () => {
    const provider = new SyntheticPageProvider();
    const diagnostics = new LighthouseDiagnostics({
      pageProvider: provider,
      runner: { run: async () => lighthouseResult() },
    });

    const result = await diagnostics.audit(call("reports"), {});
    const reports = result.structuredContent.lighthouseResult;
    if (typeof reports !== "object" || reports === null || Array.isArray(reports)) {
      throw new Error("Lighthouse result did not contain report paths");
    }
    const reportPaths = reports.reports;
    if (
      !Array.isArray(reportPaths) ||
      !reportPaths.every((path): path is string => typeof path === "string")
    ) {
      throw new Error("Lighthouse result did not contain report paths");
    }
    expect(reportPaths.every(existsSync)).toBe(true);

    await diagnostics.releaseConnection("reports");

    expect(reportPaths.every((path) => !existsSync(path))).toBe(true);
    expect(reportPaths.every((path) => !existsSync(dirname(path)))).toBe(true);
  });

  test("removes all default report paths after a partial write failure", async () => {
    const primary = new Error("synthetic HTML report write failure");
    class PartialWriteFileSystem extends NodeDiagnosticFileSystem {
      readonly createdPaths: string[] = [];
      writes = 0;

      override async createTemporaryPath(filename: string): Promise<string> {
        const path = await super.createTemporaryPath(filename);
        this.createdPaths.push(path);
        return path;
      }

      override async writeAtomic(
        destinationPath: string,
        data: Uint8Array | string,
        createParent: boolean,
      ): Promise<void> {
        this.writes += 1;
        if (this.writes === 2) throw primary;
        await super.writeAtomic(destinationPath, data, createParent);
      }
    }
    const files = new PartialWriteFileSystem();
    const diagnostics = new LighthouseDiagnostics({
      files,
      pageProvider: new SyntheticPageProvider(),
      runner: { run: async () => lighthouseResult() },
    });

    let failure: unknown;
    try {
      await diagnostics.audit(call("partial"), {});
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(primary);
    expect(files.createdPaths).toHaveLength(2);
    expect(files.createdPaths.every((path) => !existsSync(path))).toBe(true);
    expect(files.createdPaths.every((path) => !existsSync(dirname(path)))).toBe(true);
  });

  test("rejects an explicit report directory without a session path resolver", async () => {
    const provider = new SyntheticPageProvider();
    const diagnostics = new LighthouseDiagnostics({
      pageProvider: provider,
      runner: { run: async () => lighthouseResult() },
    });

    expect(diagnostics.audit(call(), { outputDirPath: "/explicit/reports" })).rejects.toMatchObject({
      code: "CHROME_MCP_OUTPUT_PATH",
    });
    expect(provider.acquired).toBe(0);
  });
});

describe("HeapSnapshotDiagnostics", () => {
  test("streams CDP chunks to the normalized heap path without buffering a response", async () => {
    const directory = await temporaryDirectory();
    const cdp = new SyntheticCdpSession();
    cdp.heapChunks = ['{"snapshot":', '"streamed"}'];
    const provider = new SyntheticPageProvider(cdp);
    const diagnostics = new HeapSnapshotDiagnostics({
      outputPaths: await outputPaths(directory),
      pageProvider: provider,
    });
    const requestedPath = join(directory, "capture.json");

    await diagnostics.takeSnapshot(call(), { filePath: requestedPath });
    const actualPath = replaceExtension(requestedPath, ".heapsnapshot");

    expect(await readFile(actualPath, "utf8")).toBe('{"snapshot":"streamed"}');
    expect(cdp.calls.map(({ method }) => method)).toEqual([
      "HeapProfiler.enable",
      "HeapProfiler.collectGarbage",
      "HeapProfiler.takeHeapSnapshot",
      "HeapProfiler.disable",
    ]);
    expect(provider.acquired).toBe(provider.released);
  });

  test("analyzes the committed normalized artifact with bounded caller options", async () => {
    const directory = await temporaryDirectory();
    const baselinePath = join(directory, "baseline.heapsnapshot");
    await writeFile(baselinePath, "baseline");
    const cdp = new SyntheticCdpSession();
    cdp.heapChunks = ["current snapshot"];
    const provider = new SyntheticPageProvider(cdp);
    const requests: HeapAnalysisRequest[] = [];
    const analyzer: HeapSnapshotAnalyzer = {
      analyze: async (request) => {
        requests.push(request);
        return {
          dominators: [
            {
              id: 3,
              name: "LargeObject",
              retainedPercent: 75,
              retainedSize: 768,
              selfSize: 512,
              type: "object",
            },
          ],
          snapshot: { edgeCount: 7, nodeCount: 5, totalShallowSize: 1024 },
        };
      },
    };
    const diagnostics = new HeapSnapshotDiagnostics({
      analyzer,
      outputPaths: await outputPaths(directory),
      pageProvider: provider,
    });
    const requestedPath = join(directory, "capture.json");

    const result = await diagnostics.takeSnapshot(call(), {
      analysis: {
        baselineFilePath: baselinePath,
        limit: 7,
        maxRetainingPathDepth: 12,
        modes: ["diff", "dominators"],
      },
      filePath: requestedPath,
    });
    const actualPath = replaceExtension(requestedPath, ".heapsnapshot");

    expect(requests).toEqual([
      {
        baselineSnapshotPath: baselinePath,
        limit: 7,
        maxRetainingPathDepth: 12,
        modes: ["diff", "dominators"],
        snapshotPath: actualPath,
      },
    ]);
    expect(await readFile(actualPath, "utf8")).toBe("current snapshot");
    expect(result.structuredContent).toMatchObject({
      analysis: {
        dominators: [
          {
            id: 3,
            name: "LargeObject",
            retainedPercent: 75,
            retainedSize: 768,
            selfSize: 512,
            type: "object",
          },
        ],
        snapshot: { edgeCount: 7, nodeCount: 5, totalShallowSize: 1024 },
      },
      filePath: actualPath,
    });
  });

  test("keeps a committed heap artifact when its post-capture analysis fails", async () => {
    const directory = await temporaryDirectory();
    const cdp = new SyntheticCdpSession();
    cdp.heapChunks = ["captured before analysis"];
    const provider = new SyntheticPageProvider(cdp);
    const primary = new Error("synthetic heap analysis failure");
    const diagnostics = new HeapSnapshotDiagnostics({
      analyzer: {
        analyze: async () => {
          throw primary;
        },
      },
      outputPaths: await outputPaths(directory),
      pageProvider: provider,
    });
    const requestedPath = join(directory, "capture.json");
    const actualPath = replaceExtension(requestedPath, ".heapsnapshot");

    let failure: unknown;
    try {
      await diagnostics.takeSnapshot(call(), { analysis: { modes: ["summary"] }, filePath: requestedPath });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(primary);
    expect(await readFile(actualPath, "utf8")).toBe("captured before analysis");
    expect(provider.acquired).toBe(provider.released);
  });

  test("does not create the heap parent directory or leave a partial destination", async () => {
    const directory = await temporaryDirectory();
    const provider = new SyntheticPageProvider();
    const diagnostics = new HeapSnapshotDiagnostics({
      outputPaths: await outputPaths(directory),
      pageProvider: provider,
    });
    const requestedPath = join(directory, "missing", "capture.heapsnapshot");

    expect(diagnostics.takeSnapshot(call(), { filePath: requestedPath })).rejects.toThrow();
    expect(existsSync(requestedPath)).toBe(false);
    expect(provider.acquired).toBe(provider.released);
  });

  test("rejects a malformed CDP heap chunk and removes the partial file", async () => {
    const directory = await temporaryDirectory();
    const cdp = new SyntheticCdpSession();
    cdp.invalidHeapChunk = true;
    const provider = new SyntheticPageProvider(cdp);
    const diagnostics = new HeapSnapshotDiagnostics({
      outputPaths: await outputPaths(directory),
      pageProvider: provider,
    });
    const requestedPath = join(directory, "capture.heapsnapshot");

    expect(diagnostics.takeSnapshot(call(), { filePath: requestedPath })).rejects.toMatchObject({
      code: "CHROME_MCP_HEAP_PROTOCOL",
    });
    expect(existsSync(requestedPath)).toBe(false);
    expect(provider.acquired).toBe(provider.released);
  });

  test("rejects a heap chunk delivered after snapshot completion", async () => {
    const directory = await temporaryDirectory();
    const cdp = new SyntheticCdpSession();
    cdp.lateHeapChunk = true;
    const provider = new SyntheticPageProvider(cdp);
    const diagnostics = new HeapSnapshotDiagnostics({
      outputPaths: await outputPaths(directory),
      pageProvider: provider,
    });
    const requestedPath = join(directory, "late.heapsnapshot");

    expect(diagnostics.takeSnapshot(call(), { filePath: requestedPath })).rejects.toThrow();
    expect(existsSync(requestedPath)).toBe(false);
  });

  test("preserves a heap protocol failure through file abort and page release failures", async () => {
    const directory = await temporaryDirectory();
    const cdp = new SyntheticCdpSession();
    cdp.invalidHeapChunk = true;
    const provider = new SyntheticPageProvider(cdp);
    provider.releaseFailure = new Error("synthetic heap release cleanup failure");
    const files: DiagnosticFileSystem = {
      createTemporaryPath: async () => join(directory, "unused"),
      materializeTrace: async () => undefined,
      openAtomic: async () => ({
        abort: async () => {
          throw new Error("synthetic heap abort cleanup failure");
        },
        commit: async () => undefined,
        write: async () => undefined,
      }),
      remove: async () => undefined,
      writeAtomic: async () => undefined,
    };
    const diagnostics = new HeapSnapshotDiagnostics({
      files,
      outputPaths: await outputPaths(directory),
      pageProvider: provider,
    });

    expect(diagnostics.takeSnapshot(call(), { filePath: join(directory, "capture") })).rejects.toMatchObject({
      code: "CHROME_MCP_HEAP_PROTOCOL",
    });
    expect(provider.acquired).toBe(provider.released);
  });

  test("rejects an explicit heap output without a session path resolver", async () => {
    const provider = new SyntheticPageProvider();
    const diagnostics = new HeapSnapshotDiagnostics({ pageProvider: provider });

    expect(diagnostics.takeSnapshot(call(), { filePath: "/explicit/heap" })).rejects.toMatchObject({
      code: "CHROME_MCP_OUTPUT_PATH",
    });
    expect(provider.acquired).toBe(0);
  });

  test("accepts a diff baseline outside the session base directory", async () => {
    const baseDirectory = await temporaryDirectory();
    const outsideDirectory = await temporaryDirectory();
    const baselineFilePath = join(outsideDirectory, "baseline.heapsnapshot");
    await writeFile(baselineFilePath, "baseline");
    const provider = new SyntheticPageProvider();
    const requests: HeapAnalysisRequest[] = [];
    const diagnostics = new HeapSnapshotDiagnostics({
      analyzer: {
        analyze: async (request) => {
          requests.push(request);
          return { snapshot: { edgeCount: 0, nodeCount: 0, totalShallowSize: 0 } };
        },
      },
      outputPaths: await outputPaths(baseDirectory),
      pageProvider: provider,
    });

    await diagnostics.takeSnapshot(call(), {
      analysis: { baselineFilePath, modes: ["diff"] },
      filePath: join(baseDirectory, "capture"),
    });

    expect(requests[0]?.baselineSnapshotPath).toBe(baselineFilePath);
    expect(provider.acquired).toBe(provider.released);
  });
});

describe("diagnostic files", () => {
  test("writes UTF-8 text and raw bytes to the same atomic file", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "output.txt");
    const file = await new NodeDiagnosticFileSystem().openAtomic(destination, false);
    await file.write("café ");
    await file.write(new Uint8Array([0, 255]));
    await file.commit();
    expect(await readFile(destination)).toEqual(Buffer.from([99, 97, 102, 195, 169, 32, 0, 255]));
  });
});

describe("diagnostic cleanup", () => {
  test("preserves a trace stream read failure when IO.close also fails", async () => {
    const cdp = new SyntheticCdpSession();
    cdp.invalidTraceRead = true;
    cdp.failures.set("IO.close", new Error("synthetic IO.close cleanup failure"));
    const file: AtomicDiagnosticFile = {
      abort: async () => undefined,
      commit: async () => undefined,
      write: async () => undefined,
    };

    expect(readTraceStream(cdp, "trace-1", file)).rejects.toMatchObject({
      code: "CHROME_MCP_TRACE_PROTOCOL",
    });
    expect(cdp.calls.map(({ method }) => method)).toEqual(["IO.read", "IO.close"]);
  });

  test("preserves an atomic write failure when abort also fails", async () => {
    const primary = new Error("synthetic atomic write failure");
    class AbortFailingFileSystem extends NodeDiagnosticFileSystem {
      override async openAtomic(
        _destinationPath: string,
        _createParent: boolean,
      ): Promise<AtomicDiagnosticFile> {
        return {
          abort: async () => {
            throw new Error("synthetic atomic abort cleanup failure");
          },
          commit: async () => undefined,
          write: async () => {
            throw primary;
          },
        };
      }
    }

    let failure: unknown;
    try {
      await new AbortFailingFileSystem().writeAtomic("/unused/report.json", "report", false);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(primary);
  });
});

describe("diagnostic output paths", () => {
  test("canonicalizes symlinked parents outside the session base directory", async () => {
    const baseDirectory = await temporaryDirectory();
    const outsideRoot = await temporaryDirectory();
    const insideDirectory = join(baseDirectory, "inside");
    await mkdir(insideDirectory);
    await symlink(insideDirectory, join(baseDirectory, "inside-link"));
    await symlink(outsideRoot, join(baseDirectory, "outside-link"));
    const resolver = await outputPaths(baseDirectory);

    expect(await resolver.resolveFile({ call: call(), path: "inside-link/capture.json" })).toBe(
      join(insideDirectory, "capture.json"),
    );
    expect(await resolver.resolveFile({ call: call(), path: "outside-link/capture.json" })).toBe(
      join(outsideRoot, "capture.json"),
    );
  });
});
