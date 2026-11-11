import type { AtomicDiagnosticFile } from "./file-system";
import { ChromeDiagnosticError, type DiagnosticCdpSession } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringField = (value: unknown, field: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const fieldValue = value[field];
  return typeof fieldValue === "string" ? fieldValue : undefined;
};

export const readTraceStream = async (
  session: DiagnosticCdpSession,
  stream: string,
  file: AtomicDiagnosticFile,
): Promise<void> => {
  let emptyReads = 0;
  let failure: unknown;
  try {
    for (;;) {
      const result = await session.send("IO.read", { handle: stream, size: 1024 * 1024 });
      if (!isRecord(result) || typeof result.data !== "string") {
        throw new ChromeDiagnosticError(
          "CHROME_MCP_TRACE_PROTOCOL",
          "Chrome returned an invalid IO.read response.",
        );
      }
      if (result.data.length > 0) {
        emptyReads = 0;
        const bytes =
          result.base64Encoded === true ? Buffer.from(result.data, "base64") : Buffer.from(result.data);
        await file.write(bytes);
      } else if (result.eof !== true) {
        emptyReads += 1;
        if (emptyReads > 8) {
          throw new ChromeDiagnosticError(
            "CHROME_MCP_TRACE_PROTOCOL",
            "Chrome returned too many empty trace stream chunks before EOF.",
          );
        }
      }
      if (result.eof === true) return;
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await session.send("IO.close", { handle: stream });
    } catch (error) {
      if (failure === undefined) throw error;
    }
  }
};

export type TraceCompletion = {
  cancel: () => void;
  promise: Promise<{ dataLossOccurred: boolean; stream: string }>;
};

export const waitForTraceCompletion = (session: DiagnosticCdpSession, timeoutMs: number): TraceCompletion => {
  let settled = false;
  const completion = Promise.withResolvers<Awaited<TraceCompletion["promise"]>>();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const listener = (payload: unknown): void => {
    const stream = stringField(payload, "stream");
    if (!stream || settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    session.off("Tracing.tracingComplete", listener);
    const dataLossOccurred = isRecord(payload) && payload.dataLossOccurred === true;
    completion.resolve({ dataLossOccurred, stream });
  };

  session.on("Tracing.tracingComplete", listener);
  timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    session.off("Tracing.tracingComplete", listener);
    completion.reject(
      new ChromeDiagnosticError(
        "CHROME_MCP_TRACE_PROTOCOL",
        `Chrome did not complete trace streaming within ${timeoutMs} ms.`,
      ),
    );
  }, timeoutMs);

  return {
    cancel: () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      session.off("Tracing.tracingComplete", listener);
      completion.reject(
        new ChromeDiagnosticError("CHROME_MCP_TRACE_INCOMPLETE", "The trace completion wait was canceled."),
      );
    },
    promise: completion.promise,
  };
};

export const heapSnapshotChunk = (payload: unknown): string => {
  const chunk = stringField(payload, "chunk");
  if (chunk === undefined) {
    throw new ChromeDiagnosticError(
      "CHROME_MCP_HEAP_PROTOCOL",
      "Chrome returned an invalid heap snapshot chunk.",
    );
  }
  return chunk;
};
