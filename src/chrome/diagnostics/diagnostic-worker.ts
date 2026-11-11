import { runLighthouseEngine } from "./lighthouse-engine";
import { redactDiagnosticRequestValues, redactFilePaths } from "./redaction";
import {
  type DiagnosticWorkerFailure,
  type DiagnosticWorkerOperation,
  type DiagnosticWorkerRequest,
  type DiagnosticWorkerSuccess,
  parseDiagnosticWorkerRequest,
  readDiagnosticWorkerOperation,
} from "./subprocess-protocol";
import { analyzeInsightWithChromeFrontend, analyzeTraceWithChromeFrontend } from "./trace-engine";
import { redirectConsoleToStderr } from "./worker-console";

redirectConsoleToStderr();

const readFailureMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown diagnostic failure";
};

const errorMessage = (error: unknown, request: DiagnosticWorkerRequest | undefined): string => {
  const message = readFailureMessage(error);

  if (!request) return redactFilePaths(message);
  return redactDiagnosticRequestValues(message, request);
};

const runRequest = async (request: DiagnosticWorkerRequest): Promise<DiagnosticWorkerSuccess> => {
  if (request.operation === "trace-analyze") {
    return {
      ok: true,
      operation: request.operation,
      result: await analyzeTraceWithChromeFrontend(request.input),
    };
  }
  if (request.operation === "trace-insight") {
    return {
      ok: true,
      operation: request.operation,
      result: await analyzeInsightWithChromeFrontend(request.input),
    };
  }
  return {
    ok: true,
    operation: request.operation,
    result: await runLighthouseEngine(request.input),
  };
};

const main = async (): Promise<void> => {
  let decoded: unknown;
  let request: DiagnosticWorkerRequest | undefined;
  let operation: DiagnosticWorkerOperation | "unknown" = "unknown";
  try {
    decoded = JSON.parse(await Bun.stdin.text());
    operation = readDiagnosticWorkerOperation(decoded);
    request = parseDiagnosticWorkerRequest(decoded);
    process.stdout.write(JSON.stringify(await runRequest(request)));
  } catch (error) {
    const response: DiagnosticWorkerFailure = {
      error: {
        code: request ? `${operation.toUpperCase().replaceAll("-", "_")}_FAILED` : "INVALID_REQUEST",
        message: errorMessage(error, request),
      },
      ok: false,
      operation,
    };
    process.stdout.write(JSON.stringify(response));
  }
};

await main();
