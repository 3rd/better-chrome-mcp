import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseServerOptions } from "./options";

test("resolves the selected workspace and preserves an executable path with spaces", () => {
  expect(
    parseServerOptions([
      "--workspace",
      "example",
      "--executable-path",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]),
  ).toEqual({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    workspacePath: resolve("example"),
    reactTools: undefined,
    mainUserDataDir: undefined,
    shouldShowHelp: false,
    shouldShowVersion: false,
  });
});

test("accepts a React tools mode and resolves the profile folder of the user's own browser", () => {
  expect(parseServerOptions(["--react", "off", "--main-user-data-dir", "profiles/chromium"])).toMatchObject({
    mainUserDataDir: resolve("profiles/chromium"),
    reactTools: "off",
  });
});

test("rejects a React tools mode other than auto, on, or off", () => {
  expect(() => parseServerOptions(["--react", "always"])).toThrow("--react must be one of auto, on, off");
});

test("rejects unknown startup options", () => {
  expect(() => parseServerOptions(["--unknown"])).toThrow();
});

test("resolves --engine-config from the current directory and normalizes --cdp-endpoint", () => {
  expect(
    parseServerOptions([
      "--engine",
      "obscura",
      "--engine-config",
      "cfg/engines.json",
      "--cdp-endpoint",
      "http://127.0.0.1:9222",
    ]),
  ).toMatchObject({
    engine: "obscura",
    engineConfigPath: resolve("cfg/engines.json"),
    cdpEndpoint: "http://127.0.0.1:9222/",
  });
  expect(parseServerOptions(["--cdp-endpoint", "http://host:9222/cdp"]).cdpEndpoint).toBe("http://host:9222/cdp");
});

test("rejects a CDP endpoint that is not an http(s) or ws(s) URL", () => {
  expect(() => parseServerOptions(["--cdp-endpoint", "file:///x"])).toThrow(
    '--cdp-endpoint must be an http(s):// or ws(s):// URL; received "file:///x"',
  );
  expect(() => parseServerOptions(["--cdp-endpoint", "not a url"])).toThrow("--cdp-endpoint must be");
});

test("echoes an invalid --react value verbatim", () => {
  expect(() => parseServerOptions(["--react", "bogus"])).toThrow('received "bogus"');
});

test("redacts credentials and query from an invalid CDP endpoint in the error", () => {
  let message = "";
  try {
    parseServerOptions(["--cdp-endpoint", "ftp://user:pw@host/?token=x"]);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain("--cdp-endpoint must be");
  expect(message).not.toContain("pw");
  expect(message).not.toContain("token=x");
});
