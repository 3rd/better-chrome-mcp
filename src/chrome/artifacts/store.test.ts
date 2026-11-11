import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactErrorCode } from "./constants";
import type { ArtifactCleanupScheduler, ArtifactStoreOptions } from "./store";
import {
  ARTIFACT_CHUNK_BYTES,
  ARTIFACT_CLEANUP_INTERVAL_MS,
  ARTIFACT_CONNECTION_MAX_BYTES,
  ARTIFACT_DIRECT_CONTENT_BYTES,
  ARTIFACT_ERROR_CODES,
  ARTIFACT_EXPIRY_MS,
  ARTIFACT_MAX_BYTES,
  ORDINARY_CALL_MAX_ARTIFACTS,
  ORDINARY_CALL_MAX_BYTES,
} from "./constants";
import { ArtifactError } from "./errors";
import { resolveArtifactInstanceRoot, resolveArtifactRoot } from "./paths";
import { ArtifactStore } from "./store";

const roots: string[] = [];
const stores: ArtifactStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createStore = (options: ArtifactStoreOptions) => {
  const store = new ArtifactStore(options);
  stores.push(store);
  return store;
};

const createRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "chrome-artifacts-test-"));
  roots.push(root);
  return root;
};

const origin = Object.freeze({ browserMode: "isolated", targetId: "target-1", tool: "run_playwright" });
const noCleanupScheduler: ArtifactCleanupScheduler = () => () => undefined;

const assignExitedInstanceOwner = async (instanceRoot: string) => {
  const exited = Bun.spawn(["true"]);
  await exited.exited;
  const ownerPath = join(instanceRoot, "owner.json");

  const owner: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
  const isOwnerRecord = typeof owner === "object" && owner !== null;
  if (!isOwnerRecord) {
    throw new Error("Instance owner metadata is not an object");
  }

  await writeFile(ownerPath, JSON.stringify({ ...owner, pid: exited.pid }));
};

const expectArtifactError = async (operation: Promise<unknown>, code: ArtifactErrorCode) => {
  try {
    await operation;
    throw new Error("Expected artifact operation to fail");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ArtifactError);
    if (!(error instanceof ArtifactError)) throw error;
    expect(error.code).toBe(code);
  }
};

