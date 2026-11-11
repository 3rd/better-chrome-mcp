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
