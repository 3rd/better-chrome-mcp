import type {
  CaptureAdapterStart,
  CaptureFinishReason,
  CaptureOutput,
  CaptureOutputPathAllocator,
  TraceAdapter,
  TraceCaptureOptions,
} from "./types";
import { captureError, CaptureFinalizeError } from "./errors";

export interface PlaywrightTracingAdapter {
  start: (options: { screenshots: boolean; snapshots: boolean; sources: boolean }) => Promise<void>;
  stop: (options: { path: string }) => Promise<void>;
}

export interface PlaywrightTracingResolver {
  tracing: (contextId: string) => Promise<PlaywrightTracingAdapter>;
}

interface TraceHandle {
  captureId: string;
  outputPath: string;
  tracing: PlaywrightTracingAdapter;
}

const isTraceHandle = (value: unknown): value is TraceHandle =>
  typeof value === "object" &&
  value !== null &&
  "captureId" in value &&
  "outputPath" in value &&
  "tracing" in value;

export class PlaywrightTraceAdapter implements TraceAdapter {
  private readonly resolver: PlaywrightTracingResolver;
  private readonly outputPaths: CaptureOutputPathAllocator;

  constructor(resolver: PlaywrightTracingResolver, outputPaths: CaptureOutputPathAllocator) {
    this.resolver = resolver;
    this.outputPaths = outputPaths;
  }

  async start(
    input: CaptureAdapterStart & { options: Required<Omit<TraceCaptureOptions, "type">> },
  ): Promise<TraceHandle> {
    input.signal.throwIfAborted();
    const tracing = await this.resolver.tracing(input.scope.contextId);
    const outputPath = await this.outputPaths.allocate(input.captureId, `${input.captureId}.zip`);
    try {
      await tracing.start(input.options);
      return { captureId: input.captureId, outputPath, tracing };
    } catch (error) {
      await this.outputPaths.discard?.(outputPath).catch(() => undefined);
      throw captureError(
        "CHROME_MCP_CAPTURE_CONFLICT",
        "Could not start Playwright tracing for this context; another trace may already be active.",
        error,
      );
    }
  }

  async finish(
    handleValue: unknown,
    input: { reason: CaptureFinishReason; signal: AbortSignal },
  ): Promise<CaptureOutput> {
    if (!isTraceHandle(handleValue)) throw new Error("Invalid Playwright trace handle.");
    const output: CaptureOutput = {
      name: `${handleValue.captureId}.zip`,
      mediaType: "application/zip",
      source: { kind: "path", path: handleValue.outputPath },
      metadata: { finishReason: input.reason },
    };
    try {
      input.signal.throwIfAborted();
      await handleValue.tracing.stop({ path: handleValue.outputPath });
      return output;
    } catch (error) {
      throw new CaptureFinalizeError("Playwright trace finalization failed.", {
        cause: error,
        partialOutput: output,
      });
    }
  }
}
