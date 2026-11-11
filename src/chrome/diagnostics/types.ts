import type { BrowserInstanceOptions, BrowserMode } from "../browser-modes";

export type ChromeBrowserMode = BrowserMode;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

export type DiagnosticCall = BrowserInstanceOptions & {
  browserMode: ChromeBrowserMode;
  connectionId: string;
};

export type DiagnosticDeviceScope = "DESKTOP" | "PHONE";

export type DiagnosticCdpSession = {
  off: (event: string, listener: (payload: unknown) => void) => void;
  on: (event: string, listener: (payload: unknown) => void) => void;
  send: (method: string, parameters?: Record<string, unknown>) => Promise<unknown>;
};

export type SelectedDiagnosticPage = {
  cdp: DiagnosticCdpSession;
  cpuThrottling: number;
  deviceScope: DiagnosticDeviceScope;
  engineTarget: JsonObject;
  navigate: (url: string, options: { waitUntil: "load" }) => Promise<void>;
  networkThrottling?: JsonObject;
  ownerGeneration: number;
  ownerId: string;
  restoreEmulation: () => Promise<void>;
  targetId: string;
  url: string;
};

export type SelectedPageProvider = {
  acquire: (call: DiagnosticCall) => Promise<SelectedDiagnosticPage>;
  // Release ends one broker lease. It must not close the generation-stable CDP session retained by an active trace.
  release: (page: SelectedDiagnosticPage) => Promise<void>;
};

export type TraceInsightReference = {
  bounds?: { startMicroseconds: number; endMicroseconds: number };
  insightKey: string;
  insightName: string;
  insightSetId: string;
  navigationKind?: "hard" | "none" | "soft";
  url?: string;
};

export type TraceAnalysis = {
  insights: TraceInsightReference[];
  summary: string;
};

export type TraceMetadata = {
  cpuThrottling: number;
  networkThrottling?: JsonObject;
};

export type TraceAnalysisInput = {
  deviceScope: DiagnosticDeviceScope;
  metadata: TraceMetadata;
  tracePath: string;
};

export type TraceInsightInput = {
  deviceScope: DiagnosticDeviceScope;
  insightName: string;
  insightSetId: string;
  metadata: TraceMetadata;
  tracePath: string;
};

export type TraceAnalyzer = {
  analyzeInsight: (input: TraceInsightInput) => Promise<{ error: string } | { output: string }>;
  analyzeTrace: (input: TraceAnalysisInput) => Promise<TraceAnalysis>;
};

export type LighthouseMode = "navigation" | "snapshot";
export type LighthouseDevice = "desktop" | "mobile";

export type LighthouseCategory = {
  id: string;
  score: number | null;
  title: string;
};

export type LighthouseAudit = {
  score: number | null;
};

export type LighthouseScreenEmulation = {
  deviceScaleFactor: number;
  disabled: false;
  height: number;
  mobile: boolean;
  width: number;
};

export type LighthouseEngineResult = {
  audits: LighthouseAudit[];
  categories: LighthouseCategory[];
  mainDocumentUrl: string;
  reports: {
    html: string;
    json: string;
  };
  totalTiming: number;
};

export const LIGHTHOUSE_CATEGORIES = ["accessibility", "seo", "best-practices", "agentic-browsing"] as const;
export const LIGHTHOUSE_MAX_WAIT_FOR_LOAD_MS = 30_000;

export type LighthouseRunnerInput = {
  categories: typeof LIGHTHOUSE_CATEGORIES;
  device: LighthouseDevice;
  engineTarget: JsonObject;
  maxWaitForLoadMs: typeof LIGHTHOUSE_MAX_WAIT_FOR_LOAD_MS;
  mode: LighthouseMode;
  screenEmulation: LighthouseScreenEmulation;
};

export type LighthouseRunner = {
  run: (input: LighthouseRunnerInput) => Promise<LighthouseEngineResult | undefined>;
};

export type DiagnosticTextContent = {
  text: string;
  type: "text";
};

export type DiagnosticToolResult = {
  content: [DiagnosticTextContent];
  structuredContent: JsonObject;
};

export type StartTraceInput = {
  autoStop?: boolean;
  filePath?: string;
  reload?: boolean;
};

export type StopTraceInput = {
  filePath?: string;
};

export type AnalyzeInsightInput =
  | { insightName: string; insightSetId: string }
  | { insightName?: never; insightSetId?: never };

export type LighthouseInput = {
  device?: LighthouseDevice;
  mode?: LighthouseMode;
  outputDirPath?: string;
};

export type HeapSnapshotInput = {
  filePath: string;
};

export type ChromeDiagnosticErrorCode =
  | "CHROME_MCP_HEAP_PROTOCOL"
  | "CHROME_MCP_INVALID_INPUT"
  | "CHROME_MCP_LIGHTHOUSE_FAILED"
  | "CHROME_MCP_OUTPUT_PATH"
  | "CHROME_MCP_TRACE_INCOMPLETE"
  | "CHROME_MCP_TRACE_NOT_ACTIVE"
  | "CHROME_MCP_TRACE_OWNERSHIP"
  | "CHROME_MCP_TRACE_PROTOCOL";

export class ChromeDiagnosticError extends Error {
  readonly code: ChromeDiagnosticErrorCode;

  constructor(code: ChromeDiagnosticErrorCode, message: string) {
    super(message);
    this.name = "ChromeDiagnosticError";
    this.code = code;
  }
}

export const textResult = (
  lines: readonly string[],
  structuredContent: JsonObject = {},
): DiagnosticToolResult => ({
  content: [{ type: "text", text: lines.join("\n") }],
  structuredContent,
});