describe("artifact paths and publication", () => {
  test("uses the Chrome MCP stable parent and opaque instance scopes", () => {
    const root = resolveArtifactRoot("/runtime");
    const left = resolveArtifactInstanceRoot(root, "instance-a", "a".repeat(32));
    const right = resolveArtifactInstanceRoot(root, "instance-a", "b".repeat(32));

    expect(root).toBe("/runtime/chrome-mcp/chrome-artifacts");
    expect(left).toStartWith(`${root}/instances/`);
    expect(left).not.toContain("instance-a");
    expect(left).not.toContain("a".repeat(32));
    expect(left).not.toBe(right);
  });

  test("rejects a symlinked Chrome MCP runtime parent before creating artifact descendants", async () => {
    const root = await createRoot();
    const target = join(root, "redirected");
    const chromeParent = join(root, "chrome-mcp");
    await mkdir(target);
    await symlink(target, chromeParent);
    const store = new ArtifactStore({
      root: join(chromeParent, "chrome-artifacts"),
      scheduler: noCleanupScheduler,
    });

    expect(store.initialize()).rejects.toThrow();
    expect(await Bun.file(join(target, "chrome-artifacts")).exists()).toBe(false);
  });

  test("publishes an owner-only immutable copy with inferred media type and full digest", async () => {
    const root = await createRoot();
    const source = join(root, "source.json");
    await writeFile(source, '{"before":true}\n');
    const store = createStore({ root: join(root, "store") });
    const connection = await store.openConnection();
    const publication = await store.beginPublication(connection);
    const descriptor = await store.publishFile(publication, source, { origin });

    await writeFile(source, '{"after":true}\n');
    const resource = await store.readResource(connection, descriptor.uri);
    expect(resource.text).toBe('{"before":true}\n');
    expect(descriptor.mediaType).toBe("application/json");
    expect(descriptor.sha256).toBe(createHash("sha256").update('{"before":true}\n').digest("hex"));
    expect(descriptor.expiresAt).toBeNull();
    const rootMetadata = await stat(store.root);
    expect(rootMetadata.mode & 0o777).toBe(0o700);

    const artifactFiles = await readdir(
      join(store.instanceRoot, connection.connectionId, "artifacts", descriptor.artifactId),
    );
    expect(artifactFiles.sort()).toEqual(["content", "manifest.json"]);
  });

  test("reserves safe single-use output paths and deletes unpublished reservations", async () => {
    const root = await createRoot();
    const store = createStore({ root: join(root, "store") });
    const connection = await store.openConnection();
    const publication = await store.beginPublication(connection);
    const reservation = await store.reserveOutput(publication, `${"x".repeat(124)}.txt`);
    await writeFile(reservation.path, "reserved");
    const descriptor = await store.publishReservation(publication, reservation, { origin });

    const resource = await store.readResource(connection, descriptor.uri);
    expect(resource.text).toBe("reserved");
    await expectArtifactError(
      store.publishReservation(publication, reservation, { origin }),
      ARTIFACT_ERROR_CODES.notFound,
    );

    const unpublished = await store.reserveOutput(publication, "unused.txt");
    await store.finishPublication(publication);
    expect(await Bun.file(unpublished.path).exists()).toBe(false);
  });

  test("keeps a publication ledger after a later publication fails", async () => {
    const root = await createRoot();
    const store = createStore({ root: join(root, "store") });
    const connection = await store.openConnection();
    const publication = await store.beginPublication(connection, "capture");
    const committed = await store.publishBytes(publication, Buffer.from("committed"), {
      name: "committed.txt",
      origin,
    });

    await expectArtifactError(
      store.publishFile(publication, join(root, "missing.txt"), { origin }),
      ARTIFACT_ERROR_CODES.invalidInput,
    );
    const duringFailure = store.publicationLedger(publication);
    expect(duringFailure.artifacts).toEqual([committed]);
    expect(duringFailure.bytes).toBe(Buffer.byteLength("committed"));
    expect(duringFailure.kind).toBe("capture");

    const finalized = await store.finishPublication(publication);
    expect(finalized).toEqual(duringFailure);
  });

  test("preserves quota errors while exposing descriptors committed earlier in the request", async () => {
    const root = await createRoot();
    const store = createStore({
      limits: { ordinaryCallBytes: 4 },
      root: join(root, "store"),
    });
    const connection = await store.openConnection();
    const publication = await store.beginPublication(connection);
    const committed = await store.publishBytes(publication, Buffer.alloc(4), { name: "exact.bin", origin });

    try {
      await store.publishBytes(publication, Buffer.alloc(1), { name: "over.bin", origin });
      throw new Error("Expected quota failure");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ArtifactError);
      if (!(error instanceof ArtifactError)) throw error;
      expect(error.code).toBe(ARTIFACT_ERROR_CODES.quota);
    }
    expect(store.publicationLedger(publication).artifacts).toEqual([committed]);
  });

  test("allows exactly one concurrent publication of a reservation", async () => {
    const root = await createRoot();
    const store = createStore({ root: join(root, "store") });
    const connection = await store.openConnection();
    const publication = await store.beginPublication(connection);
    const reservation = await store.reserveOutput(publication, "single-use.txt");
    await writeFile(reservation.path, "one copy");

    const results = await Promise.allSettled([
      store.publishReservation(publication, reservation, { origin }),
      store.publishReservation(publication, reservation, { origin }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await store.list(connection)).toHaveLength(1);
  });

  test("retries opaque connection ID collisions without reusing an existing directory", async () => {
    const root = await createRoot();
    const ids = ["a".repeat(32), "a".repeat(32), "b".repeat(32)];
    const store = createStore({
      idGenerator: () => ids.shift() ?? "c".repeat(32),
      root: join(root, "store"),
    });

    const first = await store.openConnection();
    const second = await store.openConnection();
    expect(first.connectionId).toBe("a".repeat(32));
    expect(second.connectionId).toBe("b".repeat(32));
  });

  test("rejects invalid names, media types, symlinks, and store-internal files without a reservation", async () => {
    const root = await createRoot();
    const source = join(root, "source.txt");
    const sourceLink = join(root, "source-link.txt");
    await writeFile(source, "source");
    await symlink(source, sourceLink);
    const store = createStore({ root: join(root, "store") });
    const connection = await store.openConnection();
    const publication = await store.beginPublication(connection);

    await expectArtifactError(
      store.reserveOutput(publication, "../escape.txt"),
      ARTIFACT_ERROR_CODES.invalidInput,
    );
    await expectArtifactError(
      store.reserveOutput(publication, `${"é".repeat(65)}.txt`),
      ARTIFACT_ERROR_CODES.invalidInput,
    );
    await expectArtifactError(
      store.reserveOutput(publication, "safe.txt", "not a type"),
      ARTIFACT_ERROR_CODES.invalidInput,
    );
    await expectArtifactError(
      store.publishFile(publication, sourceLink, { origin }),
      ARTIFACT_ERROR_CODES.invalidInput,
    );

    const internal = join(store.instanceRoot, connection.connectionId, "not-reserved.txt");
    await writeFile(internal, "internal");
    await expectArtifactError(
      store.publishFile(publication, internal, { origin }),
      ARTIFACT_ERROR_CODES.invalidInput,
    );
  });
});

describe("artifact chunks and quotas", () => {
  test("locks the production byte and count limits", () => {
    expect(ARTIFACT_CHUNK_BYTES).toBe(8 * 1024 * 1024);
    expect(ARTIFACT_DIRECT_CONTENT_BYTES).toBe(8 * 1024 * 1024);
    expect(ARTIFACT_MAX_BYTES).toBe(512 * 1024 * 1024);
    expect(ARTIFACT_CONNECTION_MAX_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(ARTIFACT_EXPIRY_MS).toBe(60 * 60 * 1000);
    expect(ORDINARY_CALL_MAX_ARTIFACTS).toBe(8);
    expect(ORDINARY_CALL_MAX_BYTES).toBe(100 * 1024 * 1024);
  });

  test("uses direct content through exactly 8 MiB and virtual chunks above it", async () => {
    const root = await createRoot();
    const store = createStore({ root: join(root, "store") });
    const connection = await store.openConnection();
    const publication = await store.beginPublication(connection, "capture");
    const exact = Buffer.alloc(8 * 1024 * 1024, 0x61);
    const over = Buffer.concat([exact, Buffer.from("z")]);
    const direct = await store.publishBytes(publication, exact, {
      mediaType: "application/octet-stream",
      name: "exact.bin",
      origin,
    });
    const chunked = await store.publishBytes(publication, over, {
      mediaType: "application/octet-stream",
      name: "over.bin",
      origin,
    });

    expect(direct.uri.endsWith("/content")).toBe(true);
    expect(chunked.uri.endsWith("/manifest")).toBe(true);
    const manifest = await store.manifest(connection, chunked.artifactId);
    expect(manifest.chunks.map(({ start, end, size }) => ({ end, size, start }))).toEqual([
      { end: 8 * 1024 * 1024, size: 8 * 1024 * 1024, start: 0 },
      { end: 8 * 1024 * 1024 + 1, size: 1, start: 8 * 1024 * 1024 },
    ]);

    const reconstructed = Buffer.concat(
      await Promise.all(
        manifest.chunks.map(async (chunk) => {
          const resource = await store.readResource(connection, chunk.uri);
          if (!("blob" in resource) || resource.blob === undefined) {
            throw new Error("Artifact chunk did not return a blob");
          }
          const bytes = Buffer.from(resource.blob, "base64");
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(chunk.sha256);
          return bytes;
        }),
      ),
    );
    expect(reconstructed.equals(over)).toBe(true);
    expect(createHash("sha256").update(reconstructed).digest("hex")).toBe(chunked.sha256);
  });

  test("enforces single-artifact, ordinary-call, count, and connection quotas inclusively", async () => {
    const root = await createRoot();
    const store = createStore({
      limits: {
        artifactBytes: 10,
        chunkBytes: 4,
        connectionBytes: 12,
        directContentBytes: 4,
        ordinaryCallArtifacts: 2,
        ordinaryCallBytes: 8,
      },
      root: join(root, "store"),
    });
    const connection = await store.openConnection();
    const ordinary = await store.beginPublication(connection);
    const first = await store.publishBytes(ordinary, Buffer.alloc(8), { name: "first.bin", origin });

    await expectArtifactError(
      store.publishBytes(ordinary, Buffer.alloc(1), { name: "call-over.bin", origin }),
      ARTIFACT_ERROR_CODES.quota,
    );
    const artifactsAfterCallLimit = await store.list(connection);
    expect(artifactsAfterCallLimit.map(({ artifactId }) => artifactId)).toEqual([first.artifactId]);

    const capture = await store.beginPublication(connection, "capture");
    await expectArtifactError(
      store.publishBytes(capture, Buffer.alloc(11), { name: "artifact-over.bin", origin }),
      ARTIFACT_ERROR_CODES.quota,
    );
    const second = await store.publishBytes(capture, Buffer.alloc(4), {
      name: "connection-exact.bin",
      origin,
    });
    await expectArtifactError(
      store.publishBytes(capture, Buffer.alloc(1), { name: "connection-over.bin", origin }),
      ARTIFACT_ERROR_CODES.quota,
    );
    const artifactsAfterConnectionLimit = await store.list(connection);
    expect(artifactsAfterConnectionLimit.map(({ artifactId }) => artifactId)).toEqual([
      first.artifactId,
      second.artifactId,
    ]);

    const countRoot = await createRoot();
    const countStore = createStore({
      limits: { ordinaryCallArtifacts: 2 },
      root: join(countRoot, "store"),
    });
    const countConnection = await countStore.openConnection();
    const countPublication = await countStore.beginPublication(countConnection);
    await countStore.publishBytes(countPublication, new Uint8Array(), { name: "one.bin", origin });
    await countStore.publishBytes(countPublication, new Uint8Array(), { name: "two.bin", origin });
    await expectArtifactError(
      countStore.publishBytes(countPublication, new Uint8Array(), { name: "three.bin", origin }),
      ARTIFACT_ERROR_CODES.quota,
    );
  });

  test("serializes concurrent publications against the connection-wide quota", async () => {
    const root = await createRoot();
    const store = createStore({
      limits: {
        artifactBytes: 8,
        chunkBytes: 4,
        connectionBytes: 8,
        directContentBytes: 4,
      },
      root: join(root, "store"),
    });
    const connection = await store.openConnection();
    const left = await store.beginPublication(connection, "capture");
    const right = await store.beginPublication(connection, "capture");
    const results = await Promise.allSettled([
      store.publishBytes(left, Buffer.alloc(8, 0x61), { name: "left.bin", origin }),
      store.publishBytes(right, Buffer.alloc(8, 0x62), { name: "right.bin", origin }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const failure = results.find(({ status }) => status === "rejected");
    if (!failure || failure.status !== "rejected") throw new Error("Expected one quota rejection");
    expect(failure.reason).toBeInstanceOf(ArtifactError);
    if (!(failure.reason instanceof ArtifactError)) throw failure.reason;
    expect(failure.reason.code).toBe(ARTIFACT_ERROR_CODES.quota);
    expect(await store.list(connection)).toHaveLength(1);
  });

  test("permits incomplete artifacts only for capture finalization", async () => {
    const root = await createRoot();
    const store = createStore({ root: join(root, "store") });
    const connection = await store.openConnection();
    const ordinary = await store.beginPublication(connection);
    await expectArtifactError(
      store.publishBytes(ordinary, Buffer.from("partial"), { complete: false, name: "ordinary.bin", origin }),
      ARTIFACT_ERROR_CODES.invalidInput,
    );

    const capture = await store.beginPublication(connection, "capture");
    const descriptor = await store.publishBytes(capture, Buffer.from("partial"), {
      complete: false,
      name: "capture.bin",
      origin,
    });
    expect(descriptor.complete).toBe(false);
  });

  test("leaves the caller source unchanged when quota validation rejects publication", async () => {
    const root = await createRoot();
    const source = join(root, "too-large.bin");
    const contents = Buffer.alloc(5, 0x7A);
    await writeFile(source, contents);
    const store = createStore({
      limits: { artifactBytes: 4, chunkBytes: 4, directContentBytes: 4 },
      root: join(root, "store"),
    });
    const connection = await store.openConnection();
    const publication = await store.beginPublication(connection);

    await expectArtifactError(store.publishFile(publication, source, { origin }), ARTIFACT_ERROR_CODES.quota);
    expect(Buffer.from(await Bun.file(source).arrayBuffer())).toEqual(contents);
    expect(await store.list(connection)).toEqual([]);
  });
});

describe("artifact ownership and expiry", () => {
  test("uses indistinguishable not-found errors for foreign, malformed, deleted, and closed resources", async () => {
    const root = await createRoot();
    const store = createStore({ root: join(root, "store") });
    const owner = await store.openConnection();
    const stranger = await store.openConnection();
    const publication = await store.beginPublication(owner);
    const descriptor = await store.publishBytes(publication, Buffer.from("secret"), {
      name: "secret.txt",
      origin,
    });

    await expectArtifactError(store.readResource(stranger, descriptor.uri), ARTIFACT_ERROR_CODES.notFound);
    await expectArtifactError(
      store.readResource(owner, `${descriptor.uri}/extra`),
      ARTIFACT_ERROR_CODES.notFound,
    );
    await expectArtifactError(
      store.readResource(
        owner,
        descriptor.uri.replace(`/${descriptor.artifactId}/`, `/${descriptor.artifactId}//`),
      ),
      ARTIFACT_ERROR_CODES.notFound,
    );
    await store.deleteArtifact(owner, descriptor.artifactId);
    await expectArtifactError(store.readResource(owner, descriptor.uri), ARTIFACT_ERROR_CODES.notFound);

    const next = await store.publishBytes(publication, Buffer.from("next"), { name: "next.txt", origin });
    await store.closeConnection(owner);
    await expectArtifactError(store.readResource(owner, next.uri), ARTIFACT_ERROR_CODES.notFound);
  });

  test("runs scheduled expiry cleanup without sleeps and cancels the schedule on dispose", async () => {
    const root = await createRoot();
    let now = Date.parse("2026-08-15T00:00:00.000Z");
    const clock = () => now;
    const storeRoot = join(root, "store");
    let scheduledCleanup: (() => Promise<void>) | undefined;
    let canceled = false;
    const scheduler: ArtifactCleanupScheduler = (intervalMs, task) => {
      expect(intervalMs).toBe(250);
      scheduledCleanup = task;
      return () => {
        canceled = true;
      };
    };
    const store = createStore({ cleanupIntervalMs: 250, clock, expiryMs: 1000, root: storeRoot, scheduler });
    const connection = await store.openConnection();
    const publication = await store.beginPublication(connection);
    await store.publishBytes(publication, Buffer.from("expires"), { name: "expires.txt", origin });
    await store.closeConnection(connection);
    const metadataPath = join(store.instanceRoot, connection.connectionId, "connection.json");
    expect(await Bun.file(metadataPath).exists()).toBe(true);

    now += 1001;
    if (!scheduledCleanup) throw new Error("Artifact cleanup was not scheduled");
    await scheduledCleanup();
    expect(await Bun.file(metadataPath).exists()).toBe(false);

    const cleanupDuringShutdown = scheduledCleanup();
    const firstShutdown = store.dispose();
    const secondShutdown = store.dispose();
    expect(secondShutdown).toBe(firstShutdown);
    await Promise.all([cleanupDuringShutdown, firstShutdown]);
    expect(canceled).toBe(true);
    expect(store.openConnection()).rejects.toThrow();
  });

  test("finalizes connections and releases ownership after an in-flight cleanup fails", async () => {
    const root = await createRoot();
    const now = Date.parse("2026-08-15T00:00:00.000Z");
    let throwOnNextClockRead = false;
    const cleanupFailure = new Error("injected cleanup failure");
    const clock = () => {
      if (throwOnNextClockRead) {
        throwOnNextClockRead = false;
        throw cleanupFailure;
      }
      return now;
    };
    let scheduledCleanup: (() => Promise<void>) | undefined;
    const scheduler: ArtifactCleanupScheduler = (intervalMs, task) => {
      expect(intervalMs).toBe(ARTIFACT_CLEANUP_INTERVAL_MS);
      scheduledCleanup = task;
      return () => undefined;
    };
    const store = new ArtifactStore({ clock, root: join(root, "store"), scheduler });
    const connection = await store.openConnection();
    const connectionMetadataPath = join(store.instanceRoot, connection.connectionId, "connection.json");
    const ownerMetadataPath = join(store.instanceRoot, "owner.json");
    if (!scheduledCleanup) throw new Error("Artifact cleanup was not scheduled");

    throwOnNextClockRead = true;
    const cleanup = scheduledCleanup();
    const shutdown = store.dispose();
    const [cleanupResult, shutdownResult] = await Promise.allSettled([cleanup, shutdown]);
    expect(cleanupResult).toEqual({ reason: cleanupFailure, status: "rejected" });
    expect(shutdownResult).toEqual({ reason: cleanupFailure, status: "rejected" });

    const connectionMetadata = JSON.parse(await readFile(connectionMetadataPath, "utf8"));
    const ownerMetadata = JSON.parse(await readFile(ownerMetadataPath, "utf8"));
    expect(connectionMetadata.closedAt).toBe(new Date(now).toISOString());
    expect(connectionMetadata.expiresAt).toBe(new Date(now + ARTIFACT_EXPIRY_MS).toISOString());
    expect(ownerMetadata.releasedAt).toBe(new Date(now).toISOString());
  });

  test("sweeps released prior instances without deleting live instances or runtime owner roots", async () => {
    const root = await createRoot();
    const storeRoot = join(root, "store");
    const runtimeOwnerRoot = join(storeRoot, "f".repeat(32));
    await mkdir(runtimeOwnerRoot, { recursive: true });
    await writeFile(join(runtimeOwnerRoot, "runtime-owner.txt"), "live runtime owner");
    let now = Date.parse("2026-08-15T00:00:00.000Z");
    const clock = () => now;
    const first = createStore({
      clock,
      expiryMs: 10,
      instanceId: "first-daemon",
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });
    const connection = await first.openConnection();
    await first.closeConnection(connection);
    const firstConnectionPath = join(first.instanceRoot, connection.connectionId);
    now += 11;

    const second = createStore({
      clock,
      expiryMs: 10,
      instanceId: "second-daemon",
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });
    await second.initialize();
    await second.sweepExpired();
    expect(await Bun.file(join(firstConnectionPath, "connection.json")).exists()).toBe(true);
    expect(await Bun.file(join(runtimeOwnerRoot, "runtime-owner.txt")).text()).toBe("live runtime owner");

    await first.dispose();
    await second.sweepExpired();
    expect(await Bun.file(join(firstConnectionPath, "connection.json")).exists()).toBe(false);
    expect(await Bun.file(join(runtimeOwnerRoot, "runtime-owner.txt")).text()).toBe("live runtime owner");
    await second.dispose();
  });

  test("removes expired prior instances with missing or corrupt owner metadata", async () => {
    const root = await createRoot();
    const storeRoot = join(root, "store");
    const orphan = createStore({
      instanceId: "orphan-daemon",
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });
    await mkdir(orphan.instanceRoot, { recursive: true });
    await writeFile(join(orphan.instanceRoot, "leftover.txt"), "orphaned");
    await utimes(orphan.instanceRoot, new Date(0), new Date(0));
    const corrupt = createStore({
      instanceId: "corrupt-daemon",
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });
    await mkdir(corrupt.instanceRoot, { recursive: true });
    await writeFile(join(corrupt.instanceRoot, "owner.json"), "{not-json");
    await writeFile(join(corrupt.instanceRoot, "leftover.txt"), "orphaned");
    await utimes(corrupt.instanceRoot, new Date(0), new Date(0));
    const invalidOwner = createStore({
      instanceId: "invalid-owner-daemon",
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });
    await mkdir(invalidOwner.instanceRoot, { recursive: true });
    await writeFile(
      join(invalidOwner.instanceRoot, "owner.json"),
      JSON.stringify({
        ownerId: "a".repeat(32),
        pid: process.pid,
        releasedAt: null,
        startedAt: new Date(0).toISOString(),
        unexpected: true,
        updatedAt: new Date(0).toISOString(),
      }),
    );
    await writeFile(join(invalidOwner.instanceRoot, "leftover.txt"), "orphaned");
    await utimes(invalidOwner.instanceRoot, new Date(0), new Date(0));
    const current = createStore({
      clock: () => ARTIFACT_EXPIRY_MS + 1,
      instanceId: "current-daemon",
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });

    await current.initialize();

    expect(await Bun.file(orphan.instanceRoot).exists()).toBe(false);
    expect(await Bun.file(corrupt.instanceRoot).exists()).toBe(false);
    expect(await Bun.file(invalidOwner.instanceRoot).exists()).toBe(false);
    await current.dispose();
  });

  test("ignores a prior instance removed concurrently during startup", async () => {
    const root = await createRoot();
    const storeRoot = join(root, "store");
    const prior = createStore({ instanceId: "prior-daemon", root: storeRoot, scheduler: noCleanupScheduler });
    await mkdir(prior.instanceRoot, { recursive: true });
    await writeFile(
      join(prior.instanceRoot, "owner.json"),
      JSON.stringify({
        ownerId: "a".repeat(32),
        pid: 123,
        releasedAt: null,
        startedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }),
    );
    await utimes(prior.instanceRoot, new Date(0), new Date(0));
    const current = createStore({
      clock: () => ARTIFACT_EXPIRY_MS + 1,
      instanceId: "current-daemon",
      isProcessAlive: () => {
        rmSync(prior.instanceRoot, { force: true, recursive: true });
        return false;
      },
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });

    await current.initialize();

    const instanceMetadata = await stat(current.instanceRoot);
    expect(instanceMetadata.isDirectory()).toBe(true);
    await current.dispose();
  });

  test("removes an expired released instance during startup", async () => {
    const root = await createRoot();
    const storeRoot = join(root, "store");
    let now = Date.parse("2026-08-15T00:00:00.000Z");
    const clock = () => now;
    const prior = createStore({
      clock,
      expiryMs: 10,
      instanceId: "prior-daemon",
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });
    const connection = await prior.openConnection();
    await prior.closeConnection(connection);
    const connectionPath = join(prior.instanceRoot, connection.connectionId);
    await prior.dispose();
    now += 11;

    const restarted = createStore({
      clock,
      expiryMs: 10,
      instanceId: "replacement-daemon",
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });
    await restarted.initialize();
    expect(await Bun.file(join(connectionPath, "connection.json")).exists()).toBe(false);
    await restarted.dispose();
  });

  test("expires a crashed connection from its last persisted heartbeat", async () => {
    const root = await createRoot();
    const storeRoot = join(root, "store");
    let now = Date.parse("2026-08-15T00:00:00.000Z");
    const clock = () => now;
    const crashed = new ArtifactStore({
      clock,
      expiryMs: 1000,
      instanceId: "crashed-daemon",
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });
    const connection = await crashed.openConnection();
    const connectionPath = join(crashed.instanceRoot, connection.connectionId);
    now += 24 * 60 * 60 * 1000;

    const restarted = createStore({
      clock,
      expiryMs: 1000,
      instanceId: "replacement-daemon",
      isProcessAlive: () => false,
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });
    await restarted.initialize();
    expect(await Bun.file(join(connectionPath, "connection.json")).exists()).toBe(false);
  });

  test("lets concurrent startups recover the same crashed instance", async () => {
    const root = await createRoot();
    const storeRoot = join(root, "store");

    const crashed = new ArtifactStore({
      instanceId: "crashed-daemon",
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });
    const connections = await Promise.all(Array.from({ length: 4 }, () => crashed.openConnection()));
    await assignExitedInstanceOwner(crashed.instanceRoot);

    const restarted = Array.from({ length: 12 }, (_, index) =>
      createStore({
        instanceId: `restarted-daemon-${index}`,
        root: storeRoot,
        scheduler: noCleanupScheduler,
      }),
    );
    await Promise.all(restarted.map((store) => store.initialize()));

    for (const connection of connections) {
      const connectionPath = join(crashed.instanceRoot, connection.connectionId);
      const metadata: unknown = JSON.parse(await readFile(join(connectionPath, "connection.json"), "utf8"));
      expect(metadata).toMatchObject({ expiresAt: expect.any(String) });
      const stagingMetadata = await stat(join(connectionPath, ".staging"));
      expect(stagingMetadata.isDirectory()).toBe(true);
    }

    expect(await Bun.file(join(crashed.instanceRoot, "recovery.lock")).exists()).toBe(false);
  });

  test("starts and reports a crashed instance it cannot recover", async () => {
    const root = await createRoot();
    const storeRoot = join(root, "store");

    const crashed = new ArtifactStore({
      instanceId: "crashed-daemon",
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });
    const connection = await crashed.openConnection();
    const connectionPath = join(crashed.instanceRoot, connection.connectionId);
    await chmod(connectionPath, 0o500);

    const reportError = spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const current = createStore({
        instanceId: "current-daemon",
        isProcessAlive: () => false,
        root: storeRoot,
        scheduler: noCleanupScheduler,
      });
      await current.initialize();

      const instanceMetadata = await stat(current.instanceRoot);
      expect(instanceMetadata.isDirectory()).toBe(true);
      expect(reportError).toHaveBeenCalledWith(
        expect.stringContaining(`Chrome artifact recovery skipped ${crashed.instanceRoot}`),
      );
    } finally {
      reportError.mockRestore();
      await chmod(connectionPath, 0o700);
    }
  });

  test("releases its instance synchronously so another daemon can reclaim it after exit", async () => {
    const root = await createRoot();
    const storeRoot = join(root, "store");
    let now = Date.parse("2026-08-15T00:00:00.000Z");
    const clock = () => now;
    const exiting = new ArtifactStore({
      clock,
      expiryMs: 10,
      instanceId: "exiting-daemon",
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });
    const connection = await exiting.openConnection();
    const connectionPath = join(exiting.instanceRoot, connection.connectionId);

    exiting.releaseInstanceSync();
    now += 11;

    const replacement = createStore({
      clock,
      expiryMs: 10,
      instanceId: "replacement-daemon",
      root: storeRoot,
      scheduler: noCleanupScheduler,
    });
    await replacement.initialize();
    expect(await Bun.file(join(connectionPath, "connection.json")).exists()).toBe(false);
  });

  test("emits one publication, deletion, and expiry event with the owning connection", async () => {
    const root = await createRoot();
    let now = 0;
    const store = createStore({ clock: () => now, expiryMs: 10, root: join(root, "store") });
    const events: { connectionId: string; kind: string }[] = [];
    store.subscribe((event) => events.push(event));
    const connection = await store.openConnection();
    const publication = await store.beginPublication(connection);
    const first = await store.publishBytes(publication, Buffer.from("one"), { name: "one.txt", origin });
    await store.deleteArtifact(connection, first.artifactId);
    await store.publishBytes(publication, Buffer.from("two"), { name: "two.txt", origin });
    await store.closeConnection(connection);
    now = 11;
    await store.sweepExpired();

    expect(events.map(({ kind }) => kind)).toEqual(["published", "deleted", "published", "expired"]);
    expect(events.every((event) => event.connectionId === connection.connectionId)).toBe(true);
  });
});
