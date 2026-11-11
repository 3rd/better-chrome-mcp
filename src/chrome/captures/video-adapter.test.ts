import { describe, expect, test } from "bun:test";
import type { CaptureAdapterStart, CaptureOutputPathAllocator, VideoCaptureOptions } from "./types";
import type {
  CdpSessionAdapter,
  EncoderProcess,
  FfmpegProcessFactory,
  ScreencastFrame,
} from "./video-adapter";
import { CaptureFinalizeError } from "./errors";
import { CdpFfmpegVideoAdapter } from "./video-adapter";

class Session implements CdpSessionAdapter {
  readonly sends: { method: string; parameters?: Record<string, unknown> }[] = [];
  listener?: (frame: ScreencastFrame) => void;
  detached = false;
  failStart = false;

  async send(method: string, parameters?: Record<string, unknown>) {
    this.sends.push({ method, parameters });
    if (method === "Page.startScreencast" && this.failStart) throw new Error("cannot start");
    return {};
  }
  on(_event: "Page.screencastFrame", listener: (frame: ScreencastFrame) => void) {
    this.listener = listener;
  }
  off(_event: "Page.screencastFrame", listener: (frame: ScreencastFrame) => void) {
    if (this.listener === listener) this.listener = undefined;
  }
  async detach() {
    this.detached = true;
  }
  frame(frame: ScreencastFrame) {
    this.listener?.(frame);
  }
}

class Encoder implements EncoderProcess {
  readonly writes: Uint8Array[] = [];
  closed = false;
  terminated = false;
  exitCode = 0;

  async write(bytes: Uint8Array) {
    this.writes.push(bytes);
  }
  async closeInput() {
    this.closed = true;
  }
  get exited() {
    return Promise.resolve(this.exitCode);
  }
  async errorText() {
    return this.exitCode === 0 ? "" : "encoder failed";
  }
  terminate() {
    this.terminated = true;
  }
}

const input: CaptureAdapterStart & { options: Required<Omit<VideoCaptureOptions, "type">> } = {
  captureId: "capture-1",
  signal: new AbortController().signal,
  scope: {
    connectionId: "connection-1",
    browserMode: "shared",
    browserGeneration: 1,
    contextId: "context-1",
    targetId: "target-1",
    viewport: { width: 800, height: 600 },
  },
  options: { format: "webm", width: 800, height: 600, framesPerSecond: 15 },
};

describe("CdpFfmpegVideoAdapter", () => {
  test("streams frames, acknowledges them, and finalizes WebM output", async () => {
    const session = new Session();
    const encoder = new Encoder();
    let probes = 0;
    const processes: FfmpegProcessFactory = {
      async supported() {
        probes += 1;
        return true;
      },
      start() {
        return encoder;
      },
    };
    const adapter = new CdpFfmpegVideoAdapter({
      cdp: { attach: async () => session },
      outputPaths: { allocate: async () => "/tmp/capture-1.webm" },
      processes,
    });

    expect(await adapter.supported()).toBe(true);
    expect(await adapter.supported()).toBe(true);
    expect(probes).toBe(1);
    const handle = await adapter.start(input);
    session.frame({ data: Buffer.from([1, 2, 3]).toString("base64"), sessionId: 7 });
    await new Promise<void>(queueMicrotask);
    const output = await adapter.finish(handle, { reason: "manual", signal: new AbortController().signal });

    expect(encoder.writes).toEqual([new Uint8Array([1, 2, 3])]);
    expect(encoder.closed).toBe(true);
    expect(session.detached).toBe(true);
    expect(session.sends.map((entry) => entry.method)).toEqual([
      "Page.startScreencast",
      "Page.screencastFrameAck",
      "Page.stopScreencast",
    ]);
    expect(output).toMatchObject({
      name: "capture-1.webm",
      mediaType: "video/webm",
      source: { kind: "path", path: "/tmp/capture-1.webm" },
    });
  });

  test("publishes a partial path when ffmpeg fails and cleans failed starts", async () => {
    const failedSession = new Session();
    const encoder = new Encoder();
    encoder.exitCode = 1;
    const discarded: string[] = [];
    const outputPaths: CaptureOutputPathAllocator = {
      allocate: async () => "/tmp/capture-1.webm",
      async discard(path) {
        discarded.push(path);
      },
    };
    const processes: FfmpegProcessFactory = {
      supported: async () => true,
      start: () => encoder,
    };
    const adapter = new CdpFfmpegVideoAdapter({
      cdp: { attach: async () => failedSession },
      outputPaths,
      processes,
    });
    const handle = await adapter.start(input);
    const failure = adapter.finish(handle, { reason: "browser-death", signal: new AbortController().signal });
    expect(failure).rejects.toBeInstanceOf(CaptureFinalizeError);
    expect(failure).rejects.toHaveProperty("partialOutput.source", {
      kind: "path",
      path: "/tmp/capture-1.webm",
    });

    const startFailureSession = new Session();
    startFailureSession.failStart = true;
    const startFailure = new CdpFfmpegVideoAdapter({
      cdp: { attach: async () => startFailureSession },
      outputPaths,
      processes,
    });
    expect(startFailure.start(input)).rejects.toMatchObject({ code: "CHROME_MCP_UNSUPPORTED_CAPTURE" });
    expect(encoder.terminated).toBe(true);
    expect(discarded).toEqual(["/tmp/capture-1.webm"]);
  });
});
