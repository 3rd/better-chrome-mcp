import { z } from "zod/v4";
import { isRecord } from "../../platform/records";

export const HEAP_ANALYSIS_MODES = ["summary", "diff", "dominators", "retainers"] as const;
export const HEAP_RESULT_DEFAULT_LIMIT = 10;
export const HEAP_RESULT_MAX_LIMIT = 50;
export const HEAP_RETAINING_PATH_MAX_DEPTH = 32;

const bytesSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const heapQuerySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("objects"),
      className: z.string().min(1).max(160).optional(),
      propertyName: z.string().min(1).max(160).optional(),
      minRetainedBytes: bytesSchema.optional(),
      sort: z.enum(["retainedSize", "selfSize", "id"]).default("retainedSize"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("edges"),
      nodeId: bytesSchema,
      excludePrimitives: z.boolean().default(false),
      minRetainedBytes: bytesSchema.optional(),
      sort: z.enum(["targetRetainedSize", "name"]).default("targetRetainedSize"),
    })
    .strict(),
  z.object({ kind: z.literal("contexts") }).strict(),
]);
export const heapQueryRequestSchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.number().int().min(1).max(HEAP_RESULT_MAX_LIMIT).default(HEAP_RESULT_DEFAULT_LIMIT),
    query: heapQuerySchema,
    snapshotPath: z.string().min(1),
  })
  .strict();

export type HeapQueryRequest = z.infer<typeof heapQueryRequestSchema>;

const heapObjectSchema = z
  .object({
    id: bytesSchema,
    name: z.string(),
    retainedSize: bytesSchema.nullable(),
    selfSize: bytesSchema,
    type: z.string(),
  })
  .strict();
const heapQueryPageSchema = z.object({
  snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  nextCursor: z.string().nullable(),
  totalMatches: bytesSchema,
});
export const heapContextAttributionSchema = z
  .object({
    rows: z.array(
      z
        .object({
          nodeId: bytesSchema,
          nodeName: z.string(),
          attributedSize: bytesSchema,
          retainedSize: bytesSchema,
          selfSize: bytesSchema,
        })
        .strict(),
    ),
    sharedSize: bytesSchema,
    noAttributionSize: bytesSchema,
    retention: z
      .object({
        contextCount: bytesSchema,
        retainedByContextSize: bytesSchema,
        retainedByContextCount: bytesSchema,
        notRetainedByContextSize: bytesSchema,
        notRetainedByContextCount: bytesSchema,
        totalSize: bytesSchema,
      })
      .strict(),
  })
  .strict();
export const heapQueryResultSchema = z.discriminatedUnion("kind", [
  heapQueryPageSchema
    .extend({ kind: z.literal("objects"), rows: z.array(heapObjectSchema).max(HEAP_RESULT_MAX_LIMIT) })
    .strict(),
  heapQueryPageSchema
    .extend({
      kind: z.literal("edges"),
      nodeId: bytesSchema,
      rows: z
        .array(z.object({ name: z.string(), type: z.string(), target: heapObjectSchema }).strict())
        .max(HEAP_RESULT_MAX_LIMIT),
    })
    .strict(),
  heapQueryPageSchema
    .extend(heapContextAttributionSchema.shape)
    .extend({
      kind: z.literal("contexts"),
      rows: heapContextAttributionSchema.shape.rows.max(HEAP_RESULT_MAX_LIMIT),
    })
    .strict(),
]);

export type HeapQueryResult = z.infer<typeof heapQueryResultSchema>;

export type HeapAnalysisMode = (typeof HEAP_ANALYSIS_MODES)[number];

export type HeapAnalysisOptions = {
  baselineFilePath?: string;
  limit?: number;
  maxRetainingPathDepth?: number;
  modes?: readonly HeapAnalysisMode[];
};

export type HeapAnalysisRequest = {
  baselineSnapshotPath?: string;
  limit: number;
  maxRetainingPathDepth: number;
  modes: readonly HeapAnalysisMode[];
  snapshotPath: string;
};

