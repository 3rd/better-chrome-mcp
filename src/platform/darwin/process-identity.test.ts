import { expect, test } from "bun:test";
import { parseDarwinProcessInfo, snapshotDarwinProcesses } from "./process-identity";

test("decodes the macOS process start microseconds, parent, and zombie status", () => {
  const buffer = new ArrayBuffer(136);
  const info = new DataView(buffer);
  info.setUint32(4, 2, true);
  info.setUint32(12, 42, true);
  info.setUint32(16, 11, true);
  info.setBigUint64(120, 1_234_567n, true);
  info.setBigUint64(128, 987_654n, true);

  expect(parseDarwinProcessInfo(buffer, 42)).toEqual({
    isZombie: false,
    pid: 42,
    ppid: 11,
    processStartIdentity: "darwin:1234567:987654",
  });

  info.setUint32(4, 5, true);
  expect(parseDarwinProcessInfo(buffer, 42).isZombie).toBe(true);
});

test("rejects incomplete macOS process records and mismatched process identities", () => {
  expect(() => parseDarwinProcessInfo(new ArrayBuffer(128), 42)).toThrow(
    "unexpected process information size",
  );

  const buffer = new ArrayBuffer(136);
  const info = new DataView(buffer);
  info.setUint32(12, 43, true);
  info.setBigUint64(120, 1_234_567n, true);
  expect(() => parseDarwinProcessInfo(buffer, 42)).toThrow("invalid process identity information");
});

test.skipIf(process.platform !== "darwin")(
  "includes this process with its real parent in the macOS snapshot",
  async () => {
    const records = await snapshotDarwinProcesses();
    expect(records).toContainEqual({
      isZombie: false,
      pid: process.pid,
      ppid: process.ppid,
      processStartIdentity: expect.stringMatching(/^darwin:\d+:\d+$/),
    });
  },
);
