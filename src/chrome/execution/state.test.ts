import { describe, expect, test } from "bun:test";
import {
  createTransactionalState,
  STATE_KEY_MAX_BYTES,
  STATE_TOTAL_MAX_BYTES,
  STATE_VALUE_MAX_BYTES,
} from "./state";

describe("transactional helper state", () => {
  test("copies values on set, get, entries, and snapshot", () => {
    const state = createTransactionalState([]);
    const source = { nested: { value: 1 } };
    state.set("plan", source);
    source.nested.value = 2;

    const first = state.get("plan");
    expect(first).toEqual({ nested: { value: 1 } });
    if (first && typeof first === "object" && !Array.isArray(first)) first.extra = true;
    expect(state.get("plan")).toEqual({ nested: { value: 1 } });

    const entries = state.entries();
    if (
      entries[0] &&
      typeof entries[0][1] === "object" &&
      entries[0][1] !== null &&
      !Array.isArray(entries[0][1])
    ) {
      entries[0][1].changed = true;
    }
    expect(state.snapshot()).toEqual([["plan", { nested: { value: 1 } }]]);
  });

  test("preserves insertion position when replacing an existing key", () => {
    const state = createTransactionalState([]);
    state.set("first", 1);
    state.set("second", 2);
    state.set("first", 3);
    expect(state.entries()).toEqual([
      ["first", 3],
      ["second", 2],
    ]);
  });

  test("rejects invalid mutations without changing prior transaction state", () => {
    const state = createTransactionalState([["kept", true]]);
    expect(() => state.set("bad", { value: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => state.set("bad", new Date())).toThrow();
    expect(() => state.set("bad", { value: undefined })).toThrow();
    expect(() => state.set("bad", [undefined])).toThrow();
    expect(state.snapshot()).toEqual([["kept", true]]);
  });

  test("enforces key, value, and namespace byte quotas", () => {
    const state = createTransactionalState([]);
    expect(() => state.set("x".repeat(STATE_KEY_MAX_BYTES + 1), true)).toThrow();
    expect(() => state.set("large", "x".repeat(STATE_VALUE_MAX_BYTES))).toThrow();

    const chunk = "x".repeat(Math.floor(STATE_VALUE_MAX_BYTES / 2));
    let keyIndex = 0;
    while (Buffer.byteLength(JSON.stringify(state.snapshot()), "utf8") < STATE_TOTAL_MAX_BYTES * 0.8) {
      state.set(`key-${keyIndex}`, chunk);
      keyIndex += 1;
    }
    const before = state.snapshot();
    expect(() => state.set("overflow", chunk)).toThrow();
    expect(state.snapshot()).toEqual(before);
  });

  test("supports delete and clear with undefined return values", () => {
    const state = createTransactionalState([
      ["first", 1],
      ["second", 2],
    ]);
    expect(state.delete("first")).toBeUndefined();
    expect(state.entries()).toEqual([["second", 2]]);
    expect(state.clear()).toBeUndefined();
    expect(state.entries()).toEqual([]);
  });
});
