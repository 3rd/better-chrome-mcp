import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProfileLease,
  type ProfileLeaseRecord,
  profilePathHash,
  withFlockProfileLeaseGuard,
} from "./profile-lease";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const leaseFixture = async (): Promise<{ leasePath: string; profilePath: string }> => {
  const directory = await mkdtemp(join(tmpdir(), "chrome-profile-lease-"));
  temporaryDirectories.push(directory);
  return { leasePath: join(directory, "profile.lease.json"), profilePath: join(directory, "profile") };
};

describe("ProfileLease", () => {
  test("releases the kernel profile guard when its owning process crashes", async () => {
    const fixture = await leaseFixture();
    const guardPath = `${fixture.leasePath}.guard`;
    const subprocess = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `
        import { withFlockProfileLeaseGuard } from ${JSON.stringify(`${import.meta.dir}/profile-lease.ts`)};
        await withFlockProfileLeaseGuard(process.argv[1], async () => {
          await Bun.write(Bun.stdout, "held\\n");
          await Bun.stdin.text();
        });
      `,
        guardPath,
      ],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const reader = subprocess.stdout.getReader();
      const marker = await reader.read();
      reader.releaseLock();
      expect(marker.done).toBe(false);
      expect(new TextDecoder().decode(marker.value)).toBe("held\n");

      subprocess.kill("SIGKILL");
      await subprocess.exited;

      const value = await withFlockProfileLeaseGuard(guardPath, async () => "reclaimed");
      expect(value).toBe("reclaimed");
    } finally {
      subprocess.kill();
      await subprocess.exited;
    }
  });

  test("records exact owner identity, refreshes atomically, and releases only its lease", async () => {
    const fixture = await leaseFixture();
    let now = 1000;
    let guardedOperations = 0;
    const lease = await ProfileLease.acquire(fixture.leasePath, fixture.profilePath, {
      brokerId: "broker-a",
      guard: async (path, operation) => {
        guardedOperations++;
        return withFlockProfileLeaseGuard(path, operation);
      },
      now: () => now,
      pid: 10,
      processStartIdentity: "linux:100",
      refreshMs: 60_000,
    });
    const initial = JSON.parse(await readFile(fixture.leasePath, "utf8"));
    expect(initial).toMatchObject({
      brokerId: "broker-a",
      pid: 10,
      processStartIdentity: "linux:100",
      profilePathHash: profilePathHash(fixture.profilePath),
    });
    expect("version" in initial).toBe(false);
    now = 12_000;
    await lease.refresh();
    const refreshed = JSON.parse(await readFile(fixture.leasePath, "utf8"));
    expect(Date.parse(refreshed.lastRefresh)).toBe(12_000);
    await lease.release();
    expect(Bun.file(fixture.leasePath).exists()).resolves.toBe(false);
    expect(guardedOperations).toBe(3);
  });

  test("rejects a live owner and a conservatively fresh absent owner", async () => {
    const fixture = await leaseFixture();
    const first = await ProfileLease.acquire(fixture.leasePath, fixture.profilePath, {
      brokerId: "broker-live",
      now: () => 10_000,
      pid: 10,
      processStartIdentity: "linux:100",
      refreshMs: 60_000,
    });
    expect(
      ProfileLease.acquire(fixture.leasePath, fixture.profilePath, {
        brokerId: "broker-contender",
        now: () => 100_000,
        pid: 11,
        processIdentity: async () => "same",
        processStartIdentity: "linux:200",
      }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_PROFILE_IN_USE" });
    expect(
      ProfileLease.acquire(fixture.leasePath, fixture.profilePath, {
        brokerId: "broker-contender",
        now: () => 20_000,
        pid: 11,
        processIdentity: async () => "absent",
        processStartIdentity: "linux:200",
      }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_PROFILE_IN_USE" });
    await first.release();
  });

  test("reclaims only an old lease whose exact owner identity is absent", async () => {
    const fixture = await leaseFixture();
    const stale: ProfileLeaseRecord = {
      brokerId: "dead-broker",
      createdAt: new Date(1000).toISOString(),
      lastRefresh: new Date(10_000).toISOString(),
      pid: 10,
      processStartIdentity: "linux:100",
      profilePathHash: profilePathHash(fixture.profilePath),
    };
    await writeFile(fixture.leasePath, JSON.stringify(stale), { mode: 0o600 });
    const lease = await ProfileLease.acquire(fixture.leasePath, fixture.profilePath, {
      brokerId: "new-broker",
      now: () => 40_001,
      pid: 11,
      processIdentity: async () => "different",
      processStartIdentity: "linux:200",
      refreshMs: 60_000,
    });
    expect(JSON.parse(await readFile(fixture.leasePath, "utf8"))).toMatchObject({
      brokerId: "new-broker",
      processStartIdentity: "linux:200",
    });
    await lease.release();
  });

  test("rejects unrelated lease fields", async () => {
    const fixture = await leaseFixture();
    await writeFile(
      fixture.leasePath,
      JSON.stringify({
        brokerId: "old-broker",
        createdAt: new Date(1000).toISOString(),
        lastRefresh: new Date(1000).toISOString(),
        pid: 10,
        processStartIdentity: "linux:100",
        profilePathHash: profilePathHash(fixture.profilePath),
        extra: true,
      }),
    );
    expect(
      ProfileLease.acquire(fixture.leasePath, fixture.profilePath, {
        brokerId: "new-broker",
        now: () => 100_000,
        pid: 11,
        processIdentity: async () => "absent",
        processStartIdentity: "linux:200",
      }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_PROFILE_IN_USE" });
  });

  test("rejects refresh or release of a lease replaced by another owner", async () => {
    const fixture = await leaseFixture();
    const lease = await ProfileLease.acquire(fixture.leasePath, fixture.profilePath, {
      brokerId: "broker-a",
      now: () => 1000,
      pid: 10,
      processStartIdentity: "linux:100",
      refreshMs: 60_000,
    });
    const replacement: ProfileLeaseRecord = {
      ...lease.record,
      brokerId: "broker-b",
      processStartIdentity: "linux:200",
    };
    await writeFile(fixture.leasePath, JSON.stringify(replacement));
    expect(lease.refresh()).rejects.toMatchObject({ code: "CHROME_MCP_PROFILE_LEASE_LOST" });
    expect(lease.release()).rejects.toMatchObject({ code: "CHROME_MCP_PROFILE_LEASE_LOST" });
  });

  test("serializes stale reclamation before a contender can inspect or replace the live lease", async () => {
    const fixture = await leaseFixture();
    const stale: ProfileLeaseRecord = {
      brokerId: "dead-broker",
      createdAt: new Date(1000).toISOString(),
      lastRefresh: new Date(10_000).toISOString(),
      pid: 10,
      processStartIdentity: "linux:100",
      profilePathHash: profilePathHash(fixture.profilePath),
    };
    await writeFile(fixture.leasePath, JSON.stringify(stale), { mode: 0o600 });
    let releaseProbe: (() => void) | undefined;
    let reportProbeEntered: (() => void) | undefined;
    const probeEntered = new Promise<void>((resolve) => {
      reportProbeEntered = resolve;
    });
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const firstAcquisition = ProfileLease.acquire(fixture.leasePath, fixture.profilePath, {
      brokerId: "broker-first",
      now: () => 40_001,
      pid: 11,
      processIdentity: async () => {
        reportProbeEntered?.();
        await probeGate;
        return "absent";
      },
      processStartIdentity: "linux:200",
      refreshMs: 60_000,
    });
    await probeEntered;
    const contender = ProfileLease.acquire(fixture.leasePath, fixture.profilePath, {
      brokerId: "broker-contender",
      now: () => 100_000,
      pid: 12,
      processIdentity: async () => "same",
      processStartIdentity: "linux:300",
      refreshMs: 60_000,
    });
    releaseProbe?.();
    const first = await firstAcquisition;
    expect(contender).rejects.toMatchObject({ code: "CHROME_MCP_PROFILE_IN_USE" });
    expect(JSON.parse(await readFile(fixture.leasePath, "utf8"))).toMatchObject({ brokerId: "broker-first" });
    await first.release();
  });
});
