import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { isNodeError } from "../../platform/node-errors";
import { getMcpRuntimeDir } from "../../platform/runtime-paths";
import { currentProcessStartIdentity, probeProcessIdentity, workspaceIdentity } from "../runtime";
import { BROKER_LOG_FILE, BROKER_METADATA_FILE, BROKER_STARTUP_LOCK_FILE } from "./constants";
import { BrokerRpcError } from "./errors";

const MAX_SOCKET_PATH_BYTES = 103;
const WINDOWS_PIPE_NAMESPACE = "\\\\.\\pipe\\";

export const isBrokerSocketFile = (socketPath: string) => !socketPath.startsWith(WINDOWS_PIPE_NAMESPACE);

// Windows pipe names are shared by every user of the machine, unlike socket files in a per-user
// folder. The name therefore includes a hash of the runtime folder, which differs per user. Without
// it, two users who open the same workspace path would compete for one pipe.
const resolveWindowsPipePath = (runtimeRoot: string, workspaceHash: string) => {
  const runtimeRootHash = createHash("sha256").update(runtimeRoot).digest("hex").slice(0, 12);

  return `${WINDOWS_PIPE_NAMESPACE}chrome-mcp-${runtimeRootHash}-${workspaceHash.slice(0, 16)}`;
};

const resolveSocketFileLocation = (runtimeRoot: string, uid: number, workspaceHash: string) => {
  const preferredSocketRoot = runtimeRoot;
  const preferredSocketPath = join(
    preferredSocketRoot,
    `chrome-broker-u${uid}-${workspaceHash.slice(0, 16)}.sock`,
  );

  const fallbackSocketDirectory = `chrome-mcp-u${uid}-${createHash("sha256").update(runtimeRoot).digest("hex").slice(0, 12)}`;
  let socketRoot =
    Buffer.byteLength(preferredSocketPath, "utf8") <= MAX_SOCKET_PATH_BYTES ?
      preferredSocketRoot
    : join(tmpdir(), fallbackSocketDirectory);
  if (
    Buffer.byteLength(join(socketRoot, `${workspaceHash.slice(0, 16)}.sock`), "utf8") > MAX_SOCKET_PATH_BYTES
  ) {
    socketRoot = join("/tmp", fallbackSocketDirectory);
  }

  const socketPath = join(socketRoot, `${workspaceHash.slice(0, 16)}.sock`);
  if (Buffer.byteLength(socketPath, "utf8") > MAX_SOCKET_PATH_BYTES) {
    throw new BrokerRpcError(
      "CHROME_MCP_BROKER_UNAVAILABLE",
      `Chrome broker socket path exceeds the Unix socket limit: ${socketPath}`,
    );
  }

  return { socketPath, socketRoot };
};

export const brokerMetadataSchema = z
  .object({
    brokerId: z.string().uuid(),
    createdAt: z.iso.datetime(),
    pid: z.number().int().positive(),
    processStartIdentity: z.string().min(1),
    protocolVersion: z.number().int().positive().optional(),
    socketPath: z.string().min(1),
    workspaceHash: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

export type BrokerMetadata = z.infer<typeof brokerMetadataSchema>;

const startupLockSchema = z
  .object({
    createdAt: z.iso.datetime(),
    pid: z.number().int().positive(),
    processStartIdentity: z.string().min(1),
  })
  .strict();

export type BrokerRuntimePaths = Readonly<{
  canonicalWorkspace: string;
  logPath: string;
  metadataPath: string;
  root: string;
  socketRoot: string;
  socketPath: string;
  startupLockPath: string;
  workspaceHash: string;
}>;

const publishOwnerOnlyFileExclusively = async (path: string, contents: string): Promise<boolean> => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, path);
      return true;
    } catch (error: unknown) {
      if (isNodeError(error, "EEXIST")) return false;
      throw error;
    }
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  }
};

export const resolveBrokerRuntimePaths = async (
  workspacePath: string,
  runtimeRoot = getMcpRuntimeDir(),
): Promise<BrokerRuntimePaths> => {
  const workspace = await workspaceIdentity(workspacePath);
  const uid = process.getuid?.() ?? userInfo().uid;
  const root = join(runtimeRoot, "chrome-brokers", `u${uid}`, workspace.hash.slice(0, 32));
  const { socketPath, socketRoot } =
    process.platform === "win32" ?
      { socketPath: resolveWindowsPipePath(runtimeRoot, workspace.hash), socketRoot: root }
    : resolveSocketFileLocation(runtimeRoot, uid, workspace.hash);

  return Object.freeze({
    canonicalWorkspace: workspace.canonicalPath,
    logPath: join(root, BROKER_LOG_FILE),
    metadataPath: join(root, BROKER_METADATA_FILE),
    root,
    socketRoot,
    socketPath,
    startupLockPath: join(root, BROKER_STARTUP_LOCK_FILE),
    workspaceHash: workspace.hash,
  });
};

