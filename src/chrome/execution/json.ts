import { types } from "node:util";

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = Record<string, JsonValue>;

export class JsonValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonValidationError";
  }
}

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const setJsonProperty = (target: JsonObject, key: string, value: JsonValue) => {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true });
};

type JsonCopyOptions = {
  ancestors: Set<object>;
  getUnsupportedObjectAdvice?: (value: object) => string | undefined;
  mode: "result" | "strict";
  readTypedArray?: (value: object, path: string) => ArrayIterator<number> | undefined;
};

const rejectUnsupportedJsonObject = (value: object, path: string, options: JsonCopyOptions) => {
  if (options.mode === "result") {
    const prototype: unknown = Object.getPrototypeOf(value);
    const constructor: unknown =
      typeof prototype === "object" && prototype !== null ?
        Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
      : undefined;
    const name: unknown =
      typeof constructor === "function" ?
        Object.getOwnPropertyDescriptor(constructor, "name")?.value
      : undefined;
    const type = typeof name === "string" && name.length > 0 ? name : "class instance";
    const advice =
      options.getUnsupportedObjectAdvice?.(value) ??
      "Return the relevant properties in a plain JSON object instead; custom toJSON methods are not called.";
    throw new JsonValidationError(`${path} contains unsupported ${type}. ${advice}`);
  }

  throw new JsonValidationError(`${path} must not contain typed arrays or class instances`);
};

const cloneJsonValue = (value: unknown, path: string, options: JsonCopyOptions): JsonValue => {
  const { ancestors, mode } = options;
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (value === undefined && mode === "result") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      if (mode === "result") {
        throw new JsonValidationError(
          `${path} contains non-finite number ${value}. Return an explicit string or null for this measurement instead.`,
        );
      }
      throw new JsonValidationError(`${path} must contain only finite numbers`);
    }
    return value;
  }
  if (typeof value !== "object") {
    if (mode === "result") {
      const advice =
        typeof value === "bigint" ?
          "Convert it explicitly to a decimal string with value.toString()."
        : "Return its relevant data as a JSON-safe value instead.";
      throw new JsonValidationError(`${path} contains unsupported ${typeof value}. ${advice}`);
    }
    throw new JsonValidationError(`${path} must contain only JSON-safe values`);
  }

  const values = mode === "result" ? options.readTypedArray?.(value, path) : undefined;
  if (values) {
    const clone: JsonValue[] = [];
    let index = 0;
    for (const item of values) {
      clone.push(cloneJsonValue(item, `${path}[${index}]`, options));
      index += 1;
    }
    return clone;
  }

  if (!isPlainObject(value) && !Array.isArray(value)) {
    return rejectUnsupportedJsonObject(value, path, options);
  }
  if (ancestors.has(value)) throw new JsonValidationError(`${path} must not contain cycles`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const clone: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new JsonValidationError(`${path} must not contain sparse arrays`);
        }
        clone.push(cloneJsonValue(value[index], `${path}[${index}]`, options));
      }
      return clone;
    }

    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) throw new JsonValidationError(`${path} must not contain symbol keys`);

    const clone: JsonObject = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) throw new JsonValidationError(`${path}.${key} must not be an accessor`);
      if (descriptor.value === undefined && mode === "result") continue;
      setJsonProperty(clone, key, cloneJsonValue(descriptor.value, `${path}.${key}`, options));
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
};

export const copyJsonValue = (value: unknown, label = "Value"): JsonValue =>
  cloneJsonValue(value, label, { ancestors: new Set<object>(), mode: "strict" });

const readTypedArray = (value: object, path: string) => {
  if (!types.isTypedArray(value)) return undefined;
  if (types.isBigInt64Array(value) || types.isBigUint64Array(value)) {
    const type = types.isBigInt64Array(value) ? "BigInt64Array" : "BigUint64Array";
    throw new JsonValidationError(
      `${path} contains unsupported ${type}. Convert it explicitly to decimal strings with Array.from(value, item => item.toString()).`,
    );
  }

  try {
    return Uint8Array.prototype.values.call(value);
  } catch {
    throw new JsonValidationError(
      `${path} contains an unreadable typed array with a detached or out-of-bounds buffer. Return its measurements before transferring or resizing the buffer.`,
    );
  }
};

export const normalizeJsonResult = (value: unknown, label: string): JsonValue =>
  cloneJsonValue(value, label, {
    ancestors: new Set<object>(),
    getUnsupportedObjectAdvice: (object) => {
      const needsBufferInterpretation = types.isDataView(object) || types.isAnyArrayBuffer(object);
      if (needsBufferInterpretation) {
        return "Choose its byte or numeric interpretation explicitly and return a numeric typed array or plain JSON data.";
      }
      return undefined;
    },
    mode: "result",
    readTypedArray,
  });

export const createJsonResultSerializationFunction = () => `function () {
  "use strict";
  const JsonValidationError = ${JsonValidationError.toString()};
  const isPlainObject = ${isPlainObject.toString()};
  const setJsonProperty = ${setJsonProperty.toString()};
  const cloneJsonValue = ${cloneJsonValue.toString()};
  try {
    return { isValid: true, value: cloneJsonValue(this, "Worker result", { ancestors: new Set(), mode: "result" }) };
  } catch (error) {
    return { isValid: false, error: error instanceof Error ? error.message : String(error) };
  }
}`;

export const copyJsonObject = (value: unknown, label = "Value"): JsonObject => {
  const clone = copyJsonValue(value, label);
  if (clone === null || Array.isArray(clone) || typeof clone !== "object") {
    throw new JsonValidationError(`${label} must be an object`);
  }
  return clone;
};

export const jsonByteLength = (value: JsonValue): number => Buffer.byteLength(JSON.stringify(value), "utf8");

const canonicalizeJsonValue = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  const canonical: JsonObject = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    setJsonProperty(canonical, key, canonicalizeJsonValue(value[key] ?? null));
  }
  return canonical;
};

export const canonicalJsonStringify = (value: JsonValue): string =>
  JSON.stringify(canonicalizeJsonValue(value));

export const freezeJsonValue = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeJsonValue(item);
    Object.freeze(value);
    return value;
  }
  for (const item of Object.values(value)) freezeJsonValue(item);
  Object.freeze(value);
  return value;
};
