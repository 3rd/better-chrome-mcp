import { createHash } from "node:crypto";
import { join } from "node:path";
import { findMcpInstanceId, getMcpRuntimeDir } from "../../platform/runtime-paths";

const INSTANCES_DIRECTORY_NAME = "instances";
const INSTANCE_SCOPE_HEX_LENGTH = 24;
const INSTANCE_SCOPE_PATTERN = new RegExp(`^[0-9a-f]{${INSTANCE_SCOPE_HEX_LENGTH}}$`);

const instanceScope = (instanceId: string) => {
  return createHash("sha256").update(instanceId).digest("hex").slice(0, INSTANCE_SCOPE_HEX_LENGTH);
};

export const isArtifactInstanceScope = (directoryName: string) => INSTANCE_SCOPE_PATTERN.test(directoryName);

export const resolveArtifactRoot = (runtimeRoot = getMcpRuntimeDir()): string =>
  join(runtimeRoot, "chrome-mcp", "chrome-artifacts");

export const resolveArtifactInstancesRoot = (root: string) => join(root, INSTANCES_DIRECTORY_NAME);

export const resolveArtifactInstanceRoot = (
  root: string,
  instanceId: string | undefined,
  ownerId: string,
): string => {
  const daemonInstance = instanceId ?? findMcpInstanceId() ?? `standalone-${process.pid}`;
  return join(resolveArtifactInstancesRoot(root), instanceScope(`${daemonInstance}\0${ownerId}`));
};