export const ensureOwnerOnlyBrokerRoot = async (paths: BrokerRuntimePaths): Promise<void> => {
  for (const path of new Set([paths.root, paths.socketRoot])) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new BrokerRpcError(
        "CHROME_MCP_BROKER_UNAVAILABLE",
        "Chrome broker runtime root must be a non-symlink directory",
      );
    }
    const uid = process.getuid?.();
    if (uid !== undefined && status.uid !== uid) {
      throw new BrokerRpcError(
        "CHROME_MCP_BROKER_UNAVAILABLE",
        "Chrome broker runtime root is owned by another user",
      );
    }
    await chmod(path, 0o700);
  }
};

export const readBrokerMetadata = async (path: string): Promise<BrokerMetadata | undefined> => {
  try {
    return brokerMetadataSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return undefined;
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new BrokerRpcError("CHROME_MCP_BROKER_UNAVAILABLE", "Chrome broker metadata is malformed", {
        cause: error,
      });
    }
    throw error;
  }
};

export const writeBrokerMetadata = async (path: string, metadata: BrokerMetadata): Promise<void> => {
  const value = brokerMetadataSchema.parse(metadata);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
};

export const claimBrokerMetadata = async (path: string, metadata: BrokerMetadata): Promise<void> => {
  const value = brokerMetadataSchema.parse(metadata);
  const claimed = await publishOwnerOnlyFileExclusively(path, `${JSON.stringify(value)}\n`);
  if (claimed) return;
  throw new BrokerRpcError(
    "CHROME_MCP_BROKER_UNAVAILABLE",
    "Another Chrome broker child claimed this workspace before socket bind",
  );
};

export type BrokerStartupLock = Readonly<{
  release: () => Promise<void>;
}>;

const readStartupLockOwner = async (path: string): Promise<z.infer<typeof startupLockSchema> | undefined> => {
  try {
    return startupLockSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw new BrokerRpcError("CHROME_MCP_BROKER_UNAVAILABLE", "Chrome broker startup lock is malformed", {
      cause: error,
    });
  }
};

export const tryAcquireBrokerStartupLock = async (path: string): Promise<BrokerStartupLock | undefined> => {
  const processStartIdentity = await currentProcessStartIdentity();
  const contents = `${JSON.stringify({
    createdAt: new Date().toISOString(),
    pid: process.pid,
    processStartIdentity,
  })}\n`;
  const acquired = await publishOwnerOnlyFileExclusively(path, contents);

  if (acquired) {
    return Object.freeze({
      release: async () => {
        await unlink(path).catch((error: unknown) => {
          if (!isNodeError(error, "ENOENT")) throw error;
        });
      },
    });
  }

  const observedOwner = await readStartupLockOwner(path);
  if (!observedOwner) return undefined;
  const observedIdentity = await probeProcessIdentity(observedOwner.pid, observedOwner.processStartIdentity);
  if (observedIdentity === "same" || observedIdentity === "unknown") return undefined;

  const reclamationPath = `${path}.reclaim`;
  const reclamation = await tryAcquireBrokerStartupLock(reclamationPath);
  if (!reclamation) return undefined;
  try {
    const record = await readStartupLockOwner(path);
    if (!record) return undefined;
    const identity = await probeProcessIdentity(record.pid, record.processStartIdentity);
    if (identity === "same" || identity === "unknown") return undefined;
    await unlink(path).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
    const reclaimed = await publishOwnerOnlyFileExclusively(path, contents);
    if (!reclaimed) return undefined;
    return Object.freeze({
      release: async () => {
        await unlink(path).catch((error: unknown) => {
          if (!isNodeError(error, "ENOENT")) throw error;
        });
      },
    });
  } finally {
    await reclamation.release();
  }
};

export const removeBrokerRuntimeFiles = async (paths: BrokerRuntimePaths): Promise<void> => {
  const filePaths =
    isBrokerSocketFile(paths.socketPath) ? [paths.metadataPath, paths.socketPath] : [paths.metadataPath];

  await Promise.all(
    filePaths.map((path) =>
      unlink(path).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      }),
    ),
  );
};
