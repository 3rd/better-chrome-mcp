import { z } from "zod/v4";
import type { CaptureType } from "../captures";
import { type AgentToolConformanceOptions, assertAgentToolSchema } from "../../mcp/agent-tool-schema";
import { eventCursorSchema, targetCrashEventSchema } from "../broker-rpc/protocol";
import {
  BROWSER_MODES,
  DEFAULT_BROWSER_MODE,
  getNativeDeviceScaleFactorError,
  isBrowserMode,
  isNamedBrowserMode,
  nativeDeviceScaleFactorSchema,
} from "../browser-modes";
import {
  HEAP_ANALYSIS_MODES,
  HEAP_RESULT_MAX_LIMIT,
  HEAP_RETAINING_PATH_MAX_DEPTH,
  heapQueryRequestSchema,
  heapQuerySchema,
} from "../diagnostics/heap-analysis-protocol";
import {
  copyJsonValue,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  EXECUTION_ERROR_CODES,
  MAX_EXECUTION_TIMEOUT_MS,
  MIN_EXECUTION_TIMEOUT_MS,
} from "../execution";
import { PWA_CDP_METHODS } from "../runtime/pwa-controller";
import {
  reactComponentLookupSchema,
  reactHighlightRequestSchema,
  reactIdentifierSchema,
  reactListRequestSchema,
  reactMutationValueSchema,
  reactPathSchema,
  reactProfileAnalyzeRequestSchema,
  reactProfileStartRequestSchema,
  reactProfileStopRequestSchema,
  reactSelectorLookupSchema,
  reactUpdateRequestSchema,
} from "../runtime/react-inspection-protocol";
import { unavailableTargetSchema } from "../runtime/target-registry";

const jsonArgsSchema = z.unknown().refine((value) => {
  try {
    copyJsonValue(value, "Playwright arguments");
    return true;
  } catch {
    return false;
  }
}, "Arguments must be JSON-safe");

const browserModeValueSchema = z.enum(BROWSER_MODES);

export const browserModeSchema = browserModeValueSchema.default(DEFAULT_BROWSER_MODE);

const browserInstanceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const browserInstanceIdSchema = z
  .string()
  .refine(
    (id) => browserInstanceIdPattern.test(id),
    "browserInstanceId must start with a letter or digit and use only letters, digits, '.', '_', or '-' (at most 128 characters)",
  );

const browserToolInputSchema = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z
    .object({
      ...shape,
      browser: z.string().optional().pipe(browserModeSchema),
      browserInstanceId: browserInstanceIdSchema.optional(),
      nativeDeviceScaleFactor: z.number().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const browser = Reflect.get(value, "browser");
      const browserInstanceId = Reflect.get(value, "browserInstanceId");
      if (!isBrowserMode(browser)) return;

      const isInstanceIdMissing = isNamedBrowserMode(browser) && browserInstanceId === undefined;
      if (isInstanceIdMissing) {
        context.addIssue({
          code: "custom",
          message: `browserInstanceId is required for ${browser}`,
          path: ["browserInstanceId"],
        });
      }

      const isInstanceIdUnsupported = !isNamedBrowserMode(browser) && browserInstanceId !== undefined;
      if (isInstanceIdUnsupported) {
        context.addIssue({
          code: "custom",
          message: "browserInstanceId is only supported for isolated-headless and isolated-virtual-display",
          path: ["browserInstanceId"],
        });
      }

      const scaleError = getNativeDeviceScaleFactorError(
        browser,
        Reflect.get(value, "nativeDeviceScaleFactor"),
      );
      if (scaleError) {
        context.addIssue({ code: "custom", message: scaleError, path: ["nativeDeviceScaleFactor"] });
      }
    });

export const runPlaywrightInputSchema = browserToolInputSchema({
  code: z
    .string()
    .min(1)
    .describe("Async JavaScript statement body. Owner close is terminal; the next call gets a fresh owner."),
  args: jsonArgsSchema.default(null),
  timeoutMs: z
    .number()
    .int()
    .min(MIN_EXECUTION_TIMEOUT_MS)
    .max(MAX_EXECUTION_TIMEOUT_MS)
    .default(DEFAULT_EXECUTION_TIMEOUT_MS)
    .describe(
      "Worker execution timeout in milliseconds; excludes queue waiting, browser setup, and call finalization.",
    ),
});

