import { open } from "node:fs/promises";
import { holdLockUntilStdinCloses } from "../profile-lock-child-protocol";

const LOCK_EXCLUSIVE = 2;

const holdProfileLock = async (path: string) => {
  const { dlopen } = await import("bun:ffi");
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    flock: { args: ["i32", "i32"], returns: "i32" },
  });

  try {
    const handle = await open(path, "a", 0o600);

    try {
      if (library.symbols.flock(handle.fd, LOCK_EXCLUSIVE) !== 0) {
        throw new Error("macOS could not acquire the exclusive Chrome profile lock");
      }

      await holdLockUntilStdinCloses();
    } finally {
      await handle.close();
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
