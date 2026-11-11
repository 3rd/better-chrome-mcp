import { readdir, readFile } from "node:fs/promises";
import { isNodeError } from "../node-errors";

const STATE_FIELD_INDEX = 0;
const PARENT_PID_FIELD_INDEX = 1;
const START_TICKS_FIELD_INDEX = 19;

export const parseLinuxProcessStat = (stat: string, pid: number) => {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return undefined;

  const fields = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);

  const state = fields[STATE_FIELD_INDEX];
  if (!state) return undefined;

  const startTicks = fields[START_TICKS_FIELD_INDEX];
  if (!startTicks) return undefined;

  return Object.freeze({
    isZombie: state === "Z",
    pid,
    ppid: Number(fields[PARENT_PID_FIELD_INDEX]),
    processStartIdentity: `linux:${startTicks}`,
  });
};

export const readLinuxProcessIdentity = async (pid: number) => {
  let stat: string;

  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error: unknown) {
    const isProcessAbsent = isNodeError(error, "ENOENT") || isNodeError(error, "ESRCH");
    if (isProcessAbsent) return undefined;

    throw error;
  }

  return parseLinuxProcessStat(stat, pid);
};

export const snapshotLinuxProcesses = async () => {
  const entryNames = await readdir("/proc").catch(() => []);
  const processIds = entryNames.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  const records = await Promise.all(
    processIds.map(async (pid) => readLinuxProcessIdentity(pid).catch(() => undefined)),
  );

  return records.flatMap((record) => {
    if (!record) return [];
    if (record.isZombie) return [];
    if (!Number.isInteger(record.ppid)) return [];

    return [record];
  });
};
