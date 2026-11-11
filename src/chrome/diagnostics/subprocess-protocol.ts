import { isRecord } from "../../platform/records";
import {
  type DiagnosticDeviceScope,
  type JsonObject,
  type JsonValue,
  LIGHTHOUSE_CATEGORIES,
  LIGHTHOUSE_MAX_WAIT_FOR_LOAD_MS,
  type LighthouseDevice,
  type LighthouseEngineResult,
  type LighthouseMode,
  type LighthouseRunnerInput,
  type LighthouseScreenEmulation,
  type TraceAnalysis,
  type TraceAnalysisInput,
  type TraceInsightInput,
  type TraceInsightReference,
  type TraceMetadata,
} from "./types";

export type TraceAnalyzeWorkerRequest = {
  operation: "trace-analyze";
  input: TraceAnalysisInput;
};

export type TraceInsightWorkerRequest = {
  operation: "trace-insight";
  input: TraceInsightInput;
};

export type LighthouseWorkerRequest = {
  operation: "lighthouse";
  input: LighthouseRunnerInput;
};

export type DiagnosticWorkerRequest =
  | LighthouseWorkerRequest
  | TraceAnalyzeWorkerRequest
  | TraceInsightWorkerRequest;
export type DiagnosticWorkerOperation = DiagnosticWorkerRequest["operation"];

export type DiagnosticWorkerSuccess =
  | { ok: true; operation: "lighthouse"; result: LighthouseEngineResult }
  | { ok: true; operation: "trace-analyze"; result: TraceAnalysis }
  | { ok: true; operation: "trace-insight"; result: { error: string } | { output: string } };

export type DiagnosticWorkerFailure = {
  error: { code: string; message: string };
  ok: false;
  operation: DiagnosticWorkerOperation | "unknown";
};

export type DiagnosticWorkerResponse = DiagnosticWorkerFailure | DiagnosticWorkerSuccess;

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

const isJsonObject = (value: unknown): value is JsonObject =>
  isRecord(value) && Object.values(value).every(isJsonValue);

const invalidProtocol = (message: string): Error =>
  new Error(`Invalid diagnostic subprocess message: ${message}`);

const requireExactKeys = (value: Record<string, unknown>, keys: readonly string[], name: string): void => {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw invalidProtocol(`${name} has unknown field ${key}`);
  }
};

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidProtocol(`${name} must be a non-empty string`);
  }
  return value;
};

const requireFiniteNumber = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidProtocol(`${name} must be a finite number`);
  }
  return value;
};

const parseDeviceScope = (value: unknown): DiagnosticDeviceScope => {
  if (value !== "DESKTOP" && value !== "PHONE") throw invalidProtocol("deviceScope is invalid");
  return value;
};

const parseTraceMetadata = (value: unknown): TraceMetadata => {
  if (!isRecord(value)) throw invalidProtocol("metadata must be an object");
  requireExactKeys(value, ["cpuThrottling", "networkThrottling"], "metadata");
  const cpuThrottling = requireFiniteNumber(value.cpuThrottling, "metadata.cpuThrottling");
  if (value.networkThrottling === undefined) return { cpuThrottling };
  if (!isJsonObject(value.networkThrottling)) {
    throw invalidProtocol("metadata.networkThrottling must be JSON");
  }
  return { cpuThrottling, networkThrottling: value.networkThrottling };
};

const parseTraceAnalyzeInput = (value: unknown) => {
  if (!isRecord(value)) throw invalidProtocol("trace input must be an object");
  requireExactKeys(value, ["deviceScope", "metadata", "tracePath"], "trace-analyze input");

  return {
    deviceScope: parseDeviceScope(value.deviceScope),
    metadata: parseTraceMetadata(value.metadata),
    tracePath: requireString(value.tracePath, "tracePath"),
  };
};

const parseTraceInsightInput = (value: unknown) => {
  if (!isRecord(value)) throw invalidProtocol("trace input must be an object");
  requireExactKeys(
    value,
    ["deviceScope", "insightName", "insightSetId", "metadata", "tracePath"],
    "trace-insight input",
  );
  return {
    deviceScope: parseDeviceScope(value.deviceScope),
    insightName: requireString(value.insightName, "insightName"),
    insightSetId: requireString(value.insightSetId, "insightSetId"),
    metadata: parseTraceMetadata(value.metadata),
    tracePath: requireString(value.tracePath, "tracePath"),
  };
};

const parseLighthouseCategories = (value: unknown) => {
  const hasEveryCategoryInOrder =
    Array.isArray(value) &&
    value.length === LIGHTHOUSE_CATEGORIES.length &&
    LIGHTHOUSE_CATEGORIES.every((category, index) => value[index] === category);
  if (!hasEveryCategoryInOrder) throw invalidProtocol("Lighthouse categories are invalid");

  return LIGHTHOUSE_CATEGORIES;
};

const parseLighthouseDevice = (value: unknown): LighthouseDevice => {
  if (value !== "desktop" && value !== "mobile") throw invalidProtocol("Lighthouse device is invalid");
  return value;
};

