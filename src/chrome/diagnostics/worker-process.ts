import { ISOLATED_BUN_CONFIG_ARGUMENT } from "../../platform/bun-child";

const MAX_STDERR_BYTES = 1 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1000;

type DiagnosticWorkerProcessOptions = {
  maximumStdoutBytes: number;
  request: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
  workerName: string;
  workerPath: string;
};

type WorkerProcessCompletion = {
  exitCode: number;
  state: "completed";
  stdout: string;
};

type WorkerProcessTimeout = {
  state: "timeout";
};

type WorkerProcessCancellation = { state: "cancelled"; reason: unknown };

export class DiagnosticWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosticWorkerError";
  }
}

const readBoundedText = async (
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  streamName: string,
) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let output = "";

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;

      byteCount += chunk.value.byteLength;
      if (byteCount > maximumBytes) throw new DiagnosticWorkerError(`${streamName} exceeded its size limit`);

      output += decoder.decode(chunk.value, { stream: true });
    }

    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};

export const runDiagnosticWorkerProcess = async (options: DiagnosticWorkerProcessOptions) => {
  const { maximumStdoutBytes, request, signal, timeoutMs, workerName, workerPath } = options;
  const capitalizedWorkerName = `${workerName.charAt(0).toUpperCase()}${workerName.slice(1)}`;
  signal?.throwIfAborted();
  const child = Bun.spawn([process.execPath, ISOLATED_BUN_CONFIG_ARGUMENT, workerPath], {
    env: process.env,
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
    windowsHide: true,
  });
  const stdoutPromise = readBoundedText(
    child.stdout,
    maximumStdoutBytes,
    `${capitalizedWorkerName} worker stdout`,
  );
  const stderrPromise = readBoundedText(
    child.stderr,
    MAX_STDERR_BYTES,
    `${capitalizedWorkerName} worker stderr`,
  );

  const terminateChild = async () => {
    if (child.exitCode !== null) return;

    child.kill("SIGTERM");
    let graceHandle: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      child.exited,
      new Promise<void>((resolve) => {
        graceHandle = setTimeout(resolve, TERMINATION_GRACE_MS);
      }),
    ]);

    if (graceHandle !== undefined) {
      clearTimeout(graceHandle);
    }

    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }

    await child.exited;
  };

  try {
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  } catch (error) {
    await terminateChild();
    await Promise.allSettled([child.exited, stdoutPromise, stderrPromise]);
    throw error;
  }

  const completion: Promise<WorkerProcessCompletion> = Promise.all([
    child.exited,
    stdoutPromise,
    stderrPromise,
  ]).then(([exitCode, stdout]) => ({ exitCode, state: "completed", stdout }));
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<WorkerProcessTimeout>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ state: "timeout" }), timeoutMs);
  });
  const cancellation = Promise.withResolvers<WorkerProcessCancellation>();
  const onAbort = () => cancellation.resolve({ state: "cancelled", reason: signal?.reason });
  signal?.addEventListener("abort", onAbort, { once: true });

  if (signal?.aborted) {
    onAbort();
  }

  let outcome: WorkerProcessCancellation | WorkerProcessCompletion | WorkerProcessTimeout;

  try {
    outcome = await Promise.race([completion, timeout, cancellation.promise]);
  } catch (error) {
    await terminateChild();
    throw error;
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }

    signal?.removeEventListener("abort", onAbort);
  }

  if (outcome.state === "cancelled") {
    await terminateChild();
    await Promise.allSettled([child.exited, stdoutPromise, stderrPromise]);
    throw outcome.reason;
  }

  if (outcome.state === "timeout") {
    await terminateChild();
    await completion.catch(() => undefined);
    throw new DiagnosticWorkerError(`The ${workerName} worker timed out`);
  }

  if (outcome.exitCode !== 0) {
    throw new DiagnosticWorkerError(`The ${workerName} worker exited with code ${outcome.exitCode}`);
  }

  try {
    const decoded: unknown = JSON.parse(outcome.stdout);

    return decoded;
  } catch {
    throw new DiagnosticWorkerError(`The ${workerName} worker returned invalid JSON`);
  }
};
