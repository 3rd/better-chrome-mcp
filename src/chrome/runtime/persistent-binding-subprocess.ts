import { fileURLToPath } from "node:url";
import { ISOLATED_BUN_CONFIG_ARGUMENT } from "../../platform/bun-child";
import { windowsSystemEnvironment } from "../../platform/windows/environment";
import { ChromeRuntimeError } from "./errors";
import {
  parsePersistentBindingWorkerRequest,
  parsePersistentBindingWorkerResponse,
  PERSISTENT_BINDING_WORKER_INPUT_MAX_BYTES,
  PERSISTENT_BINDING_WORKER_OUTPUT_MAX_BYTES,
  PERSISTENT_BINDING_WORKER_STDERR_MAX_BYTES,
  PERSISTENT_BINDING_WORKER_TIMEOUT_MS,
  type PersistentBindingJson,
  type PersistentBindingWorkerRequest,
} from "./persistent-binding-protocol";

export type PersistentBindingSubprocessOptions = Readonly<{
  timeoutMs?: number;
  workerPath?: string;
}>;

type CompletedBindingProcess = Readonly<{
  exitCode: number;
  state: "completed";
  stderr: string;
  stdout: string;
}>;

type TimedOutBindingProcess = Readonly<{ state: "timeout" }>;

const workerPath = (): string => fileURLToPath(new URL("./persistent-binding-worker.ts", import.meta.url));

const mutationFailure = (message: string, cause?: unknown): ChromeRuntimeError =>
  new ChromeRuntimeError("CHROME_MCP_MUTATION_FAILED", message, cause === undefined ? undefined : { cause });

const readBoundedStream = async (
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  label: string,
): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) throw mutationFailure(`${label} exceeded ${maximumBytes} bytes`);
      output += decoder.decode(chunk.value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};

const stopAndReap = async (
  child: ReturnType<typeof Bun.spawn>,
  streams: readonly Promise<unknown>[],
): Promise<void> => {
  if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.allSettled([child.exited, ...streams]);
};

const runPersistentBindingWorker = async (
  requestValue: PersistentBindingWorkerRequest,
  options: PersistentBindingSubprocessOptions = {},
) => {
  const request = parsePersistentBindingWorkerRequest(requestValue);
  const encodedRequest = JSON.stringify(request);
  if (Buffer.byteLength(encodedRequest, "utf8") > PERSISTENT_BINDING_WORKER_INPUT_MAX_BYTES) {
    throw mutationFailure(
      `Persistent binding worker input exceeds ${PERSISTENT_BINDING_WORKER_INPUT_MAX_BYTES} bytes`,
    );
  }

  const child = Bun.spawn({
    cmd: [process.execPath, ISOLATED_BUN_CONFIG_ARGUMENT, options.workerPath ?? workerPath()],
    env: windowsSystemEnvironment(),
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
    windowsHide: true,
  });
  const stdoutPromise = readBoundedStream(
    child.stdout,
    PERSISTENT_BINDING_WORKER_OUTPUT_MAX_BYTES,
    "Persistent binding worker stdout",
  );
  const stderrPromise = readBoundedStream(
    child.stderr,
    PERSISTENT_BINDING_WORKER_STDERR_MAX_BYTES,
    "Persistent binding worker stderr",
  );
  try {
    child.stdin.write(encodedRequest);
    child.stdin.end();
  } catch (error: unknown) {
    await stopAndReap(child, [stdoutPromise, stderrPromise]);
    throw mutationFailure("Could not send input to the persistent binding worker", error);
  }

  const completion: Promise<CompletedBindingProcess> = Promise.all([
    child.exited,
    stdoutPromise,
    stderrPromise,
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, state: "completed", stderr, stdout }));
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedOutBindingProcess>((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve({ state: "timeout" }),
      options.timeoutMs ?? PERSISTENT_BINDING_WORKER_TIMEOUT_MS,
    );
  });

  let outcome: CompletedBindingProcess | TimedOutBindingProcess;
  try {
    outcome = await Promise.race([completion, timeout]);
  } catch (error: unknown) {
    await stopAndReap(child, [completion]);
    if (error instanceof ChromeRuntimeError) throw error;
    throw mutationFailure("Persistent binding worker failed while reading its output", error);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }

  if (outcome.state === "timeout") {
    await stopAndReap(child, [completion]);
    throw mutationFailure(
      `Persistent binding worker timed out after ${options.timeoutMs ?? PERSISTENT_BINDING_WORKER_TIMEOUT_MS} ms`,
    );
  }
  if (outcome.exitCode !== 0) {
    const errorDetails = outcome.stderr ? `: ${outcome.stderr.trim()}` : "";
    throw mutationFailure(`Persistent binding worker exited with code ${outcome.exitCode}${errorDetails}`);
  }

  let response;
  try {
    response = parsePersistentBindingWorkerResponse(JSON.parse(outcome.stdout));
  } catch (error: unknown) {
    throw mutationFailure("Persistent binding worker returned malformed JSON", error);
  }
  if (!response.ok) {
    if (response.error.code === "BINDING_RESULT_LIMIT") {
      throw new ChromeRuntimeError("CHROME_MCP_MUTATION_LIMIT", response.error.message);
    }
    throw mutationFailure(response.error.message);
  }
  return response.value;
};

export const validatePersistentBindingSubprocess = async (
  source: string,
  options: PersistentBindingSubprocessOptions = {},
): Promise<void> => {
  await runPersistentBindingWorker({ operation: "validate", source }, options);
};

export const runPersistentBindingSubprocess = (
  request: Readonly<{ args: PersistentBindingJson[]; source: string }>,
  options: PersistentBindingSubprocessOptions = {},
) => runPersistentBindingWorker({ args: request.args, operation: "invoke", source: request.source }, options);
