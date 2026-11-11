/**
 * Portions of the parse and formatter flow are adapted from ChromeDevTools/chrome-devtools-mcp.
 * Copyright 2025 Google LLC. Licensed under Apache-2.0.
 */
import { gunzipSync } from "node:zlib";
import type {
  TraceAnalysis,
  TraceAnalysisInput,
  TraceInsightInput,
  TraceInsightReference,
  TraceMetadata,
} from "./types";
import { isRecord } from "../../platform/records";
import {
  callFrontendMethod,
  loadChromeFrontend,
  readFrontendProperty,
  requireFrontendFunction,
  requireFrontendPropertyRecord,
  requireFrontendRecord,
} from "./frontend-adapter";

type UnknownRecord = Record<string, unknown>;

type ParsedTraceContext = {
  frontend: UnknownRecord;
  insights: Map<unknown, unknown> | undefined;
  parsedTrace: UnknownRecord;
  rawEvents: unknown[];
};

type SynchronousTraceEvent = {
  category: string;
  duration?: number;
  name: string;
  phase: "B" | "E" | "X";
  timestamp: number;
};

type TraceThreadTiming = {
  events: SynchronousTraceEvent[];
  name?: string;
  processId: number;
  threadId: number;
};

type TraceTaskInterval = {
  end: number;
  start: number;
};

const DEVTOOLS_HANDLER_THREAD_NAME = "Chrome_DevToolsHandlerThread";
const MAX_TIMING_EXAMPLES = 5;
const MAX_TIMING_LABEL_CHARACTERS = 120;

// Exact line that PerformanceTraceFormatter prints when a trace has no CrUX field data. This server never
// requests CrUX data, so the line is replaced; re-check the wording whenever chrome-devtools-frontend is
// upgraded, or the false CrUX claim reappears in every summary.
const UPSTREAM_MISSING_FIELD_DATA_LINE = "Metrics (field / real users): n/a – no data for this page in CrUX";
const MISSING_FIELD_DATA_LINE =
  "Metrics (field / real users): not requested; this server does not fetch CrUX field data";

const callAsync = async (owner: unknown, method: string, argumentsList: unknown[] = []): Promise<unknown> =>
  callFrontendMethod(owner, method, argumentsList);

const callString = (owner: unknown, method: string, argumentsList: unknown[] = []): string => {
  const value = callFrontendMethod(owner, method, argumentsList);
  if (typeof value !== "string") {
    throw new TypeError(`Chrome DevTools Frontend ${method}() returned invalid text`);
  }
  return value;
};

const construct = (owner: unknown, key: string, argumentsList: unknown[]): UnknownRecord =>
  requireFrontendRecord(Reflect.construct(requireFrontendFunction(owner, key), argumentsList), key);

const loadTraceEvents = async (tracePath: string): Promise<unknown[]> => {
  const bytes = new Uint8Array(await Bun.file(tracePath).arrayBuffer());
  const isGzip = bytes.length >= 3 && bytes[0] === 0x1F && bytes[1] === 0x8B && bytes[2] === 0x08;
  const source = isGzip ? gunzipSync(bytes).toString("utf8") : new TextDecoder().decode(bytes);
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new Error("The performance trace is not valid JSON");
  }
  if (Array.isArray(decoded)) return decoded;
  if (isRecord(decoded) && Array.isArray(decoded.traceEvents)) return decoded.traceEvents;
  throw new Error("The performance trace does not contain a traceEvents array");
};

const collectTraceThreadTiming = (rawEvents: unknown[]) => {
  const threads = new Map<string, TraceThreadTiming>();
  let invalidEventCount = 0;

  for (const rawEvent of rawEvents) {
    if (!isRecord(rawEvent)) continue;
    const phase = rawEvent.ph;
    const isThreadMetadata = phase === "M" && rawEvent.name === "thread_name";
    const isSynchronousEvent = phase === "B" || phase === "E" || phase === "X";
    const hasTimingInformation = isThreadMetadata || isSynchronousEvent;
    if (!hasTimingInformation) continue;

    const processId = rawEvent.pid;
    const threadId = rawEvent.tid;
    const hasValidIdentity =
      typeof processId === "number" &&
      Number.isInteger(processId) &&
      typeof threadId === "number" &&
      Number.isInteger(threadId);
    if (!hasValidIdentity) {
      if (isSynchronousEvent) {
        invalidEventCount += 1;
      }

      continue;
    }

    const key = `${processId}:${threadId}`;
    let thread = threads.get(key);
    if (!thread) {
      thread = { events: [], processId, threadId };
      threads.set(key, thread);
    }

    if (isThreadMetadata) {
      const threadName = isRecord(rawEvent.args) ? rawEvent.args.name : undefined;
      if (typeof threadName === "string") {
        thread.name = threadName;
      }

      continue;
    }

    const timestamp = rawEvent.ts;
    const name = rawEvent.name;
    const hasValidTiming =
      isSynchronousEvent &&
      typeof timestamp === "number" &&
      Number.isFinite(timestamp) &&
      (typeof name === "string" || phase === "E");
    if (!hasValidTiming) {
      invalidEventCount += 1;
      continue;
    }

    const duration = rawEvent.dur;
    const hasValidDuration =
      typeof duration === "number" && duration >= 0 && Number.isFinite(timestamp + duration);
    thread.events.push({
      category: typeof rawEvent.cat === "string" ? rawEvent.cat : "",
      ...(hasValidDuration ? { duration } : {}),
      name: typeof name === "string" ? name : "",
      phase,
      timestamp,
    });
  }

  return { invalidEventCount, threads };
};

