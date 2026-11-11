const PROCESS_ENTRY_BYTES = 568;
const PROCESS_ENTRY_PID_OFFSET = 8;
const PROCESS_ENTRY_PARENT_PID_OFFSET = 32;
const SNAPSHOT_ALL_PROCESSES = 0x2;
const QUERY_LIMITED_INFORMATION_AND_SYNCHRONIZE = 0x00_10_10_00;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x1_02;
const ERROR_ACCESS_DENIED = 5;
const INVALID_HANDLE_VALUE = 0xFF_FF_FF_FF_FF_FF_FF_FFn;

const openWindowsProcessLibrary = async () => {
  const { dlopen } = await import("bun:ffi");

  return dlopen("kernel32.dll", {
    CloseHandle: { args: ["u64"], returns: "i32" },
    CreateToolhelp32Snapshot: { args: ["u32", "u32"], returns: "u64" },
    GetLastError: { args: [], returns: "u32" },
    GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    Process32FirstW: { args: ["u64", "ptr"], returns: "i32" },
    Process32NextW: { args: ["u64", "ptr"], returns: "i32" },
    WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
  });
};

type WindowsProcessLibrary = Awaited<ReturnType<typeof openWindowsProcessLibrary>>;

type WindowsProcessEntry = Readonly<{
  pid: number;
  ppid: number;
}>;

export type WindowsProcessState =
  | Readonly<{ startTime: bigint; state: "running" }>
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "exited" }>
  | Readonly<{ state: "inaccessible" }>;

export const windowsProcessStartIdentity = (startTime: bigint) => `win32:${startTime}`;

export const parseWindowsProcessEntry = (buffer: ArrayBuffer) => {
  const entry = new DataView(buffer);

  return Object.freeze({
    pid: entry.getUint32(PROCESS_ENTRY_PID_OFFSET, true),
    ppid: entry.getUint32(PROCESS_ENTRY_PARENT_PID_OFFSET, true),
  });
};

// Windows never updates the parent ID recorded for a process. After the parent exits, that ID can be
// reused by an unrelated process, which then looks like the parent. A real parent always started
// before its child, so a "parent" that started later is dropped. Without this check, retiring a
// broker could terminate processes the broker never started.
export const linkWindowsProcesses = (
  entries: readonly WindowsProcessEntry[],
  startTimesByPid: ReadonlyMap<number, bigint>,
) => {
  return entries.flatMap(({ pid, ppid }) => {
    const startTime = startTimesByPid.get(pid);
    if (startTime === undefined) return [];

    const parentStartTime = startTimesByPid.get(ppid);
    const hasRunningParent = parentStartTime !== undefined && parentStartTime <= startTime;

    return [
      Object.freeze({
        pid,
        ppid: hasRunningParent ? ppid : 0,
        processStartIdentity: windowsProcessStartIdentity(startTime),
      }),
    ];
  });
};

const readProcessState = (library: WindowsProcessLibrary, pid: number): WindowsProcessState => {
  const handle = library.symbols.OpenProcess(QUERY_LIMITED_INFORMATION_AND_SYNCHRONIZE, 0, pid);
  if (handle === 0n) {
    const getLastError = library.symbols.GetLastError;
    const isAccessDenied = getLastError() === ERROR_ACCESS_DENIED;
    if (isAccessDenied) return { state: "inaccessible" };

    return { state: "absent" };
  }

  try {
    const waitResult = library.symbols.WaitForSingleObject(handle, 0);
    if (waitResult === WAIT_OBJECT_0) return { state: "exited" };
    if (waitResult !== WAIT_TIMEOUT) return { state: "inaccessible" };

    const creationTime = new BigUint64Array(1);
    const exitTime = new BigUint64Array(1);
    const kernelTime = new BigUint64Array(1);
    const userTime = new BigUint64Array(1);

    const hasReadTimes =
      library.symbols.GetProcessTimes(handle, creationTime, exitTime, kernelTime, userTime) !== 0;
    const startTime = creationTime[0];
    const hasStartTime = hasReadTimes && startTime !== undefined && startTime !== 0n;
    if (!hasStartTime) return { state: "inaccessible" };

    return { startTime, state: "running" };
  } finally {
    library.symbols.CloseHandle(handle);
  }
};

const listProcessEntries = (library: WindowsProcessLibrary) => {
  const snapshot = library.symbols.CreateToolhelp32Snapshot(SNAPSHOT_ALL_PROCESSES, 0);
  if (snapshot === INVALID_HANDLE_VALUE) {
    throw new Error("Windows could not enumerate running processes");
  }

  try {
    const entry = new BigUint64Array(PROCESS_ENTRY_BYTES / BigUint64Array.BYTES_PER_ELEMENT);
    new DataView(entry.buffer).setUint32(0, PROCESS_ENTRY_BYTES, true);
    const entries: WindowsProcessEntry[] = [];

    let hasEntry = library.symbols.Process32FirstW(snapshot, entry) !== 0;

    while (hasEntry) {
      entries.push(parseWindowsProcessEntry(entry.buffer));
      hasEntry = library.symbols.Process32NextW(snapshot, entry) !== 0;
    }

    return entries;
  } finally {
    library.symbols.CloseHandle(snapshot);
  }
};

export const readWindowsProcessState = async (pid: number): Promise<WindowsProcessState> => {
  const isProcessId = Number.isInteger(pid) && pid > 0 && pid <= 0xFF_FF_FF_FF;
  if (!isProcessId) return { state: "absent" };

  const library = await openWindowsProcessLibrary();

  try {
    return readProcessState(library, pid);
  } finally {
    library.close();
  }
};

export const snapshotWindowsProcesses = async () => {
  const library = await openWindowsProcessLibrary();

  try {
    const entries = listProcessEntries(library);
    const startTimesByPid = new Map<number, bigint>();

    for (const { pid } of entries) {
      const process = readProcessState(library, pid);
      if (process.state !== "running") continue;

      startTimesByPid.set(pid, process.startTime);
    }

    return linkWindowsProcesses(entries, startTimesByPid);
  } finally {
    library.close();
  }
};
