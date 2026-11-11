/**
 * Portions of this file are adapted from ChromeDevTools/chrome-devtools-mcp.
 * Copyright 2025 Google LLC. Licensed under Apache-2.0.
 */
import { readTraceStream, waitForTraceCompletion } from "./cdp";
import { type DiagnosticFileSystem, NodeDiagnosticFileSystem, replaceExtension } from "./file-system";
import { type DiagnosticOutputPathResolver, rejectingDiagnosticOutputPathResolver } from "./output-path";
import { SubprocessTraceAnalyzer } from "./subprocess";
import {
  type AnalyzeInsightInput,
  ChromeDiagnosticError,
  type DiagnosticCall,
  type DiagnosticToolResult,
  type SelectedDiagnosticPage,
  type SelectedPageProvider,
  type StartTraceInput,
  type StopTraceInput,
  textResult,
  type TraceAnalysis,
  type TraceAnalyzer,
  type TraceMetadata,
} from "./types";

export const PERFORMANCE_TRACE_CATEGORIES: readonly string[] = [
  "-*",
  "blink.console",
  "blink.user_timing",
  "devtools.timeline",
  "disabled-by-default-devtools.screenshot",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.invalidationTracking",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-v8.cpu_profiler",
  "disabled-by-default-v8.cpu_profiler.hires",
  "latencyInfo",
  "loading",
  "disabled-by-default-lighthouse",
  "v8.execute",
  "v8",
];

type ActiveTrace = {
  connectionId: string;
  metadata: TraceMetadata;
  ownerGeneration: number;
  ownerId: string;
  page: SelectedDiagnosticPage;
};

type CompletedTrace = {
  insights: TraceAnalysis["insights"];
  metadata: TraceMetadata;
  tracePath: string;
};

