import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type ArtifactDescriptor, type ExecutionWorkerRequest, INLINE_IMAGE_MAX_BYTES } from "./protocol";
import {
  assertSupportedBunVersion,
  createWorkerEnvironment,
  type ExecutionBrokerRpcAdapter,
  type ExecutionDebugLog,
  runExecutionWorker,
} from "./runner";

const fixturePath = resolve(import.meta.dir, "test-fixtures/worker-fixture.ts");

const request = (code: string, callId = "call-1"): ExecutionWorkerRequest => ({
  args: null,
  browserMode: "isolated-headless",
  callId,
  capabilities: {},
  cdpEndpoint: "ws://127.0.0.1/devtools/browser/private",
  code,
  connectTimeoutMs: 1000,
  dialog: null,
  fileChooser: null,
  selectedTargetId: "target-1",
  state: [],
});

const adapter: ExecutionBrokerRpcAdapter = {
  execute: async () => ({ value: { marked: true } }),
};

const brokerArtifact: ArtifactDescriptor = {
  artifactId: "broker-artifact",
  complete: true,
  createdAt: "2026-08-15T00:00:00.000Z",
  expiresAt: null,
  mediaType: "text/plain",
  name: "broker.txt",
  sha256: "b".repeat(64),
  size: 6,
  uri: "chrome-artifact://connection/broker-artifact/content",
};

const runFixture = (
  workerRequest: ExecutionWorkerRequest,
  options?: { onDebugLog?: ExecutionDebugLog; signal?: AbortSignal; timeoutMs?: number },
) =>
  runExecutionWorker({
    adapter,
    onDebugLog: options?.onDebugLog,
    request: workerRequest,
    signal: options?.signal,
    timeoutMs: options?.timeoutMs ?? 2000,
    workerEntrypoint: fixturePath,
  });

describe("Bun execution subprocess runner", () => {
  test("requires Bun 1.4.0 or newer", () => {
    expect(() => assertSupportedBunVersion("1.3.14")).toThrow();
    expect(() => assertSupportedBunVersion("1.4.0")).not.toThrow();
    expect(() => assertSupportedBunVersion("2.0.0")).not.toThrow();
  });

  test("uses a fresh real process for every call", async () => {
    const first = await runFixture(request("pid", "call-1"));
    const second = await runFixture(request("pid", "call-2"));

    expect(first.ok).toBeTrue();
    expect(second.ok).toBeTrue();
    if (!first.ok || !second.ok) throw new Error("Expected successful fixture executions");
    expect(first.value).toHaveProperty("pid");
    expect(second.value).toHaveProperty("pid");
    expect(first.value).not.toEqual(second.value);
  });

  test("relays broker RPC and returns its validated response", async () => {
    const calls: string[] = [];
    const result = await runExecutionWorker({
      adapter: {
        execute: async (rpcRequest) => {
          calls.push(rpcRequest.operation);
          return { value: { ownerGeneration: 2, sequence: 10 } };
        },
      },
      request: request("rpc"),
      timeoutMs: 2000,
      workerEntrypoint: fixturePath,
    });

    expect(result).toMatchObject({ ok: true, value: { ownerGeneration: 2, sequence: 10 } });
    expect(calls).toEqual(["events_mark"]);
  });

  test("hard-kills and reaps a timed-out worker", async () => {
    const result = await runFixture(request("hang"), { timeoutMs: 100 });
    expect(result).toMatchObject({ error: { code: "CHROME_MCP_TIMEOUT" }, ok: false });

    const recovery = await runFixture(request("pid", "call-after-timeout"));
    expect(recovery.ok).toBeTrue();
  });

  test("preserves a completed result when user code leaves a live handle", async () => {
    const result = await runFixture(request("result-with-live-handle"));

    expect(result.ok).toBeTrue();
  });

  test("delivers a large result before the worker exits", async () => {
    let workerStderr = "";
    let workerStdout = "";
    const result = await runFixture(request("large-result"), {
      onDebugLog: ({ stderr, stdout }) => {
        workerStderr = stderr;
        workerStdout = stdout;
      },
    });

    if (!result.ok) throw new Error(`${result.error.message}; worker stderr: ${workerStderr}`);
    expect(result.value).toBe("large-result");
    const image = result.content[0];
    expect(image?.type).toBe("image");
    if (image?.type !== "image") throw new Error("Expected an inline image fixture result");
    expect(Buffer.from(image.data, "base64")).toHaveLength(INLINE_IMAGE_MAX_BYTES);
    expect(workerStdout).toContain("large result acknowledged");
  });

  test("hard-kills on cancellation and distinguishes it from timeout", async () => {
    const cancellation = new AbortController();
    setTimeout(() => cancellation.abort(), 25);
    const result = await runFixture(request("hang"), { signal: cancellation.signal, timeoutMs: 2000 });
    expect(result).toMatchObject({ error: { code: "CHROME_MCP_CANCELLED" }, ok: false });
  });

  test("reports an unexpected process exit as a worker crash", async () => {
    const result = await runFixture(request("crash"));
    expect(result).toMatchObject({ error: { code: "CHROME_MCP_WORKER_CRASH" }, ok: false });
  });

  test("aborts in-flight broker adapters after a terminal worker result", async () => {
    let adapterWasAborted = false;
    const result = await runExecutionWorker({
      adapter: {
        execute: async (_rpcRequest, context) =>
          new Promise((resolvePromise) => {
            context.signal.addEventListener(
              "abort",
              () => {
                adapterWasAborted = true;
                resolvePromise({ value: null });
              },
              { once: true },
            );
          }),
      },
      request: request("rpc-pending-result"),
      timeoutMs: 2000,
      workerEntrypoint: fixturePath,
    });

    expect(result.ok).toBeTrue();
    expect(adapterWasAborted).toBeTrue();
  });

  test("rejects worker artifacts that the broker did not issue", async () => {
    const result = await runFixture(request("forged-artifact"));
    expect(result).toMatchObject({ error: { code: "CHROME_MCP_INVALID_INPUT" }, ok: false });
  });

  test("rejects a result that omits an artifact issued by the broker", async () => {
    const result = await runExecutionWorker({
      adapter: {
        execute: async () => ({ artifacts: [brokerArtifact], value: null }),
      },
      request: request("rpc"),
      timeoutMs: 2000,
      workerEntrypoint: fixturePath,
    });

    expect(result).toMatchObject({ error: { code: "CHROME_MCP_INVALID_INPUT" }, ok: false });
  });

  test("captures worker console output only through the debug observer", async () => {
    let observed = "";
    const result = await runExecutionWorker({
      adapter,
      onDebugLog: ({ stdout }) => {
        observed = stdout;
      },
      request: request("log"),
      timeoutMs: 2000,
      workerEntrypoint: fixturePath,
    });

    expect(result.ok).toBeTrue();
    expect(observed).toContain("fixture output");
    expect(JSON.stringify(result)).not.toContain("fixture output");
  });

  test("builds a minimal process environment without inherited credentials", () => {
    const environment = createWorkerEnvironment({
      AWS_SECRET_ACCESS_KEY: "secret",
      HOME: "/home/test",
      PATH: "/bin",
      XDG_RUNTIME_DIR: "/tmp/runtime",
    });
    expect(environment).toEqual({
      HOME: "/home/test",
      NO_COLOR: "1",
      PATH: "/bin",
      XDG_RUNTIME_DIR: "/tmp/runtime",
    });
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });
});