export type HeapSnapshotStats = {
  edgeCount: number;
  nodeCount: number;
  totalShallowSize: number;
};

export type HeapTypeSummary = {
  count: number;
  shallowSize: number;
  type: string;
};

export type HeapClassSummary = HeapTypeSummary & {
  name: string;
};

export type HeapSummary = HeapSnapshotStats & {
  byType: HeapTypeSummary[];
  topClasses: HeapClassSummary[];
};

export type HeapClassDelta = {
  countDelta: number;
  currentCount: number;
  currentShallowSize: number;
  name: string;
  shallowSizeDelta: number;
  type: string;
};

export type HeapDiff = {
  baseline: HeapSnapshotStats;
  current: HeapSnapshotStats;
  edgeCountDelta: number;
  nodeCountDelta: number;
  shallowSizeDelta: number;
  topChanges: HeapClassDelta[];
};

export type HeapNodeSummary = {
  id: number;
  name: string;
  selfSize: number;
  type: string;
};

export type HeapDominator = HeapNodeSummary & {
  retainedPercent: number;
  retainedSize: number;
};

export type HeapRetainingPathStep = HeapNodeSummary & {
  edgeFromParent?: {
    name: string;
    type: string;
  };
};

export type HeapRetainingPath = {
  target: HeapDominator;
  targetToRoot: HeapRetainingPathStep[];
  truncated: boolean;
};

export type HeapAnalysisResult = {
  diff?: HeapDiff;
  dominators?: HeapDominator[];
  retainingPaths?: HeapRetainingPath[];
  snapshot: HeapSnapshotStats;
  summary?: HeapSummary;
};

export type HeapAnalysisWorkerRequest =
  | {
      input: HeapAnalysisRequest;
      operation: "analyze";
    }
  | { input: HeapQueryRequest; operation: "query" };

export type HeapAnalysisWorkerResponse =
  | { error: { code: string; message: string }; ok: false }
  | { ok: true; operation: "query"; result: HeapQueryResult }
  | { ok: true; result: HeapAnalysisResult };

const DEFAULT_RETAINING_PATH_DEPTH = 8;

const invalidMessage = (message: string): Error => new Error(`Invalid heap analysis message: ${message}`);

const requireExactKeys = (value: Record<string, unknown>, keys: readonly string[], name: string): void => {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw invalidMessage(`${name} has unknown field ${key}`);
  }
};

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidMessage(`${name} must be a non-empty string`);
  }
  return value;
};

const requireNumber = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidMessage(`${name} must be a finite number`);
  }
  return value;
};