type PerformanceDiagnosticsOptions = {
  analyzer?: TraceAnalyzer;
  delay?: (milliseconds: number) => Promise<void>;
  files?: DiagnosticFileSystem;
  outputPaths?: DiagnosticOutputPathResolver;
  pageProvider: SelectedPageProvider;
  traceCompletionTimeoutMs?: number;
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const connectionModeKey = (call: DiagnosticCall): string =>
  `${call.connectionId}\0${call.browserMode}\0${call.browserInstanceId ?? ""}`;

const traceMetadata = (page: SelectedDiagnosticPage): TraceMetadata => ({
  cpuThrottling: page.cpuThrottling,
  ...(page.networkThrottling ? { networkThrottling: page.networkThrottling } : {}),
});

const traceStructuredContent = (lines: readonly string[], analysis: TraceAnalysis) => ({
  ...(lines.length > 0 ? { message: lines.join("\n") } : {}),
  traceSummary: analysis.summary,
  traceInsights: analysis.insights,
});

export class PerformanceDiagnostics {
  readonly #activeByOwner = new Map<string, ActiveTrace>();
  readonly #analyzer: TraceAnalyzer;
  readonly #completedByConnectionMode = new Map<string, CompletedTrace>();
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #files: DiagnosticFileSystem;
  readonly #outputPaths: DiagnosticOutputPathResolver;
  readonly #pageProvider: SelectedPageProvider;
  readonly #traceCompletionTimeoutMs: number;

  constructor(options: PerformanceDiagnosticsOptions) {
    this.#analyzer = options.analyzer ?? new SubprocessTraceAnalyzer();
    this.#delay = options.delay ?? delay;
    this.#files = options.files ?? new NodeDiagnosticFileSystem();
    this.#outputPaths = options.outputPaths ?? rejectingDiagnosticOutputPathResolver;
    this.#pageProvider = options.pageProvider;
    this.#traceCompletionTimeoutMs = options.traceCompletionTimeoutMs ?? 120_000;
  }

  async startTrace(call: DiagnosticCall, input: StartTraceInput): Promise<DiagnosticToolResult> {
    const destination =
      input.filePath ? await this.#resolveTraceDestination(call, input.filePath) : undefined;
    const page = await this.#pageProvider.acquire(call);
    let startedTrace: ActiveTrace | undefined;
    try {
      await this.#discardStaleActiveTrace(page);
      const running = this.#activeByOwner.get(page.ownerId);
      if (running) {
        if (running.connectionId !== call.connectionId) {
          throw new ChromeDiagnosticError(
            "CHROME_MCP_TRACE_OWNERSHIP",
            "A performance trace in this browser owner belongs to another MCP connection.",
          );
        }
        const line =
          "Error: a performance trace is already running. Stop it with `performance_stop_trace` before starting another.";
        return textResult([line], { message: line });
      }

      const reload = input.reload ?? true;
      const autoStop = input.autoStop ?? true;
      const originalUrl = page.url;
      if (reload) await page.navigate("about:blank", { waitUntil: "load" });

      await page.cdp.send("Tracing.start", {
        streamFormat: "json",
        traceConfig: {
          excludedCategories: PERFORMANCE_TRACE_CATEGORIES.filter((category) => category.startsWith("-")).map(
            (category) => category.slice(1),
          ),
          includedCategories: PERFORMANCE_TRACE_CATEGORIES.filter((category) => !category.startsWith("-")),
        },
        transferMode: "ReturnAsStream",
      });
      startedTrace = {
        connectionId: call.connectionId,
        metadata: traceMetadata(page),
        ownerGeneration: page.ownerGeneration,
        ownerId: page.ownerId,
        page,
      };
      this.#activeByOwner.set(page.ownerId, startedTrace);

      if (reload) await page.navigate(originalUrl, { waitUntil: "load" });
      if (!autoStop) {
        const line = "The performance trace is being recorded. Use performance_stop_trace to stop it.";
        return textResult([line], { message: line });
      }

      await this.#delay(5000);
      return await this.#stopActiveTrace(call, startedTrace, destination, page.deviceScope);
    } catch (error) {
      if (startedTrace && this.#activeByOwner.get(startedTrace.ownerId) === startedTrace) {
        this.#activeByOwner.delete(startedTrace.ownerId);
        await this.#discardTraceCapture(startedTrace);
      }
      throw error;
    } finally {
      await this.#pageProvider.release(page);
    }
  }

  async stopTrace(call: DiagnosticCall, input: StopTraceInput): Promise<DiagnosticToolResult> {
    const destination =
      input.filePath ? await this.#resolveTraceDestination(call, input.filePath) : undefined;
    const page = await this.#pageProvider.acquire(call);
    try {
      const active = this.#activeByOwner.get(page.ownerId);
      if (!active) {
        throw new ChromeDiagnosticError(
          "CHROME_MCP_TRACE_NOT_ACTIVE",
          "No performance trace is active for this browser owner.",
        );
      }
      if (active.connectionId !== call.connectionId) {
        throw new ChromeDiagnosticError(
          "CHROME_MCP_TRACE_OWNERSHIP",
          "The active performance trace belongs to another MCP connection.",
        );
      }
      if (active.ownerGeneration !== page.ownerGeneration) {
        this.#activeByOwner.delete(page.ownerId);
        await this.#discardTraceCapture(active);
        throw new ChromeDiagnosticError(
          "CHROME_MCP_TRACE_INCOMPLETE",
          "The browser owner changed while the performance trace was active, so the trace is incomplete.",
        );
      }
      return await this.#stopActiveTrace(call, active, destination, page.deviceScope);
    } finally {
      await this.#pageProvider.release(page);
    }
  }

  async analyzeInsight(call: DiagnosticCall, input: AnalyzeInsightInput): Promise<DiagnosticToolResult> {
    const completed = this.#completedByConnectionMode.get(connectionModeKey(call));
    if (!completed) {
      throw new ChromeDiagnosticError(
        "CHROME_MCP_TRACE_NOT_ACTIVE",
        "No completed performance trace is available for this browser owner.",
      );
    }

    if (input.insightName === undefined) {
      const message =
        completed.insights.length === 0 ?
          "No performance insights are available for the latest trace. This is a valid result; do not guess an insight name."
        : `Available performance insights:\n${completed.insights
            .map((insight) => `${insight.insightSetId}/${insight.insightName}`)
            .join("\n")}`;
      return textResult([message], { message, traceInsights: completed.insights });
    }

    const available = completed.insights.find(
      (insight) => insight.insightName === input.insightName && insight.insightSetId === input.insightSetId,
    );
    if (!available) {
      const choices =
        completed.insights.length === 0 ?
          "No insights are available for the latest trace. Omit insightSetId and insightName to confirm discovery."
        : `Available pairs: ${completed.insights
            .map((insight) => `${insight.insightSetId}/${insight.insightName}`)
            .join(", ")}`;
      throw new ChromeDiagnosticError(
        "CHROME_MCP_INVALID_INPUT",
        `Performance insight ${input.insightSetId}/${input.insightName} is not available. ${choices}`,
      );
    }

    const page = await this.#pageProvider.acquire(call);
    try {
      const result = await this.#analyzer.analyzeInsight({
        deviceScope: page.deviceScope,
        insightName: input.insightName,
        insightSetId: input.insightSetId,
        metadata: completed.metadata,
        tracePath: completed.tracePath,
      });
      if ("error" in result) throw new ChromeDiagnosticError("CHROME_MCP_INVALID_INPUT", result.error);
      if (result.output.trim().length === 0) {
        throw new ChromeDiagnosticError(
          "CHROME_MCP_TRACE_PROTOCOL",
          `Performance insight ${input.insightSetId}/${input.insightName} returned no content`,
        );
      }
      return textResult([result.output]);
    } finally {
      await this.#pageProvider.release(page);
    }
  }

  async releaseConnection(connectionId: string): Promise<void> {
    const active = [...this.#activeByOwner.values()].filter((trace) => trace.connectionId === connectionId);
    for (const trace of active) {
      this.#activeByOwner.delete(trace.ownerId);
      await this.#discardTraceCapture(trace);
    }

    const completedKeys = [...this.#completedByConnectionMode.keys()].filter((key) =>
      key.startsWith(`${connectionId}\0`),
    );
    for (const key of completedKeys) {
      const completed = this.#completedByConnectionMode.get(key);
      this.#completedByConnectionMode.delete(key);
      if (completed) await this.#files.remove(completed.tracePath);
    }
  }

  async releaseOwner(call: DiagnosticCall, ownerId: string, ownerGeneration: number): Promise<void> {
    const active = this.#activeByOwner.get(ownerId);
    if (active?.connectionId === call.connectionId && active.ownerGeneration === ownerGeneration) {
      this.#activeByOwner.delete(ownerId);
      await this.#discardTraceCapture(active);
    }

    const key = connectionModeKey(call);
    const completed = this.#completedByConnectionMode.get(key);
    this.#completedByConnectionMode.delete(key);
    if (completed) await this.#files.remove(completed.tracePath);
  }

  async #captureTrace(active: ActiveTrace): Promise<string> {
    const tracePath = await this.#files.createTemporaryPath("trace.json");
    const file = await this.#files.openAtomic(tracePath, false);
    const completion = waitForTraceCompletion(active.page.cdp, this.#traceCompletionTimeoutMs);
    try {
      await active.page.cdp.send("Tracing.end");
      const { dataLossOccurred, stream } = await completion.promise;
      if (dataLossOccurred) {
        await active.page.cdp.send("IO.close", { handle: stream }).catch(() => undefined);
        throw new ChromeDiagnosticError(
          "CHROME_MCP_TRACE_INCOMPLETE",
          "Chrome reported data loss while recording the performance trace, so the trace is incomplete.",
        );
      }
      await readTraceStream(active.page.cdp, stream, file);
      await file.commit();
      return tracePath;
    } catch (error) {
      completion.cancel();
      await completion.promise.catch(() => undefined);
      await file.abort().catch(() => undefined);
      await this.#files.remove(tracePath).catch(() => undefined);
      throw error;
    }
  }

  async #discardStaleActiveTrace(page: SelectedDiagnosticPage): Promise<void> {
    const active = this.#activeByOwner.get(page.ownerId);
    if (!active || active.ownerGeneration === page.ownerGeneration) return;
    this.#activeByOwner.delete(page.ownerId);
    await this.#discardTraceCapture(active);
  }

  async #discardTraceCapture(active: ActiveTrace): Promise<void> {
    try {
      const tracePath = await this.#captureTrace(active);
      await this.#files.remove(tracePath);
    } catch {
      // A stale-trace cleanup failure does not fail the replacement browser generation.
    }
  }

  async #stopActiveTrace(
    call: DiagnosticCall,
    active: ActiveTrace,
    destination: string | undefined,
    deviceScope: SelectedDiagnosticPage["deviceScope"],
  ): Promise<DiagnosticToolResult> {
    let tracePath: string | undefined;
    let failure: unknown;
    try {
      tracePath = await this.#captureTrace(active);
      const lines: string[] = [];
      if (destination) {
        const gzip = destination.endsWith(".gz");
        await this.#files.materializeTrace(tracePath, destination, gzip);
        lines.push(`The raw trace data was saved to ${destination}.`);
      }

      const analysis = await this.#analyzer.analyzeTrace({
        deviceScope,
        metadata: active.metadata,
        tracePath,
      });
      lines.push("The performance trace has been stopped.");

      const key = connectionModeKey(call);
      const previous = this.#completedByConnectionMode.get(key);
      this.#completedByConnectionMode.set(key, {
        insights: analysis.insights,
        metadata: active.metadata,
        tracePath,
      });
      tracePath = undefined;
      if (previous) await this.#files.remove(previous.tracePath);

      return textResult([...lines, analysis.summary], traceStructuredContent(lines, analysis));
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.#activeByOwner.delete(active.ownerId);
      if (tracePath) {
        try {
          await this.#files.remove(tracePath);
        } catch (error) {
          if (failure === undefined) throw error;
        }
      }
    }
  }

  async #resolveTraceDestination(call: DiagnosticCall, filePath: string): Promise<string> {
    const gzip = filePath.endsWith(".gz");
    return this.#outputPaths.resolveFile({
      call,
      path: replaceExtension(filePath, gzip ? ".json.gz" : ".json"),
    });
  }
}
