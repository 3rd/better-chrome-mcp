import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type ToolPathContext = Readonly<{
  baseCwd: string;
}>;

export type ToolRecordingContext =
  | Readonly<{ mode: "off" }>
  | Readonly<{ mode: "session"; sessionId: string }>;

export type ToolSessionContext = Readonly<{
  connectionId: string;
  pathContext: ToolPathContext;
  recording: ToolRecordingContext;
}>;

export const createToolConnectionId = (): string => randomBytes(16).toString("hex");

export const isToolSessionContext = (value: unknown): value is ToolSessionContext => {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("connectionId" in value) ||
    typeof value.connectionId !== "string" ||
    value.connectionId.length === 0
  ) {
    return false;
  }
  if (!("pathContext" in value) || typeof value.pathContext !== "object" || value.pathContext === null) {
    return false;
  }
  if (!("baseCwd" in value.pathContext) || typeof value.pathContext.baseCwd !== "string") return false;
  if (!("recording" in value) || typeof value.recording !== "object" || value.recording === null) {
    return false;
  }
  return "mode" in value.recording && (value.recording.mode === "off" || value.recording.mode === "session");
};

const assertReadableDirectory = async (path: string, label: string): Promise<void> => {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
  await access(path, constants.R_OK | constants.X_OK);
};

const canonicalDirectory = async (path: string, label: string): Promise<string> => {
  const canonical = await realpath(resolve(path));
  await assertReadableDirectory(canonical, label);
  return canonical;
};

export const createToolPathContext = async (context: ToolPathContext): Promise<ToolPathContext> => {
  const baseCwd = await canonicalDirectory(context.baseCwd, "Tool base cwd");
  return Object.freeze({ baseCwd });
};

export const resolveToolOutputPath = async (context: ToolPathContext, inputPath: string): Promise<string> => {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Output path must not be blank");
  const unresolved = isAbsolute(trimmed) ? resolve(trimmed) : resolve(context.baseCwd, trimmed);
  const fileName = basename(unresolved);
  if (fileName === "." || fileName === "..") throw new Error("Output path must name a file");
  try {
    const metadata = await lstat(unresolved);
    if (metadata.isSymbolicLink()) throw new Error(`Output path must not be a symbolic link: ${unresolved}`);
    if (metadata.isDirectory()) throw new Error(`Output path must name a file: ${unresolved}`);
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const parent = await canonicalDirectory(dirname(unresolved), "Tool output directory");
  return join(parent, fileName);
};

export const createToolSessionContext = async (
  pathContext: ToolPathContext,
  recording: ToolRecordingContext,
  connectionId = createToolConnectionId(),
): Promise<ToolSessionContext> =>
  Object.freeze({
    connectionId,
    pathContext: await createToolPathContext(pathContext),
    recording: Object.freeze(recording),
  });

export const createStandaloneToolSessionContext = (cwd = process.cwd()) =>
  createToolSessionContext({ baseCwd: cwd }, { mode: "off" });
