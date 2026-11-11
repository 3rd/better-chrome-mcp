import { analyzeHeapSnapshot, queryHeapSnapshot } from "./heap-analysis-engine";
import { type HeapAnalysisWorkerResponse, parseHeapAnalysisWorkerRequest } from "./heap-analysis-protocol";
import { redactFilePaths } from "./redaction";
import { redirectConsoleToStderr } from "./worker-console";

redirectConsoleToStderr();

const safeErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "Unknown heap analysis failure";
  return redactFilePaths(message);
};

const main = async (): Promise<void> => {
  let response: HeapAnalysisWorkerResponse;
  try {
    const decoded: unknown = JSON.parse(await Bun.stdin.text());
    const request = parseHeapAnalysisWorkerRequest(decoded);
    response =
      request.operation === "query" ?
        { ok: true, operation: "query", result: await queryHeapSnapshot(request.input) }
      : { ok: true, result: await analyzeHeapSnapshot(request.input) };
  } catch (error) {
    response = {
      error: {
        code: "HEAP_ANALYSIS_FAILED",
        message: safeErrorMessage(error),
      },
      ok: false,
    };
  }
  process.stdout.write(JSON.stringify(response));
};

await main();
