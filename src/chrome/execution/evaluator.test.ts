import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import type { ExecutionBrowserSession } from "./helpers";
import { ChromeMcpExecutionError, serializeExecutionError } from "./errors";
import { executeWorkerRequest, type ExecutionBrowserConnector } from "./evaluator";
import { canonicalJsonStringify, copyJsonValue, type JsonValue } from "./json";
import {
  type ArtifactDescriptor,
  type BrokerRpcRequest,
  type BrokerRpcSuccess,
  type ExecutionWorkerRequest,
  INLINE_IMAGE_MAX_TOTAL_BYTES,
  INLINE_TEXT_MAX_BYTES,
  parseExecutionKernelResult,
  type WorkerToBrokerMessage,
} from "./protocol";
import { createExecutionRpcClient, type ExecutionRpcClient } from "./rpc-client";

const artifact = (name = "result.json"): ArtifactDescriptor => ({
  artifactId: `artifact-${name}`,
  complete: true,
  createdAt: "2026-08-15T00:00:00.000Z",
  expiresAt: "2026-08-15T01:00:00.000Z",
  mediaType: name.endsWith(".json") ? "application/json" : "text/plain",
  name,
  sha256: "a".repeat(64),
  size: 12,
  uri: `chrome-artifact://connection/artifact-${name}/content`,
});

const request = (code: string): ExecutionWorkerRequest => ({
  args: { start: 2 },
  browserMode: "isolated",
  callId: "call-1",
  capabilities: { selectedTargetId: "target-1" },
  cdpEndpoint: "ws://127.0.0.1/devtools/browser/private-token",
  code,
  connectTimeoutMs: 1000,
  dialog: {
    defaultValue: "default",
    message: "Continue?",
    modalId: "dialog-1",
    type: "prompt",
  },
  fileChooser: {
    accept: ".txt",
    isMultiple: false,
    modalId: "chooser-1",
  },
  selectedTargetId: "target-1",
  state: [["existing", true]],
});

type RpcHandler = (request: BrokerRpcRequest) => BrokerRpcSuccess | Promise<BrokerRpcSuccess>;

const rpcHarness = (handler: RpcHandler) => {
  const messages: WorkerToBrokerMessage[] = [];
  const rpc: ExecutionRpcClient = createExecutionRpcClient("call-1", (message) => {
    messages.push(message);
    if (message.type !== "rpc_request") return;
    Promise.resolve(handler(message.request)).then(
      (response) => rpc.handleResponse(message.rpcId, response),
      (error: unknown) =>
        rpc.handleResponse(message.rpcId, {
          error: {
            code: "CHROME_MCP_INVALID_INPUT",
            message: error instanceof Error ? error.message : String(error),
            name: "Error",
          },
          ok: false,
        }),
    );
  });
  return { messages, rpc };
};

const createFakeConnector = () => {
  const secondPage = { kind: "second-page" };
  const page = { kind: "page", secondPage };
  const context = { kind: "context" };
  const browser = { kind: "browser" };
  const locators: unknown[] = [];
  let disconnectCount = 0;
  let markerCount = 0;
  let restoreCount = 0;

  const session: ExecutionBrowserSession & { disconnect: () => Promise<void> } = {
    browser,
    context,
    evaluateWorker: async () => null,
    disconnect: async () => {
      disconnectCount += 1;
    },
    locatorFromRecipe: async (recipe) => {
      const locator = { ...recipe };
      locators.push(locator);
      return locator;
    },
    markSnapshotRoot: async () => {
      markerCount += 1;
      return async () => {
        restoreCount += 1;
      };
    },
    page,
    pageForTarget: (targetId) => {
      if (targetId === "target-1") return Promise.resolve(page);
      if (targetId === "target-2") return Promise.resolve(secondPage);

      return Promise.reject(new ChromeMcpExecutionError("CHROME_MCP_PAGE_CLOSED", "Unknown page"));
    },
    targetIdForPage: async (candidate) => {
      if (candidate === page) return "target-1";
      if (candidate === secondPage) return "target-2";
      throw new ChromeMcpExecutionError("CHROME_MCP_FOREIGN_PAGE", "Foreign page");
    },
  };
  const connect: ExecutionBrowserConnector = async () => session;
  return {
    connect,
    counts: () => ({ disconnectCount, markerCount, restoreCount }),
    locators,
    session,
  };
};

const emptyRpcResponse = (value: JsonValue = null): BrokerRpcSuccess => ({ artifacts: [], ok: true, value });

