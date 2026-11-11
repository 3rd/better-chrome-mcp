import { z } from "zod/v4";

export const REACT_COMPONENT_PAGE_DEFAULT = 100;
export const REACT_COMPONENT_PAGE_MAX = 500;
const REACT_ANALYSIS_PAGE_DEFAULT = 25;
const REACT_ANALYSIS_PAGE_MAX = 100;
export const REACT_ANALYSIS_RESULT_MAX_BYTES = 64 * 1024;
export const REACT_TREE_COMPONENT_MAX = 50_000;
export const REACT_INLINE_RESULT_MAX_BYTES = 256 * 1024;
export const REACT_INSPECTED_GRAPH_MAX_ENTRIES = 100_000;
export const REACT_INSPECTED_GRAPH_MAX_DEPTH = 100;
export const REACT_INSPECTED_GRAPH_MAX_BYTES = 32 * 1024 * 1024;
export const REACT_BRIDGE_MESSAGE_MAX_BYTES = 8 * 1024 * 1024;
export const REACT_BRIDGE_PENDING_MAX_MESSAGES = 1024;
export const REACT_BRIDGE_PENDING_MAX_BYTES = 32 * 1024 * 1024;
export const REACT_PROFILE_MAX_COMMITS = 10_000;
export const REACT_PROFILE_MAX_BYTES = 100 * 1024 * 1024;
export const REACT_HOST_NODE_MAX = 100;

export const reactIdentifierSchema = z
  .string()
  .refine((value) => value.length > 0 && value.length <= 256, "Expected 1 to 256 characters");
export const reactPathSchema = z
  .array(z.union([z.string(), z.number().int().nonnegative()]))
  .max(100)
  .meta({ id: "path" });

export const REACT_STAGED_NODE_KEY_PREFIX = "__chromeMcpReactNode_";
const reactStagedNodeKeyPattern = new RegExp(`^${REACT_STAGED_NODE_KEY_PREFIX}[0-9a-f]{32}$`, "u");

export const reactComponentLookupSchema = z
  .object({
    componentId: reactIdentifierSchema,
    type: z.literal("component"),
  })
  .strict();

export const reactSelectorLookupSchema = z
  .object({
    selector: z.string().min(1).max(4096),
    type: z.literal("selector"),
  })
  .strict();

const reactStagedNodeKeySchema = z.string().regex(reactStagedNodeKeyPattern);

const reactStagedNodeLookupSchema = z
  .object({
    key: reactStagedNodeKeySchema,
    type: z.literal("staged-node"),
  })
  .strict();

export const reactMutationValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("json"), value: z.json() }).strict(),
  z.object({ type: z.literal("undefined") }).strict(),
  z.object({ type: z.literal("nan") }).strict(),
  z.object({ sign: z.union([z.literal(1), z.literal(-1)]), type: z.literal("infinity") }).strict(),
  z.object({ type: z.literal("bigint"), value: z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u) }).strict(),
]);

export const reactListRequestSchema = z
  .object({
    cursor: reactIdentifierSchema.optional(),
    limit: z.number().int().min(1).max(REACT_COMPONENT_PAGE_MAX).default(REACT_COMPONENT_PAGE_DEFAULT),
    operation: z.literal("list"),
    parentComponentId: reactIdentifierSchema.optional(),
    rendererId: reactIdentifierSchema.optional(),
    rootId: reactIdentifierSchema.optional(),
    search: z.string().max(1024).optional(),
  })
  .strict();

const reactInspectRequestSchema = z
  .object({
    lookup: z.discriminatedUnion("type", [
      reactComponentLookupSchema,
      reactSelectorLookupSchema,
      reactStagedNodeLookupSchema,
    ]),
    operation: z.literal("inspect"),
  })
  .strict();

const reactPrepareRequestSchema = z
  .object({
    operation: z.literal("prepare"),
  })
  .strict();

