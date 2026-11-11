import { resolve } from "node:path";
import { ISOLATED_BUN_CONFIG_ARGUMENT } from "../../platform/bun-child";
import { windowsSystemEnvironment } from "../../platform/windows/environment";
import { isSupportedBunVersion, MINIMUM_BUN_VERSION_TEXT, parseBunVersion } from "../bun-version";
import { ChromeMcpExecutionError, serializeExecutionError } from "./errors";
import { copyJsonValue, type JsonValue } from "./json";
import {
  type ArtifactDescriptor,
  artifactDescriptorsEqual,
  assertExecutionArtifactProvenance,
  type BrokerRpcRequest,
  type BrokerRpcSuccess,
  type BrokerToWorkerMessage,
  type ExecutionKernelFailure,
  type ExecutionKernelResult,
  type ExecutionWorkerRequest,
  MAX_EXECUTION_TIMEOUT_MS,
  MIN_EXECUTION_TIMEOUT_MS,
  parseBrokerRpcSuccess,
  parseWorkerToBrokerMessage,
} from "./protocol";

const DEBUG_LOG_MAX_BYTES = 64 * 1024;
const RESULT_EXIT_GRACE_MS = 100;
const PASSTHROUGH_ENVIRONMENT_KEYS = [
  "DYLD_LIBRARY_PATH",
  "HOME",
  "LD_LIBRARY_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_PATH",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
] as const;

export type BrokerRpcExecutionContext = {
  callId: string;
  rpcId: string;
  signal: AbortSignal;
};

export interface ExecutionBrokerRpcAdapter {
  execute: (
    request: BrokerRpcRequest,
    context: BrokerRpcExecutionContext,
  ) => Promise<{ artifacts?: ArtifactDescriptor[]; value: JsonValue }>;
}

export type ExecutionDebugLog = (entry: { stderr: string; stdout: string }) => void;

export type RunExecutionWorkerOptions = {
  adapter: ExecutionBrokerRpcAdapter;
  bunExecutable?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  onDebugLog?: ExecutionDebugLog;
  request: ExecutionWorkerRequest;
  signal?: AbortSignal;
  timeoutMs: number;
  workerEntrypoint?: string;
};

const failure = (
  request: ExecutionWorkerRequest,
  code: ExecutionKernelFailure["error"]["code"],
  message: string,
): ExecutionKernelFailure => ({
  artifacts: [],
  error: { code, message, name: "ChromeMcpExecutionError" },
  ok: false,
  selectedTargetId: request.selectedTargetId,
});

export const assertSupportedBunVersion = (version = process.versions.bun): void => {
  const parsed = version ? parseBunVersion(version) : undefined;
  if (!parsed) {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_WORKER_CRASH",
      "The execution kernel requires the Bun runtime",
    );
  }
  if (!isSupportedBunVersion(version)) {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_WORKER_CRASH",
      `Bun ${MINIMUM_BUN_VERSION_TEXT} or newer is required; found ${version}`,
    );
  }
};

export const createWorkerEnvironment = (source: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const environment: Record<string, string> = { ...windowsSystemEnvironment(source), NO_COLOR: "1" };
  for (const key of PASSTHROUGH_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (typeof value === "string") environment[key] = value;
  }
  return environment;
};

const drainStream = async (stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> => {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    if (retainedBytes >= DEBUG_LOG_MAX_BYTES) continue;
    const remaining = DEBUG_LOG_MAX_BYTES - retainedBytes;
    const chunk = item.value.subarray(0, remaining);
    chunks.push(chunk);
    retainedBytes += chunk.byteLength;
  }
  return Buffer.concat(chunks).toString("utf8");
};

const normalizeRpcSuccess = (value: {
  artifacts?: ArtifactDescriptor[];
  value: JsonValue;
}): BrokerRpcSuccess => {
  return parseBrokerRpcSuccess({
    artifacts: value.artifacts ?? [],
    ok: true,
    value: copyJsonValue(value.value, "Broker RPC adapter value"),
  });
};

