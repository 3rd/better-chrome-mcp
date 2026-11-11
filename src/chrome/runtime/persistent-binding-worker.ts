import {
  parsePersistentBindingWorkerRequest,
  PERSISTENT_BINDING_MAX_PAYLOAD_BYTES,
  PERSISTENT_BINDING_WORKER_INPUT_MAX_BYTES,
  type PersistentBindingWorkerErrorCode,
  type PersistentBindingWorkerResponse,
} from "./persistent-binding-protocol";

const message = (error: unknown): string => {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 4 * 1024);
};

const respond = (response: PersistentBindingWorkerResponse): void => {
  process.stdout.write(JSON.stringify(response));
};

const fail = (code: PersistentBindingWorkerErrorCode, error: unknown): void => {
  respond({ error: { code, message: message(error) }, ok: false });
};

const input = await Bun.stdin.text();
if (Buffer.byteLength(input, "utf8") > PERSISTENT_BINDING_WORKER_INPUT_MAX_BYTES) {
  fail("BINDING_INVALID_SOURCE", "Persistent binding worker input exceeds its size limit");
  process.exit(0);
}

let request;
try {
  request = parsePersistentBindingWorkerRequest(JSON.parse(input));
} catch (error: unknown) {
  fail("BINDING_INVALID_SOURCE", error);
  process.exit(0);
}

let handler: unknown;
try {
  const create = new Function(`"use strict"; return (${request.source}\n);`);
  handler = create();
} catch (error: unknown) {
  fail("BINDING_INVALID_SOURCE", error);
  process.exit(0);
}
if (typeof handler !== "function") {
  fail("BINDING_INVALID_SOURCE", "Persistent binding source must evaluate to a function");
  process.exit(0);
}
if (request.operation === "validate") {
  respond({ ok: true, value: null });
  process.exit(0);
}

let result: unknown;
try {
  result = await Reflect.apply(handler, undefined, request.args);
} catch (error: unknown) {
  fail("BINDING_HANDLER_FAILED", error);
  process.exit(0);
}

let encoded: string | undefined;
try {
  encoded = JSON.stringify(result === undefined ? null : result);
} catch (error: unknown) {
  fail("BINDING_INVALID_RESULT", error);
  process.exit(0);
}
if (encoded === undefined) {
  fail("BINDING_INVALID_RESULT", "Persistent binding result must be JSON-safe");
  process.exit(0);
}
if (Buffer.byteLength(encoded, "utf8") > PERSISTENT_BINDING_MAX_PAYLOAD_BYTES) {
  fail(
    "BINDING_RESULT_LIMIT",
    `Persistent binding result exceeds ${PERSISTENT_BINDING_MAX_PAYLOAD_BYTES} bytes`,
  );
  process.exit(0);
}

respond({ ok: true, value: JSON.parse(encoded) });
