import { randomUUID } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { z } from "zod/v4";
import type { BrowserMode, DownloadPublication } from "../runtime";
import type { BrokerBackend, BrokerBackendSelection, BrokerBackendSession } from "./backend";
import { isNodeError } from "../../platform/node-errors";
import { assertMatchingNativeDeviceScaleFactor, assertNativeDeviceScaleFactor } from "../runtime/modes";
import {
  BROKER_DISCONNECT_GRACE_MS,
  BROKER_INITIAL_IDLE_MS,
  BROKER_JSON_CHUNK_CHARACTERS,
  BROKER_MAX_JSON_CHUNKS,
  BROKER_PROTOCOL_VERSION,
  BROKER_REQUEST_TIMEOUT_MS,
} from "./constants";
import { brokerError, BrokerRpcError, brokerWireError } from "./errors";
import { type BrokerFrameDecoder, createBrokerFrameDecoder, encodeBrokerFrame } from "./framing";
import { type BrokerRuntimePaths, isBrokerSocketFile } from "./paths";
import { type BrokerNotification, brokerParams, type BrokerRequest, brokerRequestSchema } from "./protocol";
import { type BrokerWriteQueue, createBrokerWriteQueue } from "./write-queue";

type BrokerSocket = Readonly<{
  data: SocketState;
  end: () => void;
  terminate: () => void;
  write: (data: Uint8Array) => number;
}>;

type SessionState = Readonly<{
  id: string;
  session: BrokerBackendSession;
}>;

type AdmissionState = {
  completion: Promise<void>;
  controller: AbortController;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  finish: () => void;
  ownerCloseAuthorized: boolean;
  operationController: AbortController;
  operations: Set<Promise<void>>;
  requestId: string;
  sessionId: string;
  started: boolean;
  terminalError?: BrokerRpcError;
  token: string;
};

type TransactionState = Readonly<{
  admissionToken: string;
  selection: BrokerBackendSelection;
  sessionId: string;
}>;

type SubscriptionState = Readonly<{
  remove: () => void;
  sessionId: string;
}>;

type DownloadPublicationState = Readonly<{
  reject: (error: Error) => void;
  resolve: (publication: DownloadPublication) => void;
  timer: ReturnType<typeof setTimeout>;
}>;

type HandshakeState = Readonly<{
  connectionId: string;
}>;

type SocketState = {
  admissions: Map<string, AdmissionState>;
  canceledRequests: Set<string>;
  cleanupConnectionId?: string;
  cleanupPromise?: Promise<void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
  decoder: BrokerFrameDecoder;
  downloads: Map<string, DownloadPublicationState>;
  handshake?: HandshakeState;
  inFlightRequestIds: Set<string>;
  requestControllers: Map<string, AbortController>;
  sessions: Map<string, SessionState>;
  sessionsByMode: Map<BrowserMode, string>;
  subscriptions: Map<string, SubscriptionState>;
  transactions: Map<string, TransactionState>;
  writes: BrokerWriteQueue;
};

export type BrokerRpcServerOptions = Readonly<{
  backend: BrokerBackend;
  brokerId: string;
  disconnectGraceMs?: number;
  initialIdleMs?: number;
  onIdle?: () => void;
  paths: BrokerRuntimePaths;
  processStartIdentity: string;
}>;

export type BrokerRpcServer = Readonly<{
  shutdown: (reason: string) => Promise<void>;
}>;

const createSocketState = (socket: BrokerSocket): SocketState => ({
  admissions: new Map(),
  canceledRequests: new Set(),
  closed: false,
  decoder: createBrokerFrameDecoder(),
  downloads: new Map(),
  inFlightRequestIds: new Set(),
  requestControllers: new Map(),
  sessions: new Map(),
  sessionsByMode: new Map(),
  subscriptions: new Map(),
  transactions: new Map(),
  writes: createBrokerWriteQueue({ write: (data) => socket.write(data) }, () => socket.terminate()),
});

const abortReason = (code: string, message: string): BrokerRpcError => new BrokerRpcError(code, message);

const waitForRequest = <Result>(promise: Promise<Result>, signal: AbortSignal): Promise<Result> => {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted))
      .catch(() => undefined);
  });
};

const send = (socket: BrokerSocket, value: unknown): void => {
  if (socket.data.closed) return;
  if (socket.data.writes.send(encodeBrokerFrame(value))) return;
  socket.data.closed = true;
};

const success = (request: BrokerRequest, result: unknown) => ({
  id: request.id,
  kind: "response" as const,
  ok: true as const,
  result: result === undefined ? null : result,
});

const failure = (request: BrokerRequest, error: unknown) => ({
  error: brokerWireError(brokerError(error)),
  id: request.id,
  kind: "response" as const,
  ok: false as const,
});

const sendSuccess = (socket: BrokerSocket, request: BrokerRequest, result: unknown): void => {
  const response = success(request, result);
  try {
    send(socket, response);
    return;
  } catch (error: unknown) {
    const normalized = brokerError(error);
    if (normalized.code !== "CHROME_MCP_BROKER_INVALID_REQUEST") throw error;
  }
  const serialized = JSON.stringify(response.result);
  const chunkCount = Math.ceil(serialized.length / BROKER_JSON_CHUNK_CHARACTERS);
  if (chunkCount > BROKER_MAX_JSON_CHUNKS) {
    throw new BrokerRpcError(
      "CHROME_MCP_BROKER_INVALID_REQUEST",
      `Chrome broker response requires ${chunkCount} chunks; maximum is ${BROKER_MAX_JSON_CHUNKS}`,
    );
  }
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    send(socket, {
      chunk: serialized.slice(
        chunkIndex * BROKER_JSON_CHUNK_CHARACTERS,
        (chunkIndex + 1) * BROKER_JSON_CHUNK_CHARACTERS,
      ),
      chunkCount,
      chunkIndex,
      id: request.id,
      kind: "response.chunk",
    });
  }
};

