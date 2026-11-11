import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import {
  decodePixelDiffBytes,
  encodePixelDiffBytes,
  parsePixelDiffWorkerRequest,
  PIXEL_DIFF_MAX_PIXELS,
  PIXEL_DIFF_MAX_REQUEST_BYTES,
  type PixelDiffWorkerFailure,
  type PixelDiffWorkerFailureCode,
  type PixelDiffWorkerSuccess,
  readBoundedPixelDiffStream,
} from "./pixel-diff-protocol";

class PixelDiffWorkerError extends Error {
  readonly code: PixelDiffWorkerFailureCode;

  constructor(code: PixelDiffWorkerFailureCode, message: string) {
    super(message);
    this.name = "PixelDiffWorkerError";
    this.code = code;
  }
}

const decodePng = (bytes: Uint8Array, label: "after" | "before") => {
  try {
    const image = PNG.sync.read(Buffer.from(bytes));
    if (
      !Number.isSafeInteger(image.width) ||
      !Number.isSafeInteger(image.height) ||
      image.width <= 0 ||
      image.height <= 0 ||
      image.width * image.height > PIXEL_DIFF_MAX_PIXELS
    ) {
      throw new Error("PNG dimensions exceed the pixel limit");
    }
    return image;
  } catch {
    throw new PixelDiffWorkerError(
      label === "before" ? "invalid-before-png" : "invalid-after-png",
      `The ${label} screenshot is not a valid PNG image.`,
    );
  }
};

const execute = async (): Promise<PixelDiffWorkerSuccess> => {
  const bytes = await readBoundedPixelDiffStream(Bun.stdin.stream(), PIXEL_DIFF_MAX_REQUEST_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PixelDiffWorkerError("invalid-request", "Pixel-diff subprocess request is invalid.");
  }
  let request;
  try {
    request = parsePixelDiffWorkerRequest(value);
  } catch {
    throw new PixelDiffWorkerError("invalid-request", "Pixel-diff subprocess request is invalid.");
  }
  const before = decodePng(decodePixelDiffBytes(request.beforePng), "before");
  const after = decodePng(decodePixelDiffBytes(request.afterPng), "after");
  if (before.width !== after.width || before.height !== after.height) {
    throw new PixelDiffWorkerError(
      "dimensions-differ",
      `Screenshot dimensions differ: ${before.width}x${before.height} and ${after.width}x${after.height}.`,
    );
  }
  const diff = new PNG({ width: before.width, height: before.height });
  const changedPixels = pixelmatch(before.data, after.data, diff.data, before.width, before.height, {
    threshold: request.threshold,
    includeAA: false,
    alpha: 0.1,
    aaColor: [255, 255, 0],
    diffColor: [255, 0, 0],
    diffColorAlt: [255, 0, 0],
    diffMask: false,
    checkerboard: true,
  });
  const diffPng = PNG.sync.write(diff, {
    bitDepth: 8,
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true,
    deflateLevel: 9,
    deflateStrategy: 3,
  });
  return {
    changedPixels,
    diffPng: encodePixelDiffBytes(diffPng),
    height: before.height,
    ok: true,
    width: before.width,
    workerPid: process.pid,
  };
};

const response = await execute().catch(
  (error: unknown): PixelDiffWorkerFailure => ({
    code: error instanceof PixelDiffWorkerError ? error.code : "pixel-diff-failed",
    message: error instanceof PixelDiffWorkerError ? error.message : "Pixel-diff subprocess failed.",
    ok: false,
    workerPid: process.pid,
  }),
);

process.stdout.write(JSON.stringify(response));