export const reactUpdateRequestSchema = z
  .object({
    componentId: reactIdentifierSchema,
    location: z.discriminatedUnion("type", [
      z.object({ path: reactPathSchema, type: z.literal("props") }).strict(),
      z.object({ path: reactPathSchema, type: z.literal("class-state") }).strict(),
      z
        .object({ hookId: reactIdentifierSchema, path: reactPathSchema, type: z.literal("hook-state") })
        .strict(),
      z
        .object({ contextId: reactIdentifierSchema, path: reactPathSchema, type: z.literal("context") })
        .strict(),
    ]),
    operation: z.literal("update"),
    value: reactMutationValueSchema,
  })
  .strict();

export const reactHighlightRequestSchema = z
  .object({
    action: z.discriminatedUnion("type", [
      z.object({ componentId: reactIdentifierSchema, type: z.literal("show") }).strict(),
      z.object({ type: z.literal("clear") }).strict(),
    ]),
    operation: z.literal("highlight"),
  })
  .strict();

export const reactProfileStartRequestSchema = z
  .object({
    operation: z.literal("profile-start"),
  })
  .strict();

export const reactProfileStopRequestSchema = z
  .object({
    operation: z.literal("profile-stop"),
    profileId: reactIdentifierSchema,
  })
  .strict();

export const REACT_PROFILE_ANALYSIS_METRICS = [
  "render-count",
  "commit-participation",
  "total-self-duration",
  "total-inclusive-duration",
  "maximum-render-duration",
  "effect-duration",
  "slowest-commit",
] as const;

const reactProfileAnalysisMetricSchema = z
  .enum(REACT_PROFILE_ANALYSIS_METRICS)
  .describe(
    "Component-row ranking metric. effect-duration sums whole-commit effect time; slowest-commit is the largest whole-commit duration. Both cover commits in which the component rendered and are not component-attributed.",
  );

export const reactProfileAnalyzeRequestSchema = z
  .object({
    cursor: reactIdentifierSchema.optional(),
    includeChangeDescriptions: z
      .boolean()
      .optional()
      .describe(
        "Default false. Publish complete per-commit change descriptions for the returned page as a JSON artifact; inline rows remain compact.",
      ),
    limit: z.number().int().min(1).max(REACT_ANALYSIS_PAGE_MAX).default(REACT_ANALYSIS_PAGE_DEFAULT),
    metrics: z
      .array(reactProfileAnalysisMetricSchema)
      .min(1)
      .max(REACT_PROFILE_ANALYSIS_METRICS.length)
      .optional(),
    operation: z.literal("profile-analyze"),
    profileId: reactIdentifierSchema,
  })
  .strict();

export const reactBrowserOperationSchema = z.discriminatedUnion("operation", [
  reactPrepareRequestSchema,
  reactListRequestSchema,
  reactInspectRequestSchema,
  reactUpdateRequestSchema,
  reactHighlightRequestSchema,
  reactProfileStartRequestSchema,
  reactProfileStopRequestSchema,
]);

export const reactOperationResultSchema = z
  .object({
    data: z.record(z.string(), z.unknown()),
    documentId: z.string().uuid(),
    frameId: z.string().min(1),
    instrumentationState: z.enum(["attached", "reloaded"]),
    reloaded: z.boolean(),
    rendererCapabilities: z
      .object({
        canEditContext: z.boolean(),
        canEditHooks: z.boolean(),
        canEditProps: z.boolean(),
        canEditState: z.boolean(),
        canHighlight: z.boolean(),
        canInspect: z.boolean(),
        canProfile: z.boolean(),
        domMapping: z.boolean(),
        ownerMetadata: z.boolean(),
        sourceMetadata: z.boolean(),
      })
      .strict(),
    targetId: z.string().min(1),
    url: z.string(),
    warnings: z.array(z.object({ code: z.string().min(1), message: z.string().min(1) }).strict()),
  })
  .strict();

export type ReactBrowserOperation = z.output<typeof reactBrowserOperationSchema>;
export type ReactMutationValue = z.output<typeof reactMutationValueSchema>;

export type ReactRendererCapabilities = z.output<typeof reactOperationResultSchema>["rendererCapabilities"];

export type ReactOperationResult = z.output<typeof reactOperationResultSchema>;