const requireHandshake = (state: SocketState): HandshakeState => {
  if (!state.handshake) {
    throw new BrokerRpcError(
      "CHROME_MCP_BROKER_INVALID_REQUEST",
      "broker.hello must be the first request on a Chrome broker socket",
    );
  }
  return state.handshake;
};

const requireSession = (state: SocketState, sessionId: string): SessionState => {
  const session = state.sessions.get(sessionId);
  if (!session) throw new BrokerRpcError("CHROME_MCP_BROKER_CLOSED", "Chrome broker session is not active");
  return session;
};

const requireAdmission = (state: SocketState, sessionId: string, token: string): AdmissionState => {
  const admission = state.admissions.get(token);
  if (!admission || admission.sessionId !== sessionId || !admission.started) {
    throw new BrokerRpcError(
      "CHROME_MCP_BROKER_INVALID_REQUEST",
      "Chrome broker mutation requires the active admission token for this browser session",
    );
  }
  return admission;
};

type TransactionOwner = Readonly<{ admissionToken: string; sessionId: string; transactionId: string }>;

const requireOwnedTransaction = (state: SocketState, owner: TransactionOwner) => {
  const transaction = state.transactions.get(owner.transactionId);
  const isOwnedTransaction =
    transaction !== undefined &&
    transaction.sessionId === owner.sessionId &&
    transaction.admissionToken === owner.admissionToken;
  if (!isOwnedTransaction) {
    throw new BrokerRpcError(
      "CHROME_MCP_BROKER_INVALID_REQUEST",
      "Chrome selection transaction is stale or foreign",
    );
  }

  return transaction;
};

const createSessionAcquireResult = (sessionId: string, session: BrokerBackendSession) => ({
  mode: session.mode,
  ownerGeneration: session.ownerGeneration,
  ownerId: session.ownerId,
  sessionId,
  snapshot: session.snapshot(),
  target: session.currentTarget(),
});

