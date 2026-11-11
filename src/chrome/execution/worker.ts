import { installBunClientResponseUrlNormalization } from "./bun-http-compat";
import { serializeExecutionError } from "./errors";
import { executeWorkerRequest } from "./evaluator";
import {
  type ExecutionKernelResult,
  type ExecutionWorkerRequest,
  parseBrokerToWorkerMessage,
  type WorkerToBrokerMessage,
} from "./protocol";
import { createExecutionRpcClient, type ExecutionRpcClient } from "./rpc-client";

const send = (message: WorkerToBrokerMessage): void => {
  if (typeof process.send !== "function") throw new Error("Execution worker IPC channel is unavailable");
  process.send(message);
};

let activeRequest: ExecutionWorkerRequest | undefined;
let rpc: ExecutionRpcClient | undefined;
let completed = false;
let pendingResultAcknowledgment: { callId: string; resolve: () => void } | undefined;

const finish = (): void => {
  if (completed) return;
  completed = true;
  if (process.connected && typeof process.disconnect === "function") process.disconnect();
};

const sendExecutionResult = async (callId: string, result: ExecutionKernelResult): Promise<void> => {
  if (pendingResultAcknowledgment) {
    throw new Error("Execution worker already has a pending result acknowledgment");
  }
  const acknowledged = new Promise<void>((resolve) => {
    pendingResultAcknowledgment = { callId, resolve };
  });
  try {
    send({ callId, result, type: "execution_result" });
  } catch (error: unknown) {
    pendingResultAcknowledgment = undefined;
    throw error;
  }
  await acknowledged;
};

const failWorker = async (error: unknown): Promise<void> => {
  if (completed) return;
  process.exitCode = 1;
  try {
    if (activeRequest && rpc) {
      const request = activeRequest;
      await sendExecutionResult(request.callId, {
        artifacts: rpc.artifacts(),
        error: serializeExecutionError(error, "CHROME_MCP_WORKER_CRASH", [request.cdpEndpoint]),
        ok: false,
        selectedTargetId: request.selectedTargetId,
      });
    }
  } finally {
    finish();
  }
};

const handleMessage = async (value: unknown): Promise<void> => {
  const message = parseBrokerToWorkerMessage(value);
  if (message.type === "execution_result_ack") {
    if (
      !activeRequest ||
      message.callId !== activeRequest.callId ||
      message.callId !== pendingResultAcknowledgment?.callId
    ) {
      throw new Error("Execution worker received an acknowledgment for another result");
    }
    const acknowledgment = pendingResultAcknowledgment;
    pendingResultAcknowledgment = undefined;
    acknowledgment.resolve();
    return;
  }
  if (message.type === "rpc_response") {
    if (!activeRequest || !rpc || message.callId !== activeRequest.callId) {
      throw new Error("Execution worker received an RPC response for another call");
    }
    rpc.handleResponse(message.rpcId, message.response);
    return;
  }
  if (activeRequest) throw new Error("Execution worker accepts exactly one execute request");

  activeRequest = message.request;
  rpc = createExecutionRpcClient(message.request.callId, send);
  const result = await executeWorkerRequest(message.request, { rpc });
  await sendExecutionResult(message.request.callId, result);
  finish();
};

installBunClientResponseUrlNormalization();

const failWorkerQuietly = (error: unknown): void => {
  failWorker(error).catch(() => {
    process.exitCode = 1;
    finish();
  });
};

process.on("message", (message: unknown) => {
  handleMessage(message).catch(failWorkerQuietly);
});
process.on("unhandledRejection", failWorkerQuietly);
process.on("uncaughtException", failWorkerQuietly);

send({ type: "ready" });
