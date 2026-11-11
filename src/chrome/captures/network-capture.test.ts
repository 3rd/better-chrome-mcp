import { describe, expect, test } from "bun:test";
import {
  HarRecorder,
  NetworkBodiesRecorder,
  normalizeHarOptions,
  playwrightGlobToRegexPattern,
  urlMatchesGlob,
} from "./network-capture";
import { MAX_CAPTURE_NETWORK_ENTRIES, type NetworkExchange } from "./types";

const exchange = (
  sequence: number,
  options: {
    url?: string;
    mediaType?: string;
    loadBody?: NetworkExchange["loadBody"];
  } = {},
): NetworkExchange => ({
  connectionId: "connection-1",
  browserMode: "shared",
  browserGeneration: 1,
  contextId: "context-1",
  targetId: "frame-1",
  rootTargetId: "target-1",
  sequence,
  request: {
    requestId: `request-${sequence}`,
    url: options.url ?? `https://example.test/${sequence}`,
    method: "GET",
    startedAt: "2026-01-01T00:00:00.000Z",
  },
  response: {
    status: 200,
    completedAt: "2026-01-01T00:00:00.001Z",
    mediaType: options.mediaType ?? "application/json",
    bodySize: 1,
  },
  loadBody: options.loadBody,
});

describe("Playwright-compatible URL globs", () => {
  test("treats question marks literally and supports one-level alternation", () => {
    expect(urlMatchesGlob("https://example.test/file?.js", "**/file?.{js,mjs}")).toBe(true);
    expect(urlMatchesGlob("https://example.test/fileX.js", "**/file?.{js,mjs}")).toBe(false);
    expect(urlMatchesGlob("https://example.test/file?.mjs", "**/file?.{js,mjs}")).toBe(true);
    expect(urlMatchesGlob("https://example.test/file?.css", "**/file?.{js,mjs}")).toBe(false);
  });

  test("supports Playwright backslash escaping and optional-directory double stars", () => {
    expect(
      urlMatchesGlob("https://example.test/literal*.js", String.raw`https://example.test/literal\*.js`),
    ).toBe(true);
    expect(
      urlMatchesGlob("https://example.test/literalX.js", String.raw`https://example.test/literal\*.js`),
    ).toBe(false);
    expect(urlMatchesGlob("https://example.test/file.js", "https://example.test/**/file.js")).toBe(true);
    expect(urlMatchesGlob("https://example.test/a/b/file.js", "https://example.test/**/file.js")).toBe(true);
  });

  test("rejects nested and unmatched brace groups when options are admitted", () => {
    for (const urlFilter of ["**/{a,{b,c}}", "**/{a,b", "**/a,b}"]) {
      expect(() => normalizeHarOptions({ type: "har", urlFilter })).toThrow();
      try {
        playwrightGlobToRegexPattern(urlFilter);
      } catch (error) {
        expect(error).toMatchObject({ code: "CHROME_MCP_CAPTURE_INVALID_OPTIONS" });
      }
    }
  });
});

describe("network capture admission", () => {
  test("filters HAR URLs before admission while bounding matching queued work", async () => {
    const recorder = new HarRecorder({ type: "har", content: "attach", urlFilter: "**/kept" });
    const controller = new AbortController();
    const gate = Promise.withResolvers<void>();
    let admittedLoaderStarts = 0;
    let rejectedLoaderStarts = 0;
    const operations: Promise<void>[] = [];

    for (let sequence = 1; sequence <= MAX_CAPTURE_NETWORK_ENTRIES; sequence += 1) {
      expect(
        recorder.record(exchange(sequence, { url: "https://example.test/filtered" }), controller.signal),
      ).toBeUndefined();
    }
    const stalled = recorder.record(
      exchange(MAX_CAPTURE_NETWORK_ENTRIES + 1, {
        url: "https://example.test/kept",
        loadBody: async () => {
          admittedLoaderStarts += 1;
          await gate.promise;
          return { bytes: new Uint8Array([1]), mediaType: "application/json" };
        },
      }),
      controller.signal,
    );
    if (stalled) operations.push(stalled);
    for (let sequence = 2; sequence <= MAX_CAPTURE_NETWORK_ENTRIES; sequence += 1) {
      const operation = recorder.record(
        exchange(MAX_CAPTURE_NETWORK_ENTRIES + sequence, { url: "https://example.test/kept" }),
        controller.signal,
      );
      if (operation) operations.push(operation);
    }
    const rejected = recorder.record(
      exchange(MAX_CAPTURE_NETWORK_ENTRIES * 2 + 1, {
        url: "https://example.test/kept",
        loadBody: () => {
          rejectedLoaderStarts += 1;
          return Promise.resolve({ bytes: new Uint8Array([2]), mediaType: "application/json" });
        },
      }),
      controller.signal,
    );

    expect(rejected).toBeUndefined();
    gate.resolve();
    await Promise.all(operations);
    expect(admittedLoaderStarts).toBe(1);
    expect(rejectedLoaderStarts).toBe(0);
  });

  test("counts MIME-filtered and stalled body entries before asynchronous work starts", async () => {
    const recorder = new NetworkBodiesRecorder({ type: "network-bodies", mimeTypes: ["application/json"] });
    const controller = new AbortController();
    const gate = Promise.withResolvers<void>();
    let admittedLoaderStarts = 0;
    let rejectedLoaderStarts = 0;
    const operations: Promise<void>[] = [];

    for (let sequence = 1; sequence < MAX_CAPTURE_NETWORK_ENTRIES; sequence += 1) {
      const operation = recorder.record(exchange(sequence, { mediaType: "text/plain" }), controller.signal);
      if (operation) operations.push(operation);
    }
    const stalled = recorder.record(
      exchange(MAX_CAPTURE_NETWORK_ENTRIES, {
        loadBody: async () => {
          admittedLoaderStarts += 1;
          await gate.promise;
          return { bytes: new Uint8Array([1]), mediaType: "application/json" };
        },
      }),
      controller.signal,
    );
    if (stalled) operations.push(stalled);
    const rejected = recorder.record(
      exchange(MAX_CAPTURE_NETWORK_ENTRIES + 1, {
        loadBody: () => {
          rejectedLoaderStarts += 1;
          return Promise.resolve({ bytes: new Uint8Array([2]), mediaType: "application/json" });
        },
      }),
      controller.signal,
    );

    expect(rejected).toBeUndefined();
    gate.resolve();
    await Promise.all(operations);
    expect(admittedLoaderStarts).toBe(1);
    expect(rejectedLoaderStarts).toBe(0);
  });
});
