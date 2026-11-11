import { isRecord } from "../../platform/records";

export const PIXEL_DIFF_MAX_PNG_BYTES = 64 * 1024 * 1024;
export const PIXEL_DIFF_MAX_PIXELS = 100_000_000;
export const PIXEL_DIFF_MAX_REQUEST_BYTES = Math.ceil(PIXEL_DIFF_MAX_PNG_BYTES / 3) * 8 + 1024;
export const PIXEL_DIFF_MAX_RESPONSE_BYTES = Math.ceil(PIXEL_DIFF_MAX_PNG_BYTES / 3) * 4 + 2048;
export const PIXEL_DIFF_MAX_STDERR_BYTES = 64 * 1024;

export type PixelDiffWorkerFailureCode =
  | "dimensions-differ"
  | "invalid-after-png"
  | "invalid-before-png"
  | "invalid-request"
  | "pixel-diff-failed";

export type PixelDiffWorkerRequest = Readonly<{
  afterPng: string;
  beforePng: string;
  operation: "pixel-diff";
  threshold: number;
}>;

export type PixelDiffWorkerSuccess = Readonly<{
  changedPixels: number;
  diffPng: string;
  height: number;
  ok: true;
  width: number;
  workerPid: number;
}>;

export type PixelDiffWorkerFailure = Readonly<{
  code: PixelDiffWorkerFailureCode;
  message: string;
  ok: false;
  workerPid: number;
}>;

export type PixelDiffWorkerResponse = PixelDiffWorkerFailure | PixelDiffWorkerSuccess;

const BASE64_PATTERN = /^(?:[\d+/A-Za-z]{4})*(?:[\d+/A-Za-z]{2}==|[\d+/A-Za-z]{3}=)?$/;
const FAILURE_CODES: ReadonlySet<string> = new Set([
  "dimensions-differ",
  "invalid-after-png",
  "invalid-before-png",
  "invalid-request",
  "pixel-diff-failed",
]);

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
  );
};

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isFailureCode = (value: unknown): value is PixelDiffWorkerFailureCode =>
  typeof value === "string" && FAILURE_CODES.has(value);

export const encodePixelDiffBytes = (bytes: Uint8Array) => {
  if (bytes.byteLength > PIXEL_DIFF_MAX_PNG_BYTES) throw new Error("Pixel-diff PNG exceeds the byte limit.");
  return Buffer.from(bytes).toString("base64");
};

export const decodePixelDiffBytes = (value: unknown) => {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(PIXEL_DIFF_MAX_PNG_BYTES / 3) * 4 ||
    !BASE64_PATTERN.test(value)
  ) {
    throw new Error("Pixel-diff PNG bytes are invalid.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > PIXEL_DIFF_MAX_PNG_BYTES || bytes.toString("base64") !== value) {
    throw new Error("Pixel-diff PNG bytes are invalid.");
  }
  return new Uint8Array(bytes);
};

export const parsePixelDiffWorkerRequest = (value: unknown): PixelDiffWorkerRequest => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["afterPng", "beforePng", "operation", "threshold"]) ||
    value.operation !== "pixel-diff" ||
    typeof value.threshold !== "number" ||
    !Number.isFinite(value.threshold) ||
    value.threshold < 0 ||
    value.threshold > 1 ||
    typeof value.beforePng !== "string" ||
    typeof value.afterPng !== "string"
  ) {
    throw new Error("Pixel-diff subprocess request is invalid.");
  }
  decodePixelDiffBytes(value.beforePng);
  decodePixelDiffBytes(value.afterPng);
  return {
    afterPng: value.afterPng,
    beforePng: value.beforePng,
    operation: "pixel-diff",
    threshold: value.threshold,
  };
};

export const parsePixelDiffWorkerResponse = (value: unknown): PixelDiffWorkerResponse => {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("Pixel-diff subprocess response is invalid.");
  }
  if (!value.ok) {
    if (
      !hasExactKeys(value, ["code", "message", "ok", "workerPid"]) ||
      !isFailureCode(value.code) ||
      typeof value.message !== "string" ||
      value.message.length === 0 ||
      Buffer.byteLength(value.message) > 512 ||
      !isPositiveInteger(value.workerPid)
    ) {
      throw new Error("Pixel-diff subprocess response is invalid.");
    }
    return {
      code: value.code,
      message: value.message,
      ok: false,
      workerPid: value.workerPid,
    };
  }
  if (
    !hasExactKeys(value, ["changedPixels", "diffPng", "height", "ok", "width", "workerPid"]) ||
    !isPositiveInteger(value.width) ||
    !isPositiveInteger(value.height) ||
    value.width * value.height > PIXEL_DIFF_MAX_PIXELS ||
    typeof value.changedPixels !== "number" ||
    !Number.isSafeInteger(value.changedPixels) ||
    value.changedPixels < 0 ||
    value.changedPixels > value.width * value.height ||
    typeof value.diffPng !== "string" ||
    !isPositiveInteger(value.workerPid)
  ) {
    throw new Error("Pixel-diff subprocess response is invalid.");
  }
  decodePixelDiffBytes(value.diffPng);
  return {
    changedPixels: value.changedPixels,
    diffPng: value.diffPng,
    height: value.height,
    ok: true,
    width: value.width,
    workerPid: value.workerPid,
  };
};

export const readBoundedPixelDiffStream = async (stream: ReadableStream<Uint8Array>, limit: number) => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) throw new Error("Pixel-diff subprocess envelope exceeds the byte limit.");
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks, size));
};
