import { expect, test } from "bun:test";
import { redactEndpointUrl } from "./endpoint-redaction";

test("redacts the userinfo and the query of an endpoint URL", () => {
  expect(redactEndpointUrl("http://user:secret@host:9222/path?token=abc")).toBe("http://***@host:9222/path?***");
  expect(redactEndpointUrl("ws://:secret@127.0.0.1:9222/devtools/browser/x")).toBe(
    "ws://***@127.0.0.1:9222/devtools/browser/x",
  );
});

test("leaves an endpoint without userinfo or query unchanged and never echoes an unparseable value", () => {
  expect(redactEndpointUrl("http://127.0.0.1:9222/")).toBe("http://127.0.0.1:9222/");
  expect(redactEndpointUrl("ws://127.0.0.1:9222/devtools/browser/x")).toBe("ws://127.0.0.1:9222/devtools/browser/x");
  expect(redactEndpointUrl("user:secret@host")).not.toContain("secret");
  expect(redactEndpointUrl("not a url")).not.toContain("not a url");
});