export const performanceStartTraceInputSchema = browserToolInputSchema({
  reload: z
    .boolean()
    .default(true)
    .describe(
      "Navigate to about:blank before tracing, then back to the original URL, discarding transient page state; false traces the current page without navigation.",
    ),
  autoStop: z
    .boolean()
    .default(true)
    .describe(
      "Record five seconds after optional navigation, then stop and return the completed trace; false returns with tracing active so you can interact, then call performance_stop_trace.",
    ),
  filePath: z
    .string()
    .optional()
    .describe(
      "Trace output path, relative to the session's working directory or absolute; saved as .json, or .json.gz when it ends in .gz.",
    ),
});

export const performanceStopTraceInputSchema = browserToolInputSchema({
  filePath: z
    .string()
    .optional()
    .describe(
      "Trace output path, relative to the session's working directory or absolute; saved as .json, or .json.gz when it ends in .gz.",
    ),
});

export const performanceAnalyzeInsightInputSchema = browserToolInputSchema({
  insightSetId: z.string().min(1).optional(),
  insightName: z.string().min(1).optional(),
}).superRefine((value, context) => {
  if ((value.insightSetId === undefined) === (value.insightName === undefined)) return;
  context.addIssue({
    code: "custom",
    message:
      "insightSetId and insightName must be provided together, or both omitted to list available insights",
  });
});

export const lighthouseAuditInputSchema = browserToolInputSchema({
  mode: z
    .enum(["navigation", "snapshot"])
    .default("navigation")
    .describe(
      "navigation reloads the selected page and audits the load; snapshot audits the current page without navigating.",
    ),
  device: z.enum(["desktop", "mobile"]).default("desktop"),
  outputDirPath: z
    .string()
    .optional()
    .describe("Report directory, relative to the session's working directory or absolute."),
});

const joinAlternatives = (values: readonly string[]) => {
  if (values.length <= 2) return values.join(" or ");

  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
};

const heapQuerySortDescription = heapQuerySchema.options
  .flatMap((option) => {
    const shape = option.shape;
    if (!("sort" in shape)) return [];
    const defaultSort = shape.sort.def.defaultValue;

    const choices = shape.sort
      .unwrap()
      .options.map((choice) => (choice === defaultSort ? `${choice} (default)` : choice));

    return [`${shape.kind.value}: ${joinAlternatives(choices)}`];
  })
  .join("; ");

const heapQueryInputSchema = z
  .object({
    kind: z.enum(heapQuerySchema.options.map((option) => option.shape.kind.value)),
    className: z.string().optional().describe("objects only"),
    propertyName: z.string().optional().describe("objects only"),
    nodeId: z.number().optional().describe("edges only; required there"),
    excludePrimitives: z.boolean().optional().describe("edges only"),
    minRetainedBytes: z.number().optional().describe("objects or edges"),
    sort: z.string().optional().describe(heapQuerySortDescription),
  })
  .strict()
  .pipe(heapQuerySchema);

export const analyzeHeapSnapshotInputSchema = heapQueryRequestSchema
  .omit({ cursor: true, query: true, snapshotPath: true })
  .extend({
    cursor: z.string().optional().pipe(heapQueryRequestSchema.shape.cursor),
    query: heapQueryInputSchema,
    filePath: z
      .string()
      .min(1)
      .describe("Saved .heapsnapshot path, relative to this session's working directory or absolute."),
  })
  .strict();

export type AnalyzeHeapSnapshotInput = z.infer<typeof analyzeHeapSnapshotInputSchema>;

export const takeHeapSnapshotInputSchema = browserToolInputSchema({
  filePath: z
    .string()
    .min(1)
    .describe(
      "Output path, relative to the session's working directory or absolute; saved with a .heapsnapshot extension.",
    ),
  analysis: z
    .object({
      baselineFilePath: z.string().min(1).optional(),
      modes: z.array(z.enum(HEAP_ANALYSIS_MODES)).min(1).max(HEAP_ANALYSIS_MODES.length).optional(),
      limit: z.number().int().min(1).max(HEAP_RESULT_MAX_LIMIT).optional(),
      maxRetainingPathDepth: z.number().int().min(1).max(HEAP_RETAINING_PATH_MAX_DEPTH).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.modes && new Set(value.modes).size !== value.modes.length) {
        context.addIssue({ code: "custom", message: "analysis.modes cannot contain duplicates" });
      }
      if (value.modes?.includes("diff") && value.baselineFilePath === undefined) {
        context.addIssue({ code: "custom", message: "analysis.diff requires baselineFilePath" });
      }
    })
    .optional(),
});

