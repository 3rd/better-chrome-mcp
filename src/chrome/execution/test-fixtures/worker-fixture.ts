import {
  type ArtifactDescriptor,
  type BrokerRpcResponse,
  type ExecutionKernelResult,
  type ExecutionKernelSuccess,
  type ExecutionWorkerRequest,
  INLINE_IMAGE_MAX_BYTES,
  parseBrokerToWorkerMessage,
  type WorkerToBrokerMessage,
} from "../protocol";

const send = (message: Record<string, unknown> | WorkerToBrokerMessage): void => {
  if (typeof process.send !== "function") throw new Error("Fixture IPC unavailable");
  process.send(message);
};

const finish = (): void => {
  if (process.connected && typeof process.disconnect === "function") process.disconnect();
};

let pendingResultAcknowledgment: { callId: string; resolve: () => void } | undefined;

const sendExecutionResult = async (callId: string, result: ExecutionKernelResult): Promise<void> => {
  if (pendingResultAcknowledgment) throw new Error("Fixture already has a pending result acknowledgment");
  const acknowledged = new Promise<void>((resolvePromise) => {
    pendingResultAcknowledgment = { callId, resolve: resolvePromise };
  });
  send({ callId, result, type: "execution_result" });
  await acknowledged;
};

const success = (
  request: ExecutionWorkerRequest,
  value: ExecutionKernelSuccess["value"],
): ExecutionKernelSuccess => ({
  artifacts: [],
  content: [],
  emittedCount: 0,
  ok: true,
  selectedTargetId: request.selectedTargetId,
  state: request.state,
  ...(value === undefined ? {} : { value }),
});

const forgedArtifact: ArtifactDescriptor = {
  artifactId: "forged-artifact",
  complete: true,
  createdAt: "2026-08-15T00:00:00.000Z",
  expiresAt: null,
  mediaType: "text/plain",
  name: "forged.txt",
  sha256: "a".repeat(64),
  size: 6,
  uri: "chrome-artifact://connection/forged-artifact/content",
};

let request: ExecutionWorkerRequest | undefined;

const handleMessage = async (value: unknown): Promise<void> => {
  const message = parseBrokerToWorkerMessage(value);
  if (message.type === "execution_result_ack") {
    if (
      !request ||
      message.callId !== request.callId ||
      message.callId !== pendingResultAcknowledgment?.callId
    ) {
      throw new Error("Fixture received an acknowledgment for another result");
    }
    const acknowledgment = pendingResultAcknowledgment;
    pendingResultAcknowledgment = undefined;
    acknowledgment.resolve();
    return;
  }
  if (message.type === "rpc_response") {
    if (!request) throw new Error("Fixture received RPC response before execute");
    const response: BrokerRpcResponse = message.response;
    await sendExecutionResult(
      request.callId,
      response.ok ?
        success(request, response.value)
      : {
          artifacts: [],
          error: response.error,
          ok: false,
          selectedTargetId: request.selectedTargetId,
        },
    );
    finish();
    return;
  }

  request = message.request;
  if (request.code === "hang") return;
  if (request.code === "crash") process.exit(7);
  if (request.code === "forged-artifact") {
    await sendExecutionResult(request.callId, { ...success(request, "forged"), artifacts: [forgedArtifact] });
    finish();
    return;
  }
  if (request.code === "rpc" || request.code === "rpc-pending-result") {
    send({
      callId: request.callId,
      request: { operation: "events_mark", payload: {} },
      rpcId: "fixture-rpc",
      type: "rpc_request",
    });
    if (request.code === "rpc") return;
  }
  if (request.code === "log") console.log("fixture output");
  const result = success(request, request.code === "large-result" ? "large-result" : { pid: process.pid });
  if (request.code === "large-result") {
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(INLINE_IMAGE_MAX_BYTES - 8),
    ]).toString("base64");
    result.content = [{ data: png, mediaType: "image/png", type: "image" }];
    result.emittedCount = 1;
  }
  await sendExecutionResult(request.callId, result);
  if (request.code === "large-result") console.log("large result acknowledged");
  finish();
  if (request.code === "result-with-live-handle") setInterval(() => undefined, 1000);
};

process.on("message", (value: unknown) => {
  handleMessage(value).catch(() => {
    process.exitCode = 1;
    finish();
  });
});

send({ type: "ready" });
