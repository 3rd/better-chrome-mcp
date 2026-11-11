import { fileURLToPath } from "node:url";
import { redactDiagnosticRequestValues } from "./redaction";
import {
  type DiagnosticWorkerRequest,
  type DiagnosticWorkerResponse,
  parseDiagnosticWorkerResponse,
} from "./subprocess-protocol";
import {
  ChromeDiagnosticError,
  type JsonObject,
  type LighthouseRunner,
  type LighthouseRunnerInput,
  type TraceAnalysisInput,
  type TraceAnalyzer,
  type TraceInsightInput,
} from "./types";
import { DiagnosticWorkerError, runDiagnosticWorkerProcess } from "./worker-process";

const DEFAULT_WORKER_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 128 * 1024 * 1024;

export type DiagnosticSubprocessOptions = {
  timeoutMs?: number;
  workerPath?: string;
};

const defaultWorkerPath = (): string => fileURLToPath(new URL("./diagnostic-worker.ts", import.meta.url));

const parseWorkerOutput = (decoded: unknown, request: DiagnosticWorkerRequest): DiagnosticWorkerResponse => {
  const response = parseDiagnosticWorkerResponse(decoded);
  if (response.operation !== request.operation) {
    throw new DiagnosticWorkerError("The diagnostic worker returned a response for another operation");
  }
  if (!response.ok) {
    return {
      ...response,
      error: { ...response.error, message: redactDiagnosticRequestValues(response.error.message, request) },
    };
  }
  return response;
};

const runDiagnosticSubprocess = async (
  request: DiagnosticWorkerRequest,
  options: DiagnosticSubprocessOptions,
) => {
  const decoded = await runDiagnosticWorkerProcess({
    maximumStdoutBytes: MAX_STDOUT_BYTES,
    request,
    timeoutMs: options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
    workerName: "diagnostic",
    workerPath: options.workerPath ?? defaultWorkerPath(),
  });

  return parseWorkerOutput(decoded, request);
};

export class SubprocessTraceAnalyzer implements TraceAnalyzer {
  readonly #options: DiagnosticSubprocessOptions;

  constructor(options: DiagnosticSubprocessOptions = {}) {
    this.#options = options;
  }

  async analyzeTrace(input: TraceAnalysisInput) {
    try {
      const response = await runDiagnosticSubprocess(
        {
          operation: "trace-analyze",
          input,
        },
        this.#options,
      );
      if (!response.ok) throw new DiagnosticWorkerError(`${response.error.code}: ${response.error.message}`);
      if (response.operation !== "trace-analyze") {
        throw new DiagnosticWorkerError("Unexpected trace response");
      }
      return response.result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown diagnostic subprocess failure";
      throw new ChromeDiagnosticError(
        "CHROME_MCP_TRACE_PROTOCOL",
        `Trace analysis subprocess failed: ${message}`,
      );
    }
  }

  async analyzeInsight(input: TraceInsightInput) {
    try {
      const response = await runDiagnosticSubprocess(
        {
          operation: "trace-insight",
          input,
        },
        this.#options,
      );
      if (!response.ok) throw new DiagnosticWorkerError(`${response.error.code}: ${response.error.message}`);
      if (response.operation !== "trace-insight") {
        throw new DiagnosticWorkerError("Unexpected insight response");
      }
      return response.result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown diagnostic subprocess failure";
      throw new ChromeDiagnosticError(
        "CHROME_MCP_TRACE_PROTOCOL",
        `Trace insight subprocess failed: ${message}`,
      );
    }
  }
}

export class SubprocessLighthouseRunner implements LighthouseRunner {
  readonly #options: DiagnosticSubprocessOptions;

  constructor(options: DiagnosticSubprocessOptions = {}) {
    this.#options = options;
  }

  async run(input: LighthouseRunnerInput) {
    try {
      const response = await runDiagnosticSubprocess({ operation: "lighthouse", input }, this.#options);
      if (!response.ok) throw new DiagnosticWorkerError(`${response.error.code}: ${response.error.message}`);
      if (response.operation !== "lighthouse") {
        throw new DiagnosticWorkerError("Unexpected Lighthouse response");
      }
      return response.result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown diagnostic subprocess failure";
      throw new ChromeDiagnosticError(
        "CHROME_MCP_LIGHTHOUSE_FAILED",
        `Lighthouse subprocess failed: ${message}`,
      );
    }
  }
}

export type LighthouseEndpointTargetInput =
  | { browserURL: string; browserWSEndpoint?: never; targetId: string }
  | { browserURL?: never; browserWSEndpoint: string; targetId: string };

export const lighthouseEndpointTarget = (input: LighthouseEndpointTargetInput): JsonObject => ({
  ...(input.browserWSEndpoint ? { browserWSEndpoint: input.browserWSEndpoint } : {}),
  ...(input.browserURL ? { browserURL: input.browserURL } : {}),
  targetId: input.targetId,
});
