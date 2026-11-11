import { describe, expect, test } from "bun:test";
import {
  runPersistentBindingSubprocess,
  validatePersistentBindingSubprocess,
} from "./persistent-binding-subprocess";

const run = (source: string, args: (boolean | number | string | null)[] = [], timeoutMs?: number) =>
  runPersistentBindingSubprocess({ args, source }, timeoutMs === undefined ? {} : { timeoutMs });

describe("persistent binding subprocess", () => {
  test("validates function source without invoking the handler", async () => {
    await validatePersistentBindingSubprocess(
      "(required) => { if (required === undefined) throw new Error('invoked'); return required; }",
    );
    expect(validatePersistentBindingSubprocess("(value =>")).rejects.toMatchObject({
      code: "CHROME_MCP_MUTATION_FAILED",
    });
    expect(validatePersistentBindingSubprocess("({ value: 1 })")).rejects.toMatchObject({
      code: "CHROME_MCP_MUTATION_FAILED",
    });
  });

  test("runs every invocation outside the broker process", async () => {
    const childPid = await run("() => process.pid");
    expect(childPid).toBeNumber();
    expect(childPid).not.toBe(process.pid);
    expect(await run("(left, right) => ({ total: left + right })", [2, 3])).toEqual({ total: 5 });
  });

  test("contains throws and process exits so a later binding still runs", async () => {
    expect(run("() => { throw new Error('handler exploded') }")).rejects.toMatchObject({
      code: "CHROME_MCP_MUTATION_FAILED",
    });
    expect(await run("() => 'after-throw'")).toBe("after-throw");

    expect(run("() => process.exit(19)")).rejects.toMatchObject({
      code: "CHROME_MCP_MUTATION_FAILED",
    });
    expect(await run("() => 'after-exit'")).toBe("after-exit");
  });

  test("kills and reaps a timed-out binding so a later binding still runs", async () => {
    expect(run("() => { while (true) {} }", [], 50)).rejects.toMatchObject({
      code: "CHROME_MCP_MUTATION_FAILED",
    });
    expect(await run("() => 'after-timeout'")).toBe("after-timeout");
  });

  test("enforces the JSON result cap in the child", async () => {
    expect(run("() => 'x'.repeat(70000)")).rejects.toMatchObject({
      code: "CHROME_MCP_MUTATION_LIMIT",
    });
    expect(await run("() => ({ healthy: true })")).toEqual({ healthy: true });
  });
});
