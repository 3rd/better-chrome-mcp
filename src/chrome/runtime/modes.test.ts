import { describe, expect, test } from "bun:test";
import { BROWSER_MODES, browserOwnership, isHeadlessMode, parseBrowserMode } from "./modes";

describe("Chrome browser modes", () => {
  test("parses native virtual-display mode alongside the existing modes", () => {
    expect(BROWSER_MODES).toEqual([
      "isolated",
      "isolated-headless",
      "isolated-virtual-display",
      "shared",
      "shared-headless",
      "main",
    ]);
    for (const mode of BROWSER_MODES) expect(parseBrowserMode(mode)).toBe(mode);
    expect(() => parseBrowserMode("headless")).toThrow();
    expect(isHeadlessMode("isolated-headless")).toBe(true);
    expect(isHeadlessMode("shared")).toBe(false);
    expect(browserOwnership("main")).toBe("attached");
    expect(browserOwnership("shared")).toBe("launched");
  });
});
