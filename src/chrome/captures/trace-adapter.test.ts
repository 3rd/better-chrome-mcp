import { describe, expect, test } from "bun:test";
import type { CaptureAdapterStart } from "./types";
import { PlaywrightTraceAdapter } from "./trace-adapter";

const input: Pick<CaptureAdapterStart, "captureId" | "scope"> = {
  captureId: "capture-1",
  scope: {
    connectionId: "connection-1",
    browserMode: "shared",
    browserGeneration: 1,
    contextId: "context-1",
    targetId: "target-1",
    viewport: { width: 800, height: 600 },
  },
};

describe("PlaywrightTraceAdapter", () => {
  test("uses the public tracing surface and returns an incomplete-capable output", async () => {
    const calls: unknown[] = [];
    const adapter = new PlaywrightTraceAdapter(
      {
        async tracing(contextId) {
          expect(contextId).toBe("context-1");
          return {
            async start(options) {
              calls.push(options);
            },
            async stop(options) {
              calls.push(options);
            },
          };
        },
      },
      { allocate: async () => "/tmp/capture-1.zip" },
    );
    const handle = await adapter.start({
      captureId: input.captureId,
      scope: input.scope,
      signal: new AbortController().signal,
      options: { screenshots: true, snapshots: false, sources: true },
    });
    const output = await adapter.finish(handle, {
      reason: "disconnect",
      signal: new AbortController().signal,
    });
    expect(calls).toEqual([
      { screenshots: true, snapshots: false, sources: true },
      { path: "/tmp/capture-1.zip" },
    ]);
    expect(output).toMatchObject({
      name: "capture-1.zip",
      source: { kind: "path", path: "/tmp/capture-1.zip" },
    });
  });
});