export const runExecutionWorker = (options: RunExecutionWorkerOptions): Promise<ExecutionKernelResult> => {
  try {
    assertSupportedBunVersion();
  } catch (error: unknown) {
    return Promise.resolve({
      artifacts: [],
      error: serializeExecutionError(error, "CHROME_MCP_WORKER_CRASH"),
      ok: false,
      selectedTargetId: options.request.selectedTargetId,
    });
  }
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < MIN_EXECUTION_TIMEOUT_MS ||
    options.timeoutMs > MAX_EXECUTION_TIMEOUT_MS
  ) {
    return Promise.resolve(
      failure(
        options.request,
        "CHROME_MCP_INVALID_INPUT",
        `Execution timeout must be an integer from ${MIN_EXECUTION_TIMEOUT_MS} through ${MAX_EXECUTION_TIMEOUT_MS}`,
      ),
    );
  }
  if (options.signal?.aborted) {
    return Promise.resolve(
      failure(options.request, "CHROME_MCP_CANCELLED", "Playwright execution was cancelled before start"),
    );
  }

  return new Promise<ExecutionKernelResult>((resolveResult) => {
    let completed = false;
    let ready = false;
    let receivedResult: ExecutionKernelResult | undefined;
    const pendingRpc = new Map<string, AbortController>();
    const brokerArtifacts = new Map<string, ArtifactDescriptor>();
    const workerEntrypoint = options.workerEntrypoint ?? resolve(import.meta.dir, "worker.ts");
    const stdoutMode = options.onDebugLog ? "pipe" : "ignore";
    const stderrMode = options.onDebugLog ? "pipe" : "ignore";
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let resultExitGrace: ReturnType<typeof setTimeout> | undefined;
    let stdoutPromise: Promise<string> = Promise.resolve("");
    let stderrPromise: Promise<string> = Promise.resolve("");

    const abortRpc = () => {
      for (const controller of pendingRpc.values()) controller.abort();
      pendingRpc.clear();
    };

    const publishDebugLog = async () => {
      if (!options.onDebugLog) return;
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      try {
        options.onDebugLog({ stderr, stdout });
      } catch {
        // Debug observers are outside the execution contract and cannot change its result.
      }
    };

    const removeCancellation = () => options.signal?.removeEventListener("abort", onCancellation);

    const complete = async (result: ExecutionKernelResult, terminate: boolean) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      if (resultExitGrace) clearTimeout(resultExitGrace);
      removeCancellation();
      abortRpc();
      if (terminate && child && child.exitCode === null) child.kill("SIGKILL");
      if (child) await child.exited;
      await publishDebugLog();
      resolveResult(result);
    };

    const failProtocol = (error: unknown) => {
      const serialized = serializeExecutionError(error, "CHROME_MCP_WORKER_CRASH", [
        options.request.cdpEndpoint,
      ]);
      complete(
        {
          artifacts: [],
          error: serialized,
          ok: false,
          selectedTargetId: options.request.selectedTargetId,
        },
        true,
      ).catch(() => undefined);
    };

    const sendToWorker = (message: BrokerToWorkerMessage): void => {
      if (!child) throw new Error("Execution worker process is unavailable");
      child.send(message);
    };

    const handleRpcRequest = async (
      message: Extract<ReturnType<typeof parseWorkerToBrokerMessage>, { type: "rpc_request" }>,
    ) => {
      const controller = new AbortController();
      pendingRpc.set(message.rpcId, controller);
      try {
        const value = await options.adapter.execute(message.request, {
          callId: message.callId,
          rpcId: message.rpcId,
          signal: controller.signal,
        });
        if (completed || receivedResult || controller.signal.aborted) return;
        const response = normalizeRpcSuccess(value);
        for (const artifact of response.artifacts) {
          const existing = brokerArtifacts.get(artifact.artifactId);
          if (existing && !artifactDescriptorsEqual(existing, artifact)) {
            throw new ChromeMcpExecutionError(
              "CHROME_MCP_INVALID_INPUT",
              `Broker returned conflicting descriptors for artifact ${artifact.artifactId}`,
            );
          }
          brokerArtifacts.set(artifact.artifactId, artifact);
        }
        sendToWorker({
          callId: message.callId,
          response,
          rpcId: message.rpcId,
          type: "rpc_response",
        });
      } catch (error: unknown) {
        if (completed || receivedResult || controller.signal.aborted) return;
        sendToWorker({
          callId: message.callId,
          response: {
            error: serializeExecutionError(error, "CHROME_MCP_INVALID_INPUT", [options.request.cdpEndpoint]),
            ok: false,
          },
          rpcId: message.rpcId,
          type: "rpc_response",
        });
      } finally {
        pendingRpc.delete(message.rpcId);
      }
    };

    const handleWorkerMessage = (value: unknown) => {
      let message: ReturnType<typeof parseWorkerToBrokerMessage>;
      try {
        message = parseWorkerToBrokerMessage(value);
      } catch (error: unknown) {
        failProtocol(error);
        return;
      }
      if (message.type === "ready") {
        if (ready) {
          failProtocol(new Error("Execution worker sent duplicate ready messages"));
          return;
        }
        ready = true;
        sendToWorker({
          request: options.request,
          type: "execute",
        });
        return;
      }
      if (message.callId !== options.request.callId) {
        failProtocol(new Error("Execution worker sent a message for another call"));
        return;
      }
      if (message.type === "rpc_request") {
        handleRpcRequest(message).catch(failProtocol);
        return;
      }
      if (message.type === "rpc_cancel") {
        for (const rpcId of message.rpcIds) pendingRpc.get(rpcId)?.abort();
        return;
      }
      if (receivedResult) {
        failProtocol(new Error("Execution worker sent duplicate results"));
        return;
      }
      try {
        assertExecutionArtifactProvenance(message.result, [...brokerArtifacts.values()]);
      } catch (error: unknown) {
        failProtocol(error);
        return;
      }
      receivedResult = message.result;
      abortRpc();
      try {
        sendToWorker({ callId: message.callId, type: "execution_result_ack" });
      } catch {
        complete(receivedResult, true).catch(() => undefined);
        return;
      }
      resultExitGrace = setTimeout(() => {
        if (!receivedResult) return;
        complete(receivedResult, true).catch(() => undefined);
      }, RESULT_EXIT_GRACE_MS);
    };

    const onCancellation = () => {
      complete(
        failure(
          options.request,
          "CHROME_MCP_CANCELLED",
          "Playwright execution was cancelled; browser-side effects may already have occurred",
        ),
        true,
      ).catch(() => undefined);
    };

    const timeout = setTimeout(() => {
      complete(
        failure(
          options.request,
          "CHROME_MCP_TIMEOUT",
          `Playwright execution exceeded ${options.timeoutMs} ms and its worker was terminated; browser-side effects may already have occurred`,
        ),
        true,
      ).catch(() => undefined);
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onCancellation, { once: true });

    try {
      child = Bun.spawn({
        cmd: [options.bunExecutable ?? process.execPath, ISOLATED_BUN_CONFIG_ARGUMENT, workerEntrypoint],
        cwd: options.cwd ?? process.cwd(),
        env: createWorkerEnvironment(options.environment),
        ipc: handleWorkerMessage,
        serialization: "json",
        stderr: stderrMode,
        stdin: "ignore",
        stdout: stdoutMode,
        windowsHide: true,
      });
      if (child.stdout instanceof ReadableStream) stdoutPromise = drainStream(child.stdout);
      if (child.stderr instanceof ReadableStream) stderrPromise = drainStream(child.stderr);
      child.exited
        .then((exitCode) => {
          if (completed) return;
          if (!receivedResult) {
            complete(
              failure(
                options.request,
                "CHROME_MCP_WORKER_CRASH",
                `Playwright execution worker exited with code ${exitCode} before returning a result`,
              ),
              false,
            ).catch(() => undefined);
            return;
          }
          if (exitCode !== 0 && receivedResult.ok) {
            complete(
              failure(
                options.request,
                "CHROME_MCP_WORKER_CRASH",
                `Playwright execution worker exited with code ${exitCode} after an incomplete success result`,
              ),
              false,
            ).catch(() => undefined);
            return;
          }
          complete(receivedResult, false).catch(() => undefined);
        })
        .catch(failProtocol);
    } catch (error: unknown) {
      complete(
        {
          artifacts: [],
          error: serializeExecutionError(error, "CHROME_MCP_WORKER_CRASH", [options.request.cdpEndpoint]),
          ok: false,
          selectedTargetId: options.request.selectedTargetId,
        },
        true,
      ).catch(() => undefined);
    }
  });
};
