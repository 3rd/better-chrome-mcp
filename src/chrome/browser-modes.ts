import { z } from "zod/v4";

export const BROWSER_MODES = [
  "isolated",
  "isolated-headless",
  "isolated-virtual-display",
  "shared",
  "shared-headless",
  "main",
] as const;

export type BrowserMode = (typeof BROWSER_MODES)[number];

export const DEFAULT_BROWSER_MODE = "isolated-headless" satisfies BrowserMode;

export const isBrowserMode = (value: unknown): value is BrowserMode => {
  for (const mode of BROWSER_MODES) {
    if (value === mode) return true;
  }

  return false;
};

export type BrowserInstanceOptions = Readonly<{
  browserInstanceId?: string;
  nativeDeviceScaleFactor?: number;
}>;

export type BrowserSelection = BrowserInstanceOptions & Readonly<{ browser: BrowserMode }>;

export const MIN_NATIVE_DEVICE_SCALE_FACTOR = 0.5;
export const MAX_NATIVE_DEVICE_SCALE_FACTOR = 4;

export const nativeDeviceScaleFactorSchema = z
  .number()
  .min(MIN_NATIVE_DEVICE_SCALE_FACTOR)
  .max(MAX_NATIVE_DEVICE_SCALE_FACTOR);

export const isNamedBrowserMode = (mode: BrowserMode) =>
  mode === "isolated-headless" || mode === "isolated-virtual-display";

export const getNativeDeviceScaleFactorError = (mode: BrowserMode, value: unknown) => {
  if (mode !== "isolated-virtual-display") {
    return value === undefined ? undefined : (
        "nativeDeviceScaleFactor is only supported for isolated-virtual-display"
      );
  }

  if (value === undefined) return "nativeDeviceScaleFactor is required for isolated-virtual-display";

  if (!nativeDeviceScaleFactorSchema.safeParse(value).success) {
    return `nativeDeviceScaleFactor must be a number from ${MIN_NATIVE_DEVICE_SCALE_FACTOR} through ${MAX_NATIVE_DEVICE_SCALE_FACTOR}`;
  }

  return undefined;
};