describe("execution evaluator", () => {
  test("preserves capture and checkpoint error codes across the worker boundary", () => {
    for (const code of [
      "CHROME_MCP_CAPTURE_NOT_FOUND",
      "CHROME_MCP_CAPTURE_INVALID_OPTIONS",
      "CHROME_MCP_CAPTURE_FINALIZE_FAILED",
      "CHROME_MCP_CHECKPOINT_NOT_FOUND",
      "CHROME_MCP_CHECKPOINT_INVALID_OPTIONS",
    ] as const) {
      expect(
        serializeExecutionError({ code, message: "domain failure" }, "CHROME_MCP_EXECUTION_FAILED"),
      ).toMatchObject({
        code,
        message: "domain failure",
      });
    }
  });

  test("maps private broker and runtime codes to stable public execution codes", () => {
    const expected = {
      CHROME_MCP_BROKER_CANCELED: "CHROME_MCP_CANCELLED",
      CHROME_MCP_BROKER_CLOSED: "CHROME_MCP_BROWSER_DISCONNECTED",
      CHROME_MCP_BROKER_DEADLINE: "CHROME_MCP_TIMEOUT",
      CHROME_MCP_BROKER_INVALID_REQUEST: "CHROME_MCP_WORKER_CRASH",
      CHROME_MCP_BROKER_UNAVAILABLE: "CHROME_MCP_BROWSER_DISCONNECTED",
      CHROME_MCP_INVALID_MODE: "CHROME_MCP_INVALID_INPUT",
      CHROME_MCP_INVALID_PROFILE_METADATA: "CHROME_MCP_PROFILE_IN_USE",
      CHROME_MCP_OWNER_CLOSED: "CHROME_MCP_BROWSER_DISCONNECTED",
      CHROME_MCP_PROFILE_LEASE_LOST: "CHROME_MCP_BROWSER_DISCONNECTED",
      CHROME_MCP_STALE_TARGET: "CHROME_MCP_PAGE_CLOSED",
      CHROME_MCP_UNKNOWN_TARGET: "CHROME_MCP_PAGE_CLOSED",
    } as const;

    for (const [code, publicCode] of Object.entries(expected)) {
      expect(
        serializeExecutionError({ code, message: "internal failure" }, "CHROME_MCP_EXECUTION_FAILED").code,
      ).toBe(publicCode);
    }
  });

  test("prebinds genuine page, context, browser, args, and chrome values", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(
      request(`
        if (page.kind !== "page" || context.kind !== "context" || browser.kind !== "browser") throw new Error("bad binding");
        chrome.setSessionStateValue("count", args.start + 1);
        chrome.emitTextResult("emitted first");
        return { count: chrome.getSessionStateValue("count"), existing: chrome.getSessionStateValue("existing") };
      `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result).toMatchObject({
      content: [{ text: "emitted first", type: "text" }],
      emittedCount: 1,
      ok: true,
      selectedTargetId: "target-1",
      state: [
        ["existing", true],
        ["count", 3],
      ],
      value: { count: 3, existing: true },
    });
    expect(fake.counts().disconnectCount).toBe(1);
  });

  test("omits undefined object properties from returned values without changing defined values", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(
      request(`return {
        missing: undefined,
        nested: { missing: undefined, kept: null, count: 0, enabled: false, text: "" },
        constructor: "data",
        negativeZero: -0,
      };`),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toStrictEqual({
      nested: { kept: null, count: 0, enabled: false, text: "" },
      constructor: "data",
      negativeZero: -0,
    });
  });

  test("preserves __proto__ as JSON data through copying and canonical serialization", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(request(`return JSON.parse('{"__proto__":{"count":3}}');`), {
      connect: fake.connect,
      rpc: harness.rpc,
    });
    assert(result.ok, "JSON evaluation failed");

    const value = result.value;
    assert(value !== undefined, "JSON result missing");
    expect(value).toStrictEqual({ ["__proto__"]: { count: 3 } });

    expect(canonicalJsonStringify(value)).toBe('{"__proto__":{"count":3}}');
  });

  test("returns undefined array entries as null without shifting positions", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(
      request('return [undefined, { missing: undefined, items: [1, undefined, 3] }, null, false, 0, ""];'),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toStrictEqual([null, { items: [1, null, 3] }, null, false, 0, ""]);
  });

  test("keeps an undefined top-level return as a successful result without a value", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(request("return undefined;"), {
      connect: fake.connect,
      rpc: harness.rpc,
    });

    expect(result.ok).toBeTrue();
    expect(result).not.toHaveProperty("value");
  });

  test("returns nested numeric typed arrays as arrays without calling custom serializers or iterators", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(
      request(`
        const values = new Float64Array([99, -0, 1.25, -3.5, 99]).subarray(1, 4);
        values[Symbol.iterator] = () => { throw new Error("custom iterator must not run"); };
        values.toJSON = () => { throw new Error("custom serializer must not run"); };
        Object.defineProperty(values, "length", { get() { throw new Error("custom getter must not run"); } });
        return { metrics: [{ values }], bytes: Buffer.from([0, 255]), empty: new Float32Array() };
      `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toStrictEqual({
      metrics: [{ values: [-0, 1.25, -3.5] }],
      bytes: [0, 255],
      empty: [],
    });
  });

  test("returns every numeric typed-array type directly when it is not image bytes", async () => {
    for (const constructor of [
      "Int8Array",
      "Uint8Array",
      "Uint8ClampedArray",
      "Int16Array",
      "Uint16Array",
      "Int32Array",
      "Uint32Array",
      "Float16Array",
      "Float32Array",
      "Float64Array",
      "Buffer",
    ]) {
      const fake = createFakeConnector();
      const harness = rpcHarness(() => emptyRpcResponse());
      const expression =
        constructor === "Buffer" ? "Buffer.from([0, 2, 127])" : `new ${constructor}([0, 2, 127])`;
      const result = await executeWorkerRequest(request(`return ${expression};`), {
        connect: fake.connect,
        rpc: harness.rpc,
      });

      expect(result).toMatchObject({ ok: true, value: [0, 2, 127] });
      expect(result).not.toHaveProperty("valueImage");
    }
  });

  test("reports the exact non-finite typed-array entry without silently changing it", async () => {
    for (const value of ["NaN", "Infinity", "-Infinity"]) {
      const fake = createFakeConnector();
      const harness = rpcHarness(() => emptyRpcResponse());
      const result = await executeWorkerRequest(
        request(`return { metrics: new Float64Array([1, ${value}]) };`),
        {
          connect: fake.connect,
          rpc: harness.rpc,
        },
      );

      expect(result.ok).toBeFalse();
      if (result.ok) throw new Error("Non-finite measurement was accepted");
      expect(result.error.code).toBe("CHROME_MCP_INVALID_INPUT");
      expect(result.error.message).toContain(
        `Playwright return value.metrics[1] contains non-finite number ${value}`,
      );
    }
  });

  test("reports a detached typed-array buffer instead of returning an empty measurement array", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(
      request(`
      const values = new Float64Array([1, 2]);
      structuredClone(values.buffer, { transfer: [values.buffer] });
      return { metrics: values };
    `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error("Detached measurements were accepted");
    expect(result.error.code).toBe("CHROME_MCP_INVALID_INPUT");
    expect(result.error.message).toContain(
      "Playwright return value.metrics contains an unreadable typed array",
    );
    expect(result.error.message).toContain("before transferring or resizing the buffer");
  });

  test("keeps typed arrays out of args and transactional session state", async () => {
    expect(() => copyJsonValue({ values: new Float64Array([1]) }, "Playwright args")).toThrow(
      "must not contain typed arrays or class instances",
    );
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(
      request('chrome.setSessionStateValue("measurements", new Float64Array([1]));'),
      {
        connect: fake.connect,
        rpc: harness.rpc,
      },
    );

    expect(result).toMatchObject({ error: { code: "CHROME_MCP_INVALID_STATE" }, ok: false });
    expect(result).not.toHaveProperty("state");
    if (result.ok) throw new Error("Typed-array state was accepted");
    expect(result.error.message).not.toContain("Playwright code completed");
  });

  test("identifies ambiguous result types and gives explicit conversion advice without calling custom code", async () => {
    for (const { expression, type, advice } of [
      {
        expression: "new BigInt64Array()",
        type: "BigInt64Array",
        advice: "Array.from(value, item => item.toString())",
      },
      {
        expression: "new BigUint64Array([9007199254740993n])",
        type: "BigUint64Array",
        advice: "decimal strings",
      },
      {
        expression: "new DataView(new ArrayBuffer(8))",
        type: "DataView",
        advice: "byte or numeric interpretation",
      },
      { expression: "new ArrayBuffer(8)", type: "ArrayBuffer", advice: "byte or numeric interpretation" },
      {
        expression:
          'new (class Measurement { toJSON() { throw new Error("custom serializer must not run"); } })()',
        type: "Measurement",
        advice: "plain JSON object",
      },
    ]) {
      const fake = createFakeConnector();
      const harness = rpcHarness(() => emptyRpcResponse());
      const result = await executeWorkerRequest(
        request(`
        page.measurementComplete = true;
        chrome.emitTextResult("measurements collected");
        chrome.setSessionStateValue("uncommitted", true);
        await chrome.selectPageForSession(page.secondPage);
        return { metrics: { values: ${expression} } };
      `),
        { connect: fake.connect, rpc: harness.rpc },
      );

      expect(result).toMatchObject({
        error: { code: "CHROME_MCP_INVALID_INPUT" },
        ok: false,
        partialContent: [{ text: "measurements collected", type: "text" }],
        selectedTargetId: "target-1",
      });
      if (result.ok) throw new Error("Ambiguous result was accepted");
      expect(result.error.message).toContain(
        `Playwright return value.metrics.values contains unsupported ${type}`,
      );
      expect(result.error.message).toContain(advice);
      expect(result.error.message).toContain("Playwright code completed");
      expect(result.error.message).toContain("Browser actions were not undone");
      expect(result.error.message).not.toContain("custom serializer must not run");
      expect(result).not.toHaveProperty("state");
      expect(fake.session.page).toMatchObject({ measurementComplete: true });
    }
  });

  test("exposes action-named helper functions without the ambiguous aliases", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(
      request(`
        const actionNames = [
          "captureAccessibilitySnapshot",
          "clearSessionState",
          "deleteSessionStateValue",
          "emitImageResult",
          "emitTextResult",
          "getSessionStateValue",
          "listSessionStateEntries",
          "publishFileArtifact",
          "reportCallProgress",
          "reserveArtifactOutputPath",
          "resolveSnapshotRefToLocator",
          "selectPageForSession",
          "setSessionStateValue",
        ];
        const ambiguousNames = ["file", "image", "locator", "outputPath", "progress", "selectPage", "snapshot", "state", "text"];
        return {
          actionFunctions: actionNames.filter((name) => typeof chrome[name] === "function"),
          ambiguousAliases: ambiguousNames.filter((name) => name in chrome),
        };
      `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        actionFunctions: [
          "captureAccessibilitySnapshot",
          "clearSessionState",
          "deleteSessionStateValue",
          "emitImageResult",
          "emitTextResult",
          "getSessionStateValue",
          "listSessionStateEntries",
          "publishFileArtifact",
          "reportCallProgress",
          "reserveArtifactOutputPath",
          "resolveSnapshotRefToLocator",
          "selectPageForSession",
          "setSessionStateValue",
        ],
        ambiguousAliases: [],
      },
    });
  });

  test("does not expose the superseded mcp helper binding", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(request("return typeof mcp;"), {
      connect: fake.connect,
      rpc: harness.rpc,
    });

    expect(result).toMatchObject({ ok: true, value: "undefined" });
  });

  test("executes with direct Bun host globals instead of claiming isolation", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(
      request("return { bunVersion: Bun.version, processId: process.pid };"),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result).toMatchObject({
      ok: true,
      value: { bunVersion: Bun.version, processId: process.pid },
    });
  });

  test("stages an explicitly selected page only on success", async () => {
    const fake = createFakeConnector();
    const requests: BrokerRpcRequest[] = [];
    const harness = rpcHarness((rpcRequest) => {
      requests.push(rpcRequest);
      return emptyRpcResponse();
    });
    const result = await executeWorkerRequest(
      request("await chrome.selectPageForSession(page.secondPage); return page.secondPage.kind;"),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result).toMatchObject({ ok: true, selectedTargetId: "target-2", value: "second-page" });
    expect(requests).toContainEqual({ operation: "select_page", payload: { targetId: "target-2" } });
  });

  test("returns a frozen capabilities snapshot with the current same-call selection", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(
      request(`
        const before = chrome.capabilities;
        await chrome.selectPageForSession(page.secondPage);
        const after = chrome.capabilities;
        return {
          afterFrozen: Object.isFrozen(after),
          afterTarget: after.selectedTargetId,
          beforeFrozen: Object.isFrozen(before),
          beforeTarget: before.selectedTargetId,
          sameObject: before === after,
        };
      `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        afterFrozen: true,
        afterTarget: "target-2",
        beforeFrozen: true,
        beforeTarget: "target-1",
        sameObject: false,
      },
    });
  });

  test("exposes persistent route, init script, and binding registries through broker RPC", async () => {
    const fake = createFakeConnector();
    const requests: BrokerRpcRequest[] = [];
    const entries = new Map<string, JsonValue[]>();
    const harness = rpcHarness((rpcRequest) => {
      requests.push(rpcRequest);
      if (rpcRequest.operation === "mutation_add") {
        const entry = { ...rpcRequest.payload.input, id: `${rpcRequest.payload.input.kind}-1` };
        entries.set(rpcRequest.payload.input.kind, [entry]);
        return emptyRpcResponse(entry);
      }
      if (rpcRequest.operation === "mutation_list") {
        return emptyRpcResponse(entries.get(rpcRequest.payload.kind) ?? []);
      }
      if (rpcRequest.operation === "mutation_remove") return emptyRpcResponse(true);
      if (rpcRequest.operation === "mutation_clear") return emptyRpcResponse(1);
      return emptyRpcResponse();
    });
    const result = await executeWorkerRequest(
      request(`
        const route = await chrome.routes.add({
          action: { body: "stubbed", headers: { "content-type": "text/plain" }, status: 201, type: "fulfill" },
          method: "get",
          urlPattern: "**/api/data",
        });
        const initScript = await chrome.initScripts.add("globalThis.__persistent = true");
        const binding = await chrome.bindings.add({ name: "hostValue", source: "(value) => ({ value })" });
        const listed = [await chrome.routes.list(), await chrome.initScripts.list(), await chrome.bindings.list()];
        const removed = await chrome.routes.remove(route.id);
        const cleared = await chrome.bindings.clear();
        return { binding, cleared, initScript, listed, removed, route };
      `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        binding: { id: "binding-1", kind: "binding", name: "hostValue" },
        cleared: 1,
        initScript: { id: "initScript-1", kind: "initScript" },
        removed: true,
        route: { id: "route-1", kind: "route", method: "GET" },
      },
    });
    expect(requests.map((item) => item.operation)).toEqual([
      "mutation_add",
      "mutation_add",
      "mutation_add",
      "mutation_list",
      "mutation_list",
      "mutation_list",
      "mutation_remove",
      "mutation_clear",
    ]);
  });

  test("exercises the broker seams for events, modals, snapshots, locators, captures, checkpoints, and artifacts", async () => {
    const fake = createFakeConnector();
    const requests: BrokerRpcRequest[] = [];
    const harness = rpcHarness((rpcRequest) => {
      requests.push(rpcRequest);
      if (rpcRequest.operation === "artifact_output_path") return emptyRpcResponse("/tmp/owned-output.txt");
      if (rpcRequest.operation === "artifact_file") {
        const descriptor = artifact("owned-output.txt");
        return { artifacts: [descriptor], ok: true, value: descriptor };
      }
      if (rpcRequest.operation === "locator_resolve") {
        return emptyRpcResponse({
          frameChain: ["#outer-frame", "iframe[name=inner]"],
          selector: "#submit",
          targetId: "target-1",
        });
      }
      return emptyRpcResponse({ operation: rpcRequest.operation });
    });
    const result = await executeWorkerRequest(
      request(`
        const mark = await chrome.events.mark();
        const events = await chrome.events.read({ limit: 10, target: "selected" });
        await chrome.dialog.accept("yes");
        await chrome.fileChooser.setFiles({ name: "a.txt", mimeType: "text/plain", buffer: new Uint8Array([65]) });
        const snapshot = await chrome.captureAccessibilitySnapshot({ root: { fake: true }, depth: 4 });
        const locator = await chrome.resolveSnapshotRefToLocator("s1e1");
        const capture = await chrome.capture.start({ type: "trace" });
        await chrome.capture.stop("capture-1");
        await chrome.checkpoint.create({ screenshot: true });
        await chrome.checkpoint.diff("checkpoint-1", { events: true });
        await chrome.reportCallProgress("half", 1, 2);
        const path = await chrome.reserveArtifactOutputPath("owned-output.txt", "text/plain");
        await chrome.publishFileArtifact(path, "text/plain");
        return { capture, events, locator, mark, snapshot };
      `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.content).toContainEqual({ artifact: artifact("owned-output.txt"), type: "resource" });
    expect(fake.counts()).toEqual({ disconnectCount: 1, markerCount: 1, restoreCount: 1 });
    expect(fake.locators).toEqual([
      {
        frameChain: ["#outer-frame", "iframe[name=inner]"],
        selector: "#submit",
        targetId: "target-1",
      },
    ]);
    expect(requests.map((item) => item.operation)).toEqual([
      "events_mark",
      "events_read",
      "dialog_accept",
      "file_chooser_set_files",
      "snapshot",
      "locator_resolve",
      "capture_start",
      "capture_stop",
      "checkpoint_create",
      "checkpoint_diff",
      "progress",
      "artifact_output_path",
      "artifact_file",
    ]);
  });

  test("rejects a locator recipe without an explicit frame chain", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness((rpcRequest) =>
      rpcRequest.operation === "locator_resolve" ?
        emptyRpcResponse({ selector: "#submit", targetId: "target-1" })
      : emptyRpcResponse(),
    );

    const result = await executeWorkerRequest(
      request('return await chrome.resolveSnapshotRefToLocator("s1e1");'),
      {
        connect: fake.connect,
        rpc: harness.rpc,
      },
    );

    expect(result).toMatchObject({
      error: { code: "CHROME_MCP_INVALID_INPUT" },
      ok: false,
    });
    expect(fake.locators).toEqual([]);
  });

  test("rejects the removed snapshot includeHidden option before broker RPC", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());

    const result = await executeWorkerRequest(
      request("return await chrome.captureAccessibilitySnapshot({ includeHidden: true });"),
      {
        connect: fake.connect,
        rpc: harness.rpc,
      },
    );

    expect(result).toMatchObject({ error: { code: "CHROME_MCP_INVALID_INPUT" }, ok: false });
    expect(harness.messages).toEqual([]);
  });

  test.each(["bounded", "full"])("forwards the explicit %s snapshot view", async (view) => {
    const fake = createFakeConnector();
    const harness = rpcHarness((input) => {
      if (input.operation !== "snapshot") throw new Error("Expected a snapshot request");
      return emptyRpcResponse(input.payload.options);
    });
    const result = await executeWorkerRequest(
      request(`return await chrome.captureAccessibilitySnapshot({ view: ${JSON.stringify(view)} });`),
      { connect: fake.connect, rpc: harness.rpc },
    );
    expect(result).toMatchObject({ ok: true, value: { view } });
  });

  test("rejects an invalid snapshot view before broker RPC", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(
      request('return await chrome.captureAccessibilitySnapshot({ view: "unknown" });'),
      { connect: fake.connect, rpc: harness.rpc },
    );
    expect(result).toMatchObject({ error: { code: "CHROME_MCP_INVALID_INPUT" }, ok: false });
    expect(harness.messages).toEqual([]);
  });

  test("rejects file chooser options rather than discarding them", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());

    const result = await executeWorkerRequest(
      request('return await chrome.fileChooser.setFiles("/tmp/a.txt", { timeout: 1 });'),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result).toMatchObject({
      error: {
        code: "CHROME_MCP_INVALID_INPUT",
      },
      ok: false,
    });
    expect(harness.messages).toEqual([]);
  });

  test("rejects malformed or extended locator recipes at the worker boundary", async () => {
    const invalidRecipes: JsonValue[] = [
      { frameChain: "iframe", selector: "#submit", targetId: "target-1" },
      { frameChain: [""], selector: "#submit", targetId: "target-1" },
      { frameChain: [], selector: "#submit", targetId: "target-1", unknown: true },
    ];
    for (const value of invalidRecipes) {
      const fake = createFakeConnector();
      const harness = rpcHarness((rpcRequest) =>
        rpcRequest.operation === "locator_resolve" ? emptyRpcResponse(value) : emptyRpcResponse(),
      );

      const result = await executeWorkerRequest(
        request('return await chrome.resolveSnapshotRefToLocator("s1e1");'),
        {
          connect: fake.connect,
          rpc: harness.rpc,
        },
      );

      expect(result).toMatchObject({ error: { code: "CHROME_MCP_INVALID_INPUT" }, ok: false });
      expect(fake.locators).toEqual([]);
    }
  });

  test("rejects malformed code before connecting to Playwright", async () => {
    let connectCount = 0;
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(request("return ("), {
      connect: async () => {
        connectCount += 1;
        return createFakeConnector().connect(request("return 1;"));
      },
      rpc: harness.rpc,
    });

    expect(result).toMatchObject({ error: { code: "CHROME_MCP_MALFORMED_CODE" }, ok: false });
    expect(connectCount).toBe(0);
  });

  test("discards transactional state and selection after user-code failure", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(
      request(`
        chrome.setSessionStateValue("not-committed", true);
        await chrome.selectPageForSession(page.secondPage);
        throw new Error("failed at ${"ws://127.0.0.1/devtools/browser/private-token"}");
      `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result).toMatchObject({
      error: { code: "CHROME_MCP_EXECUTION_FAILED" },
      ok: false,
      selectedTargetId: "target-1",
    });
    if (result.ok) throw new Error("Expected failure");
    expect(result.error.stack).toContain("chrome-mcp-user-code.js:4:");
    expect(result.error.stack).not.toContain("private-token");
    expect(result).not.toHaveProperty("state");
  });

  test("uses explicit session-state verbs and keeps prior emitted output after a later failure", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(
      request(`
        chrome.emitTextResult("measurement complete");
        chrome.setSessionStateValue("docUrl", "https://example.test");
        throw new Error("late failure");
      `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result).toMatchObject({
      error: {
        code: "CHROME_MCP_EXECUTION_FAILED",
      },
      ok: false,
      partialContent: [{ text: "measurement complete", type: "text" }],
      partialEmittedCount: 1,
      partialOmittedCount: 0,
    });
    expect(result).not.toHaveProperty("state");
  });

  test("rejects an image label in place of media options", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(
      request(
        'chrome.emitImageResult(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), "zoom-6400-percent");',
      ),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result).toMatchObject({
      error: {
        code: "CHROME_MCP_INVALID_INPUT",
      },
      ok: false,
    });
  });

  test("keeps only the bounded prefix of emitted content after a handled failure", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(
      request(`
        chrome.emitTextResult("keep");
        chrome.emitTextResult("x".repeat(${INLINE_TEXT_MAX_BYTES}));
        chrome.emitTextResult("after-overflow");
        throw new Error("late failure");
      `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result).toMatchObject({
      error: { code: "CHROME_MCP_EXECUTION_FAILED" },
      ok: false,
      partialContent: [{ text: "keep", type: "text" }],
      partialEmittedCount: 1,
      partialOmittedCount: 2,
    });
  });

  test("keeps result validation and browser connection failures distinct from user-code failures", async () => {
    for (const code of [
      "return Symbol('not-json');",
      "return { value: () => 1 };",
      "return { value: 1n };",
      "return { value: NaN };",
      "return { value: new Date() };",
      "const value = {}; value.self = value; return value;",
      "return [1, , 3];",
      "return { [Symbol('key')]: true };",
      'return { get value() { throw new Error("getter must not run"); } };',
    ]) {
      const invalidResultFake = createFakeConnector();
      const invalidResultHarness = rpcHarness(() => emptyRpcResponse());
      const invalidResult = await executeWorkerRequest(request(code), {
        connect: invalidResultFake.connect,
        rpc: invalidResultHarness.rpc,
      });
      expect(invalidResult).toMatchObject({ error: { code: "CHROME_MCP_INVALID_INPUT" }, ok: false });
      if (invalidResult.ok) throw new Error("Unsupported return value was accepted");
      expect(invalidResult.error.message).not.toContain("getter must not run");
    }

    const disconnectedHarness = rpcHarness(() => emptyRpcResponse());
    const disconnected = await executeWorkerRequest(request("return true;"), {
      connect: async () => {
        throw new Error("Connection closed");
      },
      rpc: disconnectedHarness.rpc,
    });
    expect(disconnected).toMatchObject({ error: { code: "CHROME_MCP_BROWSER_DISCONNECTED" }, ok: false });
  });

  test("preserves a stable helper failure raised while user code is running", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const result = await executeWorkerRequest(request("await chrome.selectPageForSession({});"), {
      connect: fake.connect,
      rpc: harness.rpc,
    });

    expect(result).toMatchObject({ error: { code: "CHROME_MCP_FOREIGN_PAGE" }, ok: false });
  });

  test("promotes oversized JSON and text without truncation", async () => {
    const fake = createFakeConnector();
    const published: BrokerRpcRequest[] = [];
    const harness = rpcHarness((rpcRequest) => {
      if (rpcRequest.operation !== "artifact_publish") return emptyRpcResponse();
      published.push(rpcRequest);
      const descriptor = artifact(rpcRequest.payload.name);
      return { artifacts: [descriptor], ok: true, value: descriptor };
    });
    const result = await executeWorkerRequest(
      request(`
        chrome.emitTextResult("t".repeat(${INLINE_TEXT_MAX_BYTES + 1}));
        return { missing: undefined, items: [undefined], value: new Float64Array(${INLINE_TEXT_MAX_BYTES}).fill(1.25) };
      `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.content[0]?.type).toBe("resource");
    expect(result.valueArtifact?.name).toBe("playwright-result.json");
    expect(published).toHaveLength(2);
    expect(published[0]).toMatchObject({
      operation: "artifact_publish",
      payload: { encoding: "utf8", mediaType: "text/plain" },
    });
    const jsonPublication = published[1];
    if (!jsonPublication || jsonPublication.operation !== "artifact_publish") {
      throw new Error("JSON artifact was not published");
    }
    expect(JSON.parse(jsonPublication.payload.data)).toStrictEqual({
      items: [null],
      value: Array.from({ length: INLINE_TEXT_MAX_BYTES }, () => 1.25),
    });
  });

  test("returns a direct image and cancels an unawaited helper request", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness(
      () =>
        new Promise<BrokerRpcSuccess>(() => {
          // The request intentionally remains pending until execution finalization cancels it.
        }),
    );
    const result = await executeWorkerRequest(
      request(`
        chrome.events.read();
        return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result).toMatchObject({ ok: true, valueImage: { mediaType: "image/png" } });
    expect(harness.messages.some((message) => message.type === "rpc_cancel")).toBeTrue();
  });

  test("keeps supported direct image signatures as images and wrapped image bytes as numeric data", async () => {
    for (const [mediaType, bytes] of [
      ["image/png", [137, 80, 78, 71, 13, 10, 26, 10]],
      ["image/jpeg", [255, 216, 255]],
      ["image/webp", [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]],
    ] as const) {
      for (const expression of [
        `new Uint8Array(${JSON.stringify(bytes)})`,
        `Buffer.from(${JSON.stringify(bytes)})`,
      ]) {
        const fake = createFakeConnector();
        const harness = rpcHarness(() => emptyRpcResponse());
        const direct = await executeWorkerRequest(request(`return ${expression};`), {
          connect: fake.connect,
          rpc: harness.rpc,
        });
        expect(direct).toMatchObject({
          ok: true,
          valueImage: { mediaType, data: Buffer.from(bytes).toString("base64") },
        });
        expect(direct).not.toHaveProperty("value");

        const wrapped = await executeWorkerRequest(request(`return { values: ${expression} };`), {
          connect: fake.connect,
          rpc: harness.rpc,
        });
        expect(wrapped).toMatchObject({ ok: true, value: { values: [...bytes] } });
        expect(wrapped).not.toHaveProperty("valueImage");
      }
    }

    const fake = createFakeConnector();
    const harness = rpcHarness(() => emptyRpcResponse());
    const emitted = await executeWorkerRequest(
      request("chrome.emitImageResult(new Uint8Array([1, 2, 3]));"),
      {
        connect: fake.connect,
        rpc: harness.rpc,
      },
    );
    expect(emitted).toMatchObject({ error: { code: "CHROME_MCP_INVALID_INPUT" }, ok: false });
  });

  test("does not start helper RPC after call completion", async () => {
    const fake = createFakeConnector();
    const requests: BrokerRpcRequest[] = [];
    const harness = rpcHarness((rpcRequest) => {
      requests.push(rpcRequest);
      return emptyRpcResponse();
    });
    let resolveTargetId: ((targetId: string) => void) | undefined;
    const targetId = new Promise<string>((resolve) => {
      resolveTargetId = resolve;
    });
    const connect: ExecutionBrowserConnector = async (workerRequest) => {
      const session = await fake.connect(workerRequest);
      return { ...session, targetIdForPage: async () => targetId };
    };
    const result = await executeWorkerRequest(
      request("chrome.selectPageForSession(page.secondPage); return 'completed';"),
      { connect, rpc: harness.rpc },
    );

    expect(result).toMatchObject({ ok: true, selectedTargetId: "target-1", value: "completed" });
    if (!resolveTargetId) throw new Error("Target resolver was not initialized");
    resolveTargetId("target-2");
    await targetId;
    await Promise.resolve();
    expect(requests).toEqual([]);
  });

  test("restores a rooted snapshot marker when the helper is not awaited", async () => {
    const fake = createFakeConnector();
    const requests: BrokerRpcRequest[] = [];
    const harness = rpcHarness((rpcRequest) => {
      requests.push(rpcRequest);
      return emptyRpcResponse();
    });
    const markerStarted = Promise.withResolvers<void>();
    const markerRelease = Promise.withResolvers<void>();
    const connect: ExecutionBrowserConnector = async () => ({
      ...fake.session,
      markSnapshotRoot: async (locator, token) => {
        markerStarted.resolve();
        await markerRelease.promise;
        return fake.session.markSnapshotRoot(locator, token);
      },
    });
    const execution = executeWorkerRequest(
      request("chrome.captureAccessibilitySnapshot({ root: { fake: true } }); return 'completed';"),
      { connect, rpc: harness.rpc },
    );
    await markerStarted.promise;
    markerRelease.resolve();
    const result = await execution;

    expect(result).toMatchObject({ ok: true, value: "completed" });
    expect(fake.counts()).toEqual({ disconnectCount: 1, markerCount: 1, restoreCount: 1 });
    expect(requests).toEqual([]);
  });

  test("uses independent attributes for concurrent snapshots of the same root", async () => {
    const fake = createFakeConnector();
    const requests: BrokerRpcRequest[] = [];
    const harness = rpcHarness((rpcRequest) => {
      requests.push(rpcRequest);
      return emptyRpcResponse();
    });
    const result = await executeWorkerRequest(
      request(`
        const root = { fake: true };
        await Promise.all([chrome.captureAccessibilitySnapshot({ root }), chrome.captureAccessibilitySnapshot({ root })]);
        return "completed";
      `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result).toMatchObject({ ok: true, value: "completed" });
    const roots = requests.flatMap((rpcRequest) =>
      rpcRequest.operation === "snapshot" && rpcRequest.payload.root ? [rpcRequest.payload.root] : [],
    );
    expect(roots).toHaveLength(2);
    expect(roots[0]?.attributeName).not.toBe(roots[1]?.attributeName);
    expect(roots.every((root) => root.attributeName.startsWith("data-chrome-mcp-snapshot-root-"))).toBeTrue();
    expect(fake.counts()).toEqual({ disconnectCount: 1, markerCount: 2, restoreCount: 2 });
  });

  test("keeps returned and emitted images through 10 MiB inline and publishes larger images", async () => {
    for (const delivery of ["return image;", "chrome.emitImageResult(image);"]) {
      for (const extraBytes of [0, 1]) {
        const fake = createFakeConnector();
        const harness = rpcHarness((rpcRequest) => {
          if (rpcRequest.operation !== "artifact_publish") return emptyRpcResponse();
          const descriptor = artifact(rpcRequest.payload.name);
          return { artifacts: [descriptor], ok: true, value: descriptor };
        });
        const imageBytes = 10 * 1024 * 1024 + extraBytes;
        const result = parseExecutionKernelResult(
          await executeWorkerRequest(
            request(`
            const image = new Uint8Array(${imageBytes});
            image.set([137, 80, 78, 71, 13, 10, 26, 10]);
            ${delivery}
          `),
            { connect: fake.connect, rpc: harness.rpc },
          ),
        );

        expect(result.ok).toBeTrue();
        if (!result.ok) throw new Error(result.error.message);
        const inlineImage = result.valueImage ?? result.content.find((item) => item.type === "image");
        if (extraBytes === 0) {
          if (!inlineImage) throw new Error("Expected an inline image");
          expect(Buffer.from(inlineImage.data, "base64")).toHaveLength(imageBytes);
          expect(result.artifacts).toHaveLength(0);
        } else {
          expect(inlineImage).toBeUndefined();
          expect(result.artifacts).toHaveLength(1);
          expect(
            result.valueArtifact ?? result.content.find((item) => item.type === "resource")?.artifact,
          ).toBeDefined();
        }
      }
    }
  });

  test("promotes valid images beyond the inline count to artifacts", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness((rpcRequest) => {
      if (rpcRequest.operation !== "artifact_publish") return emptyRpcResponse();
      const descriptor = artifact(rpcRequest.payload.name);
      return { artifacts: [descriptor], ok: true, value: descriptor };
    });
    const result = await executeWorkerRequest(
      request(`
        const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        for (let index = 0; index < 5; index += 1) chrome.emitImageResult(image);
      `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.content.filter((item) => item.type === "image")).toHaveLength(4);
    expect(result.content.filter((item) => item.type === "resource")).toHaveLength(1);
    expect(result.artifacts).toHaveLength(1);
  });

  test("promotes valid images beyond the aggregate inline byte limit to artifacts", async () => {
    const fake = createFakeConnector();
    const harness = rpcHarness((rpcRequest) => {
      if (rpcRequest.operation !== "artifact_publish") return emptyRpcResponse();
      const descriptor = artifact(rpcRequest.payload.name);
      return { artifacts: [descriptor], ok: true, value: descriptor };
    });
    const imageBytes = Math.floor(INLINE_IMAGE_MAX_TOTAL_BYTES / 3) + 1;
    const result = await executeWorkerRequest(
      request(`
        const image = new Uint8Array(${imageBytes});
        image.set([137, 80, 78, 71, 13, 10, 26, 10]);
        for (let index = 0; index < 3; index += 1) chrome.emitImageResult(image);
        return image;
      `),
      { connect: fake.connect, rpc: harness.rpc },
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.content.filter((item) => item.type === "image")).toHaveLength(2);
    expect(result.content.filter((item) => item.type === "resource")).toHaveLength(1);
    expect(result.valueArtifact?.name).toBe("playwright-result.png");
    expect(result.artifacts).toHaveLength(2);
  });
});
