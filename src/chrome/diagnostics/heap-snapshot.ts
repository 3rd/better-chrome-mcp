/**
 * Portions of this file are adapted from ChromeDevTools/chrome-devtools-mcp.
 * Copyright 2025 Google LLC. Licensed under Apache-2.0.
 */
import { heapSnapshotChunk } from "./cdp";
import { type DiagnosticFileSystem, NodeDiagnosticFileSystem, replaceExtension } from "./file-system";
import { type HeapSnapshotAnalyzer, SubprocessHeapSnapshotAnalyzer } from "./heap-analysis";
import {
  type HeapAnalysisOptions,
  type HeapAnalysisRequest,
  type HeapAnalysisResult,
  normalizeHeapAnalysisOptions,
} from "./heap-analysis-protocol";
import { type DiagnosticOutputPathResolver, rejectingDiagnosticOutputPathResolver } from "./output-path";
import {
  ChromeDiagnosticError,
  type DiagnosticCall,
  type DiagnosticToolResult,
  type HeapSnapshotInput,
  type SelectedPageProvider,
  textResult,
} from "./types";

export type HeapSnapshotDiagnosticInput = HeapSnapshotInput & {
  analysis?: HeapAnalysisOptions;
};

type HeapSnapshotDiagnosticsOptions = {
  analyzer?: HeapSnapshotAnalyzer;
  files?: DiagnosticFileSystem;
  outputPaths?: DiagnosticOutputPathResolver;
  pageProvider: SelectedPageProvider;
};

export class HeapSnapshotDiagnostics {
  readonly #analyzer: HeapSnapshotAnalyzer;
  readonly #files: DiagnosticFileSystem;
  readonly #pageProvider: SelectedPageProvider;
  readonly #outputPaths: DiagnosticOutputPathResolver;

  constructor(options: HeapSnapshotDiagnosticsOptions) {
    this.#analyzer = options.analyzer ?? new SubprocessHeapSnapshotAnalyzer();
    this.#files = options.files ?? new NodeDiagnosticFileSystem();
    this.#pageProvider = options.pageProvider;
    this.#outputPaths = options.outputPaths ?? rejectingDiagnosticOutputPathResolver;
  }

  async takeSnapshot(
    call: DiagnosticCall,
    input: HeapSnapshotDiagnosticInput,
  ): Promise<DiagnosticToolResult> {
    const destination = await this.#outputPaths.resolveFile({
      call,
      path: replaceExtension(input.filePath, ".heapsnapshot"),
    });
    const baselineSnapshotPath =
      input.analysis?.baselineFilePath ?
        await this.#outputPaths.resolveFile({ call, path: input.analysis.baselineFilePath })
      : undefined;
    let analysisRequest: HeapAnalysisRequest | undefined;
    if (input.analysis) {
      try {
        analysisRequest = normalizeHeapAnalysisOptions(destination, input.analysis, baselineSnapshotPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid heap analysis input";
        throw new ChromeDiagnosticError("CHROME_MCP_INVALID_INPUT", message);
      }
    }
    const page = await this.#pageProvider.acquire(call);
    let file: Awaited<ReturnType<DiagnosticFileSystem["openAtomic"]>> | undefined;
    let enabled = false;
    let acceptingChunks = true;
    let lateChunk = false;
    let failure: unknown;
    let writes = Promise.resolve();
    const onChunk = (payload: unknown): void => {
      if (!acceptingChunks) {
        lateChunk = true;
        return;
      }
      writes = writes.then(() => {
        if (!file) throw new Error("Heap snapshot output is not open");
        return file.write(heapSnapshotChunk(payload));
      });
    };

    try {
      file = await this.#files.openAtomic(destination, false);
      page.cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
      await page.cdp.send("HeapProfiler.enable");
      enabled = true;
      await page.cdp.send("HeapProfiler.collectGarbage");
      await page.cdp.send("HeapProfiler.takeHeapSnapshot", {
        reportProgress: false,
      });
      acceptingChunks = false;
      await writes;
      await page.cdp.send("HeapProfiler.disable");
      enabled = false;
      if (lateChunk) throw new Error("Chrome sent a heap snapshot chunk after reporting snapshot completion");
      await file.commit();
    } catch (error) {
      failure = error;
      if (file) {
        await file.abort().catch(() => undefined);
      }
    } finally {
      page.cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
      if (enabled) {
        try {
          await page.cdp.send("HeapProfiler.disable");
        } catch (error) {
          if (failure === undefined) failure = error;
        }
      }
      try {
        await this.#pageProvider.release(page);
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
    if (failure !== undefined) throw failure;

    const line = `Heap snapshot saved to ${destination}`;
    const analysis: HeapAnalysisResult | undefined =
      analysisRequest ? await this.#analyzer.analyze(analysisRequest) : undefined;
    if (!analysis) return textResult([line], { message: line });

    const analysisLine =
      `Heap analysis: ${analysis.snapshot.nodeCount} nodes, ${analysis.snapshot.edgeCount} edges, ` +
      `${analysis.snapshot.totalShallowSize} shallow bytes`;
    return textResult([line, analysisLine], {
      analysis,
      filePath: destination,
      message: line,
    });
  }
}
