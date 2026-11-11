import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ISOLATED_BUN_CONFIG_ARGUMENT } from "../../platform/bun-child";
import { isNodeError } from "../../platform/node-errors";
import { isRecord } from "../../platform/records";
import { ChromeRuntimeError } from "./errors";
import {
  currentProcessStartIdentity,
  probeProcessIdentity,
  type ProcessIdentityState,
} from "./process-identity";

export const PROFILE_LEASE_REFRESH_MS = 10_000;
export const PROFILE_LEASE_STALE_MS = 30_000;
export const PROFILE_LEASE_GUARD_TIMEOUT_MS = 5000;

export type ProfileLeaseGuard = <Result>(path: string, operation: () => Promise<Result>) => Promise<Result>;

export type ProfileLeaseRecord = Readonly<{
  brokerId: string;
  createdAt: string;
  lastRefresh: string;
  pid: number;
  processStartIdentity: string;
  profilePathHash: string;
}>;

export type ProfileLeaseOptions = Readonly<{
  brokerId?: string;
  now?: () => number;
  pid?: number;
  processIdentity?: (pid: number, expected: string) => Promise<ProcessIdentityState>;
  processStartIdentity?: string;
  refreshMs?: number;
  staleMs?: number;
  guard?: ProfileLeaseGuard;
}>;

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
  );
};

const parseLeaseRecord = (value: unknown): ProfileLeaseRecord => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "brokerId",
      "createdAt",
      "lastRefresh",
      "pid",
      "processStartIdentity",
      "profilePathHash",
    ]) ||
    typeof value.brokerId !== "string" ||
    !value.brokerId ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.processStartIdentity !== "string" ||
    !value.processStartIdentity ||
    typeof value.profilePathHash !== "string" ||
    !/^[\da-f]{64}$/.test(value.profilePathHash) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.lastRefresh !== "string" ||
    !Number.isFinite(Date.parse(value.lastRefresh))
  ) {
    throw new ChromeRuntimeError("CHROME_MCP_PROFILE_IN_USE", "Chrome profile lease is malformed");
  }
  return Object.freeze({
    brokerId: value.brokerId,
    createdAt: value.createdAt,
    lastRefresh: value.lastRefresh,
    pid: value.pid,
    processStartIdentity: value.processStartIdentity,
    profilePathHash: value.profilePathHash,
  });
};

export const profilePathHash = (profilePath: string): string =>
  createHash("sha256").update(profilePath).digest("hex");

const decode = new TextDecoder();

const profileLockChildCommand = (platformDirectory: "darwin" | "windows", path: string) => {
  const childPath = fileURLToPath(
    new URL(`../../platform/${platformDirectory}/profile-lock-child.ts`, import.meta.url),
  );

  return [process.execPath, ISOLATED_BUN_CONFIG_ARGUMENT, childPath, path];
};

const profileLeaseGuardCommand = (path: string) => {
  if (process.platform === "darwin") return profileLockChildCommand("darwin", path);
  if (process.platform === "win32") return profileLockChildCommand("windows", path);

  return ["flock", "--exclusive", path, "cat"];
};

const spawnProfileLeaseGuard = (path: string) => {
  try {
    return Bun.spawn({
      cmd: profileLeaseGuardCommand(path),
      stderr: "pipe",
      stdin: "pipe",
      stdout: "pipe",
      windowsHide: true,
    });
  } catch (error: unknown) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_PROFILE_IN_USE",
      "Could not start the exclusive Chrome profile guard",
      {
        cause: error,
      },
    );
  }
};

