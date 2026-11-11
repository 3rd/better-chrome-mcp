import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject, LighthouseRunner, TraceAnalyzer } from "./types";
import { normalizeLighthouseResult } from "./lighthouse-engine";
import { SubprocessLighthouseRunner, SubprocessTraceAnalyzer } from "./subprocess";
import { parseDiagnosticWorkerRequest, parseDiagnosticWorkerResponse } from "./subprocess-protocol";

const fixtureWorkerPath = fileURLToPath(new URL("./diagnostic-subprocess.test-worker.ts", import.meta.url));

const traceInput = (tracePath: string): Parameters<TraceAnalyzer["analyzeTrace"]>[0] => ({
  deviceScope: "DESKTOP",
  metadata: { cpuThrottling: 1 },
  tracePath,
});

const networkTraceEvents = (requestCount: number) => {
  const events: JsonObject[] = [
    { name: "process_name", cat: "__metadata", ph: "M", ts: 0, pid: 1, tid: 1, args: { name: "Renderer" } },
    {
      name: "thread_name",
      cat: "__metadata",
      ph: "M",
      ts: 0,
      pid: 1,
      tid: 1,
      args: { name: "CrRendererMain" },
    },
    {
      name: "TracingStartedInBrowser",
      cat: "disabled-by-default-devtools.timeline",
      ph: "I",
      s: "t",
      ts: 1000,
      pid: 1,
      tid: 1,
      args: { data: { frames: [{ frame: "FRAME", processId: 1, url: "https://example.test/" }] } },
    },
    {
      name: "navigationStart",
      cat: "blink.user_timing",
      ph: "R",
      ts: 1100,
      pid: 1,
      tid: 1,
      args: {
        frame: "FRAME",
        data: { documentLoaderURL: "https://example.test/", navigationId: "NAVIGATION" },
      },
    },
  ];
  for (let index = 0; index < requestCount; index++) {
    const start = 1150 + index * 1000;
    const redirectDuration = index === 0 ? 50 : 100;
    const headers: JsonObject[] = [];
    if (index === 0) {
      headers.push(
        { name: "Content-Type", value: "text/css" },
        { name: "Set-Cookie", value: "fixture-cookie-value" },
        { name: "Cache-Control", value: "max-age=60" },
      );
    }
    if (index === 1) {
      headers.push(
        { name: "Cache-Control", value: "max-age=60" },
        { name: "Content-Type", value: "text/css" },
      );
    }
    const requestData = {
      frame: "FRAME",
      requestId: `request-${index}`,
      priority: "VeryHigh",
      requestMethod: "GET",
      resourceType: "Stylesheet",
      renderBlocking: "blocking",
    };
    events.push(
      {
        name: "ResourceSendRequest",
        cat: "devtools.timeline",
        ph: "I",
        ts: start,
        pid: 1,
        tid: 1,
        args: { data: { ...requestData, url: `https://example.test/redirect-${index}.css` } },
      },
      {
        name: "ResourceSendRequest",
        cat: "devtools.timeline",
        ph: "I",
        ts: start + redirectDuration,
        pid: 1,
        tid: 1,
        args: { data: { ...requestData, url: `https://example.test/style-${index}.css` } },
      },
      {
        name: "ResourceReceiveResponse",
        cat: "devtools.timeline",
        ph: "I",
        ts: start + redirectDuration + 10,
        pid: 1,
        tid: 1,
        args: {
          data: {
            requestId: requestData.requestId,
            frame: "FRAME",
            statusCode: 200,
            mimeType: "text/css",
            protocol: "http/1.1",
            headers,
            fromCache: false,
            fromServiceWorker: false,
          },
        },
      },
      {
        name: "ResourceFinish",
        cat: "devtools.timeline",
        ph: "I",
        ts: start + redirectDuration + 150,
        pid: 1,
        tid: 1,
        args: {
          data: {
            requestId: requestData.requestId,
            finishTime: (start + redirectDuration + 100) / 1_000_000,
            encodedDataLength: 1024,
            decodedBodyLength: 2048,
            didFail: false,
          },
        },
      },
    );
  }
  events.push(
    {
      name: "firstPaint",
      cat: "loading",
      ph: "R",
      ts: 10_000,
      pid: 1,
      tid: 1,
      args: { frame: "FRAME", data: { navigationId: "NAVIGATION" } },
    },
    { name: "RunTask", cat: "devtools.timeline", ph: "X", ts: 11_000, dur: 500, pid: 1, tid: 1, args: {} },
  );
  return events;
};