export const reactListComponentsInputSchema = browserToolInputSchema(
  reactListRequestSchema.omit({ operation: true }).shape,
);

const reactSnapshotRefLookupSchema = z
  .object({
    ref: z
      .string()
      .refine((value) => value.length > 0 && value.length <= 256, "Expected 1 to 256 characters"),
    type: z.literal("snapshot-ref"),
  })
  .strict();

const reactInspectLookupSchema = z.discriminatedUnion("type", [
  reactComponentLookupSchema,
  reactSelectorLookupSchema,
  reactSnapshotRefLookupSchema,
]);

export const reactInspectComponentInputSchema = browserToolInputSchema({
  lookup: z
    .object({
      type: z.enum(reactInspectLookupSchema.options.map((option) => option.shape.type.value)),
      componentId: z.string().optional().describe("Required when type is component; omit otherwise."),
      selector: z.string().optional().describe("Required when type is selector; omit otherwise."),
      ref: z.string().optional().describe("Required when type is snapshot-ref; omit otherwise."),
    })
    .strict()
    .pipe(reactInspectLookupSchema),
});

const reactUpdateLocationSchema = reactUpdateRequestSchema.shape.location;

const reactUpdateLocationInputSchema = z
  .object({
    type: z.enum(reactUpdateLocationSchema.options.map((option) => option.shape.type.value)),
    path: reactPathSchema,
    hookId: reactIdentifierSchema.optional().describe("Required when type is hook-state; omit otherwise."),
    contextId: reactIdentifierSchema.optional().describe("Required when type is context; omit otherwise."),
  })
  .strict()
  .pipe(reactUpdateLocationSchema);

const reactMutationValueInputSchema = z
  .object({
    type: z.enum(reactMutationValueSchema.options.map((option) => option.shape.type.value)),
    value: z
      .unknown()
      .optional()
      .describe(
        "Required when type is json (any JSON value) or bigint (decimal integer string); omit otherwise.",
      ),
    sign: z
      .union([z.literal(1), z.literal(-1)])
      .optional()
      .describe("Required when type is infinity; omit otherwise."),
  })
  .strict()
  .pipe(reactMutationValueSchema);

export const reactUpdateComponentInputSchema = browserToolInputSchema({
  componentId: reactIdentifierSchema,
  location: reactUpdateLocationInputSchema,
  value: reactMutationValueInputSchema,
});

export const reactHighlightComponentInputSchema = browserToolInputSchema(
  reactHighlightRequestSchema.omit({ operation: true }).shape,
);

export const reactProfileStartInputSchema = browserToolInputSchema(
  reactProfileStartRequestSchema.omit({ operation: true }).shape,
);

export const reactProfileStopInputSchema = reactProfileStopRequestSchema.omit({ operation: true });

export const reactProfileAnalyzeInputSchema = reactProfileAnalyzeRequestSchema.omit({ operation: true });

assertAgentToolSchema(runPlaywrightInputSchema, {
  defaultPaths: ["$.args", "$.timeoutMs"],
  optionalPaths: ["$.args", "$.browser", "$.browserInstanceId", "$.nativeDeviceScaleFactor", "$.timeoutMs"],
});
assertAgentToolSchema(performanceStartTraceInputSchema, {
  defaultPaths: ["$.autoStop", "$.reload"],
  optionalPaths: [
    "$.autoStop",
    "$.browser",
    "$.browserInstanceId",
    "$.nativeDeviceScaleFactor",
    "$.filePath",
    "$.reload",
  ],
});
assertAgentToolSchema(performanceStopTraceInputSchema, {
  defaultPaths: [],
  optionalPaths: ["$.browser", "$.browserInstanceId", "$.nativeDeviceScaleFactor", "$.filePath"],
});
assertAgentToolSchema(performanceAnalyzeInsightInputSchema, {
  defaultPaths: [],
  optionalPaths: [
    "$.browser",
    "$.browserInstanceId",
    "$.nativeDeviceScaleFactor",
    "$.insightName",
    "$.insightSetId",
  ],
});
assertAgentToolSchema(lighthouseAuditInputSchema, {
  defaultPaths: ["$.device", "$.mode"],
  optionalPaths: [
    "$.browser",
    "$.browserInstanceId",
    "$.nativeDeviceScaleFactor",
    "$.device",
    "$.mode",
    "$.outputDirPath",
  ],
});
assertAgentToolSchema(takeHeapSnapshotInputSchema, {
  defaultPaths: [],
  optionalPaths: [
    "$.analysis",
    "$.analysis.baselineFilePath",
    "$.analysis.limit",
    "$.analysis.maxRetainingPathDepth",
    "$.analysis.modes",
    "$.browser",
    "$.browserInstanceId",
    "$.nativeDeviceScaleFactor",
  ],
});
export const ANALYZE_HEAP_SNAPSHOT_SCHEMA_OPTIONS = {
  defaultPaths: ["$.limit"],
  optionalPaths: [
    "$.cursor",
    "$.limit",
    "$.query.className",
    "$.query.excludePrimitives",
    "$.query.minRetainedBytes",
    "$.query.nodeId",
    "$.query.propertyName",
    "$.query.sort",
  ],
} satisfies AgentToolConformanceOptions;