const waitForProfileLeaseGuard = async <Result>(
  operation: Promise<Result>,
  subprocess: ReturnType<typeof spawnProfileLeaseGuard>,
  phase: string,
): Promise<Result> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          subprocess.kill("SIGKILL");
          reject(
            new ChromeRuntimeError(
              "CHROME_MCP_PROFILE_IN_USE",
              `Exclusive Chrome profile guard timed out during ${phase}`,
            ),
          );
        }, PROFILE_LEASE_GUARD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const withFlockProfileLeaseGuard: ProfileLeaseGuard = async <Result>(
  path: string,
  operation: () => Promise<Result>,
): Promise<Result> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const subprocess = spawnProfileLeaseGuard(path);
  subprocess.stdin.write("locked\n");
  await subprocess.stdin.flush();
  const reader = subprocess.stdout.getReader();
  const marker = await waitForProfileLeaseGuard(reader.read(), subprocess, "acquisition");
  reader.releaseLock();
  if (marker.done || decode.decode(marker.value) !== "locked\n") {
    subprocess.stdin.end();
    const [exitCode, stderr] = await waitForProfileLeaseGuard(
      Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]),
      subprocess,
      "failed acquisition cleanup",
    );
    const errorDetails = stderr ? `: ${stderr.trim()}` : "";
    throw new ChromeRuntimeError(
      "CHROME_MCP_PROFILE_IN_USE",
      `Exclusive Chrome profile guard failed with exit code ${exitCode}${errorDetails}`,
    );
  }

  let outcome: Readonly<{ error: unknown; ok: false }> | Readonly<{ ok: true; value: Result }>;
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error: unknown) {
    outcome = { error, ok: false };
  }
  subprocess.stdin.end();
  const [exitCode, stderr] = await waitForProfileLeaseGuard(
    Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]),
    subprocess,
    "release",
  );
  if (exitCode !== 0) {
    const errorDetails = stderr ? `: ${stderr.trim()}` : "";
    const guardError = new Error(
      `Exclusive Chrome profile guard exited with code ${exitCode}${errorDetails}`,
    );
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, guardError],
        "Chrome profile operation and guard release both failed",
      );
    }
    throw guardError;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
};

const resolveLeaseGuardPath = (leasePath: string) => `${leasePath}.guard`;

const writeExclusive = async (path: string, record: ProfileLeaseRecord): Promise<boolean> => {
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  }
};