const lighthouseInput = (
  engineTarget: JsonObject = {
    browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/synthetic",
    targetId: "target-1",
  },
): Parameters<LighthouseRunner["run"]>[0] => ({
  categories: ["accessibility", "seo", "best-practices", "agentic-browsing"],
  device: "desktop",
  engineTarget,
  maxWaitForLoadMs: 30_000,
  mode: "navigation",
  screenEmulation: {
    deviceScaleFactor: 1,
    disabled: false,
    height: 940,
    mobile: false,
    width: 1350,
  },
});

const analyzeSyntheticTrace = async (events: readonly JsonObject[]) => {
  const directory = await mkdtemp(join(tmpdir(), "chrome-diagnostic-timing-"));
  const tracePath = join(directory, "timing.trace.json");

  try {
    await writeFile(tracePath, JSON.stringify({ traceEvents: [...networkTraceEvents(0), ...events] }));

    const analyzer = new SubprocessTraceAnalyzer({ timeoutMs: 30_000 });
    return await analyzer.analyzeTrace(traceInput(tracePath));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const processMarker = (value: string): string => {
  expect(value).toContain("invocations=1");
  return value;
};

describe("diagnostic subprocess adapters", () => {
  test("escalates a timed-out worker that ignores SIGTERM", async () => {
    const analyzer = new SubprocessTraceAnalyzer({ timeoutMs: 25, workerPath: fixtureWorkerPath });

    expect(analyzer.analyzeTrace(traceInput("/synthetic/ignore-sigterm"))).rejects.toThrow();
  });

  test("launches a fresh Bun process for every trace analysis and insight analysis", async () => {
    const analyzer = new SubprocessTraceAnalyzer({ timeoutMs: 5000, workerPath: fixtureWorkerPath });
    const firstTrace = await analyzer.analyzeTrace(traceInput("/synthetic/one.trace.json"));
    const secondTrace = await analyzer.analyzeTrace(traceInput("/synthetic/two.trace.json"));
    const firstInsight = await analyzer.analyzeInsight({
      deviceScope: "DESKTOP",
      insightName: "SyntheticInsight",
      insightSetId: "NAVIGATION_1",
      metadata: { cpuThrottling: 1 },
      tracePath: "/synthetic/one.trace.json",
    });
    const secondInsight = await analyzer.analyzeInsight({
      deviceScope: "DESKTOP",
      insightName: "SyntheticInsight",
      insightSetId: "NAVIGATION_1",
      metadata: { cpuThrottling: 1 },
      tracePath: "/synthetic/one.trace.json",
    });

    expect(processMarker(firstTrace.summary)).not.toBe(processMarker(secondTrace.summary));
    if ("error" in firstInsight || "error" in secondInsight) {
      throw new Error("Synthetic insight unexpectedly failed");
    }
    expect(processMarker(firstInsight.output)).not.toBe(processMarker(secondInsight.output));
    expect(firstTrace.insights).toEqual([
      { insightKey: "SyntheticInsight", insightName: "SyntheticInsight", insightSetId: "NAVIGATION_1" },
    ]);
  });

  test("launches a fresh Bun process for every Lighthouse audit and normalizes results", async () => {
    const runner = new SubprocessLighthouseRunner({ timeoutMs: 5000, workerPath: fixtureWorkerPath });
    const first = await runner.run(lighthouseInput());
    const second = await runner.run(lighthouseInput());
    if (!first || !second) throw new Error("Synthetic Lighthouse unexpectedly returned no result");

    expect(processMarker(first.reports.html)).not.toBe(processMarker(second.reports.html));
    expect(first.categories).toEqual([{ id: "accessibility", score: 0.9, title: "Accessibility" }]);
    expect(first.audits).toEqual([{ score: 1 }, { score: 0.5 }]);
    expect(first.totalTiming).toBe(42);
  });

  test("normalizes subprocess failures without exposing the private browser endpoint", async () => {
    const runner = new SubprocessLighthouseRunner({ timeoutMs: 5000, workerPath: fixtureWorkerPath });
    let failure: unknown;
    try {
      await runner.run(
        lighthouseInput({
          browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/fail-private-token",
          targetId: "target-1",
        }),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").not.toContain("fail-private-token");
  });
});

describe("concrete diagnostic engines", () => {
  test.each([
    {
      representation: "duration",
      events: [
        { name: "EventDispatch", cat: "devtools.timeline", ph: "X", ts: 2000, dur: 100_000, pid: 1, tid: 1 },
      ],
      completedCount: 2,
      pairedCount: 0,
    },
    {
      representation: "begin/end",
      events: [
        { name: "EventDispatch", cat: "devtools.timeline", ph: "B", ts: 2000, pid: 1, tid: 1 },
        { name: "EventDispatch", cat: "devtools.timeline", ph: "E", ts: 102_000, pid: 1, tid: 1 },
      ],
      completedCount: 1,
      pairedCount: 1,
    },
  ])(
    "reports complete synchronous timing from $representation events",
    async ({ events, completedCount, pairedCount }) => {
      const analysis = await analyzeSyntheticTrace(events);

      expect(analysis.summary).toContain(`Completed X spans: ${completedCount}`);
      expect(analysis.summary).toContain(`Matched B/E spans: ${pairedCount}`);
      expect(analysis.summary).toContain("Unbounded B spans: 0");
      expect(analysis.summary).toContain("Unmatched E events: 0");

      expect(analysis.insights).toContainEqual(expect.objectContaining({ insightName: "RenderBlocking" }));
    },
  );

  test("reports unbounded timing with and without later completed thread activity without inventing an end", async () => {
    const analysis = await analyzeSyntheticTrace([
      { name: "EventDispatch", cat: "devtools.timeline", ph: "B", ts: 2000, pid: 1, tid: 1 },
      { name: "ThreadControllerImpl::RunTask", cat: "toplevel", ph: "B", ts: 12_000, pid: 1, tid: 1 },
    ]);

    expect(analysis.summary).toContain("Unbounded B spans: 2 (1 with later completed activity; 1 without)");
    expect(analysis.summary).toMatch(
      /EventDispatch.*CrRendererMain.*pid 1, tid 1.*2000 µs.*end unknown.*later completed activity/,
    );
    expect(analysis.summary).toMatch(
      /ThreadControllerImpl::RunTask.*CrRendererMain.*pid 1, tid 1.*12000 µs.*end unknown.*no later completed activity/,
    );
  });

  test("pairs synchronous events per process and thread and retains orphan ends", async () => {
    const analysis = await analyzeSyntheticTrace([
      { name: "EventDispatch", cat: "devtools.timeline", ph: "B", ts: 2000, pid: 1, tid: 1 },
      { name: "RunTask", cat: "toplevel", ph: "E", ts: 2500, pid: 2, tid: 1 },
      { name: "RunTask", cat: "toplevel", ph: "B", ts: 3000, pid: 2, tid: 1 },
      { name: "EventDispatch", cat: "devtools.timeline", ph: "E", ts: 4000, pid: 1, tid: 1 },
    ]);

    expect(analysis.summary).toContain("Matched B/E spans: 1");
    expect(analysis.summary).toContain("Unbounded B spans: 1");
    expect(analysis.summary).toContain("Unmatched E events: 1");
  });

  test("bounds unbounded-span examples while preserving their total count", async () => {
    const events = Array.from({ length: 7 }, (_, index) => ({
      name: `Unfinished-${index}`,
      cat: "devtools.timeline",
      ph: "B",
      ts: 12_000 + index,
      pid: 1,
      tid: 1,
    }));
    const analysis = await analyzeSyntheticTrace(events);

    expect(analysis.summary).toContain("Unbounded B spans: 7");
    expect(analysis.summary).toContain('"Unfinished-4"');
    expect(analysis.summary).not.toContain('"Unfinished-5"');
    expect(analysis.summary).toContain("2 additional unbounded spans not listed.");
  });

  test("reports DevTools task wall time without counting nested tasks twice", async () => {
    const analysis = await analyzeSyntheticTrace([
      { name: "process_name", cat: "__metadata", ph: "M", ts: 0, pid: 2, tid: 2, args: { name: "Browser" } },
      {
        name: "thread_name",
        cat: "__metadata",
        ph: "M",
        ts: 0,
        pid: 2,
        tid: 2,
        args: { name: "Chrome_DevToolsHandlerThread" },
      },
      {
        name: "ThreadControllerImpl::RunTask",
        cat: "toplevel",
        ph: "X",
        ts: 20_000,
        dur: 88_000,
        pid: 2,
        tid: 2,
      },
      { name: "DispatchProtocolMessage", cat: "toplevel", ph: "X", ts: 21_000, dur: 87_000, pid: 2, tid: 2 },
      {
        name: "ThreadControllerImpl::RunTask",
        cat: "toplevel",
        ph: "X",
        ts: 25_000,
        dur: 30_000,
        pid: 2,
        tid: 2,
      },
      { name: "RunTask", cat: "toplevel", ph: "B", ts: 200_000, pid: 2, tid: 2 },
      { name: "RunTask", cat: "toplevel", ph: "E", ts: 210_000, pid: 2, tid: 2 },
    ]);

    expect(analysis.summary).toContain("DevTools-handler task wall time (captured spans only):");
    expect(analysis.summary).toContain("Outer tasks: 2; maximum: 88 ms; interval coverage: 98 ms.");
    expect(analysis.summary).toMatch(/wall time.*not CPU cost.*page latency/);
  });

  test.each([
    { events: [], reason: "no Chrome_DevToolsHandlerThread metadata" },
    {
      events: [
        {
          name: "thread_name",
          cat: "__metadata",
          ph: "M",
          ts: 0,
          pid: 2,
          tid: 2,
          args: { name: "Chrome_DevToolsHandlerThread" },
        },
        { name: "RunTask", cat: "devtools.timeline", ph: "X", ts: 20_000, dur: 88_000, pid: 2, tid: 2 },
      ],
      reason: "no toplevel task events on the named thread",
    },
  ])("reports DevTools activity as not captured when $reason", async ({ events, reason }) => {
    const analysis = await analyzeSyntheticTrace(events);

    expect(analysis.summary).toContain(`DevTools-handler task wall time: not captured (${reason}).`);
  });

  test("keeps an unbounded DevTools task unmeasured", async () => {
    const analysis = await analyzeSyntheticTrace([
      {
        name: "thread_name",
        cat: "__metadata",
        ph: "M",
        ts: 0,
        pid: 2,
        tid: 2,
        args: { name: "Chrome_DevToolsHandlerThread" },
      },
      { name: "ThreadControllerImpl::RunTask", cat: "toplevel", ph: "B", ts: 20_000, pid: 2, tid: 2 },
    ]);

    expect(analysis.summary).toContain(
      "DevTools-handler task wall time: no completed task spans; unbounded task beginnings: 1.",
    );
    expect(analysis.summary).not.toContain("maximum: 0 ms");
  });

  test("normalizes a synthetic Lighthouse result and generated reports", () => {
    const result = normalizeLighthouseResult(
      {
        lhr: {
          audits: { passing: { score: 1 }, failing: { score: 0.25 }, manual: { score: null } },
          categories: { accessibility: { id: "accessibility", score: 0.95, title: "Accessibility" } },
          mainDocumentUrl: "https://example.test/",
          timing: { total: 321.5 },
        },
      },
      (_lhr: unknown, format: unknown) =>
        format === "json" ? '{"normalized":true}' : "<html>normalized</html>",
    );

    expect(result).toEqual({
      audits: [{ score: 1 }, { score: 0.25 }, { score: null }],
      categories: [{ id: "accessibility", score: 0.95, title: "Accessibility" }],
      mainDocumentUrl: "https://example.test/",
      reports: { html: "<html>normalized</html>", json: '{"normalized":true}' },
      totalTiming: 321.5,
    });
  });

  test("uses the displayed URL for snapshot audits without a navigation document URL", () => {
    const result = normalizeLighthouseResult(
      {
        lhr: {
          audits: {},
          categories: {},
          finalDisplayedUrl: "https://snapshot.example/",
          timing: { total: 12 },
        },
      },
      (_lhr: unknown, format: unknown) => (format === "json" ? "{}" : "<html></html>"),
    );

    expect(result.mainDocumentUrl).toBe("https://snapshot.example/");
  });

  test("keeps trace metadata without unrelated row legends in fresh Chrome Frontend workers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chrome-diagnostic-trace-"));
    const tracePath = join(directory, "synthetic.trace.json");
    const events = [
      { name: "process_name", cat: "__metadata", ph: "M", ts: 0, pid: 1, tid: 1, args: { name: "Renderer" } },
      {
        name: "thread_name",
        cat: "__metadata",
        ph: "M",
        ts: 0,
        pid: 1,
        tid: 1,
        args: { name: "CrRendererMain" },
      },
      {
        name: "TracingStartedInBrowser",
        cat: "disabled-by-default-devtools.timeline",
        ph: "I",
        s: "t",
        ts: 1000,
        pid: 1,
        tid: 1,
        args: { data: { frames: [{ frame: "FRAME", processId: 1, url: "https://example.test/" }] } },
      },
      {
        name: "navigationStart",
        cat: "blink.user_timing",
        ph: "R",
        ts: 1100,
        pid: 1,
        tid: 1,
        args: {
          frame: "FRAME",
          data: { documentLoaderURL: "https://example.test/", navigationId: "NAVIGATION" },
        },
      },
      { name: "RunTask", cat: "devtools.timeline", ph: "X", ts: 1200, dur: 500, pid: 1, tid: 1, args: {} },
    ];
    await writeFile(tracePath, JSON.stringify({ traceEvents: events }));
    try {
      const analyzer = new SubprocessTraceAnalyzer({
        timeoutMs: 30_000,
      });
      const analysis = await analyzer.analyzeTrace(traceInput(tracePath));

      expect(await readFile(tracePath, "utf8")).toBe(JSON.stringify({ traceEvents: events }));

      expect(analysis.summary).toContain("https://example.test/");
      expect(analysis.summary).toContain("Trace bounds: {min: 1000µs, max: 1700µs}");
      expect(analysis.summary).toContain("CPU throttling: 1x");
      expect(analysis.summary).toContain(
        "Metrics (field / real users): not requested; this server does not fetch CrUX field data",
      );
      expect(analysis.summary).not.toContain("no data for this page in CrUX");
      expect(analysis.summary).not.toContain("id;eventKey;name;duration;");
      expect(analysis.summary).not.toContain("urlIndex;eventKey;queuedTime;");
      expect(analysis.insights).toContainEqual({
        bounds: { startMicroseconds: 1100, endMicroseconds: 1700 },
        insightKey: "RenderBlocking",
        insightName: "RenderBlocking",
        insightSetId: expect.any(String),
        navigationKind: "hard",
        url: "https://example.test/",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test.each([0, 1, 6])(
    "formats %i network requests with only the applicable legend",
    async (requestCount) => {
      const directory = await mkdtemp(join(tmpdir(), "chrome-diagnostic-network-"));
      const tracePath = join(directory, "network.trace.json");
      await writeFile(tracePath, JSON.stringify({ traceEvents: networkTraceEvents(requestCount) }));
      try {
        const analyzer = new SubprocessTraceAnalyzer({ timeoutMs: 30_000 });
        const analysis = await analyzer.analyzeTrace(traceInput(tracePath));
        expect(analysis.summary).not.toContain("urlIndex;eventKey;queuedTime;");
        if (requestCount > 0) expect(analysis.summary).toContain("insight name: RenderBlocking");
        for (const insightName of ["RenderBlocking", "ModernHTTP"]) {
          const reference = analysis.insights.find(
            (insight) => insight.insightName === insightName && insight.insightSetId !== "NO_NAVIGATION",
          );
          if (!reference) throw new Error(`Missing ${insightName} insight reference`);
          const detail = await analyzer.analyzeInsight({
            deviceScope: "DESKTOP",
            insightName,
            insightSetId: reference.insightSetId,
            metadata: { cpuThrottling: 1 },
            tracePath,
          });
          if ("error" in detail) throw new Error(detail.error);
          const output = detail.output;
          expect(output).not.toContain("id;eventKey;name;duration;");
          expect(output).not.toContain("fixture-cookie-value");
          expect(output).toContain("https://developer.chrome.com/");
          const expectedRequests = insightName === "ModernHTTP" && requestCount < 6 ? 0 : requestCount;
          if (expectedRequests < 2) {
            expect(output).not.toContain("urlIndex;eventKey;queuedTime;");
            if (expectedRequests === 0) expect(output).not.toContain("https://example.test/style-");
            else {
              expect(output).toContain("https://example.test/style-0.css");
              expect(output).toContain("Set-Cookie: <redacted>");
              expect(output).toContain("50\u00a0μs");
            }
            continue;
          }
          expect(output.split("urlIndex;eventKey;queuedTime;")).toHaveLength(2);
          expect(output).toContain("headerName: headerValue");
          expect(output).toContain("in response order");
          expect(output).toContain("microseconds");
          const rows = output.split("\n").filter((line) => /^\d+;s-\d+;/.test(line));
          expect(rows).toHaveLength(expectedRequests);
          expect(rows.every((row) => row.split(";").length === 20)).toBe(true);
          expect(rows.map((row) => row.split(";")[19])).toContain(
            "[Content-Type: text/css|Set-Cookie: <redacted>|Cache-Control: max-age=60]",
          );
          expect(rows.map((row) => row.split(";")[19])).toContain(
            "[Cache-Control: max-age=60|Content-Type: text/css]",
          );
          expect(rows.map((row) => row.split(";")[19])).toContain("[]");
          expect(rows.join("\n")).toContain("|50\u00a0μs|50\u00a0μs]]");
          expect(rows.join("\n")).toContain("|0.1\u00a0ms]]");
        }
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  );
});

describe("diagnostic subprocess protocol", () => {
  test("rejects unknown request fields at every protocol-defined object boundary", () => {
    const traceRequest = {
      input: {
        deviceScope: "DESKTOP",
        metadata: { cpuThrottling: 1 },
        tracePath: "/synthetic/trace.json",
      },
      operation: "trace-analyze",
    };
    const lighthouseRequest = {
      input: lighthouseInput(),
      operation: "lighthouse",
    };
    const insightRequest = {
      input: {
        deviceScope: "DESKTOP",
        insightName: "LCPBreakdown",
        insightSetId: "NAVIGATION_1",
        metadata: { cpuThrottling: 1 },
        tracePath: "/synthetic/trace.json",
      },
      operation: "trace-insight",
    };
    const invalidRequests: unknown[] = [
      { ...traceRequest, unknown: true },
      { ...traceRequest, input: { ...traceRequest.input, unknown: true } },
      { ...traceRequest, input: { ...traceRequest.input, metadata: { cpuThrottling: 1, unknown: true } } },
      { ...insightRequest, input: { ...insightRequest.input, unknown: true } },
      { ...lighthouseRequest, input: { ...lighthouseRequest.input, unknown: true } },
      {
        ...lighthouseRequest,
        input: {
          ...lighthouseRequest.input,
          engineTarget: { ...lighthouseRequest.input.engineTarget, unknown: true },
        },
      },
      {
        ...lighthouseRequest,
        input: {
          ...lighthouseRequest.input,
          screenEmulation: { ...lighthouseRequest.input.screenEmulation, unknown: true },
        },
      },
    ];

    for (const request of invalidRequests) {
      expect(() => parseDiagnosticWorkerRequest(request)).toThrow();
    }
  });

  test("rejects unknown response fields at every protocol-defined object boundary", () => {
    const traceResult = {
      insights: [{ insightKey: "LCP", insightName: "LCPBreakdown", insightSetId: "NAVIGATION_1" }],
      summary: "summary",
    };
    const lighthouseResult = {
      audits: [{ score: 1 }],
      categories: [{ id: "accessibility", score: 1, title: "Accessibility" }],
      mainDocumentUrl: "https://example.test/",
      reports: { html: "<html></html>", json: "{}" },
      totalTiming: 1,
    };
    const invalidResponses: unknown[] = [
      { ok: true, operation: "trace-analyze", result: traceResult, unknown: true },
      {
        ok: true,
        operation: "trace-analyze",
        result: { ...traceResult, unknown: true },
      },
      {
        ok: true,
        operation: "trace-analyze",
        result: { ...traceResult, insights: [{ ...traceResult.insights[0], unknown: true }] },
      },
      {
        ok: true,
        operation: "trace-insight",
        result: { output: "output", unknown: true },
      },
      {
        ok: true,
        operation: "lighthouse",
        result: { ...lighthouseResult, audits: [{ score: 1, unknown: true }] },
      },
      {
        ok: true,
        operation: "lighthouse",
        result: {
          ...lighthouseResult,
          categories: [{ id: "accessibility", score: 1, title: "Accessibility", unknown: true }],
        },
      },
      {
        ok: true,
        operation: "lighthouse",
        result: { ...lighthouseResult, reports: { ...lighthouseResult.reports, unknown: true } },
      },
      {
        error: { code: "FAILED", message: "failure", unknown: true },
        ok: false,
        operation: "lighthouse",
      },
      {
        error: { code: "FAILED", message: "failure" },
        ok: false,
        operation: "lighthouse",
        unknown: true,
      },
    ];

    for (const response of invalidResponses) {
      expect(() => parseDiagnosticWorkerResponse(response)).toThrow();
    }
  });
});