const isTopLevelTask = (event: SynchronousTraceEvent) =>
  (event.name === "RunTask" || event.name === "ThreadControllerImpl::RunTask") &&
  event.category.split(",").includes("toplevel");

const measureTaskIntervals = (intervals: TraceTaskInterval[]) => {
  intervals.sort((left, right) => {
    const startDifference = left.start - right.start;
    if (startDifference !== 0) return startDifference;
    return right.end - left.end;
  });

  const outerIntervals: TraceTaskInterval[] = [];
  let coveredMicroseconds = 0;
  let maximumMicroseconds = 0;
  let coveredEnd = -Infinity;

  for (const interval of intervals) {
    if (interval.end <= coveredEnd) continue;

    outerIntervals.push(interval);
    coveredMicroseconds += interval.end - Math.max(interval.start, coveredEnd);
    maximumMicroseconds = Math.max(maximumMicroseconds, interval.end - interval.start);
    coveredEnd = interval.end;
  }

  return { coveredMicroseconds, maximumMicroseconds, outerIntervals };
};

const analyzeThreadTiming = (thread: TraceThreadTiming) => {
  const isDevToolsThread = thread.name === DEVTOOLS_HANDLER_THREAD_NAME;
  const beginnings: SynchronousTraceEvent[] = [];
  const taskIntervals: TraceTaskInterval[] = [];
  let completedCount = 0;
  let pairedCount = 0;
  let unmeasuredCompleteCount = 0;
  let unmatchedEndCount = 0;
  let latestCompletedStart = -Infinity;
  let hasDevToolsTaskEvents = false;

  thread.events.sort((left, right) => left.timestamp - right.timestamp);

  for (const event of thread.events) {
    const isDevToolsTask = isDevToolsThread && isTopLevelTask(event);
    hasDevToolsTaskEvents ||= isDevToolsTask;

    if (event.phase === "B") {
      beginnings.push(event);
      continue;
    }

    if (event.phase === "E") {
      const beginning = beginnings.pop();
      if (!beginning) {
        unmatchedEndCount += 1;
        continue;
      }

      pairedCount += 1;
      latestCompletedStart = Math.max(latestCompletedStart, beginning.timestamp);

      const isDevToolsTaskBeginning = isDevToolsThread && isTopLevelTask(beginning);
      if (isDevToolsTaskBeginning) {
        taskIntervals.push({ start: beginning.timestamp, end: event.timestamp });
      }

      continue;
    }

    const duration = event.duration;
    if (duration === undefined) {
      unmeasuredCompleteCount += 1;
      continue;
    }

    completedCount += 1;
    latestCompletedStart = Math.max(latestCompletedStart, event.timestamp);

    if (!isDevToolsTask) continue;

    taskIntervals.push({ start: event.timestamp, end: event.timestamp + duration });
  }

  return {
    beginnings,
    completedCount,
    hasDevToolsTaskEvents,
    isDevToolsThread,
    latestCompletedStart,
    pairedCount,
    taskIntervals,
    unmatchedEndCount,
    unmeasuredCompleteCount,
  };
};

