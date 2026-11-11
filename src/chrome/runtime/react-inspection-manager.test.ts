import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import vm from "node:vm";
import { REACT_BRIDGE_MESSAGE_MAX_BYTES } from "./react-inspection-protocol";
import {
  countReactDevToolsOverlays,
  filterSupportedReactProfileRoots,
  inspectReactMutationValue,
  inspectReactProfileLimits,
  isSupportedReactRendererVersion,
  normalizeReactValue,
  parseReactBridgeMessage,
  reactStagedNodeSelectionExpression,
  ReactTreeCursorStore,
  reactTreeScanBounds,
  readReactUpdateInspectionValue,
  readReactValueAtPath,
  sameReactMutationValue,
  unwrapReactBridgeValue,
} from "./react-inspection-manager";

test("unwraps the React DevTools inspected-value transport envelope", () => {
  const data = [{ id: 0, value: 1 }];
  expect(unwrapReactBridgeValue({ cleaned: [], data, unserializable: [] })).toEqual(data);
  expect(unwrapReactBridgeValue({ data })).toEqual({ data });
});

test("identifies nested DevTools previews instead of exposing them as complete objects", () => {
  const value = unwrapReactBridgeValue({
    cleaned: [["items", 0]],
    data: { items: [{ inspectable: true, type: "object", preview_long: '{label: "synthetic"}' }] },
    unserializable: [],
  });

  const normalized = normalizeReactValue(value);

  expect(normalized.truncated).toBeTrue();
  expect(normalized.value).toMatchObject({
    kind: "object",
    entries: [
      {
        key: "items",
        value: {
          kind: "array",
          items: [
            {
              kind: "opaque",
              preview: '{label: "synthetic"}',
              reason: "React DevTools returned a preview",
              typeName: "object",
            },
          ],
        },
      },
    ],
  });
});

test("hydrates nested mutation values and shortened strings before comparing them", async () => {
  const label = "x".repeat(600);
  const result = await inspectReactMutationValue({
    expected: [{ details: { label } }],
    path: ["props", "items"],
    inspect: (path) => {
      if (path.length === 2) {
        return Promise.resolve({
          type: "hydrated-path",
          path,
          value: {
            data: [{ details: { type: "object", inspectable: true } }],
            cleaned: [[...path, 0, "details"]],
            unserializable: [],
          },
        });
      }
      const data = path.length === 4 ? { label: `${label.slice(0, 500)}...` } : label;
      return Promise.resolve({
        type: "hydrated-path",
        path,
        value: { data, cleaned: [], unserializable: [] },
      });
    },
  });

  expect(result.status).toBe("applied");
  expect(JSON.stringify(result.observedValue)).toContain(label);
});

test.each([
  { data: { type: "undefined" }, expected: undefined },
  { data: { type: "nan" }, expected: Number.NaN },
  { data: { type: "bigint", name: "12" }, expected: 12n },
])("verifies the decoded $data.type mutation value", async ({ data, expected }) => {
  const result = await inspectReactMutationValue({
    expected,
    path: ["state", "value"],
    inspect: (path) =>
      Promise.resolve({
        type: "hydrated-path",
        path,
        value: { data, cleaned: [path], unserializable: [] },
      }),
  });

  expect(result.status).toBe("applied");
  expect(result.observedValue).toMatchObject({ kind: data.type });
});

test("reports a complete observed mismatch as overwritten", async () => {
  const result = await inspectReactMutationValue({
    expected: { label: "requested" },
    path: ["props", "record"],
    inspect: (path) =>
      Promise.resolve({
        type: "hydrated-path",
        path,
        value: { data: { label: "application" }, cleaned: [], unserializable: [] },
      }),
  });

  expect(result.status).toBe("overwritten");
  expect(JSON.stringify(result.observedValue)).toContain("application");
});

