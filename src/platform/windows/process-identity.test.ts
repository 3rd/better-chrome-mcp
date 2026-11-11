import { expect, test } from "bun:test";
import { linkWindowsProcesses, parseWindowsProcessEntry, snapshotWindowsProcesses } from "./process-identity";

test("decodes the process and parent IDs from a Windows process entry", () => {
  const buffer = new ArrayBuffer(568);
  const entry = new DataView(buffer);
  entry.setUint32(0, 568, true);
  entry.setUint32(8, 4242, true);
  entry.setUint32(28, 9, true);
  entry.setUint32(32, 1111, true);

  expect(parseWindowsProcessEntry(buffer)).toEqual({ pid: 4242, ppid: 1111 });
});

test("keeps a parent that started before its child and drops one that reused the parent's ID later", () => {
  const entries = [
    { pid: 100, ppid: 4 },
    { pid: 200, ppid: 100 },
    { pid: 300, ppid: 100 },
    { pid: 400, ppid: 999 },
  ];
  const startTimesByPid = new Map([
    [100, 5000n],
    [200, 6000n],
    [300, 4000n],
    [400, 7000n],
  ]);

  expect(linkWindowsProcesses(entries, startTimesByPid)).toEqual([
    { pid: 100, ppid: 0, processStartIdentity: "win32:5000" },
    { pid: 200, ppid: 100, processStartIdentity: "win32:6000" },
    { pid: 300, ppid: 0, processStartIdentity: "win32:4000" },
    { pid: 400, ppid: 0, processStartIdentity: "win32:7000" },
  ]);
});

test("leaves out processes whose start time could not be read", () => {
  expect(
    linkWindowsProcesses(
      [
        { pid: 100, ppid: 4 },
        { pid: 200, ppid: 100 },
      ],
      new Map([[200, 6000n]]),
    ),
  ).toEqual([{ pid: 200, ppid: 0, processStartIdentity: "win32:6000" }]);
});

test.skipIf(process.platform !== "win32")(
  "includes this process with its real parent in the Windows snapshot",
  async () => {
    const records = await snapshotWindowsProcesses();

    expect(records).toContainEqual({
      pid: process.pid,
      ppid: process.ppid,
      processStartIdentity: expect.stringMatching(/^win32:\d+$/),
    });
  },
);
