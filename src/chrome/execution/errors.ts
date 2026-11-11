import type { BrokerRpcErrorCode } from "../broker-rpc/errors";
import { isRecord } from "../../platform/records";
import { CAPTURE_ERROR_CODES } from "../captures/errors";
import { type ChromeRuntimeErrorCode, REACT_RUNTIME_ERROR_CODES } from "../runtime/errors";

export const EXECUTION_ERROR_CODES = [
  "CHROME_MCP_INVALID_INPUT",
  "CHROME_MCP_MALFORMED_CODE",
  "CHROME_MCP_EXECUTION_FAILED",
  "CHROME_MCP_TIMEOUT",
  "CHROME_MCP_CANCELLED",
  "CHROME_MCP_WORKER_CRASH",
  "CHROME_MCP_BROWSER_DISCONNECTED",
  "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
  "CHROME_MCP_MAIN_UNAVAILABLE",
  "CHROME_MCP_PROFILE_IN_USE",
  "CHROME_MCP_PAGE_CLOSED",
  "CHROME_MCP_FOREIGN_PAGE",
  "CHROME_MCP_BLOCKING_MODAL",
  "CHROME_MCP_STALE_MODAL",
  "CHROME_MCP_UNSUPPORTED_CAPABILITY",
  "CHROME_MCP_PWA_FAILED",
  "CHROME_MCP_MUTATION_CONFLICT",
  "CHROME_MCP_MUTATION_FAILED",
  "CHROME_MCP_MUTATION_LIMIT",
  ...CAPTURE_ERROR_CODES,
  "CHROME_MCP_TRACE_NOT_ACTIVE",
  "CHROME_MCP_ARTIFACT_QUOTA",
  "CHROME_MCP_ARTIFACT_NOT_FOUND",
  "CHROME_MCP_INVALID_STATE",
  "CHROME_MCP_UNKNOWN_REF",
  "CHROME_MCP_STALE_REF",
  "CHROME_MCP_SNAPSHOT_TARGET_MISMATCH",
  ...REACT_RUNTIME_ERROR_CODES,
] as const;

export type ExecutionErrorCode = (typeof EXECUTION_ERROR_CODES)[number];

export type SerializedExecutionError = {
  code: ExecutionErrorCode;
  message: string;
  name: string;
  stack?: string;
};

export class ChromeMcpExecutionError extends Error {
  readonly code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "ChromeMcpExecutionError";
  }
}

const isExecutionErrorCode = (value: unknown): value is ExecutionErrorCode => {
  for (const code of EXECUTION_ERROR_CODES) {
    if (value === code) return true;
  }

  return false;
};

const INTERNAL_ERROR_CODE_MAP = {
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
} as const satisfies Partial<Record<BrokerRpcErrorCode | ChromeRuntimeErrorCode, ExecutionErrorCode>>;

const isInternalErrorCode = (value: string): value is keyof typeof INTERNAL_ERROR_CODE_MAP =>
  Object.hasOwn(INTERNAL_ERROR_CODE_MAP, value);

const executionErrorCode = (value: unknown, fallback: ExecutionErrorCode): ExecutionErrorCode => {
  if (isExecutionErrorCode(value)) return value;
  if (typeof value !== "string") return fallback;
  return isInternalErrorCode(value) ? INTERNAL_ERROR_CODE_MAP[value] : fallback;
};

const limitUtf8 = (value: string, maximumBytes: number): string => {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const suffix = "\n… stack truncated";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let end = Math.max(0, maximumBytes - suffixBytes);
  while (end > 0 && (Buffer.from(value, "utf8")[end] ?? 0) >> 6 === 2) end -= 1;
  return `${Buffer.from(value, "utf8").subarray(0, end).toString("utf8")}${suffix}`;
};

const redact = (value: string, secrets: readonly string[]): string => {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
};

const normalizeUserFrame = (line: string): string =>
  line.replace(/chrome-mcp-user-code\.js:(\d+):(\d+)/gu, (_match, lineNumber: string, column: string) => {
    const normalizedLine = Math.max(1, Number(lineNumber) - 3);
    return `chrome-mcp-user-code.js:${normalizedLine}:${column}`;
  });

const normalizeStack = (stack: string | undefined, secrets: readonly string[]): string | undefined => {
  if (!stack) return undefined;
  const lines = redact(stack, secrets).split(/\r?\n/u);
  const [heading, ...frames] = lines;
  const relevantFrames = frames
    .filter(
      (line) =>
        line.includes("chrome-mcp-user-code.js") ||
        line.includes("/playwright-core/") ||
        line.includes("\\playwright-core\\"),
    )
    .map(normalizeUserFrame);
  const normalized = [heading ?? "Error", ...relevantFrames].join("\n");
  return limitUtf8(normalized, 32 * 1024);
};

export const serializeExecutionError = (
  error: unknown,
  fallbackCode: ExecutionErrorCode,
  secrets: readonly string[] = [],
): SerializedExecutionError => {
  const record = isRecord(error) ? error : undefined;
  const code = executionErrorCode(record?.code, fallbackCode);
  let name = "Error";

  if (error instanceof Error) {
    name = error.name;
  } else if (typeof record?.name === "string") {
    name = record.name;
  }

  let rawMessage = "Unknown execution error";

  if (error instanceof Error) {
    rawMessage = error.message;
  } else if (typeof record?.message === "string") {
    rawMessage = record.message;
  } else if (typeof error === "string") {
    rawMessage = error;
  }

  const message = redact(rawMessage, secrets);
  const stack = normalizeStack(error instanceof Error ? error.stack : undefined, secrets);
  return stack ? { code, message, name, stack } : { code, message, name };
};

export const errorFromSerialized = (error: SerializedExecutionError): ChromeMcpExecutionError => {
  const restored = new ChromeMcpExecutionError(error.code, error.message);
  restored.name = error.name;
  if (error.stack) restored.stack = error.stack;
  return restored;
};