assertAgentToolSchema(analyzeHeapSnapshotInputSchema, ANALYZE_HEAP_SNAPSHOT_SCHEMA_OPTIONS);
assertAgentToolSchema(reactListComponentsInputSchema, {
  defaultPaths: ["$.limit"],
  optionalPaths: [
    "$.browser",
    "$.browserInstanceId",
    "$.nativeDeviceScaleFactor",
    "$.cursor",
    "$.limit",
    "$.parentComponentId",
    "$.rendererId",
    "$.rootId",
    "$.search",
  ],
});
assertAgentToolSchema(reactInspectComponentInputSchema, {
  defaultPaths: [],
  optionalPaths: [
    "$.browser",
    "$.browserInstanceId",
    "$.lookup.componentId",
    "$.lookup.ref",
    "$.lookup.selector",
    "$.nativeDeviceScaleFactor",
  ],
});
assertAgentToolSchema(reactUpdateComponentInputSchema, {
  defaultPaths: [],
  optionalPaths: [
    "$.browser",
    "$.browserInstanceId",
    "$.location.contextId",
    "$.location.hookId",
    "$.nativeDeviceScaleFactor",
    "$.value.sign",
    "$.value.value",
  ],
});
assertAgentToolSchema(reactHighlightComponentInputSchema, {
  defaultPaths: [],
  optionalPaths: ["$.browser", "$.browserInstanceId", "$.nativeDeviceScaleFactor"],
});
assertAgentToolSchema(reactProfileStartInputSchema, {
  defaultPaths: [],
  optionalPaths: ["$.browser", "$.browserInstanceId", "$.nativeDeviceScaleFactor"],
});
assertAgentToolSchema(reactProfileStopInputSchema);
assertAgentToolSchema(reactProfileAnalyzeInputSchema, {
  defaultPaths: ["$.limit"],
  optionalPaths: ["$.cursor", "$.includeChangeDescriptions", "$.limit", "$.metrics"],
});

export const artifactDescriptorSchema = z
  .object({
    artifactId: z.string().describe("Opaque artifact ID owned by this MCP connection."),
    name: z.string(),
    uri: z
      .string()
      .describe(
        "Artifact content or manifest URI. Read it through the harness-native MCP resource reader for the chrome-mcp server.",
      ),
    mediaType: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string(),
    complete: z.boolean().describe("Whether publication completed and the full artifact is readable."),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
  })
  .strict();

export const browserRenderingInfoSchema = z
  .object({
    profile: z.literal("virtual-display"),
    chromeProduct: z.string(),
    nativeDeviceScaleFactor: nativeDeviceScaleFactorSchema,
    devicePixelRatio: z.number().positive(),
    viewport: z.object({ width: z.number().nonnegative(), height: z.number().nonnegative() }).strict(),
    pageZoom: z.number().positive().optional(),
    visualViewportScale: z.number().positive(),
  })
  .strict();