test.each([
  { expected: null, status: "applied" },
  { expected: "requested", status: "overwritten" },
])("reports bare-null mutation readback as $status", async ({ expected, status }) => {
  const result = await inspectReactMutationValue({
    expected,
    path: ["props", "value"],
    inspect: (path) => Promise.resolve({ type: "hydrated-path", path, value: null }),
  });

  expect(result).toEqual({ status, observedValue: { kind: "null" } });
});

test("hydrates newly discovered children before resuming sibling previews", async () => {
  const paths: (readonly (number | string)[])[] = [];
  const result = await inspectReactMutationValue({
    expected: { first: { child: null }, second: "complete" },
    path: ["props", "record"],
    inspect: (path) => {
      paths.push(path);
      if (path.length === 2) {
        return Promise.resolve({
          type: "hydrated-path",
          path,
          value: {
            data: {
              first: { type: "object", inspectable: true },
              second: { type: "string", inspectable: true },
            },
            cleaned: [
              [...path, "first"],
              [...path, "second"],
            ],
            unserializable: [],
          },
        });
      }
      if (path.at(-1) === "first") {
        return Promise.resolve({
          type: "hydrated-path",
          path,
          value: {
            data: { child: { type: "object", inspectable: true } },
            cleaned: [[...path, "child"]],
            unserializable: [],
          },
        });
      }
      const value = path.at(-1) === "child" ? null : { data: "complete", cleaned: [], unserializable: [] };
      return Promise.resolve({ type: "hydrated-path", path, value });
    },
  });

  expect(result.status).toBe("applied");
  expect(paths).toEqual([
    ["props", "record"],
    ["props", "record", "first"],
    ["props", "record", "first", "child"],
    ["props", "record", "second"],
  ]);
});

test("does not infer an infinity sign from a lossy DevTools placeholder", async () => {
  const result = await inspectReactMutationValue({
    expected: -Infinity,
    path: ["props", "value"],
    inspect: (path) =>
      Promise.resolve({
        type: "hydrated-path",
        path,
        value: { data: { type: "infinity" }, cleaned: [path], unserializable: [] },
      }),
  });

  expect(result.status).toBe("unverified");
  expect(result.observedValue).toMatchObject({ kind: "opaque", typeName: "infinity" });
});

test("does not combine mutation readbacks across a component update", async () => {
  const result = await inspectReactMutationValue({
    expected: { details: { label: "requested" } },
    path: ["hooks", 0, "value"],
    inspect: (path) => {
      if (path.length === 3) {
        return Promise.resolve({
          type: "hydrated-path",
          path,
          value: {
            data: { details: { type: "object", inspectable: true } },
            cleaned: [[...path, "details"]],
            unserializable: [],
          },
        });
      }
      return Promise.resolve({ type: "full-data", value: { hooks: [] } });
    },
  });

  expect(result).toEqual({
    status: "unverified",
    observedValue: { kind: "unavailable", reason: "React component changed during readback" },
  });
});

test("bounds mutation hydration when DevTools keeps returning an inspectable preview", async () => {
  const result = await inspectReactMutationValue({
    expected: {},
    path: ["props", "value"],
    inspect: (path) => {
      return Promise.resolve({
        type: "hydrated-path",
        path,
        value: {
          data: { type: "object", inspectable: true },
          cleaned: [path],
          unserializable: [],
        },
      });
    },
  });

  expect(result.status).toBe("unverified");
});

test("normalizes cycles without invoking accessors or proxy traps", () => {
  let accessorCalls = 0;
  let proxyTrapCalls = 0;
  const value: Record<string, unknown> = {};
  Object.defineProperty(value, "secret", {
    enumerable: true,
    get: () => {
      accessorCalls += 1;
      return "should not be read";
    },
  });
  value.self = value;
  value.proxy = new Proxy(
    {},
    {
      ownKeys: () => {
        proxyTrapCalls += 1;
        return [];
      },
    },
  );

  const normalized = normalizeReactValue(value);

  expect(accessorCalls).toBe(0);
  expect(proxyTrapCalls).toBe(0);
  expect(normalized.truncated).toBeFalse();
  expect(JSON.stringify(normalized.value)).toContain("accessor property was not invoked");
  expect(JSON.stringify(normalized.value)).toContain('"kind":"reference"');
  expect(JSON.stringify(normalized.value)).toContain("proxy objects are not inspected");
});

