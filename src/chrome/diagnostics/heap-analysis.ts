import { fileURLToPath } from "node:url";
import {
  type HeapAnalysisRequest,
  type HeapAnalysisResult,
  type HeapAnalysisWorkerRequest,
  type HeapQueryRequest,
  type HeapQueryResult,
  parseHeapAnalysisWorkerResponse,
} from "./heap-analysis-protocol";
import { redactFilePaths } from "./redaction";
import { ChromeDiagnosticError } from "./types";
import { DiagnosticWorkerError, runDiagnosticWorkerProcess } from "./worker-process";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

export type HeapSnapshotAnalyzer = {
  analyze: (request: HeapAnalysisRequest) => Promise<HeapAnalysisResult>;
};

export type SubprocessHeapSnapshotAnalyzerOptions = {
  timeoutMs?: number;
  workerPath?: string;
};

const defaultWorkerPath = (): string => fileURLToPath(new URL("./heap-analysis-worker.ts", import.meta.url));

const redactPaths = (message: string, request: HeapAnalysisRequest | HeapQueryRequest): string => {
  let redacted = message.replaceAll(request.snapshotPath, "[redacted snapshot path]");
  if ("baselineSnapshotPath" in request && request.baselineSnapshotPath) {
    redacted = redacted.replaceAll(request.baselineSnapshotPath, "[redacted baseline path]");
  }
  return redactFilePaths(redacted);
};

const runWorker = async (
  request: HeapAnalysisWorkerRequest,
  options: SubprocessHeapSnapshotAnalyzerOptions,
  signal?: AbortSignal,
) => {
  const decoded = await runDiagnosticWorkerProcess({
    maximumStdoutBytes: MAX_STDOUT_BYTES,
    request,
    signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    workerName: "heap analysis",
    workerPath: options.workerPath ?? defaultWorkerPath(),
  });

  return parseHeapAnalysisWorkerResponse(decoded);
};

export class SubprocessHeapSnapshotAnalyzer implements HeapSnapshotAnalyzer {
  readonly #options: SubprocessHeapSnapshotAnalyzerOptions;

  constructor(options: SubprocessHeapSnapshotAnalyzerOptions = {}) {
    this.#options = options;
  }

  async analyze(request: HeapAnalysisRequest): Promise<HeapAnalysisResult> {
    try {
      const response = await runWorker({ input: request, operation: "analyze" }, this.#options);
      if (!response.ok) throw new DiagnosticWorkerError(`${response.error.code}: ${response.error.message}`);
      if ("operation" in response) {
        throw new DiagnosticWorkerError("Unexpected heap query response");
      }
      return response.result;
    } catch (error) {
      const message =
        error instanceof Error ? redactPaths(error.message, request) : "Unknown heap analysis failure";
      throw new ChromeDiagnosticError(
        "CHROME_MCP_HEAP_PROTOCOL",
        `Heap snapshot analysis failed: ${message}`,
      );
    }
  }

  async query(request: HeapQueryRequest, signal?: AbortSignal): Promise<HeapQueryResult> {
    try {
      const response = await runWorker({ input: request, operation: "query" }, this.#options, signal);
      if (!response.ok) {
        throw new DiagnosticWorkerError(`${response.error.code}: ${response.error.message}`);
      }
      if (!("operation" in response) || response.operation !== "query") {
        throw new DiagnosticWorkerError("Unexpected heap analysis response");
      }
      return response.result;
    } catch (error: unknown) {
      if (signal?.aborted) throw signal.reason;

      const message =
        error instanceof Error ? redactPaths(error.message, request) : "Unknown heap query failure";
      throw new ChromeDiagnosticError("CHROME_MCP_HEAP_PROTOCOL", `Heap snapshot query failed: ${message}`);
    }
  }
}
