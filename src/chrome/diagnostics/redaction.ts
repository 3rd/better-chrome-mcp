import type { DiagnosticWorkerRequest } from "./subprocess-protocol";

type SensitiveValue = { replacement: string; value: string };

const FILE_PATH_PATTERN = /(?:\/[\w.-]+){2,}/g;

export const redactFilePaths = (message: string) => message.replaceAll(FILE_PATH_PATTERN, "[redacted path]");

const listSensitiveRequestValues = (request: DiagnosticWorkerRequest) => {
  if (request.operation !== "lighthouse") {
    return [{ replacement: "[redacted trace path]", value: request.input.tracePath }];
  }

  const target = request.input.engineTarget;
  const values: SensitiveValue[] = [];

  for (const key of ["browserWSEndpoint", "browserURL"]) {
    const value = target[key];
    const isEndpointPresent = typeof value === "string" && value.length > 0;
    if (!isEndpointPresent) continue;

    values.push({ replacement: "[redacted endpoint]", value });
  }

  const targetId = target.targetId;
  const isTargetIdPresent = typeof targetId === "string" && targetId.length > 0;
  if (isTargetIdPresent) {
    values.push({ replacement: "[redacted target]", value: targetId });
  }

  return values;
};

// The request's own values are replaced before the generic path rule runs. In the other order a trace path
// would already read "[redacted path]" and its specific "[redacted trace path]" label would never appear.
export const redactDiagnosticRequestValues = (message: string, request: DiagnosticWorkerRequest) => {
  let redacted = message;

  for (const sensitive of listSensitiveRequestValues(request)) {
    redacted = redacted.replaceAll(sensitive.value, sensitive.replacement);
  }

  return redactFilePaths(redacted);
};
