import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, rename, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { isNodeError } from "../../platform/node-errors";

export type AtomicDiagnosticFile = {
  abort: () => Promise<void>;
  commit: () => Promise<void>;
  write: (data: Uint8Array | string) => Promise<void>;
};

export type DiagnosticFileSystem = {
  createTemporaryPath: (filename: string) => Promise<string>;
  materializeTrace: (sourcePath: string, destinationPath: string, gzip: boolean) => Promise<void>;
  openAtomic: (destinationPath: string, createParent: boolean) => Promise<AtomicDiagnosticFile>;
  remove: (filePath: string) => Promise<void>;
  writeAtomic: (destinationPath: string, data: Uint8Array | string, createParent: boolean) => Promise<void>;
};

const temporarySibling = (destinationPath: string): string =>
  join(dirname(destinationPath), `.${basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`);

export const replaceExtension = (filePath: string, extension: string): string => {
  const currentExtension = extname(filePath);
  return filePath.slice(0, filePath.length - currentExtension.length) + extension;
};

const removeIfPresent = async (filePath: string): Promise<void> => {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
};

const removeEmptyDirectory = async (directory: string): Promise<void> => {
  try {
    await rmdir(directory);
  } catch (error) {
    const isExpectedRemovalFailure =
      isNodeError(error, "ENOENT") || isNodeError(error, "ENOTEMPTY") || isNodeError(error, "EEXIST");
    if (!isExpectedRemovalFailure) throw error;
  }
};

export class NodeDiagnosticFileSystem implements DiagnosticFileSystem {
  readonly #temporaryDirectories = new Set<string>();

  async createTemporaryPath(filename: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "chrome-diagnostics-"));
    this.#temporaryDirectories.add(directory);
    return join(directory, filename);
  }

  async materializeTrace(sourcePath: string, destinationPath: string, gzip: boolean): Promise<void> {
    await mkdir(dirname(destinationPath), { recursive: true });
    const temporaryPath = temporarySibling(destinationPath);
    try {
      if (gzip) {
        await pipeline(
          createReadStream(sourcePath),
          createGzip(),
          createWriteStream(temporaryPath, { flags: "wx" }),
        );
      } else await copyFile(sourcePath, temporaryPath);
      await rename(temporaryPath, destinationPath);
    } catch (error) {
      await removeIfPresent(temporaryPath);
      throw error;
    }
  }

  async openAtomic(destinationPath: string, createParent: boolean): Promise<AtomicDiagnosticFile> {
    if (createParent) await mkdir(dirname(destinationPath), { recursive: true });
    const temporaryPath = temporarySibling(destinationPath);
    const handle = await open(temporaryPath, "wx");
    let closed = false;
    let committed = false;

    const close = async (): Promise<void> => {
      if (closed) return;
      await handle.close();
      closed = true;
    };

    return {
      abort: async () => {
        if (committed) return;
        await close();
        await removeIfPresent(temporaryPath);
      },
      commit: async () => {
        if (committed) return;
        await close();
        await rename(temporaryPath, destinationPath);
        committed = true;
      },
      write: async (data) => {
        if (closed) throw new Error("Cannot write to a closed diagnostic file");

        const bytes = typeof data === "string" ? Buffer.from(data) : data;
        await handle.write(bytes);
      },
    };
  }

  async remove(filePath: string): Promise<void> {
    await removeIfPresent(filePath);
    const parent = dirname(filePath);
    if (!this.#temporaryDirectories.has(parent)) return;
    await removeEmptyDirectory(parent);
    this.#temporaryDirectories.delete(parent);
  }

  async writeAtomic(
    destinationPath: string,
    data: Uint8Array | string,
    createParent: boolean,
  ): Promise<void> {
    const file = await this.openAtomic(destinationPath, createParent);
    try {
      await file.write(data);
      await file.commit();
    } catch (error) {
      await file.abort().catch(() => undefined);
      throw error;
    }
  }
}
