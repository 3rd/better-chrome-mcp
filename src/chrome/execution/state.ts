import { ChromeMcpExecutionError } from "./errors";
import { copyJsonValue, jsonByteLength, type JsonValue } from "./json";

export const STATE_KEY_MAX_BYTES = 128;
export const STATE_VALUE_MAX_BYTES = 256 * 1024;
export const STATE_TOTAL_MAX_BYTES = 1024 * 1024;

export type StateEntry = readonly [string, JsonValue];
export type StateSnapshot = StateEntry[];

const invalidState = (message: string, cause?: unknown): ChromeMcpExecutionError =>
  new ChromeMcpExecutionError(
    "CHROME_MCP_INVALID_STATE",
    message,
    cause === undefined ? undefined : { cause },
  );

const copyStateValue = (value: unknown): JsonValue => {
  let clone: JsonValue;
  try {
    clone = copyJsonValue(value, "State value");
  } catch (error: unknown) {
    throw invalidState(error instanceof Error ? error.message : "State value is not JSON-safe", error);
  }
  const measuredBytes = jsonByteLength(clone);
  if (measuredBytes > STATE_VALUE_MAX_BYTES) {
    throw invalidState(`State value is ${measuredBytes} bytes; maximum is ${STATE_VALUE_MAX_BYTES} bytes`);
  }
  return clone;
};

const validateKey = (key: unknown): string => {
  if (typeof key !== "string" || key.length === 0) throw invalidState("State key must be a non-empty string");
  const measuredBytes = Buffer.byteLength(key, "utf8");
  if (measuredBytes > STATE_KEY_MAX_BYTES) {
    throw invalidState(`State key is ${measuredBytes} bytes; maximum is ${STATE_KEY_MAX_BYTES} bytes`);
  }
  return key;
};

const snapshotFromMap = (state: ReadonlyMap<string, JsonValue>): StateSnapshot =>
  [...state.entries()].map(([key, value]) => [key, copyJsonValue(value, "State value")]);

const assertTotalQuota = (state: ReadonlyMap<string, JsonValue>): void => {
  const measuredBytes = Buffer.byteLength(JSON.stringify(snapshotFromMap(state)), "utf8");
  if (measuredBytes > STATE_TOTAL_MAX_BYTES) {
    throw invalidState(
      `State namespace is ${measuredBytes} bytes; maximum is ${STATE_TOTAL_MAX_BYTES} bytes`,
    );
  }
};

export const validateStateSnapshot = (snapshot: readonly StateEntry[]): StateSnapshot => {
  const state = new Map<string, JsonValue>();
  for (const entry of snapshot) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw invalidState("State snapshot entry must be [key, value]");
    }
    const key = validateKey(entry[0]);
    if (state.has(key)) throw invalidState(`State snapshot contains duplicate key: ${key}`);
    state.set(key, copyStateValue(entry[1]));
  }
  assertTotalQuota(state);
  return snapshotFromMap(state);
};

export interface TransactionalState {
  clear: () => undefined;
  delete: (key: string) => undefined;
  entries: () => StateSnapshot;
  get: (key: string) => JsonValue | undefined;
  set: (key: string, value: unknown) => undefined;
  snapshot: () => StateSnapshot;
}

export const createTransactionalState = (initial: readonly StateEntry[]): TransactionalState => {
  const state = new Map<string, JsonValue>(validateStateSnapshot(initial));

  return Object.freeze({
    clear: () => {
      state.clear();
      return undefined;
    },
    delete: (inputKey: string) => {
      state.delete(validateKey(inputKey));
      return undefined;
    },
    entries: () => snapshotFromMap(state),
    get: (inputKey: string) => {
      const value = state.get(validateKey(inputKey));
      return value === undefined ? undefined : copyJsonValue(value, "State value");
    },
    set: (inputKey: string, inputValue: unknown) => {
      const key = validateKey(inputKey);
      const value = copyStateValue(inputValue);
      const candidate = new Map(state);
      candidate.set(key, value);
      assertTotalQuota(candidate);
      state.set(key, value);
      return undefined;
    },
    snapshot: () => snapshotFromMap(state),
  });
};
