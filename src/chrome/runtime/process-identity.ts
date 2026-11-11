import { readDarwinProcessIdentity } from "../../platform/darwin/process-identity";
import { readLinuxProcessIdentity } from "../../platform/linux/process-identity";
import { isNodeError } from "../../platform/node-errors";
import {
  readWindowsProcessState,
  windowsProcessStartIdentity,
  type WindowsProcessState,
} from "../../platform/windows/process-identity";
import { ChromeRuntimeError } from "./errors";

export type ProcessIdentityState = "absent" | "different" | "same" | "unknown";
export type ProcessIdentityProbe = (pid: number, expected: string) => Promise<ProcessIdentityState>;

export const currentProcessStartIdentity = async (pid = process.pid) => {
  if (process.platform === "darwin") {
    try {
      const identity = await readDarwinProcessIdentity(pid);
      const hasActiveIdentity = identity !== undefined && !identity.isZombie;
      if (hasActiveIdentity) return identity.processStartIdentity;
    } catch (error: unknown) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_PROFILE_IN_USE",
        "macOS native process identity is unavailable",
        { cause: error },
      );
    }
  }

  if (process.platform === "win32") {
    try {
      const windowsProcess = await readWindowsProcessState(pid);
      if (windowsProcess.state === "running") return windowsProcessStartIdentity(windowsProcess.startTime);
    } catch (error: unknown) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_PROFILE_IN_USE",
        "Windows native process identity is unavailable",
        { cause: error },
      );
    }
  }

  if (process.platform === "linux") {
    const identity = await readLinuxProcessIdentity(pid);
    const hasActiveIdentity = identity !== undefined && !identity.isZombie;
    if (hasActiveIdentity) return identity.processStartIdentity;
  }

  const hasNativeIdentitySource = process.platform === "darwin" || process.platform === "win32";
  const requiresExactIdentity = pid !== process.pid || hasNativeIdentitySource;
  if (requiresExactIdentity) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_PROFILE_IN_USE",
      `Cannot establish an exact process-start identity for PID ${pid} on ${process.platform}`,
    );
  }

  return `${process.platform}:${pid}:${Math.round(Date.now() - process.uptime() * 1000)}`;
};

const windowsProcessIdentityState = (windowsProcess: WindowsProcessState, expected: string) => {
  switch (windowsProcess.state) {
    case "absent": {
      return "absent";
    }
    case "exited": {
      return "different";
    }
    case "inaccessible": {
      return "unknown";
    }
    case "running": {
      if (windowsProcessStartIdentity(windowsProcess.startTime) === expected) return "same";

      return "different";
    }
    default: {
      return windowsProcess satisfies never;
    }
  }
};

export const probeProcessIdentity: ProcessIdentityProbe = async (pid, expected) => {
  if (process.platform === "win32") {
    return windowsProcessIdentityState(await readWindowsProcessState(pid), expected);
  }

  if (process.platform === "darwin") {
    const darwinIdentity = await readDarwinProcessIdentity(pid);
    if (darwinIdentity) {
      if (darwinIdentity.isZombie) return "different";
      if (darwinIdentity.processStartIdentity === expected) return "same";
      return "different";
    }
  }

  if (process.platform === "linux") {
    const linuxIdentity = await readLinuxProcessIdentity(pid);
    if (!linuxIdentity) return "absent";
    if (linuxIdentity.isZombie) return "different";
    if (linuxIdentity.processStartIdentity === expected) return "same";

    return "different";
  }

  try {
    process.kill(pid, 0);

    return "unknown";
  } catch (error: unknown) {
    if (isNodeError(error, "ESRCH")) return "absent";
    return "unknown";
  }
};