const replaceOwnedLease = async (path: string, record: ProfileLeaseRecord): Promise<void> => {
  const temporaryPath = `${path}.${record.brokerId}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch((cleanupError: unknown) => {
      if (!isNodeError(cleanupError, "ENOENT")) throw cleanupError;
    });
    throw error;
  }
};

const readLease = async (path: string): Promise<ProfileLeaseRecord | undefined> => {
  try {
    return parseLeaseRecord(JSON.parse(await readFile(path, "utf8")));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
};

export class ProfileLease {
  readonly path: string;
  readonly record: ProfileLeaseRecord;

  #closed = false;
  #failure: unknown;
  #failurePromise: Promise<unknown>;
  #guard: ProfileLeaseGuard;
  #now: () => number;
  #refreshing: Promise<void> | undefined;
  #refreshMs: number;
  #resolveFailure: ((error: unknown) => void) | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    path: string,
    record: ProfileLeaseRecord,
    now: () => number,
    refreshMs: number,
    guard: ProfileLeaseGuard,
  ) {
    this.path = path;
    this.record = record;
    this.#guard = guard;
    this.#now = now;
    this.#refreshMs = refreshMs;
    this.#failurePromise = new Promise((resolve) => {
      this.#resolveFailure = resolve;
    });
  }

  static async acquire(
    path: string,
    profilePath: string,
    options: ProfileLeaseOptions = {},
  ): Promise<ProfileLease> {
    const now = options.now ?? Date.now;
    const pid = options.pid ?? process.pid;
    const brokerId = options.brokerId ?? randomUUID();
    const processStartIdentity = options.processStartIdentity ?? (await currentProcessStartIdentity(pid));
    const processIdentity = options.processIdentity ?? probeProcessIdentity;
    const staleMs = options.staleMs ?? PROFILE_LEASE_STALE_MS;
    const refreshMs = options.refreshMs ?? PROFILE_LEASE_REFRESH_MS;
    const guard = options.guard ?? withFlockProfileLeaseGuard;
    const profileHash = profilePathHash(profilePath);
    const createdAt = new Date(now()).toISOString();
    const newRecord: ProfileLeaseRecord = Object.freeze({
      brokerId,
      createdAt,
      lastRefresh: createdAt,
      pid,
      processStartIdentity,
      profilePathHash: profileHash,
    });

    await guard(resolveLeaseGuardPath(path), async () => {
      const existing = await readLease(path);
      if (!existing) {
        if (await writeExclusive(path, newRecord)) return;
        throw new ChromeRuntimeError(
          "CHROME_MCP_PROFILE_IN_USE",
          "Chrome profile lease appeared outside its exclusive guard",
        );
      }
      if (existing.profilePathHash !== profileHash) {
        throw new ChromeRuntimeError(
          "CHROME_MCP_PROFILE_IN_USE",
          "Chrome profile lease belongs to a different profile path",
        );
      }
      const identityState = await processIdentity(existing.pid, existing.processStartIdentity);
      const ageMs = now() - Date.parse(existing.lastRefresh);
      if (identityState === "same" || identityState === "unknown" || ageMs < staleMs) {
        throw new ChromeRuntimeError(
          "CHROME_MCP_PROFILE_IN_USE",
          `Chrome profile is owned by broker ${existing.brokerId} (PID ${existing.pid}, last refresh ${existing.lastRefresh})`,
        );
      }
      await replaceOwnedLease(path, newRecord);
    });
    const lease = new ProfileLease(path, newRecord, now, refreshMs, guard);
    lease.startRefreshing();
    return lease;
  }

  startRefreshing(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(() => {
      this.refresh().catch((error: unknown) => this.#recordFailure(error));
    }, this.#refreshMs);
    this.#timer.unref?.();
  }

  async refresh(): Promise<void> {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed) return;
    if (this.#refreshing) return this.#refreshing;
    const refreshing = this.#performRefresh();
    this.#refreshing = refreshing;
    try {
      await refreshing;
    } finally {
      if (this.#refreshing === refreshing) this.#refreshing = undefined;
    }
  }

  waitForFailure(): Promise<unknown> {
    return this.#failurePromise;
  }

  stopRefreshing(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #performRefresh(): Promise<void> {
    await this.#guard(resolveLeaseGuardPath(this.path), async () => {
      const current = await readLease(this.path);
      const isLeaseStillOwned = current !== undefined && this.isOwnRecord(current);
      if (!isLeaseStillOwned) {
        throw new ChromeRuntimeError(
          "CHROME_MCP_PROFILE_LEASE_LOST",
          "Chrome profile lease ownership changed",
        );
      }

      const refreshed = Object.freeze({ ...this.record, lastRefresh: new Date(this.#now()).toISOString() });
      await replaceOwnedLease(this.path, refreshed);
    });
  }

  async release(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.stopRefreshing();
    if (this.#refreshing) {
      try {
        await this.#refreshing;
      } catch {
        // Release still removes an owned lease after a failed refresh.
      }
      this.#refreshing = undefined;
    }
    await this.#guard(resolveLeaseGuardPath(this.path), async () => {
      const current = await readLease(this.path);
      if (!current) return;
      if (!this.isOwnRecord(current)) {
        throw new ChromeRuntimeError(
          "CHROME_MCP_PROFILE_LEASE_LOST",
          "Cannot release another broker's profile lease",
        );
      }

      await unlink(this.path);
    });
  }

  private isOwnRecord(current: ProfileLeaseRecord) {
    return (
      current.brokerId === this.record.brokerId &&
      current.processStartIdentity === this.record.processStartIdentity
    );
  }

  #recordFailure(error: unknown): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#resolveFailure?.(error);
    this.#resolveFailure = undefined;
  }
}
