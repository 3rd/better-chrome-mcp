import { randomUUID } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { isNodeError } from "../../platform/node-errors";
import { currentProcessStartIdentity } from "../runtime";
import { createChromeBrokerBackend } from "./backend";
import { cleanupBrokerChild, createBrokerChildTermination } from "./child-shutdown";
import {
  BROKER_CHILD_EXECUTABLE_ENV,
  BROKER_CHILD_RUNTIME_ENV,
  BROKER_CHILD_WORKSPACE_ENV,
  BROKER_PROTOCOL_VERSION,
  BROKER_SHUTDOWN_RETRY_MS,
  BROKER_SHUTDOWN_TIMEOUT_MS,
} from "./constants";
import {
  claimBrokerMetadata,
  ensureOwnerOnlyBrokerRoot,
  readBrokerMetadata,
  resolveBrokerRuntimePaths,
} from "./paths";
import { type BrokerRpcServer, startBrokerRpcServer } from "./server";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Chrome broker child requires ${name}`);
  return value;
};

const workspacePath = requiredEnvironment(BROKER_CHILD_WORKSPACE_ENV);
const executablePath = requiredEnvironment(BROKER_CHILD_EXECUTABLE_ENV);
const runtimeRoot = process.env[BROKER_CHILD_RUNTIME_ENV] || undefined;
const paths = await resolveBrokerRuntimePaths(workspacePath, runtimeRoot);
await ensureOwnerOnlyBrokerRoot(paths);

const existing = await readBrokerMetadata(paths.metadataPath);
if (existing) {
  throw new Error("Chrome broker owner metadata already exists; a second child cannot bind");
}

const brokerId = randomUUID();
const processStartIdentity = await currentProcessStartIdentity();
await claimBrokerMetadata(paths.metadataPath, {
  brokerId,
  createdAt: new Date().toISOString(),
  pid: process.pid,
  processStartIdentity,
  protocolVersion: BROKER_PROTOCOL_VERSION,
  socketPath: paths.socketPath,
  workspaceHash: paths.workspaceHash,
});

const removeOwnedMetadata = async (): Promise<void> => {
  const metadata = await readBrokerMetadata(paths.metadataPath);
  if (metadata?.brokerId !== brokerId) return;
  await unlink(paths.metadataPath).catch((error: unknown) => {
    if (!isNodeError(error, "ENOENT")) throw error;
  });
};

const backend = await createChromeBrokerBackend({
  executablePath,
  runtimeRoot,
  workspacePath: paths.canonicalWorkspace,
}).catch(async (error: unknown) => {
  await removeOwnedMetadata();
  throw error;
});
let server: BrokerRpcServer | undefined;
const cleanupOptions = {
  cleanupMetadata: removeOwnedMetadata,
  cleanupServer: async (reason: string) => {
    if (server) await server.shutdown(reason);
    else await backend.close();
  },
  onRetry: (error: unknown) => {
    console.error(
      `Chrome broker shutdown cleanup will retry: ${error instanceof Error ? error.message : String(error)}`,
    );
  },
  waitBeforeRetry: () => {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, BROKER_SHUTDOWN_RETRY_MS);
    });
  },
};
const termination = createBrokerChildTermination({
  ...cleanupOptions,
  exit: (code) => process.exit(code),
  timeoutMs: BROKER_SHUTDOWN_TIMEOUT_MS,
});

const stopOnSignal = (signal: string): void => termination.request(signal, "graceful");

process.on("SIGINT", () => stopOnSignal("SIGINT"));
process.on("SIGTERM", () => stopOnSignal("SIGTERM"));
process.on("SIGHUP", () => stopOnSignal("SIGHUP"));

try {
  server = await startBrokerRpcServer({
    backend,
    brokerId,
    onIdle: () => {
      termination.request("final client cleanup completed", "graceful");
    },
    paths,
    processStartIdentity,
  });
  await chmod(paths.metadataPath, 0o600);
} catch (error: unknown) {
  await cleanupBrokerChild(cleanupOptions, "startup failure").catch(() => undefined);
  throw error;
}

process.on("uncaughtException", (error) => {
  termination.request(`uncaughtException: ${error.message}`, "fatal");
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : "unknown rejection";
  termination.request(`unhandledRejection: ${message}`, "fatal");
});
