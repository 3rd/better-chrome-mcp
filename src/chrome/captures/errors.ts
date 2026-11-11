import type { CaptureOutput } from "./types";

export const CAPTURE_ERROR_CODES = [
  "CHROME_MCP_CAPTURE_CONFLICT",
  "CHROME_MCP_CAPTURE_NOT_FOUND",
  "CHROME_MCP_CAPTURE_INVALID_OPTIONS",
  "CHROME_MCP_CAPTURE_FINALIZE_FAILED",
  "CHROME_MCP_UNSUPPORTED_CAPTURE",
  "CHROME_MCP_CHECKPOINT_NOT_FOUND",
  "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
] as const;

export type CaptureErrorCode = (typeof CAPTURE_ERROR_CODES)[number];

export class CaptureError extends Error {
  readonly code: CaptureErrorCode;

  constructor(code: CaptureErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CaptureError";
    this.code = code;
  }
}

export class CaptureFinalizeError extends Error {
  readonly partialOutput?: CaptureOutput;

  constructor(message: string, options?: { cause?: unknown; partialOutput?: CaptureOutput }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CaptureFinalizeError";
    this.partialOutput = options?.partialOutput;
  }
}

export const captureError = (code: CaptureErrorCode, message: string, cause?: unknown) =>
  new CaptureError(code, message, cause === undefined ? undefined : { cause });
