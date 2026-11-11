// `withFlockProfileLeaseGuard` writes a marker to this process's stdin, treats the marker coming back
// on stdout as proof that the lock is held, and closes stdin to release the lock. Echoing before the
// lock is held would let two brokers change one profile lease at the same time.
export const holdLockUntilStdinCloses = async () => {
  for await (const chunk of Bun.stdin.stream()) {
    await Bun.write(Bun.stdout, chunk);
  }
};
