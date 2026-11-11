import { fileURLToPath } from "node:url";
import type { PixelDiffAdapter, PixelDiffResult } from "./types";
import { ISOLATED_BUN_CONFIG_ARGUMENT } from "../../platform/bun-child";
import { isRecord } from "../../platform/records";
import { windowsSystemEnvironment } from "../../platform/windows/environment";
import { captureError } from "./errors";
import {
  decodePixelDiffBytes,
  encodePixelDiffBytes,
  parsePixelDiffWorkerResponse,
  PIXEL_DIFF_MAX_PIXELS,
  PIXEL_DIFF_MAX_PNG_BYTES,
  PIXEL_DIFF_MAX_REQUEST_BYTES,
  PIXEL_DIFF_MAX_RESPONSE_BYTES,
  PIXEL_DIFF_MAX_STDERR_BYTES,
  readBoundedPixelDiffStream,
} from "./pixel-diff-protocol";

export interface PixelDiffExecutionRequest {
  beforePng: Uint8Array;
  afterPng: Uint8Array;
  threshold: number;
}

export interface PixelDiffExecutionResult {
  width: number;
  height: number;
  changedPixels: number;
  diffPng: Uint8Array;
  workerPid: number;
}

export interface PixelDiffExecutor {
  execute: (request: PixelDiffExecutionRequest) => Promise<unknown>;
}

export interface PixelmatchPixelDiffAdapterOptions {
  executor?: PixelDiffExecutor;
  threshold?: number;
}

const readExecutionResult = (value: unknown): PixelDiffExecutionResult => {
  if (!isRecord(value)) {
    throw captureError(
      "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
      "The pixel-diff executor returned an invalid result.",
    );
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ["changedPixels", "diffPng", "height", "width", "workerPid"];
  const { width, height, changedPixels, diffPng, workerPid } = value;
  const totalPixels = typeof width === "number" && typeof height === "number" ? width * height : 0;
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    !Number.isSafeInteger(totalPixels) ||
    totalPixels > PIXEL_DIFF_MAX_PIXELS ||
    typeof changedPixels !== "number" ||
    !Number.isSafeInteger(changedPixels) ||
    changedPixels < 0 ||
    changedPixels > totalPixels ||
    !(diffPng instanceof Uint8Array) ||
    diffPng.byteLength > PIXEL_DIFF_MAX_PNG_BYTES ||
    typeof workerPid !== "number" ||
    !Number.isSafeInteger(workerPid) ||
    workerPid <= 0
  ) {
    throw captureError(
      "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
      "The pixel-diff executor returned an invalid result.",
    );
  }
  return { width, height, changedPixels, diffPng: new Uint8Array(diffPng), workerPid };
};

const workerPath = fileURLToPath(new URL("./pixel-diff-worker.ts", import.meta.url));

export class SubprocessPixelDiffExecutor implements PixelDiffExecutor {
  async execute(request: PixelDiffExecutionRequest): Promise<PixelDiffExecutionResult> {
    if (
      !(request.beforePng instanceof Uint8Array) ||
      !(request.afterPng instanceof Uint8Array) ||
      request.beforePng.byteLength > PIXEL_DIFF_MAX_PNG_BYTES ||
      request.afterPng.byteLength > PIXEL_DIFF_MAX_PNG_BYTES ||
      !Number.isFinite(request.threshold) ||
      request.threshold < 0 ||
      request.threshold > 1
    ) {
      throw captureError("CHROME_MCP_CHECKPOINT_INVALID_OPTIONS", "Pixel-diff subprocess input is invalid.");
    }
    const payload = new TextEncoder().encode(
      JSON.stringify({
        afterPng: encodePixelDiffBytes(request.afterPng),
        beforePng: encodePixelDiffBytes(request.beforePng),
        operation: "pixel-diff",
        threshold: request.threshold,
      }),
    );
    if (payload.byteLength > PIXEL_DIFF_MAX_REQUEST_BYTES) {
      throw captureError("CHROME_MCP_CHECKPOINT_INVALID_OPTIONS", "Pixel-diff subprocess input is invalid.");
    }

    const child = Bun.spawn({
      cmd: [process.execPath, ISOLATED_BUN_CONFIG_ARGUMENT, workerPath],
      env: windowsSystemEnvironment(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    try {
      const stdout = readBoundedPixelDiffStream(child.stdout, PIXEL_DIFF_MAX_RESPONSE_BYTES);
      const stderr = readBoundedPixelDiffStream(child.stderr, PIXEL_DIFF_MAX_STDERR_BYTES);
      child.stdin.write(payload);
      child.stdin.end();
      const [exitCode, output] = await Promise.all([child.exited, stdout, stderr]);
      if (exitCode !== 0) {
        throw captureError("CHROME_MCP_CHECKPOINT_INVALID_OPTIONS", "Pixel-diff subprocess failed.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(output));
      } catch (error) {
        throw captureError(
          "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
          "Pixel-diff subprocess returned invalid output.",
          error,
        );
      }
      let response;
      try {
        response = parsePixelDiffWorkerResponse(parsed);
      } catch (error) {
        throw captureError(
          "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
          "Pixel-diff subprocess returned invalid output.",
          error,
        );
      }
      if (!response.ok) {
        throw captureError("CHROME_MCP_CHECKPOINT_INVALID_OPTIONS", response.message);
      }
      return {
        changedPixels: response.changedPixels,
        diffPng: decodePixelDiffBytes(response.diffPng),
        height: response.height,
        width: response.width,
        workerPid: response.workerPid,
      };
    } catch (error) {
      child.kill();
      await child.exited.catch(() => undefined);
      throw error;
    }
  }
}

export class PixelmatchPixelDiffAdapter implements PixelDiffAdapter {
  private readonly executor: PixelDiffExecutor;
  private readonly threshold: number;

  constructor(options: PixelmatchPixelDiffAdapterOptions = {}) {
    const threshold = options.threshold ?? 0.1;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw captureError(
        "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
        "Pixel-diff threshold must be from 0 through 1.",
      );
    }
    this.executor = options.executor ?? new SubprocessPixelDiffExecutor();
    this.threshold = threshold;
  }

  async diff(before: unknown, after: unknown): Promise<PixelDiffResult> {
    if (
      !(before instanceof Uint8Array) ||
      !(after instanceof Uint8Array) ||
      before.byteLength > PIXEL_DIFF_MAX_PNG_BYTES ||
      after.byteLength > PIXEL_DIFF_MAX_PNG_BYTES
    ) {
      throw captureError(
        "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
        "Pixel comparison requires bounded PNG screenshot bytes.",
      );
    }
    const execution = readExecutionResult(
      await this.executor.execute({
        beforePng: new Uint8Array(before),
        afterPng: new Uint8Array(after),
        threshold: this.threshold,
      }),
    );
    const totalPixels = execution.width * execution.height;
    const ratio = execution.changedPixels / totalPixels;
    return {
      width: execution.width,
      height: execution.height,
      changedPixels: execution.changedPixels,
      totalPixels,
      ratio,
      output: {
        name: "checkpoint-pixel-diff.png",
        mediaType: "image/png",
        source: { kind: "bytes", bytes: execution.diffPng },
        metadata: {
          width: execution.width,
          height: execution.height,
          changedPixels: execution.changedPixels,
          totalPixels,
          ratio,
          threshold: this.threshold,
        },
      },
    };
  }
}
