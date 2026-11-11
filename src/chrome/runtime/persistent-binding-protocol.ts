import { isRecord } from "../../platform/records";

export const PERSISTENT_BINDING_MAX_PAYLOAD_BYTES = 64 * 1024;
export const PERSISTENT_BINDING_MAX_SOURCE_BYTES = 64 * 1024;
export const PERSISTENT_BINDING_WORKER_INPUT_MAX_BYTES =
  PERSISTENT_BINDING_MAX_PAYLOAD_BYTES + PERSISTENT_BINDING_MAX_SOURCE_BYTES + 4 * 1024;
export const PERSISTENT_BINDING_WORKER_OUTPUT_MAX_BYTES = PERSISTENT_BINDING_MAX_PAYLOAD_BYTES + 4 * 1024;
export const PERSISTENT_BINDING_WORKER_STDERR_MAX_BYTES = 16 * 1024;
export const PERSISTENT_BINDING_WORKER_TIMEOUT_MS = 5000;

export type PersistentBindingJson =
  | PersistentBindingJson[]
  | { [key: string]: PersistentBindingJson }
  | boolean
  | number
  | string
  | null;

export type PersistentBindingWorkerRequest =
  | Readonly<{
      args: PersistentBindingJson[];
      operation: "invoke";
      source: string;
    }>
  | Readonly<{
      operation: "validate";
      source: string;
    }>;

const PERSISTENT_BINDING_WORKER_ERROR_CODES = [
  "BINDING_HANDLER_FAILED",
  "BINDING_INVALID_RESULT",
  "BINDING_INVALID_SOURCE",
  "BINDING_RESULT_LIMIT",
] as const;

export type PersistentBindingWorkerErrorCode = (typeof PERSISTENT_BINDING_WORKER_ERROR_CODES)[number];

export type PersistentBindingWorkerResponse =
  | Readonly<{
      error: Readonly<{
        code: PersistentBindingWorkerErrorCode;
        message: string;
      }>;
      ok: false;
    }>
  | Readonly<{ ok: true; value: PersistentBindingJson }>;

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export const parsePersistentBindingJson = (value: unknown): PersistentBindingJson => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(parsePersistentBindingJson);
  if (!isRecord(value)) throw new Error("Value is not JSON-safe");
  const parsed: Record<string, PersistentBindingJson> = {};
  for (const [key, item] of Object.entries(value)) parsed[key] = parsePersistentBindingJson(item);
  return parsed;
};

export const parsePersistentBindingWorkerRequest = (value: unknown): PersistentBindingWorkerRequest => {
  if (!isRecord(value) || (value.operation !== "invoke" && value.operation !== "validate")) {
    throw new Error("Persistent binding worker request has an unsupported shape");
  }
  if (
    typeof value.source !== "string" ||
    value.source.length === 0 ||
    Buffer.byteLength(value.source, "utf8") > PERSISTENT_BINDING_MAX_SOURCE_BYTES
  ) {
    throw new Error("Persistent binding worker source is invalid");
  }
  if (value.operation === "validate") {
    if (!hasExactKeys(value, ["operation", "source"])) {
      throw new Error("Persistent binding validation request has an unsupported shape");
    }
    return Object.freeze({ operation: "validate", source: value.source });
  }
  if (!hasExactKeys(value, ["args", "operation", "source"]) || !Array.isArray(value.args)) {
    throw new Error("Persistent binding invocation request has an unsupported shape");
  }
  return Object.freeze({
    args: value.args.map(parsePersistentBindingJson),
    operation: "invoke",
    source: value.source,
  });
};

export const parsePersistentBindingWorkerResponse = (value: unknown): PersistentBindingWorkerResponse => {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("Persistent binding worker response has an unsupported shape");
  }
  if (value.ok) {
    if (!hasExactKeys(value, ["ok", "value"])) {
      throw new Error("Persistent binding worker success response has an unsupported shape");
    }
    return Object.freeze({ ok: true, value: parsePersistentBindingJson(value.value) });
  }

  const error = value.error;
  const isFailureShape =
    hasExactKeys(value, ["error", "ok"]) && isRecord(error) && hasExactKeys(error, ["code", "message"]);
  if (!isFailureShape) {
    throw new Error("Persistent binding worker failure response has an unsupported shape");
  }

  const { message } = error;
  const code = PERSISTENT_BINDING_WORKER_ERROR_CODES.find((candidate) => candidate === error.code);
  const isFailureContent = typeof message === "string" && code !== undefined;
  if (!isFailureContent) {
    throw new Error("Persistent binding worker failure response has an unsupported shape");
  }

  return Object.freeze({
    error: Object.freeze({ code, message }),
    ok: false,
  });
};