export const startBrokerRpcServer = async (options: BrokerRpcServerOptions): Promise<BrokerRpcServer> => {
  const disconnectGraceMs = options.disconnectGraceMs ?? BROKER_DISCONNECT_GRACE_MS;
  const sockets = new Set<BrokerSocket>();
  const connections = new Map<string, BrokerSocket>();
  let activeCleanup = 0;
  let activeRequests = 0;
  let backendClosed = false;
  let downloadPublisherReleased = false;
  let initialIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let listenerStopped = false;
  let shutdownPromise: Promise<void> | undefined;
  let shuttingDown = false;
  let idleScheduled = false;

  const status = () => {
    let sessions = 0;
    let activeAdmissions = 0;
    for (const socket of sockets) {
      sessions += socket.data.sessions.size;
      activeAdmissions += socket.data.admissions.size;
    }
    return {
      activeAdmissions,
      brokerId: options.brokerId,
      brokerPid: process.pid,
      connections: connections.size,
      sessions,
      workspaceHash: options.paths.workspaceHash,
    };
  };

  const maybeIdle = (): void => {
    if (
      shutdownPromise ||
      idleScheduled ||
      sockets.size > 0 ||
      connections.size > 0 ||
      activeCleanup > 0 ||
      activeRequests > 0
    ) {
      return;
    }
    idleScheduled = true;
    queueMicrotask(() => {
      idleScheduled = false;
      if (
        !shutdownPromise &&
        sockets.size === 0 &&
        connections.size === 0 &&
        activeCleanup === 0 &&
        activeRequests === 0
      ) {
        options.onIdle?.();
      }
    });
  };

  const notify: (socket: BrokerSocket, notification: BrokerNotification) => void = send;

  const notifyCdpEvent = (
    socket: BrokerSocket,
    eventMethod: string,
    params: unknown,
    sessionId: string | undefined,
    subscriptionId: string,
  ): void => {
    const notification = {
      eventMethod,
      notification: "cdp.event" as const,
      params: params === undefined ? null : z.json().parse(params),
      sessionId: sessionId ?? null,
      subscriptionId,
    };
    try {
      notify(socket, notification);
      return;
    } catch (error: unknown) {
      const normalized = brokerError(error);
      if (normalized.code !== "CHROME_MCP_BROKER_INVALID_REQUEST") throw error;
    }
    const serialized = JSON.stringify(notification.params);
    const chunkCount = Math.ceil(serialized.length / BROKER_JSON_CHUNK_CHARACTERS);
    if (chunkCount > BROKER_MAX_JSON_CHUNKS) {
      notify(socket, {
        ...notification,
        params: {
          error: {
            code: "CHROME_MCP_BROKER_INVALID_REQUEST",
            message: `Chrome CDP event requires ${chunkCount} chunks; maximum is ${BROKER_MAX_JSON_CHUNKS}`,
          },
        },
      });
      return;
    }
    const transmissionId = randomUUID();
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      notify(socket, {
        chunk: serialized.slice(
          chunkIndex * BROKER_JSON_CHUNK_CHARACTERS,
          (chunkIndex + 1) * BROKER_JSON_CHUNK_CHARACTERS,
        ),
        chunkCount,
        chunkIndex,
        eventMethod,
        notification: "cdp.event.chunk",
        sessionId: sessionId ?? null,
        subscriptionId,
        transmissionId,
      });
    }
  };

  const publishDownload = (
    download: Readonly<{
      browserMode: BrowserMode;
      connectionId: string;
      downloadId: string;
      ownerGeneration: number;
      path: string;
      suggestedFilename?: string;
      targetId: string;
    }>,
  ): Promise<DownloadPublication> => {
    const socket = connections.get(download.connectionId);
    if (!socket || socket.data.closed || socket.data.handshake?.connectionId !== download.connectionId) {
      return Promise.reject(
        new BrokerRpcError(
          "CHROME_MCP_BROKER_CLOSED",
          "The MCP connection that owns this download is no longer active",
        ),
      );
    }
    const publicationId = randomUUID();
    return new Promise<DownloadPublication>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.data.downloads.delete(publicationId);
        reject(
          new BrokerRpcError(
            "CHROME_MCP_BROKER_DEADLINE",
            "The MCP connection did not publish its owned download before the broker deadline",
          ),
        );
      }, BROKER_REQUEST_TIMEOUT_MS);
      socket.data.downloads.set(publicationId, Object.freeze({ reject, resolve, timer }));
      notify(socket, {
        browserMode: download.browserMode,
        connectionId: download.connectionId,
        downloadId: download.downloadId,
        notification: "download.finished",
        ownerGeneration: download.ownerGeneration,
        path: download.path,
        publicationId,
        ...(download.suggestedFilename === undefined ?
          {}
        : { suggestedFilename: download.suggestedFilename }),
        targetId: download.targetId,
      });
    });
  };

  const rollbackAdmissionTransactions = (state: SocketState, admissionToken: string): unknown[] => {
    const failures: unknown[] = [];
    for (const [transactionId, transaction] of state.transactions) {
      if (transaction.admissionToken !== admissionToken) continue;
      try {
        transaction.selection.rollback();
      } catch (error: unknown) {
        failures.push(error);
      }
      state.transactions.delete(transactionId);
    }
    return failures;
  };

  const discardAdmissionTransactions = (state: SocketState, admissionToken: string): void => {
    for (const [transactionId, transaction] of state.transactions) {
      if (transaction.admissionToken === admissionToken) state.transactions.delete(transactionId);
    }
  };

  const cancelAdmission = (state: SocketState, admission: AdmissionState, reason: BrokerRpcError): void => {
    const terminalError = admission.terminalError ?? reason;
    admission.terminalError = terminalError;
    if (admission.deadlineTimer) clearTimeout(admission.deadlineTimer);
    state.admissions.delete(admission.token);
    admission.operationController.abort(terminalError);

    const finishCancellation = (): void => {
      const rollbackFailures = rollbackAdmissionTransactions(state, admission.token);
      const cancellation =
        rollbackFailures.length === 0 ?
          terminalError
        : new BrokerRpcError(
            terminalError.code,
            `${terminalError.message}; Chrome selection rollback also failed`,
            { cause: new AggregateError(rollbackFailures) },
          );
      admission.controller.abort(cancellation);
      admission.finish();
    };
    Promise.allSettled(admission.operations)
      .then(finishCancellation)
      .catch(() => {
        admission.controller.abort(terminalError);
        admission.finish();
      });
  };

  const runAdmissionOperation = async <Result>(
    admission: AdmissionState,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const completion = Promise.withResolvers<void>();
    admission.operations.add(completion.promise);
    try {
      return await operation();
    } finally {
      completion.resolve();
      admission.operations.delete(completion.promise);
    }
  };

  const closeSession = async (state: SocketState, sessionId: string): Promise<void> => {
    const session = state.sessions.get(sessionId);
    if (!session) return;
    const cleanupFailures: unknown[] = [];
    for (const [subscriptionId, subscription] of state.subscriptions) {
      if (subscription.sessionId !== sessionId) continue;
      try {
        subscription.remove();
      } catch (error: unknown) {
        cleanupFailures.push(error);
      }
      state.subscriptions.delete(subscriptionId);
    }
    for (const [transactionId, transaction] of state.transactions) {
      if (transaction.sessionId !== sessionId) continue;
      try {
        transaction.selection.rollback();
      } catch (error: unknown) {
        cleanupFailures.push(error);
      }
      state.transactions.delete(transactionId);
    }
    const admissions = [...state.admissions.values()].filter(
      (admission) => admission.sessionId === sessionId,
    );
    for (const admission of admissions) {
      cancelAdmission(
        state,
        admission,
        abortReason("CHROME_MCP_BROKER_CLOSED", "Chrome browser session closed while work was pending"),
      );
    }
    await Promise.allSettled(admissions.map((admission) => admission.completion));
    state.sessions.delete(sessionId);
    state.sessionsByMode.delete(session.session.mode);
    try {
      await session.session.close();
    } catch (error: unknown) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Chrome broker session cleanup failed");
    }
  };

  const cleanupSocket = (socket: BrokerSocket): Promise<void> => {
    const state = socket.data;
    if (state.cleanupPromise) return state.cleanupPromise;
    const attempt = (async () => {
      if (state.cleanupTimer) {
        clearTimeout(state.cleanupTimer);
        state.cleanupTimer = undefined;
      }
      const handshake = state.handshake;
      if (handshake) {
        state.handshake = undefined;
        state.cleanupConnectionId = handshake.connectionId;
      }
      const connectionId = state.cleanupConnectionId;
      if (!connectionId) {
        if (state.closed) sockets.delete(socket);
        maybeIdle();
        return;
      }
      activeCleanup += 1;
      let completed = false;
      try {
        for (const publication of state.downloads.values()) {
          clearTimeout(publication.timer);
          publication.reject(
            new BrokerRpcError(
              "CHROME_MCP_BROKER_CLOSED",
              "The MCP connection closed before publishing its owned download",
            ),
          );
        }
        state.downloads.clear();
        for (const admission of state.admissions.values()) {
          cancelAdmission(
            state,
            admission,
            abortReason("CHROME_MCP_BROKER_CANCELED", "Chrome transport disconnected"),
          );
        }
        for (const controller of state.requestControllers.values()) {
          controller.abort(abortReason("CHROME_MCP_BROKER_CANCELED", "Chrome transport disconnected"));
        }
        const cleanup = [
          ...[...state.sessions.keys()].map((sessionId) => closeSession(state, sessionId)),
          ...(options.backend.cleanupConnection ? [options.backend.cleanupConnection(connectionId)] : []),
        ];
        const results = await Promise.allSettled(cleanup);
        const failures = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failures.length > 0) {
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Chrome broker connection cleanup failed",
          );
        }
        completed = true;
      } finally {
        if (connections.get(connectionId) === socket) connections.delete(connectionId);
        if (completed) state.cleanupConnectionId = undefined;
        if (state.closed && state.cleanupConnectionId === undefined) sockets.delete(socket);
        activeCleanup -= 1;
        maybeIdle();
      }
    })();
    state.cleanupPromise = attempt;
    attempt.catch(() => {
      if (state.cleanupPromise === attempt) state.cleanupPromise = undefined;
    });
    return attempt;
  };

  const scheduleSocketCleanup = (socket: BrokerSocket): void => {
    const state = socket.data;
    if (state.cleanupTimer || !state.handshake) {
      if (state.closed && !state.handshake && state.cleanupConnectionId === undefined) sockets.delete(socket);
      maybeIdle();
      return;
    }
    state.cleanupTimer = setTimeout(() => {
      cleanupSocket(socket).catch(() => undefined);
    }, disconnectGraceMs);
  };

  const openAdmission = async (socket: BrokerSocket, request: BrokerRequest): Promise<unknown> => {
    const params = brokerParams.admissionOpen.parse(request.params);
    const session = requireSession(socket.data, params.sessionId).session;
    if (params.deadlineAt !== undefined && params.deadlineAt <= Date.now()) {
      throw abortReason(
        "CHROME_MCP_BROKER_DEADLINE",
        "Chrome broker admission deadline expired before queueing",
      );
    }
    const token = randomUUID();
    const controller = new AbortController();
    const ready = Promise.withResolvers<
      Readonly<{
        admissionToken: string;
        dialog: ReturnType<BrokerBackendSession["activeDialog"]> | null;
        fileChooser: ReturnType<BrokerBackendSession["activeFileChooser"]> | null;
        ownerGeneration: number;
        target: ReturnType<BrokerBackendSession["currentTarget"]>;
      }>
    >();
    const hold = Promise.withResolvers<void>();
    const state: AdmissionState = {
      completion: Promise.resolve(),
      controller,
      finish: hold.resolve,
      ownerCloseAuthorized: false,
      operationController: new AbortController(),
      operations: new Set(),
      requestId: request.id,
      sessionId: params.sessionId,
      started: false,
      token,
    };
    socket.data.admissions.set(token, state);
    notify(socket, {
      admissionRequestId: request.id,
      notification: "admission.progress",
      phase: "queued",
      position: session.pendingAdmissions,
    });
    if (params.deadlineAt !== undefined) {
      state.deadlineTimer = setTimeout(
        () => {
          cancelAdmission(
            socket.data,
            state,
            abortReason(
              "CHROME_MCP_BROKER_DEADLINE",
              "Chrome broker admission deadline expired in the owner queue",
            ),
          );
        },
        Math.max(0, params.deadlineAt - Date.now()),
      );
    }
    state.completion = session.admit({
      modalPolicy: params.modalPolicy,
      run: async (signal) => {
        state.started = true;
        notify(socket, {
          admissionRequestId: request.id,
          notification: "admission.progress",
          phase: "admitted",
        });
        ready.resolve({
          admissionToken: token,
          dialog: session.activeDialog() ?? null,
          fileChooser: session.activeFileChooser() ?? null,
          ownerGeneration: session.ownerGeneration,
          target: session.currentTarget(),
        });
        const aborted = () => {
          const reason =
            signal.reason ?? abortReason("CHROME_MCP_BROKER_CANCELED", "Chrome broker admission canceled");
          state.operationController.abort(reason);
          hold.reject(reason);
        };

        if (signal.aborted) aborted();
        else signal.addEventListener("abort", aborted, { once: true });
        try {
          await hold.promise;
        } finally {
          signal.removeEventListener("abort", aborted);
        }
      },
      signal: controller.signal,
    });
    state.completion.then(
      () => {
        socket.data.admissions.delete(token);
        notify(socket, {
          admissionRequestId: request.id,
          notification: "admission.progress",
          phase: "completed",
        });
      },
      (error: unknown) => {
        socket.data.admissions.delete(token);
        if (!state.started) ready.reject(error);
        notify(socket, {
          admissionRequestId: request.id,
          notification: "admission.progress",
          phase: "canceled",
        });
      },
    );
    return ready.promise;
  };

  type BrokerSelectionMethod = Extract<
    BrokerRequest["method"],
    "selection.begin" | "selection.commit" | "selection.prepare" | "selection.rollback" | "selection.select"
  >;

  const dispatchSelectionRequest = async (
    state: SocketState,
    method: BrokerSelectionMethod,
    rawParams: unknown,
  ) => {
    switch (method) {
      case "selection.begin": {
        const params = brokerParams.selectionBegin.parse(rawParams);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const session = requireSession(state, params.sessionId);
        return runAdmissionOperation(admission, async () => {
          let selection: BrokerBackendSelection;
          try {
            selection = await session.session.beginSelection();
          } catch (error: unknown) {
            if (admission.terminalError) throw admission.terminalError;
            if (
              state.admissions.get(params.admissionToken) !== admission ||
              state.sessions.get(params.sessionId) !== session
            ) {
              throw new BrokerRpcError(
                "CHROME_MCP_BROKER_CLOSED",
                "Chrome broker admission ended while creating a selection transaction",
              );
            }
            throw error;
          }
          if (
            state.admissions.get(params.admissionToken) !== admission ||
            state.sessions.get(params.sessionId) !== session ||
            admission.terminalError
          ) {
            const terminalError =
              admission.terminalError ??
              new BrokerRpcError(
                "CHROME_MCP_BROKER_CLOSED",
                "Chrome broker admission ended while creating a selection transaction",
              );
            try {
              selection.rollback();
            } catch (rollbackError: unknown) {
              throw new BrokerRpcError(
                terminalError.code,
                `${terminalError.message}; Chrome selection rollback also failed`,
                { cause: new AggregateError([terminalError, rollbackError]) },
              );
            }
            throw terminalError;
          }
          const transactionId = randomUUID();
          state.transactions.set(
            transactionId,
            Object.freeze({
              admissionToken: params.admissionToken,
              selection,
              sessionId: params.sessionId,
            }),
          );
          return { initialTarget: selection.initialTarget, transactionId };
        });
      }
      case "selection.prepare":
      case "selection.commit": {
        const params = brokerParams.selectionCommit.parse(rawParams);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const transaction = requireOwnedTransaction(state, params);

        for (const target of params.createdTargets) transaction.selection.recordCreated(target);

        if (method === "selection.prepare") {
          return runAdmissionOperation(admission, () => transaction.selection.prepare());
        }

        try {
          return await runAdmissionOperation(admission, () => transaction.selection.commit());
        } catch (error: unknown) {
          const commitError = brokerError(error);
          try {
            transaction.selection.rollback();
          } catch (rollbackError: unknown) {
            const rollbackFailure = brokerError(rollbackError);
            const sameFailure =
              rollbackFailure.code === commitError.code && rollbackFailure.message === commitError.message;
            throw new BrokerRpcError(
              commitError.code,
              sameFailure ?
                commitError.message
              : `${commitError.message}; Chrome selection rollback also failed`,
              { cause: new AggregateError([error, rollbackError]) },
            );
          }
          throw error;
        } finally {
          state.transactions.delete(params.transactionId);
        }
      }
      case "selection.select": {
        const params = brokerParams.selectionSelect.parse(rawParams);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const transaction = requireOwnedTransaction(state, params);
        await runAdmissionOperation(admission, () => transaction.selection.select(params.target));
        return null;
      }
      case "selection.rollback": {
        const params = brokerParams.selectionRollback.parse(rawParams);
        requireAdmission(state, params.sessionId, params.admissionToken);
        const transaction = requireOwnedTransaction(state, params);

        try {
          return transaction.selection.rollback();
        } finally {
          state.transactions.delete(params.transactionId);
        }
      }
      default: {
        return method satisfies never;
      }
    }
  };

  type BrokerBrowserSessionMethod = Extract<
    BrokerRequest["method"],
    | "cdp.send"
    | "cdp.subscribe"
    | "cdp.unsubscribe"
    | "journal.capabilities"
    | "journal.current"
    | "journal.mark"
    | "journal.range"
    | "journal.read"
    | "modal.dialog"
    | "modal.fileChooser"
    | "modal.handleDialog"
    | "modal.requireNone"
    | "modal.setFileChooserFiles"
    | "page.viewport"
    | "pwa.execute"
    | "react.execute"
    | "target.current"
    | "target.ensure"
    | "target.record"
    | "worker.connection"
  >;

  const dispatchBrowserSessionRequest = async (
    socket: BrokerSocket,
    method: BrokerBrowserSessionMethod,
    rawParams: unknown,
  ) => {
    const state = socket.data;

    switch (method) {
      case "target.current": {
        const params = brokerParams.sessionOnly.parse(rawParams);
        return requireSession(state, params.sessionId).session.currentTarget();
      }
      case "target.ensure": {
        const params = brokerParams.admittedSession.parse(rawParams);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const session = requireSession(state, params.sessionId).session;
        return runAdmissionOperation(admission, () => session.ensureTarget());
      }
      case "target.record": {
        const params = brokerParams.targetRecord.parse(rawParams);
        return requireSession(state, params.sessionId).session.targetRecord(params.targetId) ?? null;
      }
      case "journal.current": {
        const params = brokerParams.sessionOnly.parse(rawParams);
        return requireSession(state, params.sessionId).session.currentEventCursor();
      }
      case "journal.capabilities": {
        const params = brokerParams.sessionOnly.parse(rawParams);
        return requireSession(state, params.sessionId).session.journalCapabilities();
      }
      case "journal.mark": {
        const params = brokerParams.sessionOnly.parse(rawParams);
        return requireSession(state, params.sessionId).session.markEvents();
      }
      case "journal.read": {
        const params = brokerParams.journalRead.parse(rawParams);
        return requireSession(state, params.sessionId).session.readEvents(params.options);
      }
      case "journal.range": {
        const params = brokerParams.journalRange.parse(rawParams);
        return requireSession(state, params.sessionId).session.eventRange(params.after, params.targetId);
      }
      case "modal.dialog": {
        const params = brokerParams.sessionOnly.parse(rawParams);
        return requireSession(state, params.sessionId).session.activeDialog() ?? null;
      }
      case "modal.fileChooser": {
        const params = brokerParams.sessionOnly.parse(rawParams);
        return requireSession(state, params.sessionId).session.activeFileChooser() ?? null;
      }
      case "modal.requireNone": {
        const params = brokerParams.admittedSession.parse(rawParams);
        requireAdmission(state, params.sessionId, params.admissionToken);
        requireSession(state, params.sessionId).session.requireNoBlockingModal();
        return { ok: true };
      }
      case "modal.handleDialog": {
        const params = brokerParams.modalHandleDialog.parse(rawParams);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const session = requireSession(state, params.sessionId).session;
        await runAdmissionOperation(admission, () =>
          session.handleDialog(params.dialogId, params.accept, params.promptText),
        );
        return { ok: true };
      }
      case "modal.setFileChooserFiles": {
        const params = brokerParams.modalSetFileChooserFiles.parse(rawParams);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const session = requireSession(state, params.sessionId).session;
        await runAdmissionOperation(admission, () =>
          session.setFileChooserFiles(params.chooserId, params.files),
        );
        return { ok: true };
      }
      case "cdp.send": {
        const params = brokerParams.cdpSend.parse(rawParams);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const session = requireSession(state, params.sessionId).session;
        return runAdmissionOperation(admission, () =>
          session.sendCdp(params.method, params.params, params.targetSessionId, params.timeoutMs),
        );
      }
      case "page.viewport": {
        const params = brokerParams.pageViewport.parse(rawParams);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const session = requireSession(state, params.sessionId).session;
        return runAdmissionOperation(admission, () =>
          session.pageViewport(params.request, admission.controller.signal),
        );
      }
      case "pwa.execute": {
        const params = brokerParams.pwaExecute.parse(rawParams);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const session = requireSession(state, params.sessionId).session;
        return runAdmissionOperation(admission, () =>
          session.pwa(params.input, admission.operationController.signal),
        );
      }
      case "cdp.subscribe": {
        const params = brokerParams.cdpSubscribe.parse(rawParams);
        if (state.subscriptions.has(params.subscriptionId)) {
          throw new BrokerRpcError(
            "CHROME_MCP_BROKER_INVALID_REQUEST",
            "Chrome CDP subscription ID is already active",
          );
        }
        const remove = requireSession(state, params.sessionId).session.onCdp(
          params.eventMethod,
          (payload, sessionId) => {
            notifyCdpEvent(socket, params.eventMethod, payload, sessionId, params.subscriptionId);
          },
        );
        state.subscriptions.set(
          params.subscriptionId,
          Object.freeze({ remove, sessionId: params.sessionId }),
        );
        return { subscriptionId: params.subscriptionId };
      }
      case "cdp.unsubscribe": {
        const params = brokerParams.cdpUnsubscribe.parse(rawParams);
        const subscription = state.subscriptions.get(params.subscriptionId);
        subscription?.remove();
        state.subscriptions.delete(params.subscriptionId);
        return { ok: true };
      }
      case "worker.connection": {
        const params = brokerParams.admittedSession.parse(rawParams);
        requireAdmission(state, params.sessionId, params.admissionToken);
        return requireSession(state, params.sessionId).session.workerConnection();
      }
      case "react.execute": {
        const params = brokerParams.reactExecute.parse(rawParams);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const session = requireSession(state, params.sessionId).session;
        return runAdmissionOperation(admission, () => session.react(params.input));
      }
      default: {
        return method satisfies never;
      }
    }
  };

  const dispatch = async (socket: BrokerSocket, request: BrokerRequest): Promise<unknown> => {
    if (shuttingDown) {
      throw new BrokerRpcError("CHROME_MCP_BROKER_CLOSED", "Chrome broker shutdown is in progress");
    }
    const state = socket.data;
    if (request.method === "broker.hello") {
      const params = brokerParams.hello.parse(request.params);
      if (state.handshake) {
        throw new BrokerRpcError(
          "CHROME_MCP_BROKER_INVALID_REQUEST",
          "Chrome broker socket is already authenticated",
        );
      }
      if (params.workspaceHash !== options.paths.workspaceHash) {
        throw new BrokerRpcError(
          "CHROME_MCP_BROKER_INVALID_REQUEST",
          "Chrome broker workspace identity does not match this socket",
        );
      }
      if (params.protocolVersion !== BROKER_PROTOCOL_VERSION) {
        throw new BrokerRpcError(
          "CHROME_MCP_BROKER_INVALID_REQUEST",
          `Chrome broker protocol ${BROKER_PROTOCOL_VERSION} does not match client protocol ${params.protocolVersion}`,
        );
      }
      if (connections.has(params.connectionId)) {
        throw new BrokerRpcError(
          "CHROME_MCP_BROKER_INVALID_REQUEST",
          "Chrome broker connection ID is already leased",
        );
      }
      if (initialIdleTimer) {
        clearTimeout(initialIdleTimer);
        initialIdleTimer = undefined;
      }
      state.handshake = Object.freeze({ connectionId: params.connectionId });
      connections.set(params.connectionId, socket);
      return {
        brokerId: options.brokerId,
        brokerPid: process.pid,
        processStartIdentity: options.processStartIdentity,
        protocolVersion: BROKER_PROTOCOL_VERSION,
        workspaceHash: options.paths.workspaceHash,
      };
    }

    requireHandshake(state);

    switch (request.method) {
      case "broker.status": {
        brokerParams.status.parse(request.params);
        return status();
      }
      case "connection.close": {
        brokerParams.connectionClose.parse(request.params);
        try {
          await cleanupSocket(socket);
        } finally {
          setTimeout(() => socket.end(), 0);
        }
        return { ok: true };
      }
      case "download.ack": {
        const params = brokerParams.downloadAck.parse(request.params);
        const publication = state.downloads.get(params.publicationId);
        if (!publication) {
          throw new BrokerRpcError(
            "CHROME_MCP_BROKER_INVALID_REQUEST",
            "Chrome download publication is stale or foreign",
          );
        }
        clearTimeout(publication.timer);
        state.downloads.delete(params.publicationId);
        if (params.outcome.status === "failed") {
          publication.reject(
            new BrokerRpcError(
              "CHROME_MCP_BROKER_UNAVAILABLE",
              "The MCP connection could not publish its owned download",
            ),
          );
        } else {
          publication.resolve(params.outcome.publication);
        }
        return { ok: true };
      }
      case "request.cancel": {
        const params = brokerParams.requestCancel.parse(request.params);
        if (state.inFlightRequestIds.has(params.requestId)) state.canceledRequests.add(params.requestId);
        state.requestControllers
          .get(params.requestId)
          ?.abort(
            abortReason("CHROME_MCP_BROKER_CANCELED", "Chrome broker request was canceled by its transport"),
          );
        const admission = [...state.admissions.values()].find(
          (candidate) => candidate.requestId === params.requestId,
        );
        if (admission) {
          cancelAdmission(
            state,
            admission,
            abortReason("CHROME_MCP_BROKER_CANCELED", "Chrome broker request was canceled by its transport"),
          );
        }
        return { ok: true };
      }
      case "session.acquire": {
        const params = brokerParams.sessionAcquire.parse(request.params);
        assertNativeDeviceScaleFactor(params.mode, params.nativeDeviceScaleFactor);

        const existingId = state.sessionsByMode.get(params.mode);
        if (existingId) {
          const existing = requireSession(state, existingId).session;
          assertMatchingNativeDeviceScaleFactor(
            existing.snapshot().nativeDeviceScaleFactor,
            params.nativeDeviceScaleFactor,
          );

          return createSessionAcquireResult(existingId, existing);
        }
        const connection = requireHandshake(state);
        const controller = state.requestControllers.get(request.id);
        if (!controller) {
          throw new BrokerRpcError("CHROME_MCP_BROKER_CANCELED", "Chrome broker request is no longer active");
        }
        const acquisition = options.backend.acquire(connection.connectionId, params.mode, {
          mainUserDataDir: params.mainUserDataDir,
          nativeDeviceScaleFactor: params.nativeDeviceScaleFactor,
        });
        let session: BrokerBackendSession;
        try {
          session = await waitForRequest(acquisition, controller.signal);
        } catch (error: unknown) {
          acquisition.then((lateSession) => lateSession.close()).catch(() => undefined);
          throw error;
        }
        if (state.closed || state.handshake !== connection || state.canceledRequests.has(request.id)) {
          await session.close();
          throw new BrokerRpcError(
            "CHROME_MCP_BROKER_CLOSED",
            "Chrome broker connection closed during browser session acquisition",
          );
        }
        const concurrentId = state.sessionsByMode.get(params.mode);
        if (concurrentId) {
          await session.close();
          const concurrent = requireSession(state, concurrentId).session;
          assertMatchingNativeDeviceScaleFactor(
            concurrent.snapshot().nativeDeviceScaleFactor,
            params.nativeDeviceScaleFactor,
          );

          return createSessionAcquireResult(concurrentId, concurrent);
        }
        const acquired = Object.freeze({ id: randomUUID(), session });
        state.sessions.set(acquired.id, acquired);
        state.sessionsByMode.set(params.mode, acquired.id);

        return createSessionAcquireResult(acquired.id, session);
      }
      case "session.release": {
        const params = brokerParams.sessionRelease.parse(request.params);
        await closeSession(state, params.sessionId);
        return { ok: true };
      }
      case "session.snapshot": {
        const params = brokerParams.sessionSnapshot.parse(request.params);
        return requireSession(state, params.sessionId).session.snapshot();
      }
      case "admission.open": {
        return openAdmission(socket, request);
      }
      case "admission.close": {
        const params = brokerParams.admissionClose.parse(request.params);

        if (!state.admissions.has(params.admissionToken)) return { ok: true };

        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        await Promise.allSettled(admission.operations);
        let rollbackFailures: unknown[] = [];
        if (admission.ownerCloseAuthorized) {
          discardAdmissionTransactions(state, params.admissionToken);
        } else {
          rollbackFailures = rollbackAdmissionTransactions(state, params.admissionToken);
        }
        if (admission.deadlineTimer) clearTimeout(admission.deadlineTimer);
        admission.finish();
        await admission.completion;
        if (rollbackFailures.length > 0) {
          throw new BrokerRpcError(
            "CHROME_MCP_BROKER_UNAVAILABLE",
            "Chrome selection rollback failed while closing the owner admission",
            { cause: new AggregateError(rollbackFailures) },
          );
        }
        return { ok: true };
      }
      case "owner.close.authorize": {
        const params = brokerParams.ownerCloseAuthorize.parse(request.params);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        requireSession(state, params.sessionId).session.authorizeOwnerClose(params.resource);
        admission.ownerCloseAuthorized = true;
        return { ok: true };
      }
      case "owner.invalidate": {
        const params = brokerParams.ownerInvalidate.parse(request.params);
        requireAdmission(state, params.sessionId, params.admissionToken);
        requireSession(state, params.sessionId).session.invalidateOwner();
        return { ok: true };
      }
      case "download.enable": {
        const params = brokerParams.admittedSession.parse(request.params);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const session = requireSession(state, params.sessionId).session;
        await runAdmissionOperation(admission, () => session.enableOwnedDownloads());
        return { ok: true };
      }
      case "mutation.add": {
        const params = brokerParams.mutationAdd.parse(request.params);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const session = requireSession(state, params.sessionId).session;
        return runAdmissionOperation(admission, () => session.addMutation(params.input, params.target));
      }
      case "mutation.clear": {
        const params = brokerParams.mutationClear.parse(request.params);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const session = requireSession(state, params.sessionId).session;
        return runAdmissionOperation(admission, () => session.clearMutations(params.kind));
      }
      case "mutation.list": {
        const params = brokerParams.mutationList.parse(request.params);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const session = requireSession(state, params.sessionId).session;
        return runAdmissionOperation(admission, async () => session.listMutations(params.kind));
      }
      case "mutation.remove": {
        const params = brokerParams.mutationRemove.parse(request.params);
        const admission = requireAdmission(state, params.sessionId, params.admissionToken);
        const session = requireSession(state, params.sessionId).session;
        return runAdmissionOperation(admission, () => session.removeMutation(params.kind, params.id));
      }
      case "selection.begin":
      case "selection.prepare":
      case "selection.commit":
      case "selection.select":
      case "selection.rollback": {
        return dispatchSelectionRequest(state, request.method, request.params);
      }
      case "target.current":
      case "target.ensure":
      case "target.record":
      case "journal.current":
      case "journal.capabilities":
      case "journal.mark":
      case "journal.read":
      case "journal.range":
      case "modal.dialog":
      case "modal.fileChooser":
      case "modal.requireNone":
      case "modal.handleDialog":
      case "modal.setFileChooserFiles":
      case "cdp.send":
      case "page.viewport":
      case "pwa.execute":
      case "cdp.subscribe":
      case "cdp.unsubscribe":
      case "worker.connection":
      case "react.execute": {
        return dispatchBrowserSessionRequest(socket, request.method, request.params);
      }
      default: {
        return request.method satisfies never;
      }
    }
  };

  const handle = async (socket: BrokerSocket, raw: unknown): Promise<void> => {
    let request: BrokerRequest;
    try {
      request = brokerRequestSchema.parse(raw);
    } catch (error: unknown) {
      socket.end();
      throw error;
    }
    try {
      activeRequests += 1;
      socket.data.inFlightRequestIds.add(request.id);
      const requestController = new AbortController();
      socket.data.requestControllers.set(request.id, requestController);
      sendSuccess(socket, request, await dispatch(socket, request));
    } catch (error: unknown) {
      send(socket, failure(request, error));
    } finally {
      activeRequests -= 1;
      socket.data.inFlightRequestIds.delete(request.id);
      socket.data.requestControllers.delete(request.id);
      socket.data.canceledRequests.delete(request.id);
      maybeIdle();
    }
  };

  const listener = Bun.listen<SocketState>({
    unix: options.paths.socketPath,
    socket: {
      open: (socket) => {
        socket.data = createSocketState(socket);
        sockets.add(socket);
      },
      close: (socket) => {
        socket.data.closed = true;
        socket.data.writes.close();
        scheduleSocketCleanup(socket);
      },
      error: (socket) => {
        socket.data.closed = true;
        socket.data.writes.close();
        scheduleSocketCleanup(socket);
      },
      drain: (socket) => socket.data.writes.flush(),
      data: (socket, chunk) => {
        let frames: unknown[];
        try {
          frames = socket.data.decoder.push(chunk);
        } catch {
          socket.end();
          return;
        }
        for (const frame of frames) handle(socket, frame).catch(() => socket.end());
      },
    },
  });
  if (isBrokerSocketFile(options.paths.socketPath)) {
    await chmod(options.paths.socketPath, 0o600);
  }
  options.backend.setDownloadPublisher?.(publishDownload);

  if (options.onIdle) {
    initialIdleTimer = setTimeout(() => {
      initialIdleTimer = undefined;
      for (const socket of sockets) {
        if (socket.data.handshake) continue;
        socket.data.closed = true;
        socket.data.writes.close();
        socket.end();
        sockets.delete(socket);
      }
      maybeIdle();
    }, options.initialIdleMs ?? BROKER_INITIAL_IDLE_MS);
  }

  const shutdown = (_reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    const attempt = (async () => {
      const failures: unknown[] = [];
      if (!downloadPublisherReleased) {
        try {
          options.backend.setDownloadPublisher?.(undefined);
          downloadPublisherReleased = true;
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      if (initialIdleTimer) {
        clearTimeout(initialIdleTimer);
        initialIdleTimer = undefined;
      }
      if (!listenerStopped) {
        try {
          listener.stop(true);
          listenerStopped = true;
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      const cleanupResults = await Promise.allSettled(
        [...sockets].map(async (socket) => {
          socket.data.closed = true;
          socket.data.writes.close();
          try {
            socket.end();
          } finally {
            await cleanupSocket(socket);
          }
        }),
      );
      for (const result of cleanupResults) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (!backendClosed) {
        await options.backend.close().then(
          () => {
            backendClosed = true;
          },
          (error: unknown) => {
            failures.push(error);
          },
        );
      }
      const shouldRemoveSocketFile =
        backendClosed && failures.length === 0 && isBrokerSocketFile(options.paths.socketPath);
      if (shouldRemoveSocketFile) {
        await unlink(options.paths.socketPath).catch((error: unknown) => {
          if (!isNodeError(error, "ENOENT")) {
            failures.push(error);
          }
        });
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Chrome broker shutdown failed");
      }
    })();
    shutdownPromise = attempt;
    attempt.catch(() => {
      if (shutdownPromise === attempt) shutdownPromise = undefined;
    });
    return attempt;
  };

  return Object.freeze({ shutdown });
};
