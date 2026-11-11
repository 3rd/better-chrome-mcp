import { describe, expect, test } from "bun:test";
import type { z } from "zod/v4";
import { heapQuerySchema } from "../diagnostics/heap-analysis-protocol";
import { reactMutationValueSchema, reactUpdateRequestSchema } from "../runtime/react-inspection-protocol";
import {
  analyzeHeapSnapshotInputSchema,
  browserModeSchema,
  CHROME_CAPABILITY_CDP_METHODS,
  CHROME_CAPABILITY_LIMIT_FIELDS,
  CHROME_TOOL_NAMES,
  chromeCapabilitiesSchema,
  lighthouseAuditInputSchema,
  performanceAnalyzeInsightInputSchema,
  performanceStartTraceInputSchema,
  performanceStopTraceInputSchema,
  reactHighlightComponentInputSchema,
  reactInspectComponentInputSchema,
  reactListComponentsInputSchema,
  reactProfileAnalyzeInputSchema,
  reactProfileStartInputSchema,
  reactProfileStopInputSchema,
  reactUpdateComponentInputSchema,
  runPlaywrightInputSchema,
  runPlaywrightOutputSchema,
  takeHeapSnapshotInputSchema,
} from "./contracts";

type JsonSchemaProvider = {
  "~standard": {
    jsonSchema: {
      input: (options: { target: "draft-2020-12" }) => unknown;
    };
  };
};

type SamplesByVariant<Variant extends Record<Key, string>, Key extends string> = {
  [Value in Variant[Key]]: Extract<Variant, Record<Key, Value>>;
};

const advertisedRequiredProperties = (schema: JsonSchemaProvider): unknown => {
  const jsonSchema = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  if (typeof jsonSchema !== "object" || jsonSchema === null) {
    throw new Error("Expected an object JSON Schema");
  }
  return Reflect.get(jsonSchema, "required");
};

const advertisedPropertyNames = (schema: JsonSchemaProvider): string[] => {
  const jsonSchema = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  if (typeof jsonSchema !== "object" || jsonSchema === null) {
    throw new Error("Expected an object JSON Schema");
  }
  const properties = Reflect.get(jsonSchema, "properties");
  if (typeof properties !== "object" || properties === null) {
    throw new Error("Expected root object properties");
  }
  return Object.keys(properties);
};