test("marks an inspected graph that exceeds the depth limit as truncated", () => {
  const root: Record<string, unknown> = {};
  let current = root;
  for (let depth = 0; depth < 110; depth += 1) {
    const child: Record<string, unknown> = {};
    current.child = child;
    current = child;
  }

  const normalized = normalizeReactValue(root);

  expect(normalized.truncated).toBeTrue();
  expect(JSON.stringify(normalized.value)).toContain("React inspected graph depth limit reached");
});

test("validates the nonce-bound page bridge envelope and rejects malformed or oversized messages", () => {
  const expected = { bindingName: "binding", executionContextId: 7, nonce: "nonce" };
  expect(parseReactBridgeMessage({ name: "other" }, expected)).toEqual({ kind: "ignore" });
  expect(parseReactBridgeMessage({ executionContextId: 7, name: "binding", payload: "{" }, expected)).toEqual(
    { kind: "invalid" },
  );
  expect(
    parseReactBridgeMessage(
      {
        executionContextId: 7,
        name: "binding",
        payload: JSON.stringify({ event: "operations", extra: true, nonce: "nonce" }),
      },
      expected,
    ),
  ).toEqual({ kind: "invalid" });
  expect(
    parseReactBridgeMessage(
      {
        executionContextId: 8,
        name: "binding",
        payload: JSON.stringify({ event: "operations", nonce: "nonce" }),
      },
      expected,
    ),
  ).toEqual({ kind: "ignore" });
  expect(
    parseReactBridgeMessage(
      {
        executionContextId: 7,
        name: "binding",
        payload: "x".repeat(REACT_BRIDGE_MESSAGE_MAX_BYTES + 1),
      },
      expected,
    ),
  ).toEqual({ kind: "invalid" });
  expect(
    parseReactBridgeMessage(
      {
        executionContextId: 7,
        name: "binding",
        payload: JSON.stringify({ event: "operations", nonce: "nonce", payload: [1, 2] }),
      },
      expected,
    ),
  ).toEqual({ kind: "message", message: { event: "operations", payload: [1, 2] } });
});

test("reads and compares mutation values without invoking accessors or proxy traps", () => {
  let accessorCalls = 0;
  let proxyTrapCalls = 0;
  const value = {
    nested: Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        return 1;
      },
    }),
    proxy: new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          proxyTrapCalls += 1;
          return undefined;
        },
      },
    ),
  };

  expect(readReactValueAtPath(value, ["nested", "secret"])).toBeUndefined();
  expect(readReactValueAtPath(value, ["proxy", "anything"])).toBeUndefined();
  expect(sameReactMutationValue({ nested: { value: 1 } }, { nested: { value: 1 } })).toBeTrue();
  expect(sameReactMutationValue({ nested: { value: 1 } }, value)).toBeFalse();
  expect(accessorCalls).toBe(0);
  expect(proxyTrapCalls).toBe(0);
});

test("distinguishes pre-update inspection failures from components lost after an update", () => {
  expect(
    readReactUpdateInspectionValue({ type: "full-data", value: { canEditHooks: true } }, "before"),
  ).toEqual({ canEditHooks: true });

  let beforeError: unknown;
  try {
    readReactUpdateInspectionValue({ message: "renderer refused", type: "error" }, "before");
  } catch (error: unknown) {
    beforeError = error;
  }
  expect(beforeError).toMatchObject({
    code: "CHROME_MCP_REACT_UNSUPPORTED_OPERATION",
    message: expect.stringContaining("before applying"),
  });

  let afterError: unknown;
  try {
    readReactUpdateInspectionValue({ type: "full-data" }, "after");
  } catch (error: unknown) {
    afterError = error;
  }
  expect(afterError).toMatchObject({
    code: "CHROME_MCP_REACT_STALE_COMPONENT",
    message: expect.stringContaining("after the requested update"),
  });
});

