import { describe, expect, test } from "bun:test";
import {
  type BrokerRpcRequest,
  type ExecutionKernelFailure,
  type ExecutionWorkerRequest,
  INLINE_IMAGE_MAX_BYTES,
  INLINE_IMAGE_MAX_TOTAL_BYTES,
  parseBrokerRpcRequest,
  parseBrokerRpcResponse,
  parseBrokerToWorkerMessage,
  parseExecutionKernelResult,
  parseWorkerToBrokerMessage,
} from "./protocol";

const workerRequest = (): ExecutionWorkerRequest => ({
  args: null,
  browserMode: "isolated",
  callId: "call-1",
  capabilities: {},
  cdpEndpoint: "ws://127.0.0.1/devtools/browser/private",
  code: "return page.url();",
  connectTimeoutMs: 1000,
  dialog: null,
  fileChooser: null,
  selectedTargetId: "target-1",
  state: [],
});

describe("execution protocol validation", () => {
  test("preserves live and closed artifact expiry values exactly", () => {
    const artifact = (expiresAt: string | null) => ({
      artifactId: "artifact-1",
      complete: true,
      createdAt: "2026-08-15T00:00:00.000Z",
      expiresAt,
      mediaType: "text/plain",
      name: "result.txt",
      sha256: "a".repeat(64),
      size: 12,
      uri: "chrome-artifact://connection/artifact-1/content",
    });
    const live = parseBrokerRpcResponse({ artifacts: [artifact(null)], ok: true, value: null });
    expect(live.ok).toBeTrue();
    if (!live.ok) throw new Error(live.error.message);
    expect(live.artifacts[0]?.expiresAt).toBeNull();

    const closed = parseBrokerRpcResponse({
      artifacts: [artifact("2026-08-15T01:00:00.000Z")],
      ok: true,
      value: null,
    });
    expect(closed.ok).toBeTrue();
    if (!closed.ok) throw new Error(closed.error.message);
    expect(closed.artifacts[0]?.expiresAt).toBe("2026-08-15T01:00:00.000Z");
    expect(() => parseBrokerRpcResponse({ artifacts: [artifact("")], ok: true, value: null })).toThrow();
  });

  test("accepts capture results with more descriptors than an ordinary call may publish", () => {
    const artifacts = Array.from({ length: 9 }, (_, index) => ({
      artifactId: `artifact-${index}`,
      complete: true,
      createdAt: "2026-08-15T00:00:00.000Z",
      expiresAt: null,
      mediaType: "text/plain",
      name: `result-${index}.txt`,
      sha256: index.toString(16).padStart(64, "0"),
      size: 1,
      uri: `chrome-artifact://connection/artifact-${index}/content`,
    }));

    const result = parseBrokerRpcResponse({ artifacts, ok: true, value: null });

    expect(result.ok).toBeTrue();
    if (result.ok) expect(result.artifacts).toHaveLength(9);
  });

  test("round-trips strict broker and worker messages", () => {
    expect(
      parseBrokerToWorkerMessage({
        request: workerRequest(),
        type: "execute",
      }),
    ).toEqual({
      request: workerRequest(),
      type: "execute",
    });
    expect(
      parseBrokerToWorkerMessage({
        callId: "call-1",
        type: "execution_result_ack",
      }),
    ).toEqual({
      callId: "call-1",
      type: "execution_result_ack",
    });
    expect(
      parseWorkerToBrokerMessage({
        callId: "call-1",
        request: { operation: "events_mark", payload: {} },
        rpcId: "r1",
        type: "rpc_request",
      }),
    ).toEqual({
      callId: "call-1",
      request: { operation: "events_mark", payload: {} },
      rpcId: "r1",
      type: "rpc_request",
    });
  });

  test("preserves an explicitly empty dialog prompt", () => {
    expect(
      parseBrokerRpcRequest({
        operation: "dialog_accept",
        payload: { modalId: "modal-1", promptText: "" },
      }),
    ).toEqual({
      operation: "dialog_accept",
      payload: { modalId: "modal-1", promptText: "" },
    });
  });

  test("validates owner-close authorization requests", () => {
    expect(
      parseBrokerRpcRequest({
        operation: "owner_close_authorize",
        payload: { resource: "browser" },
      }),
    ).toEqual({
      operation: "owner_close_authorize",
      payload: { resource: "browser" },
    });
    expect(() =>
      parseBrokerRpcRequest({
        operation: "owner_close_authorize",
        payload: { resource: "page" },
      }),
    ).toThrow();
  });

  test("preserves partial media emulation updates and explicit resets for a required target", () => {
    const request: BrokerRpcRequest = {
      operation: "media_emulate",
      payload: { options: { colorScheme: null, reducedMotion: "reduce" }, targetId: "target-1" },
    };
    expect(parseBrokerRpcRequest(request)).toEqual(request);
    expect(() => parseBrokerRpcRequest({ ...request, payload: { options: {} } })).toThrow();
    expect(() =>
      parseBrokerRpcRequest({ ...request, payload: { options: null, targetId: "target-1" } }),
    ).toThrow();
  });

  test("rejects malformed base64 and image publications at the broker boundary", () => {
    expect(() =>
      parseBrokerRpcRequest({
        operation: "artifact_publish",
        payload: {
          data: "not-base64",
          encoding: "base64",
          mediaType: "application/octet-stream",
          name: "bad.bin",
        },
      }),
    ).toThrow();
    expect(() =>
      parseBrokerRpcRequest({
        operation: "artifact_publish",
        payload: {
          data: Buffer.from("not a png").toString("base64"),
          encoding: "base64",
          mediaType: "image/png",
          name: "bad.png",
        },
      }),
    ).toThrow();
    expect(() =>
      parseBrokerRpcRequest({
        operation: "artifact_publish",
        payload: { data: "text", encoding: "utf8", mediaType: "text/plain; charset=utf-8", name: "bad.txt" },
      }),
    ).toThrow();
    expect(() =>
      parseBrokerRpcRequest({
        operation: "file_chooser_set_files",
        payload: {
          files: [{ bufferBase64: "%%%", kind: "payload", mimeType: "text/plain", name: "bad.txt" }],
          modalId: "chooser-1",
        },
      }),
    ).toThrow();
    expect(() =>
      parseBrokerRpcRequest({
        operation: "file_chooser_set_files",
        payload: {
          files: [{ kind: "path", path: "/tmp/a.txt" }],
          modalId: "chooser-1",
          options: { timeout: 1 },
        },
      }),
    ).toThrow();
  });

  test("rejects forged image counts, sizes, emitted counts, and artifact references", () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
    const image = { data: png, mediaType: "image/png", type: "image" };
    const success = {
      artifacts: [],
      content: [],
      emittedCount: 0,
      ok: true,
      selectedTargetId: "target-1",
      state: [],
    };
    expect(() => parseExecutionKernelResult({ ...success, content: [image], emittedCount: 0 })).toThrow();
    expect(() =>
      parseExecutionKernelResult({
        ...success,
        content: Array.from({ length: 5 }, () => image),
        emittedCount: 5,
      }),
    ).toThrow();
    const aggregateImageBytes = Math.floor(INLINE_IMAGE_MAX_TOTAL_BYTES / 4) + 1;
    const aggregatePng = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(aggregateImageBytes - 8),
    ]).toString("base64");
    const aggregateImage = { data: aggregatePng, mediaType: "image/png", type: "image" };
    expect(() =>
      parseExecutionKernelResult({
        ...success,
        content: Array.from({ length: 3 }, () => aggregateImage),
        emittedCount: 3,
        valueImage: { data: aggregatePng, mediaType: "image/png" },
      }),
    ).toThrow();
    const oversizedPng = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(INLINE_IMAGE_MAX_BYTES - 7),
    ]).toString("base64");
    expect(() =>
      parseExecutionKernelResult({
        ...success,
        content: [{ data: oversizedPng, mediaType: "image/png", type: "image" }],
        emittedCount: 1,
      }),
    ).toThrow();

    const artifact = {
      artifactId: "artifact-1",
      complete: true,
      createdAt: "2026-08-15T00:00:00.000Z",
      expiresAt: null,
      mediaType: "text/plain",
      name: "result.txt",
      sha256: "a".repeat(64),
      size: 12,
      uri: "chrome-artifact://connection/artifact-1/content",
    };
    expect(() =>
      parseExecutionKernelResult({
        ...success,
        content: [{ artifact, type: "resource" }],
        emittedCount: 1,
      }),
    ).toThrow();
  });

  test("validates bounded partial output on failed executions", () => {
    const failure: ExecutionKernelFailure = {
      artifacts: [],
      error: { code: "CHROME_MCP_EXECUTION_FAILED", message: "late failure", name: "Error" },
      ok: false,
      partialContent: [{ text: "measurement", type: "text" }],
      partialEmittedCount: 1,
      partialOmittedCount: 2,
      selectedTargetId: "target-1",
    };

    expect(parseExecutionKernelResult(failure)).toEqual(failure);
    expect(() => parseExecutionKernelResult({ ...failure, partialOmittedCount: undefined })).toThrow();
    expect(() => parseExecutionKernelResult({ ...failure, partialEmittedCount: 2 })).toThrow();
    expect(() =>
      parseExecutionKernelResult({
        ...failure,
        partialContent: [
          {
            artifact: {
              artifactId: "artifact-1",
              complete: true,
              createdAt: "2026-08-15T00:00:00.000Z",
              expiresAt: null,
              mediaType: "text/plain",
              name: "result.txt",
              sha256: "a".repeat(64),
              size: 12,
              uri: "chrome-artifact://connection/artifact-1/content",
            },
            type: "resource",
          },
        ],
      }),
    ).toThrow();
  });

  test("rejects unknown nested keys", () => {
    expect(() =>
      parseBrokerRpcRequest({
        operation: "select_page",
        payload: { extra: true, targetId: "target-1" },
      }),
    ).toThrow();
  });

  test("rejects malformed optional-looking boundary values instead of replacing them", () => {
    expect(() =>
      parseBrokerToWorkerMessage({
        request: {
          ...workerRequest(),
          dialog: { defaultValue: 1, message: "", modalId: "modal-1", type: "prompt" },
        },
        type: "execute",
      }),
    ).toThrow();
    expect(() =>
      parseBrokerRpcRequest({
        operation: "artifact_publish",
        payload: { data: null, encoding: "utf8", mediaType: "text/plain", name: "result.txt" },
      }),
    ).toThrow();
    expect(() =>
      parseExecutionKernelResult({
        artifacts: [],
        content: null,
        emittedCount: 0,
        ok: true,
        selectedTargetId: "target-1",
        state: [],
      }),
    ).toThrow();
  });
});