const runPlaywrightSuccessSchema = z
  .object({
    ok: z.literal(true),
    selectedTargetId: z.string().nullable(),
    emittedCount: z.number().int().nonnegative(),
    rendering: browserRenderingInfoSchema.optional(),
    artifacts: z
      .array(artifactDescriptorSchema)
      .describe("Connection-owned artifacts published by this call."),
    value: z.json().optional(),
    unavailableTargets: z
      .array(unavailableTargetSchema)
      .describe(
        "Unresponsive main Chrome tabs omitted from Playwright pages; a later navigation can make them available again.",
      )
      .optional(),
    valueArtifact: artifactDescriptorSchema
      .describe("Complete returned value when it exceeded the inline result limit.")
      .optional(),
  })
  .strict();

const runPlaywrightFailureSchema = z
  .object({
    ok: z.literal(false),
    diagnostics: z
      .object({
        browserConnection: z
          .enum(["connected", "disconnected", "unknown"])
          .describe("Observed browser CDP connection state, not proof of browser-process exit."),
        chromeProduct: z.string().optional(),
        unavailableTargets: z.array(unavailableTargetSchema).optional(),
        targetCrash: targetCrashEventSchema
          .describe(
            "Crash observed for the failed call's selected target, within this call and owner generation.",
          )
          .optional(),
        journal: z
          .object({
            droppedBefore: eventCursorSchema.nullable(),
            ownerReset: z.boolean(),
          })
          .strict()
          .optional(),
        unavailable: z
          .array(z.enum(["browser-state", "crash-events"]))
          .max(2)
          .optional(),
      })
      .strict()
      .optional(),
    selectedTargetId: z.string().nullable(),
    artifacts: z
      .array(artifactDescriptorSchema)
      .describe("Connection-owned artifacts published before this failure."),
    partialEmittedCount: z
      .number()
      .int()
      .nonnegative()
      .describe("Emitted items returned after a handled failure.")
      .optional(),
    partialOmittedCount: z
      .number()
      .int()
      .nonnegative()
      .describe("Emitted items omitted from the bounded failure prefix.")
      .optional(),
    error: z
      .object({
        code: z.enum(EXECUTION_ERROR_CODES),
        name: z.string(),
        message: z.string(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.partialEmittedCount === undefined) === (value.partialOmittedCount === undefined)) return;
    context.addIssue({
      code: "custom",
      message: "partialEmittedCount and partialOmittedCount must be provided together",
    });
  });

export const runPlaywrightOutputSchema = z
  .discriminatedUnion("ok", [runPlaywrightSuccessSchema, runPlaywrightFailureSchema])
  .meta({ type: "object" });
assertAgentToolSchema(runPlaywrightOutputSchema, {
  direction: "output",
  mapPaths: ["$.$defs.__schema0.anyOf[5]"],
  nullablePaths: [
    "$.$defs.__schema0",
    "$.oneOf[0].artifacts[].expiresAt",
    "$.oneOf[0].selectedTargetId",
    "$.oneOf[0].valueArtifact.expiresAt",
    "$.oneOf[1].artifacts[].expiresAt",
    "$.oneOf[1].diagnostics.journal.droppedBefore",
    "$.oneOf[1].selectedTargetId",
  ],
  optionalPaths: [
    "$.oneOf[0].rendering",
    "$.oneOf[0].rendering.pageZoom",
    "$.oneOf[0].unavailableTargets",
    "$.oneOf[0].value",
    "$.oneOf[0].valueArtifact",
    "$.oneOf[1].diagnostics",
    "$.oneOf[1].diagnostics.chromeProduct",
    "$.oneOf[1].diagnostics.journal",
    "$.oneOf[1].diagnostics.targetCrash",
    "$.oneOf[1].diagnostics.unavailable",
    "$.oneOf[1].diagnostics.unavailableTargets",
    "$.oneOf[1].partialEmittedCount",
    "$.oneOf[1].partialOmittedCount",
  ],
});

export type BrowserMode = z.output<typeof browserModeSchema>;
export type RunPlaywrightInput = z.output<typeof runPlaywrightInputSchema>;
export type PerformanceStartTraceInput = z.output<typeof performanceStartTraceInputSchema>;
export type PerformanceStopTraceInput = z.output<typeof performanceStopTraceInputSchema>;
export type PerformanceAnalyzeInsightInput = z.output<typeof performanceAnalyzeInsightInputSchema>;
export type LighthouseAuditInput = z.output<typeof lighthouseAuditInputSchema>;
export type TakeHeapSnapshotInput = z.output<typeof takeHeapSnapshotInputSchema>;
export type RunPlaywrightOutput = z.output<typeof runPlaywrightOutputSchema>;
export type ReactListComponentsInput = z.output<typeof reactListComponentsInputSchema>;
export type ReactInspectComponentInput = z.output<typeof reactInspectComponentInputSchema>;
export type ReactUpdateComponentInput = z.output<typeof reactUpdateComponentInputSchema>;
export type ReactHighlightComponentInput = z.output<typeof reactHighlightComponentInputSchema>;
export type ReactProfileStartInput = z.output<typeof reactProfileStartInputSchema>;
export type ReactProfileStopInput = z.output<typeof reactProfileStopInputSchema>;
export type ReactProfileAnalyzeInput = z.output<typeof reactProfileAnalyzeInputSchema>;

export const CHROME_CAPABILITY_CAPTURE_TYPES = [
  "trace",
  "har",
  "video",
  "network-bodies",
] as const satisfies readonly CaptureType[];

export const CHROME_CAPABILITY_LIMIT_FIELDS = [
  "artifactBytes",
  "artifactChunkBytes",
  "bindingConcurrency",
  "bindingPayloadBytes",
  "bindingTimeoutMs",
  "connectionArtifactBytes",
  "directArtifactBytes",
  "eventBytes",
  "eventCount",
  "harBytes",
  "inlineImageBytes",
  "inlineImageCount",
  "inlineImageTotalBytes",
  "inlineTextBytes",
  "mutationCountPerKind",
  "mutationEntryBytes",
  "mutationTotalBytes",
  "networkBodyBytes",
  "networkEntries",
  "networkTotalBytes",
  "ordinaryArtifactBytes",
  "ordinaryArtifactCount",
  "runArtifactBytes",
  "snapshotMaxBytes",
  "snapshotMaxDepth",
  "snapshotMinBytes",
  "snapshotMinDepth",
  "snapshotRetainedCount",
  "stateKeyBytes",
  "stateTotalBytes",
  "stateValueBytes",
] as const;

export const CHROME_CAPABILITY_CDP_METHODS = [
  "Accessibility.getFullAXTree",
  "DOM.getBoxModel",
  "HeapProfiler.takeHeapSnapshot",
  "Network.getResponseBody",
  "Page.captureScreenshot",
  "Page.startScreencast",
  ...PWA_CDP_METHODS,
  "Tracing.start",
] as const;

export type ChromeCapabilityCdpMethod = (typeof CHROME_CAPABILITY_CDP_METHODS)[number];

export const chromeCapabilitiesSchema = z
  .object({
    playwrightVersion: z.string(),
    chromeProduct: z.string(),
    cdpProtocolVersion: z.string(),
    browserMode: browserModeSchema,
    browserOwnership: z.enum(["attached", "launched"]),
    headless: z.boolean(),
    nativeDeviceScaleFactor: nativeDeviceScaleFactorSchema.optional(),
    selectedTargetId: z.string(),
    workspaceShared: z.boolean(),
    captures: z.record(
      z.enum(CHROME_CAPABILITY_CAPTURE_TYPES),
      z.object({ activeConflict: z.boolean(), supported: z.boolean() }).strict(),
    ),
    limits: z.record(z.enum(CHROME_CAPABILITY_LIMIT_FIELDS), z.number().nonnegative()),
    journal: z
      .object({
        currentSequence: z.number().int().nonnegative(),
        eventCount: z.number().int().nonnegative(),
        firstRetainedSequence: z.number().int().nonnegative(),
        retainedBytes: z.number().int().nonnegative(),
      })
      .strict(),
    cdp: z.record(z.enum(CHROME_CAPABILITY_CDP_METHODS), z.boolean()),
  })
  .strict();

export type ChromeCapabilities = z.output<typeof chromeCapabilitiesSchema>;

export const CHROME_TOOL_NAMES = [
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
] as const;

export const REMOVED_CHROME_TOOL_NAMES = [
  "react_highlight_component",
  "click",
  "close_page",
  "drag",
  "emulate",
  "evaluate_script",
  "fill",
  "fill_form",
  "get_console_message",
  "get_network_request",
  "handle_dialog",
  "hover",
  "list_console_messages",
  "list_network_requests",
  "list_pages",
  "navigate_page",
  "new_page",
  "press_key",
  "resize_page",
  "select_page",
  "take_screenshot",
  "take_snapshot",
  "type_text",
  "upload_file",
  "wait_for",
] as const;