test("retains only the newest React tree cursor snapshot", () => {
  const cursors = new ReactTreeCursorStore();
  const first = cursors.replace({ index: 1, query: "first", revision: 1, truncated: false, values: [1, 2] });
  const second = cursors.replace({
    index: 2,
    query: "second",
    revision: 1,
    truncated: true,
    values: [3, 4, 5],
  });

  expect(cursors.consume(first, "first", 1)).toBeUndefined();
  expect(cursors.consume(second, "second", 1)).toEqual({
    index: 2,
    query: "second",
    revision: 1,
    truncated: true,
    values: [3, 4, 5],
  });
  expect(cursors.consume(second, "second", 1)).toBeUndefined();
});

test("marks React tree scans truncated only when source elements exceed the cap", () => {
  expect(reactTreeScanBounds(50_000)).toEqual({ count: 50_000, truncated: false });
  expect(reactTreeScanBounds(50_001)).toEqual({ count: 50_000, truncated: true });
});

test("rejects profile data before normalization when commit or byte work exceeds its limit", () => {
  const roots = new Map([[1, { commitData: [{ duration: 1 }, { duration: 2 }], rendererID: 1 }]]);
  const profile = { dataForRoots: roots, imported: false };
  let accessorCalls = 0;
  let proxyTrapCalls = 0;

  const foreignSnapshots: unknown = vm.runInNewContext(`new Map(Array.from(
    { length: 100 },
    (_, index) => [index, "x".repeat(32)]
  ))`);
  const emptyForeignSnapshots: unknown = vm.runInNewContext("new Map()");
  const foreignValues: unknown = vm.runInNewContext('new Set(["x".repeat(5000)])');

  const guardedValue = Object.defineProperty(
    {
      proxy: new Proxy(
        {},
        {
          ownKeys: () => {
            proxyTrapCalls += 1;
            return [];
          },
        },
      ),
    },
    "secret",
    {
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        return "secret";
      },
    },
  );

  expect(inspectReactProfileLimits(profile, { maxBytes: 100_000, maxCommits: 1 })).toEqual({
    commitCount: 2,
    incomplete: true,
  });
  expect(inspectReactProfileLimits(profile, { maxBytes: 100_000, maxCommits: 2 })).toEqual({
    commitCount: 2,
    incomplete: false,
  });
  expect(
    inspectReactProfileLimits(
      { dataForRoots: [[1, { commitData: [], displayName: "large" }]] },
      {
        maxBytes: 100,
        maxCommits: 2,
      },
    ),
  ).toEqual({ commitCount: 0, incomplete: true });
  expect(
    inspectReactProfileLimits(
      {
        dataForRoots: [[1, { commitData: [], snapshots: emptyForeignSnapshots }]],
        imported: false,
      },
      {
        maxBytes: 5000,
        maxCommits: 2,
      },
    ),
  ).toEqual({ commitCount: 0, incomplete: false });
  expect(
    inspectReactProfileLimits(
      {
        dataForRoots: [[1, { commitData: [], snapshots: foreignSnapshots }]],
        imported: false,
      },
      {
        maxBytes: 5000,
        maxCommits: 2,
      },
    ),
  ).toEqual({ commitCount: 0, incomplete: true });
  expect(inspectReactProfileLimits({ values: foreignValues }, { maxBytes: 5000, maxCommits: 2 })).toEqual({
    commitCount: 0,
    incomplete: true,
  });
  expect(
    inspectReactProfileLimits(
      { guardedValue },
      {
        maxBytes: 100_000,
        maxCommits: 2,
      },
    ),
  ).toEqual({ commitCount: 0, incomplete: false });
  expect({ accessorCalls, proxyTrapCalls }).toEqual({ accessorCalls: 0, proxyTrapCalls: 0 });
});