const requireInteger = (
  value: unknown,
  name: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  const number = requireNumber(value, name);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw invalidMessage(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return number;
};

const parseMode = (value: unknown): HeapAnalysisMode => {
  if (value === "summary" || value === "diff" || value === "dominators" || value === "retainers") {
    return value;
  }
  throw invalidMessage("analysis mode is unsupported");
};

const normalizedModes = (
  modes: readonly HeapAnalysisMode[] | undefined,
  hasBaseline: boolean,
): readonly HeapAnalysisMode[] => {
  const selected =
    modes ?? (hasBaseline ? HEAP_ANALYSIS_MODES : HEAP_ANALYSIS_MODES.filter((mode) => mode !== "diff"));
  if (selected.length === 0) throw invalidMessage("at least one analysis mode is required");
  const unique = new Set<HeapAnalysisMode>();
  for (const mode of selected) {
    if (unique.has(mode)) throw invalidMessage(`analysis mode ${mode} is duplicated`);
    unique.add(mode);
  }
  if (unique.has("diff") && !hasBaseline) throw invalidMessage("diff analysis requires baselineFilePath");
  return [...unique];
};

export const normalizeHeapAnalysisOptions = (
  snapshotPath: string,
  options: HeapAnalysisOptions,
  baselineSnapshotPath?: string,
): HeapAnalysisRequest => {
  const normalizedSnapshotPath = requireString(snapshotPath, "snapshotPath");
  const modes = normalizedModes(options.modes, baselineSnapshotPath !== undefined);
  if (modes.includes("diff") && baselineSnapshotPath === normalizedSnapshotPath) {
    throw invalidMessage("baselineFilePath must differ from filePath for diff analysis");
  }
  return {
    ...(baselineSnapshotPath ? { baselineSnapshotPath } : {}),
    limit: requireInteger(
      options.limit ?? HEAP_RESULT_DEFAULT_LIMIT,
      "analysis.limit",
      1,
      HEAP_RESULT_MAX_LIMIT,
    ),
    maxRetainingPathDepth: requireInteger(
      options.maxRetainingPathDepth ?? DEFAULT_RETAINING_PATH_DEPTH,
      "analysis.maxRetainingPathDepth",
      1,
      HEAP_RETAINING_PATH_MAX_DEPTH,
    ),
    modes,
    snapshotPath: normalizedSnapshotPath,
  };
};

const parseRequestInput = (value: unknown): HeapAnalysisRequest => {
  if (!isRecord(value)) throw invalidMessage("request input must be an object");
  requireExactKeys(
    value,
    ["baselineSnapshotPath", "limit", "maxRetainingPathDepth", "modes", "snapshotPath"],
    "request input",
  );
  const baselineSnapshotPath =
    value.baselineSnapshotPath === undefined ?
      undefined
    : requireString(value.baselineSnapshotPath, "baselineSnapshotPath");
  if (!Array.isArray(value.modes)) throw invalidMessage("modes must be an array");
  const modes = value.modes.map(parseMode);
  const normalized = normalizeHeapAnalysisOptions(
    requireString(value.snapshotPath, "snapshotPath"),
    {
      limit: requireInteger(value.limit, "limit", 1, HEAP_RESULT_MAX_LIMIT),
      maxRetainingPathDepth: requireInteger(
        value.maxRetainingPathDepth,
        "maxRetainingPathDepth",
        1,
        HEAP_RETAINING_PATH_MAX_DEPTH,
      ),
      modes,
    },
    baselineSnapshotPath,
  );
  return normalized;
};

export const parseHeapAnalysisWorkerRequest = (value: unknown): HeapAnalysisWorkerRequest => {
  if (!isRecord(value)) throw invalidMessage("request must be an object");
  requireExactKeys(value, ["input", "operation"], "request");
  if (value.operation === "query") {
    return { input: heapQueryRequestSchema.parse(value.input), operation: "query" };
  }

  if (value.operation !== "analyze") throw invalidMessage("operation is unsupported");
  return { input: parseRequestInput(value.input), operation: "analyze" };
};

const parseSnapshotFields = (value: Record<string, unknown>, name: string): HeapSnapshotStats => ({
  edgeCount: requireInteger(value.edgeCount, `${name}.edgeCount`),
  nodeCount: requireInteger(value.nodeCount, `${name}.nodeCount`),
  totalShallowSize: requireInteger(value.totalShallowSize, `${name}.totalShallowSize`),
});

const parseSnapshotStats = (value: unknown, name: string): HeapSnapshotStats => {
  if (!isRecord(value)) throw invalidMessage(`${name} must be an object`);
  requireExactKeys(value, ["edgeCount", "nodeCount", "totalShallowSize"], name);
  return parseSnapshotFields(value, name);
};

const parseTypeSummary = (value: unknown, name: string): HeapTypeSummary => {
  if (!isRecord(value)) throw invalidMessage(`${name} must be an object`);
  requireExactKeys(value, ["count", "shallowSize", "type"], name);
  return {
    count: requireInteger(value.count, `${name}.count`),
    shallowSize: requireInteger(value.shallowSize, `${name}.shallowSize`),
    type: requireString(value.type, `${name}.type`),
  };
};

const parseClassSummary = (value: unknown, name: string): HeapClassSummary => {
  if (!isRecord(value)) throw invalidMessage(`${name} must be an object`);
  requireExactKeys(value, ["count", "name", "shallowSize", "type"], name);
  return {
    count: requireInteger(value.count, `${name}.count`),
    name: requireString(value.name, `${name}.name`),
    shallowSize: requireInteger(value.shallowSize, `${name}.shallowSize`),
    type: requireString(value.type, `${name}.type`),
  };
};

const parseSummary = (value: unknown): HeapSummary => {
  if (!isRecord(value)) throw invalidMessage("summary must be an object");
  requireExactKeys(value, ["byType", "edgeCount", "nodeCount", "topClasses", "totalShallowSize"], "summary");
  if (!Array.isArray(value.byType) || !Array.isArray(value.topClasses)) {
    throw invalidMessage("summary collections must be arrays");
  }
  return {
    ...parseSnapshotFields(value, "summary"),
    byType: value.byType.map((item, index) => parseTypeSummary(item, `summary.byType[${index}]`)),
    topClasses: value.topClasses.map((item, index) =>
      parseClassSummary(item, `summary.topClasses[${index}]`),
    ),
  };
};

const parseClassDelta = (value: unknown, name: string): HeapClassDelta => {
  if (!isRecord(value)) throw invalidMessage(`${name} must be an object`);
  requireExactKeys(
    value,
    ["countDelta", "currentCount", "currentShallowSize", "name", "shallowSizeDelta", "type"],
    name,
  );
  return {
    countDelta: requireInteger(value.countDelta, `${name}.countDelta`, Number.MIN_SAFE_INTEGER),
    currentCount: requireInteger(value.currentCount, `${name}.currentCount`),
    currentShallowSize: requireInteger(value.currentShallowSize, `${name}.currentShallowSize`),
    name: requireString(value.name, `${name}.name`),
    shallowSizeDelta: requireInteger(
      value.shallowSizeDelta,
      `${name}.shallowSizeDelta`,
      Number.MIN_SAFE_INTEGER,
    ),
    type: requireString(value.type, `${name}.type`),
  };
};

const parseDiff = (value: unknown): HeapDiff => {
  if (!isRecord(value) || !Array.isArray(value.topChanges)) throw invalidMessage("diff must be an object");
  requireExactKeys(
    value,
    ["baseline", "current", "edgeCountDelta", "nodeCountDelta", "shallowSizeDelta", "topChanges"],
    "diff",
  );
  return {
    baseline: parseSnapshotStats(value.baseline, "diff.baseline"),
    current: parseSnapshotStats(value.current, "diff.current"),
    edgeCountDelta: requireInteger(value.edgeCountDelta, "diff.edgeCountDelta", Number.MIN_SAFE_INTEGER),
    nodeCountDelta: requireInteger(value.nodeCountDelta, "diff.nodeCountDelta", Number.MIN_SAFE_INTEGER),
    shallowSizeDelta: requireInteger(
      value.shallowSizeDelta,
      "diff.shallowSizeDelta",
      Number.MIN_SAFE_INTEGER,
    ),
    topChanges: value.topChanges.map((item, index) => parseClassDelta(item, `diff.topChanges[${index}]`)),
  };
};

const parseNodeFields = (value: Record<string, unknown>, name: string): HeapNodeSummary => ({
  id: requireInteger(value.id, `${name}.id`),
  name: requireString(value.name, `${name}.name`),
  selfSize: requireInteger(value.selfSize, `${name}.selfSize`),
  type: requireString(value.type, `${name}.type`),
});

const parseDominator = (value: unknown, name: string): HeapDominator => {
  if (!isRecord(value)) throw invalidMessage(`${name} must be an object`);
  requireExactKeys(value, ["id", "name", "retainedPercent", "retainedSize", "selfSize", "type"], name);
  return {
    ...parseNodeFields(value, name),
    retainedPercent: requireNumber(value.retainedPercent, `${name}.retainedPercent`),
    retainedSize: requireInteger(value.retainedSize, `${name}.retainedSize`),
  };
};

const parsePathStep = (value: unknown, name: string): HeapRetainingPathStep => {
  if (!isRecord(value)) throw invalidMessage(`${name} must be an object`);
  requireExactKeys(value, ["edgeFromParent", "id", "name", "selfSize", "type"], name);
  const node = parseNodeFields(value, name);
  if (value.edgeFromParent === undefined) return node;
  if (!isRecord(value.edgeFromParent)) throw invalidMessage(`${name}.edgeFromParent must be an object`);
  requireExactKeys(value.edgeFromParent, ["name", "type"], `${name}.edgeFromParent`);
  return {
    ...node,
    edgeFromParent: {
      name: requireString(value.edgeFromParent.name, `${name}.edgeFromParent.name`),
      type: requireString(value.edgeFromParent.type, `${name}.edgeFromParent.type`),
    },
  };
};

const parseRetainingPath = (value: unknown, name: string): HeapRetainingPath => {
  if (!isRecord(value) || !Array.isArray(value.targetToRoot)) {
    throw invalidMessage(`${name} must be an object`);
  }
  requireExactKeys(value, ["target", "targetToRoot", "truncated"], name);
  if (typeof value.truncated !== "boolean") throw invalidMessage(`${name}.truncated must be a boolean`);
  return {
    target: parseDominator(value.target, `${name}.target`),
    targetToRoot: value.targetToRoot.map((item, index) =>
      parsePathStep(item, `${name}.targetToRoot[${index}]`),
    ),
    truncated: value.truncated,
  };
};

const parseResult = (value: unknown): HeapAnalysisResult => {
  if (!isRecord(value)) throw invalidMessage("result must be an object");
  requireExactKeys(value, ["diff", "dominators", "retainingPaths", "snapshot", "summary"], "result");
  if (value.dominators !== undefined && !Array.isArray(value.dominators)) {
    throw invalidMessage("result.dominators must be an array");
  }
  if (value.retainingPaths !== undefined && !Array.isArray(value.retainingPaths)) {
    throw invalidMessage("result.retainingPaths must be an array");
  }
  return {
    ...(value.diff === undefined ? {} : { diff: parseDiff(value.diff) }),
    ...(value.dominators === undefined ?
      {}
    : { dominators: value.dominators.map((item, index) => parseDominator(item, `dominators[${index}]`)) }),
    ...(value.retainingPaths === undefined ?
      {}
    : {
        retainingPaths: value.retainingPaths.map((item, index) =>
          parseRetainingPath(item, `retainingPaths[${index}]`),
        ),
      }),
    snapshot: parseSnapshotStats(value.snapshot, "snapshot"),
    ...(value.summary === undefined ? {} : { summary: parseSummary(value.summary) }),
  };
};

export const parseHeapAnalysisWorkerResponse = (value: unknown): HeapAnalysisWorkerResponse => {
  if (!isRecord(value) || typeof value.ok !== "boolean") throw invalidMessage("response must be an object");
  if (value.ok) {
    if (value.operation === "query") {
      requireExactKeys(value, ["ok", "operation", "result"], "response");
      return { ok: true, operation: "query", result: heapQueryResultSchema.parse(value.result) };
    }

    requireExactKeys(value, ["ok", "result"], "response");
    return { ok: true, result: parseResult(value.result) };
  }
  requireExactKeys(value, ["error", "ok"], "response");
  if (!isRecord(value.error)) throw invalidMessage("response.error must be an object");
  requireExactKeys(value.error, ["code", "message"], "response.error");
  return {
    error: {
      code: requireString(value.error.code, "response.error.code"),
      message: requireString(value.error.message, "response.error.message"),
    },
    ok: false,
  };
};
