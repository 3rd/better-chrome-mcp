import { errorFromSerialized } from "./errors";
import {
  type ArtifactDescriptor,
  type BrokerRpcRequest,
  type BrokerRpcResponse,
  type BrokerRpcSuccess,
  parseBrokerRpcRequest,
  type WorkerToBrokerMessage,
} from "./protocol";

export type WorkerMessageSender = (message: WorkerToBrokerMessage) => void;

type PendingRpc = {
  reject: (error: Error) => void;
  resolve: (response: BrokerRpcSuccess) => void;
};

export interface ExecutionRpcClient {
  artifacts: () => ArtifactDescriptor[];
  cancelPending: () => void;
  handleResponse: (rpcId: string, response: BrokerRpcResponse) => void;
  request: (request: BrokerRpcRequest) => Promise<BrokerRpcSuccess>;
}

export const createExecutionRpcClient = (callId: string, send: WorkerMessageSender): ExecutionRpcClient => {
  let nextRpcId = 1;
  const pending = new Map<string, PendingRpc>();
  const artifacts = new Map<string, ArtifactDescriptor>();

  return Object.freeze({
    artifacts: () => [...artifacts.values()],
    cancelPending: (): void => {
      const rpcIds = [...pending.keys()];
      if (rpcIds.length === 0) return;
      send({
        callId,
        rpcIds,
        type: "rpc_cancel",
      });
      for (const request of pending.values()) request.resolve({ artifacts: [], ok: true, value: null });
      pending.clear();
    },
    handleResponse: (rpcId: string, response: BrokerRpcResponse) => {
      const request = pending.get(rpcId);
      if (!request) return;
      pending.delete(rpcId);
      if (!response.ok) {
        request.reject(errorFromSerialized(response.error));
        return;
      }
      for (const artifact of response.artifacts) artifacts.set(artifact.artifactId, artifact);
      request.resolve(response);
    },
    request: (input: BrokerRpcRequest) => {
      const request = parseBrokerRpcRequest(input);
      const rpcId = `r${nextRpcId}`;
      nextRpcId += 1;
      const promise = new Promise<BrokerRpcSuccess>((resolve, reject) => {
        pending.set(rpcId, { reject, resolve });
        try {
          send({
            callId,
            request,
            rpcId,
            type: "rpc_request",
          });
        } catch (error: unknown) {
          pending.delete(rpcId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      promise.catch(() => undefined);
      return promise;
    },
  });
};
