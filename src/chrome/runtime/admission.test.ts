import { describe, expect, test } from "bun:test";
import { OwnerAdmissionQueue } from "./admission";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

const deferred = (): Deferred => {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolvePromise) throw new Error("Deferred resolver is unavailable");
      resolvePromise();
    },
  };
};

describe("OwnerAdmissionQueue", () => {
  test("admits work in FIFO order and one operation at a time", async () => {
    const queue = new OwnerAdmissionQueue();
    const gate = deferred();
    const order: string[] = [];
    const first = queue.admit({
      run: async () => {
        order.push("first-start");
        await gate.promise;
        order.push("first-end");
        return 1;
      },
    });
    const second = queue.admit({
      run: async () => {
        order.push("second");
        return 2;
      },
    });
    const third = queue.admit({
      run: async () => {
        order.push("third");
        return 3;
      },
    });
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    expect(queue.pending).toBe(2);
    gate.resolve();
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
    expect(order).toEqual(["first-start", "first-end", "second", "third"]);
    await queue.idle();
    expect(queue.running).toBe(false);
  });

  test("removes a canceled queued operation without disturbing active work", async () => {
    const queue = new OwnerAdmissionQueue();
    const gate = deferred();
    const first = queue.admit({ run: async () => gate.promise });
    const controller = new AbortController();
    const canceled = queue.admit({ run: async () => "unreachable", signal: controller.signal });
    const last = queue.admit({ run: async () => "last" });
    controller.abort(new Error("client canceled"));
    expect(canceled).rejects.toThrow();
    gate.resolve();
    await first;
    expect(await last).toBe("last");
  });

  test("rejects queued and future work after close but lets active work finish", async () => {
    const queue = new OwnerAdmissionQueue();
    const gate = deferred();
    const active = queue.admit({ run: async () => gate.promise });
    const queued = queue.admit({ run: async () => undefined });
    queue.close();
    expect(queued).rejects.toThrow();
    expect(queue.admit({ run: async () => undefined })).rejects.toThrow();
    gate.resolve();
    await active;
    await queue.idle();
  });

  test("gives active work cooperative cancellation before invoking its force hook", async () => {
    const queue = new OwnerAdmissionQueue();
    const forceGate = deferred();
    let cooperativeSignal: AbortSignal | undefined;
    let forced = false;
    const active = queue.admit({
      force: () => {
        forced = true;
        forceGate.resolve();
      },
      run: async (signal) => {
        cooperativeSignal = signal;
        await forceGate.promise;
        throw signal.reason;
      },
    });
    await Promise.resolve();
    await queue.shutdown(0);
    expect(cooperativeSignal?.aborted).toBe(true);
    expect(forced).toBe(true);
    expect(active).rejects.toMatchObject({ code: "CHROME_MCP_OWNER_CLOSED" });
  });
});
