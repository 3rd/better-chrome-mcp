import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isNodeError } from "../../platform/node-errors";
import { ChromeDiagnosticError, type DiagnosticCall } from "./types";

export type DiagnosticOutputPathRequest = {
  call: DiagnosticCall;
  path: string;
};

export type DiagnosticOutputPathResolver = {
  resolveDirectory: (request: DiagnosticOutputPathRequest) => Promise<string>;
  resolveFile: (request: DiagnosticOutputPathRequest) => Promise<string>;
};

export type DiagnosticOutputPathResolverOptions = {
  baseDirectory: string;
};

type CanonicalCandidate = {
  exists: boolean;
  path: string;
};

const outputPathError = (message: string): ChromeDiagnosticError =>
  new ChromeDiagnosticError("CHROME_MCP_OUTPUT_PATH", message);

const canonicalCandidate = async (candidate: string): Promise<CanonicalCandidate> => {
  const missingSegments: string[] = [];
  let existingPath = candidate;
  for (;;) {
    try {
      await lstat(existingPath);
      break;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = dirname(existingPath);
      if (parent === existingPath) throw outputPathError(`Output path has no existing parent: ${candidate}`);
      missingSegments.unshift(basename(existingPath));
      existingPath = parent;
    }
  }

  const canonicalExistingPath = await realpath(existingPath);
  if (missingSegments.length === 0) return { exists: true, path: canonicalExistingPath };

  const parentMetadata = await stat(canonicalExistingPath);
  if (!parentMetadata.isDirectory()) {
    throw outputPathError(`Output path parent is not a directory: ${candidate}`);
  }
  return { exists: false, path: join(canonicalExistingPath, ...missingSegments) };
};

class FileSystemDiagnosticOutputPathResolver implements DiagnosticOutputPathResolver {
  readonly #baseDirectory: string;

  constructor(baseDirectory: string) {
    this.#baseDirectory = baseDirectory;
  }

  resolveDirectory(request: DiagnosticOutputPathRequest): Promise<string> {
    return this.#resolve(request.path, "directory");
  }

  resolveFile(request: DiagnosticOutputPathRequest): Promise<string> {
    return this.#resolve(request.path, "file");
  }

  async #resolve(path: string, kind: "directory" | "file"): Promise<string> {
    if (path.length === 0) throw outputPathError("Output path must not be empty.");
    const candidate = await canonicalCandidate(resolve(this.#baseDirectory, path));
    if (candidate.exists) {
      const metadata = await stat(candidate.path);
      if (kind === "directory" && !metadata.isDirectory()) {
        throw outputPathError(`Output directory is not a directory: ${path}`);
      }
      if (kind === "file" && !metadata.isFile()) {
        throw outputPathError(`Output file is not a regular file: ${path}`);
      }
    }
    return candidate.path;
  }
}

export const createDiagnosticOutputPathResolver = async (
  options: DiagnosticOutputPathResolverOptions,
): Promise<DiagnosticOutputPathResolver> => {
  const baseDirectory = await realpath(resolve(options.baseDirectory));
  const baseMetadata = await stat(baseDirectory);
  if (!baseMetadata.isDirectory()) {
    throw outputPathError(`Diagnostic output base is not a directory: ${baseDirectory}`);
  }
  return new FileSystemDiagnosticOutputPathResolver(baseDirectory);
};

const rejectExplicitOutputPath = (): Promise<string> =>
  Promise.reject(outputPathError("Explicit diagnostic output paths require a session path resolver."));

export const rejectingDiagnosticOutputPathResolver: DiagnosticOutputPathResolver = {
  resolveDirectory: rejectExplicitOutputPath,
  resolveFile: rejectExplicitOutputPath,
};
