import type {
  CaptureAdapterStart,
  CaptureFinishReason,
  CaptureOutput,
  CaptureOutputPathAllocator,
  VideoAdapter,
  VideoCaptureOptions,
} from "./types";
import { captureError, CaptureFinalizeError } from "./errors";

export interface ScreencastFrame {
  data: string;
  sessionId: number;
}

export interface CdpSessionAdapter {
  send: (method: string, parameters?: Record<string, unknown>) => Promise<unknown>;
  on: (event: "Page.screencastFrame", listener: (frame: ScreencastFrame) => void) => void;
  off: (event: "Page.screencastFrame", listener: (frame: ScreencastFrame) => void) => void;
  detach: () => Promise<void>;
}

export interface CdpSessionFactory {
  attach: (targetId: string) => Promise<CdpSessionAdapter>;
}

export interface EncoderProcess {
  write: (bytes: Uint8Array) => Promise<void>;
  closeInput: () => Promise<void>;
  exited: Promise<number>;
  errorText: () => Promise<string>;
  terminate: () => void;
}

export interface FfmpegProcessFactory {
  supported: (executable: string) => Promise<boolean>;
  start: (executable: string, outputPath: string, framesPerSecond: number) => EncoderProcess;
}

export interface CdpFfmpegVideoAdapterOptions {
  cdp: CdpSessionFactory;
  outputPaths: CaptureOutputPathAllocator;
  processes?: FfmpegProcessFactory;
  executable?: string;
  maximumQueuedFrames?: number;
}

interface VideoHandle {
  captureId: string;
  session: CdpSessionAdapter;
  encoder: EncoderProcess;
  outputPath: string;
  width: number;
  height: number;
  framesPerSecond: number;
  listener: (frame: ScreencastFrame) => void;
  frameQueue: Promise<void>;
  queuedFrames: number;
  frameError?: unknown;
  stopped: boolean;
}

const isVideoHandle = (value: unknown): value is VideoHandle =>
  typeof value === "object" &&
  value !== null &&
  "captureId" in value &&
  "session" in value &&
  "encoder" in value;

const bunProcesses: FfmpegProcessFactory = {
  async supported(executable) {
    try {
      const process = Bun.spawn([executable, "-version"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      });
      return (await process.exited) === 0;
    } catch {
      return false;
    }
  },
  start(executable, outputPath, framesPerSecond) {
    const process = Bun.spawn({
      cmd: [
        executable,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-framerate",
        String(framesPerSecond),
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "webm",
        outputPath,
      ],
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
    });
    return {
      async write(bytes) {
        process.stdin.write(bytes);
        await process.stdin.flush();
      },
      async closeInput() {
        process.stdin.end();
      },
      exited: process.exited,
      async errorText() {
        return new Response(process.stderr).text();
      },
      terminate() {
        process.kill();
      },
    };
  },
};

export class CdpFfmpegVideoAdapter implements VideoAdapter {
  private readonly cdp: CdpSessionFactory;
  private readonly outputPaths: CaptureOutputPathAllocator;
  private readonly processes: FfmpegProcessFactory;
  private readonly executable: string;
  private readonly maximumQueuedFrames: number;
  private supportResult?: Promise<boolean>;

  constructor(options: CdpFfmpegVideoAdapterOptions) {
    this.cdp = options.cdp;
    this.outputPaths = options.outputPaths;
    this.processes = options.processes ?? bunProcesses;
    this.executable = options.executable ?? "ffmpeg";
    this.maximumQueuedFrames = options.maximumQueuedFrames ?? 2;
    if (!Number.isInteger(this.maximumQueuedFrames) || this.maximumQueuedFrames < 1) {
      throw new Error("maximumQueuedFrames must be a positive integer.");
    }
  }

  supported() {
    this.supportResult ??= this.processes.supported(this.executable);
    return this.supportResult;
  }

