import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import {
  type PixelDiffExecutionRequest,
  type PixelDiffExecutor,
  PixelmatchPixelDiffAdapter,
  SubprocessPixelDiffExecutor,
} from "./pixel-diff-adapter";

const png = (width: number, height: number, pixels: [number, number, number, number][]) => {
  const image = new PNG({ width, height });
  for (const [index, pixel] of pixels.entries()) {
    const offset = index * 4;
    image.data[offset] = pixel[0];
    image.data[offset + 1] = pixel[1];
    image.data[offset + 2] = pixel[2];
    image.data[offset + 3] = pixel[3];
  }
  return new Uint8Array(PNG.sync.write(image));
};

const outputBytes = (result: Awaited<ReturnType<PixelmatchPixelDiffAdapter["diff"]>>) => {
  const source = result.output?.source;
  if (!source || source.kind !== "bytes") throw new Error("Expected an in-memory PNG diff.");
  return source.bytes;
};

describe("PixelmatchPixelDiffAdapter", () => {
  test("reports regression pixels and emits deterministic PNG output and metadata", async () => {
    const white: [number, number, number, number] = [255, 255, 255, 255];
    const black: [number, number, number, number] = [0, 0, 0, 255];
    const before = png(2, 2, [white, white, white, white]);
    const after = png(2, 2, [black, white, white, white]);
    const adapter = new PixelmatchPixelDiffAdapter({ threshold: 0.1 });

    const first = await adapter.diff(before, after);
    const second = await adapter.diff(before, after);
    const firstBytes = outputBytes(first);
    const secondBytes = outputBytes(second);
    const decoded = PNG.sync.read(Buffer.from(firstBytes));

    expect(first).toMatchObject({
      width: 2,
      height: 2,
      changedPixels: 1,
      totalPixels: 4,
      ratio: 0.25,
      output: {
        name: "checkpoint-pixel-diff.png",
        mediaType: "image/png",
        metadata: {
          width: 2,
          height: 2,
          changedPixels: 1,
          totalPixels: 4,
          ratio: 0.25,
          threshold: 0.1,
        },
      },
    });
    expect([decoded.width, decoded.height]).toEqual([2, 2]);
    expect(createHash("sha256").update(firstBytes).digest("hex")).toBe(
      createHash("sha256").update(secondBytes).digest("hex"),
    );
  });

  test("rejects invalid PNG bytes and mismatched dimensions", async () => {
    const adapter = new PixelmatchPixelDiffAdapter();
    const onePixel = png(1, 1, [[0, 0, 0, 255]]);
    const twoPixels = png(2, 1, [
      [0, 0, 0, 255],
      [0, 0, 0, 255],
    ]);

    expect(adapter.diff(new Uint8Array([1, 2, 3]), onePixel)).rejects.toMatchObject({
      code: "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
    });
    expect(adapter.diff(onePixel, twoPixels)).rejects.toMatchObject({
      code: "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
    });
  });

  test("validates results returned through the injected execution seam", async () => {
    const input = png(1, 1, [[0, 0, 0, 255]]);
    let received: PixelDiffExecutionRequest | undefined;
    const executor: PixelDiffExecutor = {
      execute(request) {
        received = request;
        return Promise.resolve({
          width: 1,
          height: 1,
          changedPixels: 0,
          diffPng: input,
          workerPid: process.pid,
        });
      },
    };
    const adapter = new PixelmatchPixelDiffAdapter({ executor, threshold: 0.2 });
    const result = await adapter.diff(input, input);

    expect(received).toMatchObject({ threshold: 0.2 });
    expect(received?.beforePng).not.toBe(input);
    expect(result).toMatchObject({ changedPixels: 0, totalPixels: 1, ratio: 0 });

    const invalidExecutor: PixelDiffExecutor = { execute: () => Promise.resolve({ width: 1 }) };
    expect(
      new PixelmatchPixelDiffAdapter({ executor: invalidExecutor }).diff(input, input),
    ).rejects.toMatchObject({
      code: "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
    });
  });

  test("isolates malformed image decoding and remains usable afterward", async () => {
    const input = png(1, 1, [[0, 0, 0, 255]]);
    const executor = new SubprocessPixelDiffExecutor();

    expect(
      executor.execute({
        beforePng: new Uint8Array([1, 2, 3]),
        afterPng: input,
        threshold: 0.1,
      }),
    ).rejects.toMatchObject({
      code: "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
    });

    const recovered = await executor.execute({
      beforePng: input,
      afterPng: input,
      threshold: 0.1,
    });
    expect(recovered).toMatchObject({ width: 1, height: 1, changedPixels: 0 });
  });

  test("uses a fresh subprocess for every pixel comparison", async () => {
    const input = png(1, 1, [[0, 0, 0, 255]]);
    const executor = new SubprocessPixelDiffExecutor();
    const first = await executor.execute({ beforePng: input, afterPng: input, threshold: 0.1 });
    const second = await executor.execute({ beforePng: input, afterPng: input, threshold: 0.1 });

    expect(first.workerPid).toBeGreaterThan(0);
    expect(second.workerPid).toBeGreaterThan(0);
    expect(first.workerPid).not.toBe(second.workerPid);
  });
});