const summarizeTraceTiming = (rawEvents: unknown[]) => {
  const { invalidEventCount, threads } = collectTraceThreadTiming(rawEvents);
  const examples: string[] = [];
  const devToolsIntervals: TraceTaskInterval[] = [];
  let completedCount = 0;
  let pairedCount = 0;
  let unmeasuredCompleteCount = 0;
  let unboundedCount = 0;
  let laterActivityCount = 0;
  let unmatchedEndCount = 0;

  let devToolsTaskCount = 0;
  let unboundedDevToolsTaskCount = 0;
  let hasDevToolsMetadata = false;
  let hasDevToolsTaskEvents = false;

  for (const thread of threads.values()) {
    const analysis = analyzeThreadTiming(thread);
    completedCount += analysis.completedCount;
    pairedCount += analysis.pairedCount;
    unmeasuredCompleteCount += analysis.unmeasuredCompleteCount;
    unmatchedEndCount += analysis.unmatchedEndCount;
    hasDevToolsMetadata ||= analysis.isDevToolsThread;
    hasDevToolsTaskEvents ||= analysis.hasDevToolsTaskEvents;

    for (const beginning of analysis.beginnings) {
      unboundedCount += 1;
      const hasLaterCompletedActivity = analysis.latestCompletedStart > beginning.timestamp;
      if (hasLaterCompletedActivity) {
        laterActivityCount += 1;
      }

      const isDevToolsTaskBeginning = analysis.isDevToolsThread && isTopLevelTask(beginning);
      if (isDevToolsTaskBeginning) {
        unboundedDevToolsTaskCount += 1;
      }

      if (examples.length >= MAX_TIMING_EXAMPLES) continue;

      const name = JSON.stringify(beginning.name.slice(0, MAX_TIMING_LABEL_CHARACTERS));
      const threadName = thread.name?.slice(0, MAX_TIMING_LABEL_CHARACTERS) ?? "unnamed thread";
      const activity = hasLaterCompletedActivity ? "later completed activity" : "no later completed activity";
      examples.push(
        `- ${name} on ${threadName} (pid ${thread.processId}, tid ${thread.threadId}) at ${beginning.timestamp} µs; end unknown; ${activity}`,
      );
    }

    const measured = measureTaskIntervals(analysis.taskIntervals);
    devToolsTaskCount += measured.outerIntervals.length;

    for (const interval of measured.outerIntervals) {
      devToolsIntervals.push(interval);
    }
  }

  const lines = [
    "## Synchronous timing coverage (raw trace)",
    `Completed X spans: ${completedCount}; Matched B/E spans: ${pairedCount}; Unmeasured X spans: ${unmeasuredCompleteCount}.`,
    `Unbounded B spans: ${unboundedCount} (${laterActivityCount} with later completed activity; ${unboundedCount - laterActivityCount} without); Unmatched E events: ${unmatchedEndCount}; Invalid synchronous event records: ${invalidEventCount}.`,
    "X spans carry durations; zero E events alone does not imply missing timing. Capture boundaries can leave spans unbounded; later activity does not supply an end time.",
    ...examples,
  ];

  if (unboundedCount > examples.length) {
    lines.push(`${unboundedCount - examples.length} additional unbounded spans not listed.`);
  }

  if (!hasDevToolsMetadata) {
    lines.push(
      `DevTools-handler task wall time: not captured (no ${DEVTOOLS_HANDLER_THREAD_NAME} metadata).`,
    );
  } else if (!hasDevToolsTaskEvents) {
    lines.push(
      "DevTools-handler task wall time: not captured (no toplevel task events on the named thread).",
    );
  } else if (devToolsTaskCount === 0) {
    lines.push(
      `DevTools-handler task wall time: no completed task spans; unbounded task beginnings: ${unboundedDevToolsTaskCount}.`,
    );
  } else {
    const measured = measureTaskIntervals(devToolsIntervals);

    lines.push(
      "DevTools-handler task wall time (captured spans only):",
      `Outer tasks: ${devToolsTaskCount}; maximum: ${measured.maximumMicroseconds / 1000} ms; interval coverage: ${measured.coveredMicroseconds / 1000} ms.`,
      `Unbounded task beginnings: ${unboundedDevToolsTaskCount}.`,
      "These durations are wall time, not CPU cost or added page latency.",
    );
  }

  return lines.join("\n");
};

const traceInsights = (parsedTrace: UnknownRecord): Map<unknown, unknown> | undefined => {
  const value = parsedTrace.insights;
  if (value === null || value === undefined) return undefined;
  if (!(value instanceof Map)) throw new Error("Chrome DevTools Frontend returned invalid trace insights");
  const insights: Map<unknown, unknown> = value;
  return insights;
};