const parseLighthouseMode = (value: unknown): LighthouseMode => {
  if (value !== "navigation" && value !== "snapshot") throw invalidProtocol("Lighthouse mode is invalid");
  return value;
};

const parseEngineTarget = (value: unknown): JsonObject => {
  if (!isRecord(value)) throw invalidProtocol("engineTarget must be an object");
  requireExactKeys(value, ["browserURL", "browserWSEndpoint", "targetId"], "engineTarget");
  const targetId = requireString(value.targetId, "engineTarget.targetId");
  const browserURL =
    value.browserURL === undefined ? undefined : requireString(value.browserURL, "engineTarget.browserURL");
  const browserWSEndpoint =
    value.browserWSEndpoint === undefined ?
      undefined
    : requireString(value.browserWSEndpoint, "engineTarget.browserWSEndpoint");
  if ((browserURL === undefined) === (browserWSEndpoint === undefined)) {
    throw invalidProtocol("engineTarget must provide exactly one browser endpoint");
  }
  return {
    ...(browserURL ? { browserURL } : {}),
    ...(browserWSEndpoint ? { browserWSEndpoint } : {}),
    targetId,
  };
};

const parseScreenEmulation = (value: unknown): LighthouseScreenEmulation => {
  if (!isRecord(value)) throw invalidProtocol("screenEmulation must be an object");
  requireExactKeys(value, ["deviceScaleFactor", "disabled", "height", "mobile", "width"], "screenEmulation");
  if (typeof value.mobile !== "boolean" || value.disabled !== false) {
    throw invalidProtocol("screenEmulation flags are invalid");
  }
  return {
    deviceScaleFactor: requireFiniteNumber(value.deviceScaleFactor, "screenEmulation.deviceScaleFactor"),
    disabled: false,
    height: requireFiniteNumber(value.height, "screenEmulation.height"),
    mobile: value.mobile,
    width: requireFiniteNumber(value.width, "screenEmulation.width"),
  };
};

const parseLighthouseRequestInput = (value: unknown): LighthouseRunnerInput => {
  if (!isRecord(value)) throw invalidProtocol("Lighthouse input must be an object");
  requireExactKeys(
    value,
    ["categories", "device", "engineTarget", "maxWaitForLoadMs", "mode", "screenEmulation"],
    "Lighthouse input",
  );
  if (value.maxWaitForLoadMs !== LIGHTHOUSE_MAX_WAIT_FOR_LOAD_MS) {
    throw invalidProtocol("maxWaitForLoadMs is invalid");
  }
  return {
    categories: parseLighthouseCategories(value.categories),
    device: parseLighthouseDevice(value.device),
    engineTarget: parseEngineTarget(value.engineTarget),
    maxWaitForLoadMs: LIGHTHOUSE_MAX_WAIT_FOR_LOAD_MS,
    mode: parseLighthouseMode(value.mode),
    screenEmulation: parseScreenEmulation(value.screenEmulation),
  };
};

export const readDiagnosticWorkerOperation = (message: unknown) => {
  if (!isRecord(message)) return "unknown";

  const operation = message.operation;
  const isKnownOperation =
    operation === "trace-analyze" || operation === "trace-insight" || operation === "lighthouse";
  if (isKnownOperation) return operation;

  return "unknown";
};

export const parseDiagnosticWorkerRequest = (value: unknown): DiagnosticWorkerRequest => {
  if (!isRecord(value)) throw invalidProtocol("request must be an object");
  requireExactKeys(value, ["input", "operation"], "request");
  if (value.operation === "trace-analyze") {
    return { operation: "trace-analyze", input: parseTraceAnalyzeInput(value.input) };
  }
  if (value.operation === "trace-insight") {
    return { operation: "trace-insight", input: parseTraceInsightInput(value.input) };
  }
  if (value.operation === "lighthouse") {
    return { operation: "lighthouse", input: parseLighthouseRequestInput(value.input) };
  }
  throw invalidProtocol("operation is unsupported");
};