describe("Chrome MCP public contracts", () => {
  test("advertises the seven general and six enabled React tool names", () => {
    expect(CHROME_TOOL_NAMES).toEqual([
      "run_playwright",
      "performance_start_trace",
      "performance_stop_trace",
      "performance_analyze_insight",
      "lighthouse_audit",
      "take_heapsnapshot",
      "analyze_heapsnapshot",
      "react_list_components",
      "react_inspect_component",
      "react_update_component",
      "react_profile_start",
      "react_profile_stop",
      "react_profile_analyze",
    ]);
  });

  test("supports native virtual-display mode and preserves the isolated-headless default", () => {
    expect(browserModeSchema.parse(undefined)).toBe("isolated-headless");
    for (const mode of [
      "isolated",
      "isolated-headless",
      "isolated-virtual-display",
      "shared",
      "shared-headless",
      "main",
    ] as const) {
      expect(browserModeSchema.parse(mode)).toBe(mode);
    }
    expect(() => browserModeSchema.parse("headless")).toThrow();
  });

  test("reuses direct React lookup contracts while keeping snapshot refs public-only", () => {
    expect(reactListComponentsInputSchema.parse({ browser: "isolated" })).toEqual({
      browser: "isolated",
      limit: 100,
    });
    expect(
      reactInspectComponentInputSchema.parse({
        browser: "isolated",
        lookup: { componentId: "component", type: "component" },
      }),
    ).toEqual({
      browser: "isolated",
      lookup: { componentId: "component", type: "component" },
    });
    expect(
      reactInspectComponentInputSchema.parse({
        browser: "isolated",
        lookup: { selector: "#root", type: "selector" },
      }),
    ).toEqual({
      browser: "isolated",
      lookup: { selector: "#root", type: "selector" },
    });
    expect(
      reactInspectComponentInputSchema.parse({
        browser: "isolated",
        lookup: { ref: "s1e7", type: "snapshot-ref" },
      }),
    ).toEqual({
      browser: "isolated",
      lookup: { ref: "s1e7", type: "snapshot-ref" },
    });
    expect(() =>
      reactInspectComponentInputSchema.parse({
        browser: "isolated",
        lookup: { key: "__chromeMcpReactNode_0123456789abcdef0123456789abcdef", type: "staged-node" },
      }),
    ).toThrow();
    expect(() =>
      reactInspectComponentInputSchema.parse({
        browser: "isolated",
        lookup: { ref: "s1e7", type: "snapshot-ref", unknown: true },
      }),
    ).toThrow();
    expect(() =>
      reactInspectComponentInputSchema.parse({
        browser: "isolated",
        lookup: { ref: "", type: "snapshot-ref" },
      }),
    ).toThrow();
    expect(
      reactUpdateComponentInputSchema.parse({
        browser: "isolated",
        componentId: "component",
        location: { hookId: "hook", path: ["value", 0], type: "hook-state" },
        value: { type: "undefined" },
      }),
    ).toMatchObject({ browser: "isolated", componentId: "component" });
    expect(
      reactHighlightComponentInputSchema.parse({ browser: "isolated", action: { type: "clear" } }),
    ).toEqual({
      action: { type: "clear" },
      browser: "isolated",
    });
    expect(reactProfileStartInputSchema.parse({ browser: "isolated" })).toEqual({ browser: "isolated" });
    expect(reactProfileStopInputSchema.parse({ profileId: "profile" })).toEqual({ profileId: "profile" });
    expect(reactProfileAnalyzeInputSchema.parse({ profileId: "profile" })).toEqual({
      limit: 25,
      profileId: "profile",
    });
    expect(
      reactProfileAnalyzeInputSchema.parse({ includeChangeDescriptions: true, profileId: "profile" }),
    ).toEqual({ includeChangeDescriptions: true, limit: 25, profileId: "profile" });
    expect(() =>
      reactProfileAnalyzeInputSchema.parse({ includeChangeDescriptions: "true", profileId: "profile" }),
    ).toThrow();
    expect(() => reactListComponentsInputSchema.parse({ browser: "isolated", limit: 501 })).toThrow();
    expect(() => reactProfileStopInputSchema.parse({ browser: "isolated", profileId: "profile" })).toThrow();
  });

  test("accepts every heap query kind the heap snapshot protocol defines", () => {
    const queries: SamplesByVariant<z.output<typeof heapQuerySchema>, "kind"> = {
      objects: {
        kind: "objects",
        className: "Detached",
        propertyName: "listener",
        minRetainedBytes: 1024,
        sort: "selfSize",
      },
      edges: { kind: "edges", nodeId: 7, excludePrimitives: true, minRetainedBytes: 1024, sort: "name" },
      contexts: { kind: "contexts" },
    };
    expect(Object.keys(queries)).toEqual(heapQuerySchema.options.map((option) => option.shape.kind.value));

    for (const query of Object.values(queries)) {
      expect(analyzeHeapSnapshotInputSchema.parse({ filePath: "heap.heapsnapshot", query }).query).toEqual(
        query,
      );
    }
  });

  test("accepts every React component lookup type", () => {
    const lookups: SamplesByVariant<z.output<typeof reactInspectComponentInputSchema>["lookup"], "type"> = {
      component: { type: "component", componentId: "component" },
      selector: { type: "selector", selector: "#root" },
      "snapshot-ref": { type: "snapshot-ref", ref: "s1e7" },
    };

    for (const lookup of Object.values(lookups)) {
      expect(reactInspectComponentInputSchema.parse({ browser: "isolated", lookup }).lookup).toEqual(lookup);
    }
  });

  test("accepts every React update location and value type the React protocol defines", () => {
    const locationSchema = reactUpdateRequestSchema.shape.location;
    const locations: SamplesByVariant<z.output<typeof locationSchema>, "type"> = {
      props: { type: "props", path: ["count"] },
      "class-state": { type: "class-state", path: ["items", 0] },
      "hook-state": { type: "hook-state", hookId: "hook", path: [] },
      context: { type: "context", contextId: "context", path: ["theme"] },
    };
    const values: SamplesByVariant<z.output<typeof reactMutationValueSchema>, "type"> = {
      json: { type: "json", value: { enabled: true } },
      undefined: { type: "undefined" },
      nan: { type: "nan" },
      infinity: { type: "infinity", sign: -1 },
      bigint: { type: "bigint", value: "-12" },
    };
    expect(Object.keys(locations)).toEqual(locationSchema.options.map((option) => option.shape.type.value));
    expect(Object.keys(values)).toEqual(
      reactMutationValueSchema.options.map((option) => option.shape.type.value),
    );

    for (const location of Object.values(locations)) {
      const update = {
        browser: "isolated",
        componentId: "component",
        location,
        value: { type: "undefined" },
      };
      expect(reactUpdateComponentInputSchema.parse(update).location).toEqual(location);
    }

    for (const value of Object.values(values)) {
      const update = {
        browser: "isolated",
        componentId: "component",
        location: { type: "props", path: [] },
        value,
      };
      expect(reactUpdateComponentInputSchema.parse(update).value).toEqual(value);
    }
  });

  test("parses run_playwright defaults and rejects unknown fields", () => {
    expect(
      runPlaywrightInputSchema.parse({ browserInstanceId: "defaults", code: "return await page.title();" }),
    ).toEqual({
      code: "return await page.title();",
      args: null,
      timeoutMs: 30_000,
      browser: "isolated-headless",
      browserInstanceId: "defaults",
    });
    expect(() =>
      runPlaywrightInputSchema.parse({ browserInstanceId: "defaults", code: "return 1;", unknown: true }),
    ).toThrow();
    expect(() =>
      runPlaywrightInputSchema.parse({ browserInstanceId: "defaults", code: "", timeoutMs: 30_000 }),
    ).toThrow();
    expect(() =>
      runPlaywrightInputSchema.parse({ browserInstanceId: "defaults", code: "return 1;", timeoutMs: 99 }),
    ).toThrow();
    expect(() =>
      runPlaywrightInputSchema.parse({ browserInstanceId: "defaults", code: "return 1;", args: undefined }),
    ).not.toThrow();
    expect(() => runPlaywrightInputSchema.parse({ code: "return 1;" })).toThrow(
      "browserInstanceId is required for isolated-headless",
    );
  });

  test("accepts reusable isolated-headless browser instance IDs on every browser tool", () => {
    const browser = "isolated-headless";
    const browserInstanceId = "worker-3.audit";
    expect(runPlaywrightInputSchema.parse({ browser, browserInstanceId, code: "return 1;" })).toMatchObject({
      browser,
      browserInstanceId,
    });
    expect(performanceStartTraceInputSchema.parse({ browser, browserInstanceId })).toMatchObject({
      browserInstanceId,
    });
    expect(performanceStopTraceInputSchema.parse({ browser, browserInstanceId })).toMatchObject({
      browserInstanceId,
    });
    expect(performanceAnalyzeInsightInputSchema.parse({ browser, browserInstanceId })).toMatchObject({
      browserInstanceId,
    });
    expect(lighthouseAuditInputSchema.parse({ browser, browserInstanceId })).toMatchObject({
      browserInstanceId,
    });
    expect(
      takeHeapSnapshotInputSchema.parse({ browser, browserInstanceId, filePath: "heap.heapsnapshot" }),
    ).toMatchObject({
      browserInstanceId,
    });
    expect(() =>
      runPlaywrightInputSchema.parse({ browser: "isolated", browserInstanceId, code: "return 1;" }),
    ).toThrow();
    expect(() => runPlaywrightInputSchema.parse({ browser, code: "return 1;" })).toThrow();
    expect(() =>
      runPlaywrightInputSchema.parse({ browser, browserInstanceId: "invalid instance", code: "return 1;" }),
    ).toThrow();
    for (const schema of [
      runPlaywrightInputSchema,
      performanceStartTraceInputSchema,
      performanceStopTraceInputSchema,
      performanceAnalyzeInsightInputSchema,
      lighthouseAuditInputSchema,
      takeHeapSnapshotInputSchema,
    ]) {
      expect(advertisedPropertyNames(schema)).toContain("browser");
      expect(advertisedPropertyNames(schema)).toContain("browserInstanceId");
    }
  });

  test("requires an explicit native scale and instance for virtual-display calls only", () => {
    const input = {
      browser: "isolated-virtual-display",
      browserInstanceId: "desktop",
      nativeDeviceScaleFactor: 1.296_875,
    };
    expect(runPlaywrightInputSchema.parse({ ...input, code: "return 1" })).toMatchObject(input);
    expect(performanceStartTraceInputSchema.parse(input)).toMatchObject(input);
    expect(reactListComponentsInputSchema.parse(input)).toMatchObject(input);
    expect(() =>
      runPlaywrightInputSchema.parse({ ...input, code: "return 1", nativeDeviceScaleFactor: undefined }),
    ).toThrow("nativeDeviceScaleFactor is required");
    expect(() =>
      runPlaywrightInputSchema.parse({ ...input, code: "return 1", browserInstanceId: undefined }),
    ).toThrow("browserInstanceId is required");
    expect(() =>
      runPlaywrightInputSchema.parse({ ...input, code: "return 1", browser: "isolated-headless" }),
    ).toThrow("nativeDeviceScaleFactor is only supported");
    expect(() => performanceStartTraceInputSchema.parse({ ...input, nativeDeviceScaleFactor: 0 })).toThrow();
    expect(() => performanceStartTraceInputSchema.parse({ ...input, nativeDeviceScaleFactor: 5 })).toThrow();
  });

  test("preserves retained diagnostic defaults", () => {
    expect(performanceStartTraceInputSchema.parse({ browser: "isolated" })).toEqual({
      reload: true,
      autoStop: true,
      browser: "isolated",
    });
    expect(lighthouseAuditInputSchema.parse({ browser: "isolated" })).toEqual({
      mode: "navigation",
      device: "desktop",
      browser: "isolated",
    });
    expect(takeHeapSnapshotInputSchema.parse({ browser: "isolated", filePath: "heap.heapsnapshot" })).toEqual(
      {
        filePath: "heap.heapsnapshot",
        browser: "isolated",
      },
    );
    expect(
      takeHeapSnapshotInputSchema.parse({
        browser: "isolated",
        filePath: "current.heapsnapshot",
        analysis: {
          baselineFilePath: "baseline.heapsnapshot",
          modes: ["summary", "diff", "dominators", "retainers"],
          limit: 12,
          maxRetainingPathDepth: 6,
        },
      }),
    ).toMatchObject({ analysis: { limit: 12, modes: ["summary", "diff", "dominators", "retainers"] } });
    expect(() =>
      takeHeapSnapshotInputSchema.parse({
        browser: "isolated",
        filePath: "heap.heapsnapshot",
        analysis: { modes: ["diff"] },
      }),
    ).toThrow();
    expect(() =>
      takeHeapSnapshotInputSchema.parse({
        browser: "isolated",
        filePath: "heap.heapsnapshot",
        analysis: { modes: ["summary", "summary"] },
      }),
    ).toThrow();
  });

  test("defaults browser diagnostics to the caller's named headless instance", () => {
    for (const { schema, input } of [
      { schema: performanceStartTraceInputSchema, input: {} },
      { schema: performanceStopTraceInputSchema, input: {} },
      { schema: performanceAnalyzeInsightInputSchema, input: {} },
      { schema: lighthouseAuditInputSchema, input: {} },
      { schema: takeHeapSnapshotInputSchema, input: { filePath: "heap.heapsnapshot" } },
      { schema: reactListComponentsInputSchema, input: {} },
      {
        schema: reactInspectComponentInputSchema,
        input: { lookup: { componentId: "component", type: "component" } },
      },
      {
        schema: reactUpdateComponentInputSchema,
        input: {
          componentId: "component",
          location: { type: "props", path: ["count"] },
          value: { type: "json", value: 1 },
        },
      },
      { schema: reactHighlightComponentInputSchema, input: { action: { type: "clear" } } },
      { schema: reactProfileStartInputSchema, input: {} },
    ]) {
      expect(schema.parse({ ...input, browserInstanceId: "diagnostics" })).toMatchObject({
        browser: "isolated-headless",
        browserInstanceId: "diagnostics",
      });
      expect(() => schema.parse(input)).toThrow("browserInstanceId is required for isolated-headless");
    }
  });

  test("advertises only genuinely required input fields", () => {
    expect(advertisedRequiredProperties(runPlaywrightInputSchema)).toEqual(["code"]);
    expect(advertisedRequiredProperties(performanceStartTraceInputSchema)).toBeUndefined();
    expect(advertisedRequiredProperties(performanceStopTraceInputSchema)).toBeUndefined();
    expect(advertisedRequiredProperties(performanceAnalyzeInsightInputSchema)).toBeUndefined();
    expect(performanceAnalyzeInsightInputSchema.parse({ browser: "isolated" })).toEqual({
      browser: "isolated",
    });
    expect(() =>
      performanceAnalyzeInsightInputSchema.parse({ browser: "isolated", insightName: "LCPBreakdown" }),
    ).toThrow();
    expect(advertisedRequiredProperties(lighthouseAuditInputSchema)).toBeUndefined();
    expect(advertisedRequiredProperties(takeHeapSnapshotInputSchema)).toEqual(["filePath"]);
  });

  test("defines the success and failure structured output envelopes", () => {
    expect(
      runPlaywrightOutputSchema.parse({
        ok: true,
        selectedTargetId: "target-1",
        emittedCount: 0,
        artifacts: [],
        value: { title: "Example" },
      }),
    ).toMatchObject({ ok: true, selectedTargetId: "target-1" });
    expect(
      runPlaywrightOutputSchema.parse({
        ok: true,
        selectedTargetId: null,
        emittedCount: 0,
        artifacts: [],
      }),
    ).toMatchObject({ ok: true, selectedTargetId: null });
    expect(
      runPlaywrightOutputSchema.parse({
        ok: false,
        selectedTargetId: null,
        artifacts: [],
        partialEmittedCount: 2,
        partialOmittedCount: 1,
        error: { code: "CHROME_MCP_TIMEOUT", name: "TimeoutError", message: "Worker terminated." },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CHROME_MCP_TIMEOUT" },
      partialEmittedCount: 2,
      partialOmittedCount: 1,
    });
    expect(() =>
      runPlaywrightOutputSchema.parse({
        ok: false,
        selectedTargetId: null,
        artifacts: [],
        partialEmittedCount: 2,
        error: { code: "CHROME_MCP_TIMEOUT", name: "TimeoutError", message: "Worker terminated." },
      }),
    ).toThrow();
    expect(() =>
      runPlaywrightOutputSchema.parse({
        ok: false,
        selectedTargetId: null,
        artifacts: [],
        error: { code: "CHROME_MCP_FICTIONAL", name: "Error", message: "Not a public error." },
      }),
    ).toThrow();
  });

  test("owns the exact capability field contract", () => {
    expect(Object.keys(chromeCapabilitiesSchema.shape)).toEqual([
      "playwrightVersion",
      "chromeProduct",
      "cdpProtocolVersion",
      "browserMode",
      "browserOwnership",
      "headless",
      "nativeDeviceScaleFactor",
      "selectedTargetId",
      "workspaceShared",
      "captures",
      "limits",
      "journal",
      "cdp",
    ]);
    expect(CHROME_CAPABILITY_LIMIT_FIELDS).toEqual(
      expect.arrayContaining([
        "snapshotMaxBytes",
        "snapshotMaxDepth",
        "snapshotMinBytes",
        "snapshotMinDepth",
        "snapshotRetainedCount",
        "mutationCountPerKind",
        "mutationEntryBytes",
        "mutationTotalBytes",
        "bindingPayloadBytes",
        "bindingConcurrency",
        "bindingTimeoutMs",
        "inlineImageTotalBytes",
        "stateTotalBytes",
      ]),
    );
    expect(CHROME_CAPABILITY_CDP_METHODS).toContain("Page.startScreencast");
  });
});
