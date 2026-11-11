const DARWIN_BSD_INFO_BYTES = 136;
const DARWIN_BSD_INFO_FLAVOR = 3;
const DARWIN_ZOMBIE_STATUS = 5;

const openDarwinProcessLibrary = async () => {
  const { dlopen } = await import("bun:ffi");

  return dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: {
      args: ["i32", "i32", "u64", "buffer", "i32"],
      returns: "i32",
    },
    proc_listallpids: {
      args: ["ptr", "i32"],
      returns: "i32",
    },
  });
};

type DarwinProcessLibrary = Awaited<ReturnType<typeof openDarwinProcessLibrary>>;

export const parseDarwinProcessInfo = (buffer: ArrayBuffer, expectedPid: number) => {
  if (buffer.byteLength !== DARWIN_BSD_INFO_BYTES) {
    throw new Error("macOS returned an unexpected process information size");
  }

  const info = new DataView(buffer);
  const pid = info.getUint32(12, true);
  const startSeconds = info.getBigUint64(120, true);
  const startMicroseconds = info.getBigUint64(128, true);
  const hasInvalidIdentity = pid !== expectedPid || startSeconds === 0n || startMicroseconds >= 1_000_000n;
  if (hasInvalidIdentity) {
    throw new Error("macOS returned invalid process identity information");
  }

  return Object.freeze({
    isZombie: info.getUint32(4, true) === DARWIN_ZOMBIE_STATUS,
    pid,
    ppid: info.getUint32(16, true),
    processStartIdentity: `darwin:${startSeconds}:${startMicroseconds}`,
  });
};

const readProcessInfo = (library: DarwinProcessLibrary, pid: number) => {
  const buffer = new BigUint64Array(DARWIN_BSD_INFO_BYTES / BigUint64Array.BYTES_PER_ELEMENT);

  const bytesRead = library.symbols.proc_pidinfo(pid, DARWIN_BSD_INFO_FLAVOR, 0n, buffer, buffer.byteLength);
  if (bytesRead === 0) return undefined;
  if (bytesRead !== buffer.byteLength) {
    throw new Error("macOS returned incomplete process identity information");
  }

  return parseDarwinProcessInfo(buffer.buffer, pid);
};

export const readDarwinProcessIdentity = async (pid: number) => {
  const isProcessId = Number.isInteger(pid) && pid > 0 && pid <= 2_147_483_647;
  if (!isProcessId) return undefined;

  const library = await openDarwinProcessLibrary();

  try {
    return readProcessInfo(library, pid);
  } finally {
    library.close();
  }
};

export const snapshotDarwinProcesses = async () => {
  const library = await openDarwinProcessLibrary();

  try {
    let capacity = library.symbols.proc_listallpids(null, 0);
    if (capacity <= 0) {
      throw new Error("macOS could not enumerate running processes");
    }

    for (;;) {
      const pids = new Int32Array(capacity);

      const count = library.symbols.proc_listallpids(pids, pids.byteLength);
      const hasInvalidProcessCount = count <= 0 || count > capacity;
      if (hasInvalidProcessCount) {
        throw new Error("macOS returned an invalid process list");
      }
      if (count === capacity) {
        capacity *= 2;
        continue;
      }

      return Array.from(pids.subarray(0, count))
        .filter((pid) => pid > 0)
        .flatMap((pid) => {
          const record = readProcessInfo(library, pid);
          if (!record) return [];
          if (record.isZombie) return [];

          return [record];
        });
    }
  } finally {
    library.close();
  }
};
