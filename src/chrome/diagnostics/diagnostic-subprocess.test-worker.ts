import {
  type DiagnosticWorkerFailure,
  type DiagnosticWorkerSuccess,
  parseDiagnosticWorkerRequest,
} from "./subprocess-protocol";

const processToken = crypto.randomUUID();
let invocationCount = 0;

const request = parseDiagnosticWorkerRequest(JSON.parse(await Bun.stdin.text()));
invocationCount += 1;
const marker = `process=${processToken}; invocations=${invocationCount}`;

if (request.operation === "trace-analyze" && request.input.tracePath === "/synthetic/ignore-sigterm") {
  process.on("SIGTERM", () => undefined);
  await Promise.withResolvers<never>().promise;
}

let response: DiagnosticWorkerFailure | DiagnosticWorkerSuccess;
if (request.operation === "trace-analyze") {
  response = {
    ok: true,
    operation: request.operation,
    result: {
      insights: [
        { insightKey: "SyntheticInsight", insightName: "SyntheticInsight", insightSetId: "NAVIGATION_1" },
      ],
      summary: marker,
    },
  };
} else if (request.operation === "trace-insight") {
  response = {
    ok: true,
    operation: request.operation,
    result: { output: marker },
  };
} else if (
  typeof request.input.engineTarget.browserWSEndpoint === "string" &&
  request.input.engineTarget.browserWSEndpoint.includes("/fail-")
) {
  const endpoint = request.input.engineTarget.browserWSEndpoint;
  response = {
    error: {
      code: "SYNTHETIC_FAILURE",
      message: `Unable to attach to ${typeof endpoint === "string" ? endpoint : "the endpoint"}`,
    },
    ok: false,
    operation: request.operation,
  };
} else {
  response = {
    ok: true,
    operation: request.operation,
    result: {
      audits: [{ score: 1 }, { score: 0.5 }],
      categories: [{ id: "accessibility", score: 0.9, title: "Accessibility" }],
      mainDocumentUrl: `https://example.test/${processToken}`,
      reports: { html: `<html>${marker}</html>`, json: JSON.stringify({ marker }) },
      totalTiming: 42,
    },
  };
}

process.stdout.write(JSON.stringify(response));
