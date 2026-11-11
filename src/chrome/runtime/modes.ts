import {
  BROWSER_MODES,
  type BrowserMode,
  getNativeDeviceScaleFactorError,
  isBrowserMode,
  isNamedBrowserMode,
} from "../browser-modes";
import { ChromeRuntimeError } from "./errors";

export { BROWSER_MODES, type BrowserMode } from "../browser-modes";
export type SharedBrowserMode = Extract<BrowserMode, "shared-headless" | "shared">;

export const parseBrowserMode = (value: unknown): BrowserMode => {
  if (isBrowserMode(value)) return value;
  throw new ChromeRuntimeError(
    "CHROME_MCP_INVALID_MODE",
    `Browser mode must be one of ${BROWSER_MODES.join(", ")}`,
  );
};

export const isHeadlessMode = (mode: BrowserMode): boolean =>
  mode === "isolated-headless" || mode === "shared-headless";

export const isIsolatedMode = (
  mode: BrowserMode,
): mode is Extract<BrowserMode, "isolated-headless" | "isolated-virtual-display" | "isolated"> =>
  mode === "isolated" || isNamedBrowserMode(mode);

export const assertNativeDeviceScaleFactor = (mode: BrowserMode, value: unknown) => {
  const error = getNativeDeviceScaleFactorError(mode, value);
  if (error) {
    throw new ChromeRuntimeError("CHROME_MCP_INVALID_INPUT", error);
  }
};

export const assertMatchingNativeDeviceScaleFactor = (
  actual: number | undefined,
  requested: number | undefined,
) => {
  if (actual !== requested) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_INVALID_INPUT",
      "This browser instance already uses a different nativeDeviceScaleFactor; reuse its original scale or choose a new browserInstanceId",
    );
  }
};

export const isSharedMode = (mode: BrowserMode): mode is SharedBrowserMode =>
  mode === "shared" || mode === "shared-headless";

export const browserOwnership = (mode: BrowserMode): "attached" | "launched" =>
  mode === "main" ? "attached" : "launched";
