import { expect, test } from "bun:test";
import { currentProcessStartIdentity, probeProcessIdentity } from "./process-identity";

test("identifies a live process exactly and observes its exit", async () => {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, "-e", "await Bun.stdin.text()"],
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });

  try {
    const identity = await currentProcessStartIdentity(subprocess.pid);
    expect(identity.startsWith(`${process.platform}:`)).toBe(true);
    expect(await probeProcessIdentity(subprocess.pid, identity)).toBe("same");
    expect(await probeProcessIdentity(subprocess.pid, `${identity}-another-process`)).toBe("different");

    subprocess.stdin.end();
    expect(await subprocess.exited).toBe(0);
    expect(await probeProcessIdentity(subprocess.pid, identity)).toBe("absent");
  } finally {
    subprocess.kill();
    await subprocess.exited;
  }
});
