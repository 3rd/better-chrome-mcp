import type { BrokerMetadata } from "./paths";
import { snapshotDarwinProcesses } from "../../platform/darwin/process-identity";
import { snapshotLinuxProcesses } from "../../platform/linux/process-identity";
import { isNodeError } from "../../platform/node-errors";
import { snapshotWindowsProcesses } from "../../platform/windows/process-identity";
import { probeProcessIdentity } from "../runtime";

type ProcessRecord = Readonly<{
  pid: number;
  ppid: number;
  processStartIdentity: string;
}>;

export type BrokerRetirementOptions = Readonly<{
  gracefulTimeoutMs?: number;
  timeoutMs?: number;
}>;

const snapshotDescendants = async (ownerPid: number): Promise<ProcessRecord[]> => {
  let records: readonly ProcessRecord[];

  if (process.platform === "darwin") {
    records = await snapshotDarwinProcesses();
  } else if (process.platform === "win32") {
    records = await snapshotWindowsProcesses();
  } else if (process.platform === "linux") {
    records = await snapshotLinuxProcesses();
  } else {
    return [];
  }

  const descendants: ProcessRecord[] = [];
  const ownerPids = new Set([ownerPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (ownerPids.has(record.pid) || !ownerPids.has(record.ppid)) continue;
      ownerPids.add(record.pid);
      descendants.push(record);
      changed = true;
    }
  }
  return descendants;
};

const signalExactProcess = async (
  pid: number,
  processStartIdentity: string,
  signal: "SIGKILL" | "SIGTERM",
): Promise<boolean> => {
  if ((await probeProcessIdentity(pid, processStartIdentity)) !== "same") return false;
  try {
    process.kill(pid, signal);
  } catch (error: unknown) {
    if (!isNodeError(error, "ESRCH")) throw error;
  }
  return true;
};

const waitForExit = async (
  pid: number,
  processStartIdentity: string,
  deadlineMs: number,
): Promise<boolean> => {
  while (Date.now() < deadlineMs) {
    if ((await probeProcessIdentity(pid, processStartIdentity)) !== "same") return true;
    await Bun.sleep(Math.min(25, Math.max(0, deadlineMs - Date.now())));
  }
  return (await probeProcessIdentity(pid, processStartIdentity)) !== "same";
};

export const retireChromeBroker = async (
  metadata: BrokerMetadata,
  options: BrokerRetirementOptions = {},
): Promise<boolean> => {
  if (metadata.pid === process.pid) throw new Error("Chrome broker cannot retire its own process");
  const identity = await probeProcessIdentity(metadata.pid, metadata.processStartIdentity);
  if (identity === "unknown") {
    throw new Error(`Cannot verify Chrome broker PID ${metadata.pid} before retirement`);
  }
  if (identity !== "same") return false;

  const descendants = await snapshotDescendants(metadata.pid);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadlineMs = Date.now() + timeoutMs;
  const gracefulDeadlineMs = Math.min(deadlineMs, Date.now() + (options.gracefulTimeoutMs ?? 5000));
  await signalExactProcess(metadata.pid, metadata.processStartIdentity, "SIGTERM");
  if (!(await waitForExit(metadata.pid, metadata.processStartIdentity, gracefulDeadlineMs))) {
    await signalExactProcess(metadata.pid, metadata.processStartIdentity, "SIGKILL");
  }
  if (!(await waitForExit(metadata.pid, metadata.processStartIdentity, deadlineMs))) {
    throw new Error(`Chrome broker PID ${metadata.pid} did not exit within ${timeoutMs}ms`);
  }

  for (const descendant of descendants) {
    await signalExactProcess(descendant.pid, descendant.processStartIdentity, "SIGTERM");
  }
  const descendantGraceDeadlineMs = Math.min(deadlineMs, Date.now() + 500);
  for (const descendant of descendants) {
    await waitForExit(descendant.pid, descendant.processStartIdentity, descendantGraceDeadlineMs);
  }
  for (const descendant of descendants) {
    await signalExactProcess(descendant.pid, descendant.processStartIdentity, "SIGKILL");
  }
  for (const descendant of descendants) {
    if (!(await waitForExit(descendant.pid, descendant.processStartIdentity, deadlineMs))) {
      throw new Error(`Chrome broker descendant PID ${descendant.pid} did not exit within ${timeoutMs}ms`);
    }
  }
  return true;
};