const parseTraceAnalysis = (value: unknown): TraceAnalysis => {
  if (!isRecord(value) || !Array.isArray(value.insights)) throw invalidProtocol("trace result is invalid");
  requireExactKeys(value, ["insights", "summary"], "trace result");
  const insights = value.insights.map((item) => {
    if (!isRecord(item)) throw invalidProtocol("trace insight reference is invalid");
    requireExactKeys(
      item,
      ["bounds", "insightKey", "insightName", "insightSetId", "navigationKind", "url"],
      "trace insight reference",
    );
    const navigationKind = item.navigationKind;
    const hasInvalidNavigationKind =
      navigationKind !== undefined &&
      navigationKind !== "hard" &&
      navigationKind !== "soft" &&
      navigationKind !== "none";
    if (hasInvalidNavigationKind) {
      throw invalidProtocol("trace navigation kind is invalid");
    }

    let bounds: { startMicroseconds: number; endMicroseconds: number } | undefined;
    if (item.bounds !== undefined) {
      if (!isRecord(item.bounds)) {
        throw invalidProtocol("trace insight bounds are invalid");
      }
      requireExactKeys(item.bounds, ["startMicroseconds", "endMicroseconds"], "trace insight bounds");

      bounds = {
        startMicroseconds: requireFiniteNumber(item.bounds.startMicroseconds, "trace insight start"),
        endMicroseconds: requireFiniteNumber(item.bounds.endMicroseconds, "trace insight end"),
      };
      if (bounds.endMicroseconds < bounds.startMicroseconds) {
        throw invalidProtocol("trace insight bounds are reversed");
      }
    }

    return {
      ...(bounds === undefined ? {} : { bounds }),
      insightKey: requireString(item.insightKey, "trace insight key"),
      insightName: requireString(item.insightName, "trace insight name"),
      insightSetId: requireString(item.insightSetId, "trace insight set id"),
      ...(navigationKind === undefined ? {} : { navigationKind }),
      ...(item.url === undefined ? {} : { url: requireString(item.url, "trace insight URL") }),
    } satisfies TraceInsightReference;
  });
  return {
    insights,
    summary: requireString(value.summary, "trace summary"),
  };
};

const parseInsightResult = (value: unknown): { error: string } | { output: string } => {
  if (!isRecord(value)) throw invalidProtocol("trace insight result is invalid");
  if (value.error !== undefined) {
    requireExactKeys(value, ["error"], "trace insight result");
    return { error: requireString(value.error, "trace insight error") };
  }
  requireExactKeys(value, ["output"], "trace insight result");
  return { output: requireString(value.output, "trace insight output") };
};

const parseLighthouseResult = (value: unknown): LighthouseEngineResult => {
  if (!isRecord(value) || !Array.isArray(value.audits) || !Array.isArray(value.categories)) {
    throw invalidProtocol("Lighthouse result is invalid");
  }
  requireExactKeys(
    value,
    ["audits", "categories", "mainDocumentUrl", "reports", "totalTiming"],
    "Lighthouse result",
  );
  const audits = value.audits.map((audit) => {
    if (!isRecord(audit)) throw invalidProtocol("Lighthouse audit is invalid");
    requireExactKeys(audit, ["score"], "Lighthouse audit");
    if (audit.score !== null && (typeof audit.score !== "number" || !Number.isFinite(audit.score))) {
      throw invalidProtocol("Lighthouse audit score is invalid");
    }
    return { score: audit.score };
  });
  const categories = value.categories.map((category) => {
    if (!isRecord(category)) throw invalidProtocol("Lighthouse category is invalid");
    requireExactKeys(category, ["id", "score", "title"], "Lighthouse category");
    if (category.score !== null && (typeof category.score !== "number" || !Number.isFinite(category.score))) {
      throw invalidProtocol("Lighthouse category score is invalid");
    }
    return {
      id: requireString(category.id, "Lighthouse category id"),
      score: category.score,
      title: requireString(category.title, "Lighthouse category title"),
    };
  });
  if (!isRecord(value.reports)) throw invalidProtocol("Lighthouse reports are invalid");
  requireExactKeys(value.reports, ["html", "json"], "Lighthouse reports");
  return {
    audits,
    categories,
    mainDocumentUrl: requireString(value.mainDocumentUrl, "Lighthouse main document URL"),
    reports: {
      html: requireString(value.reports.html, "Lighthouse HTML report"),
      json: requireString(value.reports.json, "Lighthouse JSON report"),
    },
    totalTiming: requireFiniteNumber(value.totalTiming, "Lighthouse total timing"),
  };
};

export const parseDiagnosticWorkerResponse = (value: unknown): DiagnosticWorkerResponse => {
  if (!isRecord(value)) throw invalidProtocol("response must be an object");
  if (value.ok === false) {
    requireExactKeys(value, ["error", "ok", "operation"], "worker failure response");
    if (!isRecord(value.error)) throw invalidProtocol("worker error is invalid");
    requireExactKeys(value.error, ["code", "message"], "worker error");
    return {
      error: {
        code: requireString(value.error.code, "worker error code"),
        message: requireString(value.error.message, "worker error message"),
      },
      ok: false,
      operation: readDiagnosticWorkerOperation(value),
    };
  }
  if (value.ok !== true) throw invalidProtocol("response ok flag is invalid");
  requireExactKeys(value, ["ok", "operation", "result"], "worker success response");
  if (value.operation === "trace-analyze") {
    return { ok: true, operation: "trace-analyze", result: parseTraceAnalysis(value.result) };
  }
  if (value.operation === "trace-insight") {
    return { ok: true, operation: "trace-insight", result: parseInsightResult(value.result) };
  }
  if (value.operation === "lighthouse") {
    return { ok: true, operation: "lighthouse", result: parseLighthouseResult(value.result) };
  }
  throw invalidProtocol("response operation is unsupported");
};