  async start(
    input: CaptureAdapterStart & { options: Required<Omit<VideoCaptureOptions, "type">> },
  ): Promise<VideoHandle> {
    if (input.signal.aborted) throw input.signal.reason;
    const outputPath = await this.outputPaths.allocate(input.captureId, `${input.captureId}.webm`);
    let session: CdpSessionAdapter;
    try {
      session = await this.cdp.attach(input.scope.targetId);
    } catch (error) {
      await this.outputPaths.discard?.(outputPath).catch(() => undefined);
      throw captureError(
        "CHROME_MCP_UNSUPPORTED_CAPTURE",
        "Could not attach a CDP screencast session to the selected target.",
        error,
      );
    }
    let encoder: EncoderProcess;
    try {
      encoder = this.processes.start(this.executable, outputPath, input.options.framesPerSecond);
    } catch (error) {
      await session.detach().catch(() => undefined);
      await this.outputPaths.discard?.(outputPath).catch(() => undefined);
      throw captureError(
        "CHROME_MCP_UNSUPPORTED_CAPTURE",
        "Could not start the local ffmpeg encoder.",
        error,
      );
    }
    const handle: VideoHandle = {
      captureId: input.captureId,
      session,
      encoder,
      outputPath,
      width: input.options.width,
      height: input.options.height,
      framesPerSecond: input.options.framesPerSecond,
      listener: () => undefined,
      frameQueue: Promise.resolve(),
      queuedFrames: 0,
      stopped: false,
    };
    handle.listener = (frame) => {
      if (handle.stopped) return;
      if (handle.queuedFrames >= this.maximumQueuedFrames) {
        session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch((error: unknown) => {
          handle.frameError ??= error;
        });
        return;
      }
      handle.queuedFrames += 1;
      handle.frameQueue = handle.frameQueue
        .then(async () => {
          await encoder.write(Buffer.from(frame.data, "base64"));
          await session.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
        })
        .catch((error: unknown) => {
          handle.frameError ??= error;
        })
        .finally(() => {
          handle.queuedFrames -= 1;
        });
    };

    session.on("Page.screencastFrame", handle.listener);
    try {
      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        maxWidth: input.options.width,
        maxHeight: input.options.height,
        everyNthFrame: 1,
      });
      return handle;
    } catch (error) {
      handle.stopped = true;
      session.off("Page.screencastFrame", handle.listener);
      encoder.terminate();
      await encoder.exited.catch(() => undefined);
      await session.detach().catch(() => undefined);
      await this.outputPaths.discard?.(outputPath).catch(() => undefined);
      throw captureError(
        "CHROME_MCP_UNSUPPORTED_CAPTURE",
        "The selected Chrome target does not support CDP screencast video.",
        error,
      );
    }
  }

  async finish(
    handleValue: unknown,
    input: { reason: CaptureFinishReason; signal: AbortSignal },
  ): Promise<CaptureOutput> {
    if (!isVideoHandle(handleValue)) throw new Error("Invalid CDP screencast handle.");
    const handle = handleValue;
    handle.stopped = true;
    handle.session.off("Page.screencastFrame", handle.listener);
    const abort = () => handle.encoder.terminate();
    const listeningForAbort = !input.signal.aborted;
    if (listeningForAbort) input.signal.addEventListener("abort", abort, { once: true });
    else abort();
    let failure: unknown;
    try {
      await handle.session.send("Page.stopScreencast").catch((error: unknown) => {
        failure ??= error;
      });
      await handle.frameQueue;
      if (handle.frameError) failure ??= handle.frameError;
      await handle.encoder.closeInput();
      const exitCode = await handle.encoder.exited;
      if (exitCode !== 0) {
        const encoderError = await handle.encoder.errorText();
        const errorText = encoderError.trim();
        failure ??= new Error(errorText || `ffmpeg exited with code ${exitCode}.`);
      }
    } catch (error) {
      failure ??= error;
    } finally {
      if (listeningForAbort) input.signal.removeEventListener("abort", abort);
      await handle.session.detach().catch((error: unknown) => {
        failure ??= error;
      });
    }

    const output: CaptureOutput = {
      name: `${handle.captureId}.webm`,
      mediaType: "video/webm",
      source: { kind: "path", path: handle.outputPath },
      metadata: {
        encoder: "ffmpeg",
        finishReason: input.reason,
        width: handle.width,
        height: handle.height,
        framesPerSecond: handle.framesPerSecond,
      },
    };
    if (failure) {
      throw new CaptureFinalizeError("CDP screencast video finalization failed.", {
        cause: failure,
        partialOutput: output,
      });
    }
    return output;
  }
}