const parseTrace = async (input: {
  metadata: TraceMetadata;
  tracePath: string;
}): Promise<ParsedTraceContext> => {
  const frontend = await loadChromeFrontend();
  const traceEngine = requireFrontendPropertyRecord(frontend, "TraceEngine");
  const traceModel = requireFrontendPropertyRecord(traceEngine, "TraceModel");
  const modelClass = readFrontendProperty(traceModel, "Model");
  const model = requireFrontendRecord(callFrontendMethod(modelClass, "createWithAllHandlers"), "trace model");
  const rawEvents = await loadTraceEvents(input.tracePath);
  await callAsync(model, "parse", [rawEvents, { metadata: input.metadata }]);
  const parsedTrace = requireFrontendRecord(callFrontendMethod(model, "parsedTrace"), "parsed trace");
  const insights = traceInsights(parsedTrace);
  return { frontend, insights, parsedTrace, rawEvents };
};

const createFocus = (frontend: UnknownRecord, parsedTrace: UnknownRecord): unknown => {
  const agentFocus = readFrontendProperty(frontend, "AgentFocus");
  return callFrontendMethod(agentFocus, "fromParsedTrace", [parsedTrace]);
};

const insightReferences = (insights: Map<unknown, unknown> | undefined): TraceInsightReference[] => {
  const references: TraceInsightReference[] = [];
  for (const [insightSetIdValue, setValue] of insights?.entries() ?? []) {
    if (typeof insightSetIdValue !== "string" || insightSetIdValue.length === 0) {
      throw new Error("A trace insight set has no insightSetId");
    }
    const insightSet = requireFrontendRecord(setValue, "trace insight set");
    const bounds = requireFrontendPropertyRecord(insightSet, "bounds");
    const min = bounds.min;
    const max = bounds.max;
    const hasInvalidBounds =
      typeof min !== "number" || !Number.isFinite(min) || typeof max !== "number" || !Number.isFinite(max);
    if (hasInvalidBounds) {
      throw new Error("A trace insight set has invalid time bounds");
    }

    const navigation =
      insightSet.navigation === undefined ?
        undefined
      : requireFrontendRecord(insightSet.navigation, "insight navigation");
    let navigationKind: TraceInsightReference["navigationKind"] = "none";
    if (navigation !== undefined) {
      navigationKind = navigation.name === "SoftNavigationStart" ? "soft" : "hard";
    }

    const url = String(insightSet.url);
    const models = requireFrontendPropertyRecord(insightSet, "model");

    for (const [insightName, modelValue] of Object.entries(models)) {
      const model = requireFrontendRecord(modelValue, "trace insight model");
      if (typeof model.insightKey !== "string") throw new Error("A trace insight has no insightKey");
      references.push({
        bounds: { startMicroseconds: min, endMicroseconds: max },
        insightKey: model.insightKey,
        insightName,
        insightSetId: insightSetIdValue,
        navigationKind,
        url,
      });
    }
  }
  return references;
};

export const analyzeTraceWithChromeFrontend = async (input: TraceAnalysisInput): Promise<TraceAnalysis> => {
  const parsed = await parseTrace(input);
  const focus = createFocus(parsed.frontend, parsed.parsedTrace);
  const formatter = construct(parsed.frontend, "PerformanceTraceFormatter", [focus, input.deviceScope]);
  const summaryText = callString(formatter, "formatTraceSummary").replaceAll(
    UPSTREAM_MISSING_FIELD_DATA_LINE,
    MISSING_FIELD_DATA_LINE,
  );

  return {
    insights: insightReferences(parsed.insights),
    summary: `## Summary of Performance trace findings:\n${summaryText}\n\n${summarizeTraceTiming(parsed.rawEvents)}`,
  };
};

export const analyzeInsightWithChromeFrontend = async (
  input: TraceInsightInput,
): Promise<{ error: string } | { output: string }> => {
  const parsed = await parseTrace(input);
  if (!parsed.insights) return { error: "No Performance insights are available for this trace." };

  const insightSetValue: unknown = parsed.insights.get(input.insightSetId);
  if (insightSetValue === undefined) {
    return {
      error:
        'No Performance Insights for the given insight set id. Only use ids given in the "Available insight sets" list.',
    };
  }
  const insightSet = requireFrontendRecord(insightSetValue, "trace insight set");
  const models = requireFrontendPropertyRecord(insightSet, "model");
  const matchingInsight = models[input.insightName];
  if (!matchingInsight) {
    return {
      error: `No Insight with the name ${input.insightName} found. Double check the name you provided is accurate and try again.`,
    };
  }
  const focus = createFocus(parsed.frontend, parsed.parsedTrace);
  const formatter = construct(parsed.frontend, "PerformanceInsightFormatter", [
    focus,
    matchingInsight,
    input.deviceScope,
  ]);
  return { output: callString(formatter, "formatInsight") };
};
