import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserMode, SharedBrowserMode } from "./modes";
import { isNodeError } from "../../platform/node-errors";
import { isRecord } from "../../platform/records";
import { isBrowserMode } from "../browser-modes";
import { ChromeRuntimeError } from "./errors";
import { isSharedMode, parseBrowserMode } from "./modes";

export type ProfileMetadata = Readonly<{
  chromeMajorVersion?: number;
  cleanShutdown: boolean;
  mode: SharedBrowserMode;
  workspaceHash: string;
}>;

export type BrowserOwnerMetadata = Readonly<{
  browserPid: number;
  cleanShutdown: boolean;
  endpoint: string;
  mode: BrowserMode;
  ownerGeneration: number;
  processStartIdentity: string;
  profilePathHash: string;
  updatedAt: string;
}>;

export type BrowserCrashMarker = Readonly<{
  createdAt: string;
  ownerGeneration: number;
}>;

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
  );
};

const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch((cleanupError: unknown) => {
      if (!isNodeError(cleanupError, "ENOENT")) throw cleanupError;
    });
    throw error;
  }
};

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
};

export const readProfileMetadata = async (path: string): Promise<ProfileMetadata | undefined> => {
  const value = await readJson(path);
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "cleanShutdown",
      "mode",
      "workspaceHash",
      ...(value.chromeMajorVersion === undefined ? [] : ["chromeMajorVersion"]),
    ]) ||
    !isBrowserMode(value.mode) ||
    !isSharedMode(value.mode) ||
    typeof value.workspaceHash !== "string" ||
    !/^[\da-f]{64}$/.test(value.workspaceHash) ||
    typeof value.cleanShutdown !== "boolean" ||
    (value.chromeMajorVersion !== undefined &&
      (typeof value.chromeMajorVersion !== "number" || !Number.isSafeInteger(value.chromeMajorVersion)))
  ) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_INVALID_PROFILE_METADATA",
      "Chrome profile metadata has an unsupported shape",
    );
  }
  return Object.freeze({
    ...(typeof value.chromeMajorVersion === "number" ? { chromeMajorVersion: value.chromeMajorVersion } : {}),
    cleanShutdown: value.cleanShutdown,
    mode: value.mode,
    workspaceHash: value.workspaceHash,
  });
};

export const writeProfileMetadata: (path: string, metadata: ProfileMetadata) => Promise<void> =
  writeJsonAtomic;

export const readBrowserOwnerMetadata = async (path: string): Promise<BrowserOwnerMetadata | undefined> => {
  const value = await readJson(path);
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "browserPid",
      "cleanShutdown",
      "endpoint",
      "mode",
      "ownerGeneration",
      "processStartIdentity",
      "profilePathHash",
      "updatedAt",
    ]) ||
    typeof value.browserPid !== "number" ||
    !Number.isSafeInteger(value.browserPid) ||
    value.browserPid <= 0 ||
    typeof value.cleanShutdown !== "boolean" ||
    typeof value.endpoint !== "string" ||
    !value.endpoint.startsWith("ws://127.0.0.1:") ||
    !isBrowserMode(value.mode) ||
    typeof value.ownerGeneration !== "number" ||
    !Number.isSafeInteger(value.ownerGeneration) ||
    value.ownerGeneration < 1 ||
    typeof value.processStartIdentity !== "string" ||
    !value.processStartIdentity ||
    typeof value.profilePathHash !== "string" ||
    !/^[\da-f]{64}$/.test(value.profilePathHash) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_INVALID_PROFILE_METADATA",
      "Chrome owner metadata has an unsupported shape",
    );
  }
  return Object.freeze({
    browserPid: value.browserPid,
    cleanShutdown: value.cleanShutdown,
    endpoint: value.endpoint,
    mode: parseBrowserMode(value.mode),
    ownerGeneration: value.ownerGeneration,
    processStartIdentity: value.processStartIdentity,
    profilePathHash: value.profilePathHash,
    updatedAt: value.updatedAt,
  });
};

export const writeBrowserOwnerMetadata: (path: string, metadata: BrowserOwnerMetadata) => Promise<void> =
  writeJsonAtomic;

export const writeBrowserCrashMarker: (path: string, marker: BrowserCrashMarker) => Promise<void> =
  writeJsonAtomic;

export const removeBrowserCrashMarker = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
};