test("maps React 19 profile roots to the renderer IDs captured at profile start", () => {
  const snapshots = new Map([[1, { children: [], id: 1 }]]);
  const roots = new Map([
    [10, { commitData: [{ duration: 1 }], rootID: 10, snapshots }],
    [20, { commitData: [{ duration: 2 }], rootID: 20, snapshots: new Map() }],
  ]);
  const rendererByRoot = new Map([
    [10, 19],
    [20, 17],
  ]);

  expect(
    filterSupportedReactProfileRoots(roots, new Set([19]), (rootId) => rendererByRoot.get(rootId)),
  ).toEqual([[10, { commitData: [{ duration: 1 }], rendererID: 19, rootID: 10, snapshots }]]);

  const foreignRoots: unknown = vm.runInNewContext(`new Map([[
    30,
    { commitData: [{ duration: 3 }], rootID: 30, snapshots: new Map([[1, { children: [], id: 1 }]]) }
  ]])`);
  const filteredForeignRoots = filterSupportedReactProfileRoots(foreignRoots, new Set([19]), () => 19);
  expect(filteredForeignRoots).toHaveLength(1);
  expect(filteredForeignRoots[0]?.[0]).toBe(30);
  expect(filteredForeignRoots[0]?.[1].rendererID).toBe(19);
});

test("recognizes only supported React renderer major versions", () => {
  expect(isSupportedReactRendererVersion("18.3.1")).toBeTrue();
  expect(isSupportedReactRendererVersion("19.1.0")).toBeTrue();
  expect(isSupportedReactRendererVersion("17.0.2")).toBeFalse();
  expect(isSupportedReactRendererVersion("unknown")).toBeFalse();
});

test("consumes a staged connected Element before selecting it", () => {
  const window = new Window();
  const key = "__chromeMcpReactNode_0123456789abcdef0123456789abcdef";
  const stateKey = "__chromeMcpReactState_test";
  const element = window.document.createElement("button");
  window.document.body.append(element);
  let selected: unknown;
  const context: Record<string, unknown> = {
    Element: window.Element,
    [stateKey]: {
      select: (node: unknown) => {
        expect(Object.hasOwn(context, key)).toBeFalse();
        selected = node;
        return true;
      },
    },
  };
  Object.defineProperty(context, key, {
    configurable: true,
    enumerable: false,
    value: element,
    writable: false,
  });

  try {
    expect(vm.runInNewContext(reactStagedNodeSelectionExpression(key, stateKey), context)).toEqual({
      selected: true,
    });
    expect(selected).toBe(element);
    expect(Object.hasOwn(context, key)).toBeFalse();
    expect(vm.runInNewContext(reactStagedNodeSelectionExpression(key, stateKey), context)).toEqual({
      selected: false,
    });

    let getterCalls = 0;
    Object.defineProperty(context, key, {
      configurable: true,
      get: () => {
        getterCalls += 1;
        return element;
      },
    });
    expect(vm.runInNewContext(reactStagedNodeSelectionExpression(key, stateKey), context)).toEqual({
      selected: false,
    });
    expect(getterCalls).toBe(0);
    expect(Object.hasOwn(context, key)).toBeFalse();

    const disconnected = window.document.createElement("button");
    Object.defineProperty(context, key, { configurable: true, value: disconnected });
    expect(vm.runInNewContext(reactStagedNodeSelectionExpression(key, stateKey), context)).toEqual({
      selected: false,
    });
    expect(Object.hasOwn(context, key)).toBeFalse();
  } finally {
    window.close();
  }
});

test("recognizes the pinned React DevTools overlay after it is painted", () => {
  const window = new Window();
  const container = window.document.createElement("div");
  const tip = window.document.createElement("div");
  tip.style.position = "fixed";
  tip.append(window.document.createElement("span"), window.document.createElement("span"));
  container.style.zIndex = "10000000";
  container.append(tip);
  window.document.body.append(container);

  expect(countReactDevToolsOverlays(window.document)).toBe(1);
  container.remove();
  expect(countReactDevToolsOverlays(window.document)).toBe(0);
  window.close();
});
