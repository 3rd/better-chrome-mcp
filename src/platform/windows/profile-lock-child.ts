import { holdLockUntilStdinCloses } from "../profile-lock-child-protocol";

const GENERIC_READ_AND_WRITE = 0xC0_00_00_00;
const SHARE_READ_WRITE_AND_DELETE = 0x7;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const LOCKFILE_EXCLUSIVE_LOCK = 0x2;
const OVERLAPPED_BYTES = 32;
const INVALID_HANDLE_VALUE = 0xFF_FF_FF_FF_FF_FF_FF_FFn;

const holdProfileLock = async (path: string) => {
  const { dlopen } = await import("bun:ffi");
  const library = dlopen("kernel32.dll", {
    CloseHandle: { args: ["u64"], returns: "i32" },
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    LockFileEx: { args: ["u64", "u32", "u32", "u32", "u32", "ptr"], returns: "i32" },
  });

  try {
    const handle = library.symbols.CreateFileW(
      Buffer.from(`${path}\0`, "utf16le"),
      GENERIC_READ_AND_WRITE,
      SHARE_READ_WRITE_AND_DELETE,
      null,
      OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
      0n,
    );
    if (handle === INVALID_HANDLE_VALUE) {
      throw new Error("Windows could not open the Chrome profile lock file");
    }

    try {
      const firstByteRange = new BigUint64Array(OVERLAPPED_BYTES / BigUint64Array.BYTES_PER_ELEMENT);

      if (library.symbols.LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, firstByteRange) === 0) {
        throw new Error("Windows could not acquire the exclusive Chrome profile lock");
      }

      await holdLockUntilStdinCloses();
    } finally {
      library.symbols.CloseHandle(handle);
    }
  } finally {
    library.close();
  }
};

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    throw new Error("The Chrome profile lock requires a file path");
  }

  await holdProfileLock(path);
}
