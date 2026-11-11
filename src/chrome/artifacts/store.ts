import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ArtifactChunk,
  ArtifactConnection,
  ArtifactDescriptor,
  ArtifactManifest,
  ArtifactOrigin,
  ArtifactPublication,
  ArtifactPublicationKind,
  ArtifactPublicationLedger,
  ArtifactReservation,
  ArtifactResource,
  ArtifactStoreEvent,
  ArtifactStoreLimits,
} from "./types";
import { isNodeError } from "../../platform/node-errors";
import { isRecord } from "../../platform/records";
import {
  ARTIFACT_CHUNK_BYTES,
  ARTIFACT_CLEANUP_INTERVAL_MS,
  ARTIFACT_CONNECTION_MAX_BYTES,
  ARTIFACT_DIRECT_CONTENT_BYTES,
  ARTIFACT_ERROR_CODES,
  ARTIFACT_EXPIRY_MS,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_NAME_MAX_BYTES,
  ORDINARY_CALL_MAX_ARTIFACTS,
  ORDINARY_CALL_MAX_BYTES,
} from "./constants";
import { ArtifactError, artifactNotFound } from "./errors";
import {
  isArtifactInstanceScope,
  resolveArtifactInstanceRoot,
  resolveArtifactInstancesRoot,
  resolveArtifactRoot,
} from "./paths";
import { ARTIFACT_URI_PROTOCOL, artifactChunkUri, artifactContentUri, artifactManifestUri } from "./uris";

const CONNECTION_METADATA_NAME = "connection.json";
const INSTANCE_METADATA_NAME = "owner.json";
const ARTIFACTS_DIRECTORY_NAME = "artifacts";
const STAGING_DIRECTORY_NAME = ".staging";
const RECOVERY_LOCK_NAME = "recovery.lock";
const TOKEN_PATTERN = /^[\da-f]{32}$/;
const MEDIA_TYPE_PATTERN = /^[\w!#$&+.^-]+\/[\w!#$&+.^-]+$/;
const COPY_BUFFER_BYTES = 1024 * 1024;

const MEDIA_TYPES = new Map([
  [".css", "text/css"],
  [".csv", "text/csv"],
  [".gif", "image/gif"],
  [".har", "application/json"],
  [".html", "text/html"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".xml", "application/xml"],
  [".zip", "application/zip"],
]);

type Clock = () => number;

export type ArtifactCleanupScheduler = (intervalMs: number, task: () => Promise<void>) => () => void;

type ConnectionMetadata = {
  closedAt: string | null;
  connectionId: string;
  createdAt: string;
  expiresAt: string | null;
  updatedAt: string;
};

type InstanceMetadata = {
  ownerId: string;
  pid: number;
  releasedAt: string | null;
  startedAt: string;
  updatedAt: string;
};

type StoredArtifact = {
  contentPath: string;
  manifest: ArtifactManifest;
};

type PublicationState = {
  artifactCount: number;
  artifacts: ArtifactDescriptor[];
  bytes: number;
  consumingReservations: Set<string>;
  kind: ArtifactPublicationKind;
  publicationId: string;
  reservations: Map<string, ArtifactReservation>;
};

type ConnectionState = {
  active: boolean;
  artifacts: Map<string, StoredArtifact>;
  connectionId: string;
  expiresAt: string | null;
  publications: Map<string, PublicationState>;
  usedBytes: number;
};

export type ArtifactStoreOptions = Readonly<{
  cleanupIntervalMs?: number;
  clock?: Clock;
  expiryMs?: number;
  idGenerator?: () => string;
  instanceId?: string;
  isProcessAlive?: (pid: number) => boolean;
  limits?: Partial<ArtifactStoreLimits>;
  root?: string;
  scheduler?: ArtifactCleanupScheduler;
}>;

export type PublishArtifactOptions = Readonly<{
  complete?: boolean;
  mediaType?: string;
  name?: string;
  origin: ArtifactOrigin;
}>;

const defaultLimits: ArtifactStoreLimits = Object.freeze({
  artifactBytes: ARTIFACT_MAX_BYTES,
  chunkBytes: ARTIFACT_CHUNK_BYTES,
  connectionBytes: ARTIFACT_CONNECTION_MAX_BYTES,
  directContentBytes: ARTIFACT_DIRECT_CONTENT_BYTES,
  ordinaryCallArtifacts: ORDINARY_CALL_MAX_ARTIFACTS,
  ordinaryCallBytes: ORDINARY_CALL_MAX_BYTES,
});

const quotaError = (message: string, measured: number, allowed: number) =>
  new ArtifactError(ARTIFACT_ERROR_CODES.quota, message, { allowed, measured });

const token = (): string => randomBytes(16).toString("hex");

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
  );
};

const parseConnectionMetadata = (value: unknown): ConnectionMetadata | undefined => {
  if (!isRecord(value)) return undefined;
  if (!hasExactKeys(value, ["closedAt", "connectionId", "createdAt", "expiresAt", "updatedAt"])) {
    return undefined;
  }
  if (typeof value.connectionId !== "string" || !TOKEN_PATTERN.test(value.connectionId)) {
    return undefined;
  }
  if (
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !(value.closedAt === null || typeof value.closedAt === "string") ||
    !(value.expiresAt === null || typeof value.expiresAt === "string")
  ) {
    return undefined;
  }
  return {
    closedAt: value.closedAt,
    connectionId: value.connectionId,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    updatedAt: value.updatedAt,
  };
};

const parseInstanceMetadata = (value: unknown): InstanceMetadata | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    !hasExactKeys(value, ["ownerId", "pid", "releasedAt", "startedAt", "updatedAt"]) ||
    typeof value.ownerId !== "string" ||
    !TOKEN_PATTERN.test(value.ownerId) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !(value.releasedAt === null || typeof value.releasedAt === "string") ||
    typeof value.startedAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return undefined;
  }
  return {
    ownerId: value.ownerId,
    pid: value.pid,
    releasedAt: value.releasedAt,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
  };
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isNodeError(error, "ESRCH");
  }
};

const scheduleCleanup: ArtifactCleanupScheduler = (intervalMs, task) => {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    task()
      .catch((error: unknown) => {
        console.error(
          `Chrome artifact cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};

const stableJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const writeSynced = async (path: string, contents: string, mode: number) => {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
};

const writeAtomic = async (path: string, value: unknown) => {
  const temporary = `${path}.tmp-${process.pid}-${token()}`;
  try {
    await writeSynced(temporary, stableJson(value), 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

const writeAtomicSync = (path: string, value: unknown) => {
  const temporary = `${path}.tmp-${process.pid}-${token()}`;
  try {
    const descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );

    try {
      writeFileSync(descriptor, stableJson(value), "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
};

const validatedName = (name: string): string => {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    Buffer.byteLength(name, "utf8") > ARTIFACT_NAME_MAX_BYTES
  ) {
    throw new ArtifactError(
      ARTIFACT_ERROR_CODES.invalidInput,
      `Artifact name must be a plain filename no longer than ${ARTIFACT_NAME_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return name;
};

const resolvedMediaType = (name: string, requested?: string): string => {
  if (requested !== undefined) {
    if (!MEDIA_TYPE_PATTERN.test(requested)) {
      throw new ArtifactError(ARTIFACT_ERROR_CODES.invalidInput, `Invalid artifact media type: ${requested}`);
    }
    return requested.toLowerCase();
  }
  return MEDIA_TYPES.get(extname(name).toLowerCase()) ?? "application/octet-stream";
};

const isTextMediaType = (mediaType: string): boolean =>
  mediaType.startsWith("text/") ||
  mediaType === "application/json" ||
  mediaType === "application/javascript" ||
  mediaType === "application/xml" ||
  mediaType.endsWith("+json") ||
  mediaType.endsWith("+xml");

class SerialQueue {
  #tail = Promise.resolve();

  async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolveTurn) => {
      release = resolveTurn;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

type CopiedFile = {
  chunks: { end: number; index: number; sha256: string; size: number; start: number }[];
  sha256: string;
  size: number;
};

type ParsedArtifactUri =
  | Readonly<{ artifactId: string; index: number; kind: "chunk" }>
  | Readonly<{ artifactId: string; kind: "content" }>
  | Readonly<{ artifactId: string; kind: "manifest" }>;

const copyAndHash = async (
  sourcePath: string,
  destinationPath: string,
  maximumBytes: number,
  chunkBytes: number,
) => {
  let source;
  try {
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    throw new ArtifactError(
      ARTIFACT_ERROR_CODES.invalidInput,
      `Artifact source must be an existing regular file: ${sourcePath}`,
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  let destination;
  try {
    const sourceMetadata = await source.stat();
    if (!sourceMetadata.isFile()) {
      throw new ArtifactError(
        ARTIFACT_ERROR_CODES.invalidInput,
        `Artifact source must be a regular file: ${sourcePath}`,
      );
    }
    if (sourceMetadata.size > maximumBytes) {
      throw quotaError("Artifact exceeds the single-artifact byte limit", sourceMetadata.size, maximumBytes);
    }

    destination = await open(
      destinationPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const fullHash = createHash("sha256");
    const chunks: CopiedFile["chunks"] = [];
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let chunkHash = createHash("sha256");
    let chunkStart = 0;
    let chunkSize = 0;
    let position = 0;

    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      if (position + bytesRead > maximumBytes) {
        throw quotaError(
          "Artifact exceeds the single-artifact byte limit",
          position + bytesRead,
          maximumBytes,
        );
      }

      const readBytes = buffer.subarray(0, bytesRead);
      fullHash.update(readBytes);
      let offset = 0;
      while (offset < readBytes.byteLength) {
        const remaining = readBytes.byteLength - offset;
        const chunkRemaining = chunkBytes - chunkSize;
        const length = Math.min(remaining, chunkRemaining);
        chunkHash.update(readBytes.subarray(offset, offset + length));
        chunkSize += length;
        offset += length;
        if (chunkSize === chunkBytes) {
          chunks.push({
            end: chunkStart + chunkSize,
            index: chunks.length,
            sha256: chunkHash.digest("hex"),
            size: chunkSize,
            start: chunkStart,
          });
          chunkStart += chunkSize;
          chunkSize = 0;
          chunkHash = createHash("sha256");
        }
      }

      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(readBytes, written, bytesRead - written, position + written);
        if (result.bytesWritten === 0) throw new Error("Artifact copy made no write progress");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }

    if (chunkSize > 0) {
      chunks.push({
        end: chunkStart + chunkSize,
        index: chunks.length,
        sha256: chunkHash.digest("hex"),
        size: chunkSize,
        start: chunkStart,
      });
    }

    await destination.sync();
    await destination.close();
    destination = undefined;
    await chmod(destinationPath, 0o400);
    return { chunks, sha256: fullHash.digest("hex"), size: position } satisfies CopiedFile;
  } finally {
    await source.close();
    if (destination !== undefined) await destination.close();
  }
};

const descriptorFrom = (manifest: ArtifactManifest, expiresAt: string | null): ArtifactDescriptor => ({
  artifactId: manifest.artifactId,
  complete: manifest.complete,
  createdAt: manifest.createdAt,
  expiresAt,
  mediaType: manifest.mediaType,
  name: manifest.name,
  sha256: manifest.sha256,
  size: manifest.size,
  uri: manifest.uri,
});

const isAlreadyExists = (error: unknown) => {
  return isNodeError(error, "EEXIST");
};

const isNotFound = (error: unknown) => {
  return isNodeError(error, "ENOENT");
};

const requirePublication = (state: ConnectionState, publication: ArtifactPublication) => {
  if (!state.active) throw artifactNotFound();
  const scope = state.publications.get(publication.publicationId);
  if (!scope || publication.connectionId !== state.connectionId) throw artifactNotFound();
  return scope;
};

const createPublicationLedger = (
  state: ConnectionState,
  publication: PublicationState,
): ArtifactPublicationLedger => {
  return Object.freeze({
    artifacts: Object.freeze([...publication.artifacts]),
    bytes: publication.bytes,
    connectionId: state.connectionId,
    kind: publication.kind,
    publicationId: publication.publicationId,
  });
};

const parseOwnedUri = (state: ConnectionState, uri: string): ParsedArtifactUri => {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw artifactNotFound();
  }

  const isBareArtifactUri =
    parsed.protocol === ARTIFACT_URI_PROTOCOL &&
    !parsed.username &&
    !parsed.password &&
    !parsed.port &&
    !parsed.search &&
    !parsed.hash;
  if (!isBareArtifactUri) throw artifactNotFound();

  if (parsed.hostname !== state.connectionId) throw artifactNotFound();
  const segments = parsed.pathname.split("/").filter(Boolean);
  const artifactId = segments[0];
  if (!artifactId || !TOKEN_PATTERN.test(artifactId)) throw artifactNotFound();
  if (segments.length === 2 && segments[1] === "manifest") {
    if (uri !== artifactManifestUri(state.connectionId, artifactId)) throw artifactNotFound();
    return { artifactId, kind: "manifest" };
  }
  if (segments.length === 2 && segments[1] === "content") {
    if (uri !== artifactContentUri(state.connectionId, artifactId)) throw artifactNotFound();
    return { artifactId, kind: "content" };
  }
  if (segments.length === 3 && segments[1] === "chunks" && /^(0|[1-9]\d*)$/.test(segments[2] ?? "")) {
    const index = Number(segments[2]);
    const isCanonicalChunkUri =
      Number.isSafeInteger(index) && uri === artifactChunkUri(state.connectionId, artifactId, index);
    if (isCanonicalChunkUri) return { artifactId, index, kind: "chunk" };
  }
  throw artifactNotFound();
};

export class ArtifactStore {
  readonly instanceRoot: string;
  readonly limits: ArtifactStoreLimits;
  readonly root: string;

  #cancelCleanup: (() => void) | undefined;
  #cleanupIntervalMs: number;
  #cleanupScheduler: ArtifactCleanupScheduler;
  #cleanupTasks = new Set<Promise<unknown>>();
  #clock: Clock;
  #connections = new Map<string, ConnectionState>();
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #expiryMs: number;
  #idGenerator: () => string;
  #initialized: Promise<void> | undefined;
  private instanceRootCreated = false;
  #isProcessAlive: (pid: number) => boolean;
  #lifecycleQueue = new SerialQueue();
  #listeners = new Set<(event: ArtifactStoreEvent) => void>();
  #ownerId = token();
  #queues = new Map<string, SerialQueue>();

  constructor(options: ArtifactStoreOptions = {}) {
    this.root = options.root ?? resolveArtifactRoot();
    this.instanceRoot = resolveArtifactInstanceRoot(this.root, options.instanceId, this.#ownerId);
    this.#cleanupIntervalMs = options.cleanupIntervalMs ?? ARTIFACT_CLEANUP_INTERVAL_MS;
    this.#cleanupScheduler = options.scheduler ?? scheduleCleanup;
    this.#clock = options.clock ?? Date.now;
    this.#expiryMs = options.expiryMs ?? ARTIFACT_EXPIRY_MS;
    this.#idGenerator = options.idGenerator ?? token;
    this.#isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.limits = Object.freeze({ ...defaultLimits, ...options.limits });
    if (
      !Number.isSafeInteger(this.#cleanupIntervalMs) ||
      this.#cleanupIntervalMs <= 0 ||
      this.#expiryMs < 0 ||
      Object.values(this.limits).some((limit) => !Number.isSafeInteger(limit) || limit <= 0) ||
      this.limits.directContentBytes > this.limits.chunkBytes ||
      this.limits.chunkBytes > this.limits.artifactBytes
    ) {
      throw new Error("Artifact store limits must be positive safe integers in a valid size order");
    }
  }

  async initialize() {
    this.#assertOpen();
    this.#initialized ??= this.#initialize();
    return this.#initialized;
  }

  async openConnection() {
    await this.initialize();
    let connectionId = this.#nextId();
    let connectionDirectory = this.#connectionDirectory(connectionId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await mkdir(connectionDirectory, { mode: 0o700 });
        break;
      } catch (error: unknown) {
        if (!isAlreadyExists(error) || attempt === 99) throw error;
        connectionId = this.#nextId();
        connectionDirectory = this.#connectionDirectory(connectionId);
      }
    }
    const now = iso(this.#clock());
    const state: ConnectionState = {
      active: true,
      artifacts: new Map(),
      connectionId,
      expiresAt: null,
      publications: new Map(),
      usedBytes: 0,
    };
    await mkdir(join(connectionDirectory, ARTIFACTS_DIRECTORY_NAME), { recursive: true, mode: 0o700 });
    await mkdir(join(connectionDirectory, STAGING_DIRECTORY_NAME), { recursive: true, mode: 0o700 });
    await chmod(connectionDirectory, 0o700);
    await this.#writeConnectionMetadata(state, now, null);
    this.#connections.set(connectionId, state);
    return Object.freeze({ connectionId }) satisfies ArtifactConnection;
  }

  async closeConnection(connection: ArtifactConnection) {
    await this.initialize();
    const state = this.#requireConnection(connection.connectionId, true);
    await this.#queue(state.connectionId).run(() => this.deactivateConnection(state));
  }

  private async deactivateConnection(state: ConnectionState) {
    if (!state.active) return;

    for (const publication of state.publications.values()) {
      await this.#removePublicationFiles(state, publication);
    }

    state.publications.clear();
    state.active = false;
    const closedAt = this.#clock();
    state.expiresAt = iso(closedAt + this.#expiryMs);
    await this.#writeConnectionMetadata(state, iso(closedAt), iso(closedAt));
  }

  async beginPublication(connection: ArtifactConnection, kind: ArtifactPublicationKind = "ordinary") {
    await this.initialize();
    const state = this.#requireConnection(connection.connectionId, true);
    if (!state.active) throw artifactNotFound();
    let publicationId = this.#nextId();
    for (let attempt = 0; state.publications.has(publicationId); attempt += 1) {
      if (attempt === 99) throw new Error("Artifact publication could not allocate a unique ID");
      publicationId = this.#nextId();
    }
    state.publications.set(publicationId, {
      artifactCount: 0,
      artifacts: [],
      bytes: 0,
      consumingReservations: new Set(),
      kind,
      publicationId,
      reservations: new Map(),
    });
    await mkdir(this.#publicationDirectory(state.connectionId, publicationId), {
      recursive: true,
      mode: 0o700,
    });
    return Object.freeze({ connectionId: state.connectionId, publicationId }) satisfies ArtifactPublication;
  }

  async reserveOutput(publication: ArtifactPublication, name: string, mediaType?: string) {
    await this.initialize();
    const state = this.#requireConnection(publication.connectionId, true);
    return this.#queue(state.connectionId).run(async () => {
      const scope = requirePublication(state, publication);
      if (
        scope.kind === "ordinary" &&
        scope.artifactCount + scope.reservations.size >= this.limits.ordinaryCallArtifacts
      ) {
        throw quotaError(
          "Publication exceeds the ordinary-call artifact count limit",
          scope.artifactCount + scope.reservations.size + 1,
          this.limits.ordinaryCallArtifacts,
        );
      }
      const safeName = validatedName(name);
      const safeMediaType = resolvedMediaType(safeName, mediaType);
      let reservationId = this.#nextId();
      let path = join(
        this.#publicationDirectory(state.connectionId, scope.publicationId),
        `${reservationId}-${safeName}`,
      );
      let handle;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          handle = await open(
            path,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          );
          break;
        } catch (error: unknown) {
          if (!isAlreadyExists(error) || attempt === 99) throw error;
          reservationId = this.#nextId();
          path = join(
            this.#publicationDirectory(state.connectionId, scope.publicationId),
            `${reservationId}-${safeName}`,
          );
        }
      }
      if (!handle) throw new Error("Artifact reservation could not allocate a unique path");
      await handle.close();
      const reservation = Object.freeze({
        connectionId: state.connectionId,
        mediaType: safeMediaType,
        name: safeName,
        path,
        publicationId: scope.publicationId,
        reservationId,
      }) satisfies ArtifactReservation;
      scope.reservations.set(reservationId, reservation);
      return reservation;
    });
  }

  async publishReservation(
    publication: ArtifactPublication,
    reservation: ArtifactReservation,
    options: Omit<PublishArtifactOptions, "mediaType" | "name">,
  ) {
    const state = this.#requireConnection(publication.connectionId, true);
    const scope = requirePublication(state, publication);
    const stored = scope.reservations.get(reservation.reservationId);
    if (
      publication.connectionId !== reservation.connectionId ||
      publication.publicationId !== reservation.publicationId ||
      stored?.path !== reservation.path ||
      scope.consumingReservations.has(reservation.reservationId)
    ) {
      throw artifactNotFound();
    }
    scope.consumingReservations.add(reservation.reservationId);
    try {
      const descriptor = await this.publishFile(publication, reservation.path, {
        ...options,
        mediaType: reservation.mediaType,
        name: reservation.name,
      });
      scope.reservations.delete(reservation.reservationId);
      scope.consumingReservations.delete(reservation.reservationId);
      await rm(reservation.path, { force: true });
      return descriptor;
    } catch (error: unknown) {
      scope.reservations.delete(reservation.reservationId);
      scope.consumingReservations.delete(reservation.reservationId);
      try {
        await rm(reservation.path, { force: true });
      } catch (cleanupError: unknown) {
        console.error(
          `Chrome artifact reservation cleanup failed after publication failure: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
      throw error;
    }
  }

  async publishFile(publication: ArtifactPublication, sourcePath: string, options: PublishArtifactOptions) {
    await this.initialize();
    const state = this.#requireConnection(publication.connectionId, true);
    return this.#queue(state.connectionId).run(async () => {
      const scope = requirePublication(state, publication);
      this.#assertOwnedSourcePath(scope, sourcePath);
      if (scope.kind !== "capture" && options.complete === false) {
        throw new ArtifactError(
          ARTIFACT_ERROR_CODES.invalidInput,
          "Only capture finalization may publish a readable incomplete artifact",
        );
      }
      const name = validatedName(options.name ?? basename(sourcePath));
      const mediaType = resolvedMediaType(name, options.mediaType);
      if (scope.kind === "ordinary" && scope.artifactCount >= this.limits.ordinaryCallArtifacts) {
        throw quotaError(
          "Publication exceeds the ordinary-call artifact count limit",
          scope.artifactCount + 1,
          this.limits.ordinaryCallArtifacts,
        );
      }

      let artifactId = this.#nextId();
      let stageDirectory = join(
        this.#connectionDirectory(state.connectionId),
        STAGING_DIRECTORY_NAME,
        artifactId,
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (state.artifacts.has(artifactId)) {
          if (attempt === 99) throw new Error("Artifact publication could not allocate a unique ID");
          artifactId = this.#nextId();
          stageDirectory = join(
            this.#connectionDirectory(state.connectionId),
            STAGING_DIRECTORY_NAME,
            artifactId,
          );
          continue;
        }
        try {
          await mkdir(stageDirectory, { mode: 0o700 });
          break;
        } catch (error: unknown) {
          if (!isAlreadyExists(error) || attempt === 99) throw error;
          artifactId = this.#nextId();
          stageDirectory = join(
            this.#connectionDirectory(state.connectionId),
            STAGING_DIRECTORY_NAME,
            artifactId,
          );
        }
      }
      const destinationDirectory = this.#artifactDirectory(state.connectionId, artifactId);
      const contentPath = join(stageDirectory, "content");
      let exposed = false;

      try {
        const copied = await copyAndHash(
          sourcePath,
          contentPath,
          this.limits.artifactBytes,
          this.limits.chunkBytes,
        );
        this.#assertPublicationQuota(state, scope, copied.size);
        const createdAt = iso(this.#clock());
        const chunks: ArtifactChunk[] =
          copied.size > this.limits.directContentBytes ?
            copied.chunks.map((chunk) => ({
              ...chunk,
              uri: artifactChunkUri(state.connectionId, artifactId, chunk.index),
            }))
          : [];
        const manifest: ArtifactManifest = Object.freeze({
          artifactId,
          chunks: Object.freeze(chunks),
          complete: options.complete ?? true,
          createdAt,
          expiresAt: state.expiresAt,
          mediaType,
          name,
          origin: Object.freeze({ ...options.origin }),
          sha256: copied.sha256,
          size: copied.size,
          uri:
            copied.size <= this.limits.directContentBytes ?
              artifactContentUri(state.connectionId, artifactId)
            : artifactManifestUri(state.connectionId, artifactId),
        });
        await writeSynced(join(stageDirectory, "manifest.json"), stableJson(manifest), 0o400);
        await rename(stageDirectory, destinationDirectory);
        exposed = true;
        const stored = { contentPath: join(destinationDirectory, "content"), manifest };
        await this.#touchConnection(state);
        state.artifacts.set(artifactId, stored);
        state.usedBytes += copied.size;
        scope.artifactCount += 1;
        scope.bytes += copied.size;
        const descriptor = Object.freeze(descriptorFrom(manifest, state.expiresAt));
        scope.artifacts.push(descriptor);
        this.#emit({ connectionId: state.connectionId, kind: "published" });
        return descriptor;
      } catch (error: unknown) {
        try {
          await rm(stageDirectory, { force: true, recursive: true });
          if (exposed) await rm(destinationDirectory, { force: true, recursive: true });
        } catch (cleanupError: unknown) {
          console.error(
            `Chrome artifact publication cleanup failed after publication failure: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
        throw error;
      }
    });
  }

  async publishBytes(publication: ArtifactPublication, bytes: Uint8Array, options: PublishArtifactOptions) {
    const reservation = await this.reserveOutput(
      publication,
      options.name ?? "artifact.bin",
      options.mediaType,
    );
    try {
      await writeFile(reservation.path, bytes, { flag: "w", mode: 0o600 });
      const descriptor = await this.publishReservation(publication, reservation, {
        ...(options.complete === undefined ? {} : { complete: options.complete }),
        origin: options.origin,
      });
      await rm(reservation.path, { force: true });
      return descriptor;
    } catch (error: unknown) {
      const state = this.#connections.get(publication.connectionId);
      if (state) {
        const scope = state.publications.get(publication.publicationId);
        if (scope) {
          scope.reservations.delete(reservation.reservationId);
          scope.consumingReservations.delete(reservation.reservationId);
        }
      }
      try {
        await rm(reservation.path, { force: true });
      } catch (cleanupError: unknown) {
        console.error(
          `Chrome artifact byte reservation cleanup failed after publication failure: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
      throw error;
    }
  }

  publicationLedger(publication: ArtifactPublication) {
    const state = this.#requireConnection(publication.connectionId, true);
    const scope = requirePublication(state, publication);
    return createPublicationLedger(state, scope);
  }

  async finishPublication(publication: ArtifactPublication) {
    await this.initialize();
    const state = this.#requireConnection(publication.connectionId, true);
    return this.#queue(state.connectionId).run(async () => {
      const scope = requirePublication(state, publication);
      const ledger = createPublicationLedger(state, scope);
      await this.#removePublicationFiles(state, scope);
      state.publications.delete(scope.publicationId);
      return ledger;
    });
  }

  hasRetainedArtifacts(): boolean {
    return [...this.#connections.values()].some((state) => state.artifacts.size > 0);
  }

  async removeEmptyInstance() {
    if (!this.hasEmptyInstance()) {
      return;
    }

    await rm(this.instanceRoot, { force: true, recursive: true });
    this.instanceRootCreated = false;
  }

  removeEmptyInstanceSync() {
    if (!this.hasEmptyInstance()) {
      return;
    }

    rmSync(this.instanceRoot, { force: true, recursive: true });
    this.instanceRootCreated = false;
  }

  releaseInstanceSync() {
    if (!this.instanceRootCreated) return;

    const metadataPath = join(this.instanceRoot, INSTANCE_METADATA_NAME);
    let existing: InstanceMetadata | undefined;

    try {
      existing = parseInstanceMetadata(JSON.parse(readFileSync(metadataPath, "utf8")));
    } catch (error: unknown) {
      if (isNotFound(error)) return;

      throw error;
    }

    if (!existing) return;

    const isOwnUnreleasedInstance = existing.ownerId === this.#ownerId && existing.releasedAt === null;
    if (!isOwnUnreleasedInstance) return;

    writeAtomicSync(metadataPath, { ...existing, releasedAt: iso(this.#clock()) } satisfies InstanceMetadata);
  }

  private hasEmptyInstance() {
    return this.instanceRootCreated && !this.hasRetainedArtifacts();
  }

  dispose() {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose() {
    this.#disposed = true;
    this.#cancelCleanup?.();
    this.#cancelCleanup = undefined;
    let failure: Readonly<{ error: unknown }> | undefined;
    const recordFailure = (error: unknown) => {
      failure ??= { error };
    };
    const cleanupResults = await Promise.allSettled(this.#cleanupTasks);
    for (const result of cleanupResults) {
      if (result.status === "rejected") recordFailure(result.reason);
    }
    if (this.#initialized === undefined) {
      this.#listeners.clear();
      if (failure) throw failure.error;
      return;
    }
    let initialized = true;
    try {
      await this.#initialized;
    } catch (error: unknown) {
      initialized = false;
      recordFailure(error);
    }
    if (initialized) {
      try {
        await this.#lifecycleQueue.run(async () => {
          let lifecycleFailure: Readonly<{ error: unknown }> | undefined;
          for (const state of this.#connections.values()) {
            try {
              await this.#queue(state.connectionId).run(() => this.deactivateConnection(state));
            } catch (error: unknown) {
              lifecycleFailure ??= { error };
            }
          }
          try {
            this.releaseInstanceSync();
          } catch (error: unknown) {
            lifecycleFailure ??= { error };
          }
          if (lifecycleFailure) throw lifecycleFailure.error;
        });
      } catch (error: unknown) {
        recordFailure(error);
      }
    }
    this.#listeners.clear();
    if (failure) throw failure.error;
  }

  async close() {
    await this.dispose();
  }

  async deleteArtifact(connection: ArtifactConnection, artifactId: string) {
    await this.initialize();
    const state = this.#requireConnection(connection.connectionId, true);
    await this.#queue(state.connectionId).run(async () => {
      const artifact = state.artifacts.get(artifactId);
      if (!artifact) throw artifactNotFound();
      await rm(this.#artifactDirectory(state.connectionId, artifactId), { force: true, recursive: true });
      state.artifacts.delete(artifactId);
      state.usedBytes -= artifact.manifest.size;
      this.#emit({ connectionId: state.connectionId, kind: "deleted" });
    });
  }

  async list(connection: ArtifactConnection) {
    await this.initialize();
    const state = this.#requireReadableConnection(connection.connectionId);
    return [...state.artifacts.values()]
      .map(({ manifest }) => descriptorFrom(manifest, state.expiresAt))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.artifactId.localeCompare(right.artifactId),
      );
  }

  async manifest(connection: ArtifactConnection, artifactId: string) {
    await this.initialize();
    const state = this.#requireReadableConnection(connection.connectionId);
    const artifact = state.artifacts.get(artifactId);
    if (!artifact) throw artifactNotFound();
    return Object.freeze({ ...artifact.manifest, expiresAt: state.expiresAt }) satisfies ArtifactManifest;
  }

  async readResource(connection: ArtifactConnection, uri: string) {
    await this.initialize();
    const state = this.#requireReadableConnection(connection.connectionId);
    const parsed = parseOwnedUri(state, uri);
    const artifact = state.artifacts.get(parsed.artifactId);
    if (!artifact) throw artifactNotFound();
    const manifest = Object.freeze({ ...artifact.manifest, expiresAt: state.expiresAt });

    if (parsed.kind === "manifest") {
      return {
        mimeType: "application/json",
        text: stableJson(manifest),
        uri,
      } satisfies ArtifactResource;
    }

    if (parsed.kind === "content") {
      if (manifest.size > this.limits.directContentBytes) throw artifactNotFound();
      let bytes: Buffer;
      try {
        bytes = await readFile(artifact.contentPath);
      } catch {
        throw artifactNotFound();
      }
      if (
        bytes.byteLength !== manifest.size ||
        createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
      ) {
        throw artifactNotFound();
      }
      if (isTextMediaType(manifest.mediaType)) {
        try {
          return {
            mimeType: manifest.mediaType,
            text: new TextDecoder("utf8", { fatal: true }).decode(bytes),
            uri,
          } satisfies ArtifactResource;
        } catch {
          return {
            blob: bytes.toString("base64"),
            mimeType: manifest.mediaType,
            uri,
          } satisfies ArtifactResource;
        }
      }
      return { blob: bytes.toString("base64"), mimeType: manifest.mediaType, uri } satisfies ArtifactResource;
    }

    const chunk = manifest.chunks[parsed.index];
    if (!chunk) throw artifactNotFound();
    let handle;
    try {
      handle = await open(artifact.contentPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw artifactNotFound();
    }
    try {
      const bytes = Buffer.allocUnsafe(chunk.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, chunk.start + offset);
        if (result.bytesRead === 0) throw artifactNotFound();
        offset += result.bytesRead;
      }
      if (createHash("sha256").update(bytes).digest("hex") !== chunk.sha256) throw artifactNotFound();
      return { blob: bytes.toString("base64"), mimeType: manifest.mediaType, uri } satisfies ArtifactResource;
    } finally {
      await handle.close();
    }
  }

  subscribe(listener: (event: ArtifactStoreEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  sweepExpired() {
    return this.#trackCleanup(this.#sweepExpired());
  }

  async #sweepExpired() {
    await this.initialize();
    return this.#lifecycleQueue.run(async () => {
      const now = this.#clock();
      const expired = [...this.#connections.values()].filter(
        (state) => !state.active && state.expiresAt !== null && Date.parse(state.expiresAt) <= now,
      );
      for (const state of expired) {
        await rm(this.#connectionDirectory(state.connectionId), { force: true, recursive: true });
        this.#connections.delete(state.connectionId);
        this.#queues.delete(state.connectionId);
        this.#emit({ connectionId: state.connectionId, kind: "expired" });
      }
      await this.#sweepInstance(this.instanceRoot, now, new Set(this.#connections.keys()), now);
      await this.#sweepPriorInstances(now);
      await this.#heartbeatInstance(now);
      return expired.length;
    });
  }

  async #initialize() {
    const stableParent = dirname(this.root);
    const runtimeRoot = dirname(stableParent);
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const runtimeRootMetadata = await lstat(runtimeRoot);
    if (runtimeRootMetadata.isSymbolicLink() || !runtimeRootMetadata.isDirectory()) {
      throw new Error(`Chrome MCP runtime root must be a non-symlink directory: ${runtimeRoot}`);
    }
    await mkdir(stableParent, { recursive: true, mode: 0o700 });
    const stableParentMetadata = await lstat(stableParent);
    if (stableParentMetadata.isSymbolicLink() || !stableParentMetadata.isDirectory()) {
      throw new Error(`Chrome MCP runtime parent must be a non-symlink directory: ${stableParent}`);
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Chrome artifact root must be a non-symlink directory: ${this.root}`);
    }
    await chmod(this.root, 0o700);
    const instancesRoot = resolveArtifactInstancesRoot(this.root);
    await mkdir(instancesRoot, { recursive: true, mode: 0o700 });
    const instancesMetadata = await lstat(instancesRoot);
    if (instancesMetadata.isSymbolicLink() || !instancesMetadata.isDirectory()) {
      throw new Error(`Chrome artifact instances root must be a non-symlink directory: ${instancesRoot}`);
    }
    await chmod(instancesRoot, 0o700);
    await this.#acquireInstance();
    try {
      const now = this.#clock();
      await this.#sweepInstance(this.instanceRoot, now, new Set(), now);
      await this.#sweepPriorInstances(now);
      if (!this.#disposed) {
        this.#cancelCleanup = this.#cleanupScheduler(this.#cleanupIntervalMs, async () => {
          if (this.#disposed) return;
          await this.sweepExpired();
        });
      }
    } catch (error: unknown) {
      try {
        this.releaseInstanceSync();
      } catch (releaseError: unknown) {
        console.error(
          `Chrome artifact instance release failed after initialization failure: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
        );
      }
      throw error;
    }
  }

  async #acquireInstance() {
    await mkdir(this.instanceRoot, { recursive: true, mode: 0o700 });
    this.instanceRootCreated = true;

    const rootMetadata = await lstat(this.instanceRoot);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new Error(`Chrome artifact instance root must be a non-symlink directory: ${this.instanceRoot}`);
    }
    await chmod(this.instanceRoot, 0o700);
    const metadataPath = join(this.instanceRoot, INSTANCE_METADATA_NAME);
    let existing: InstanceMetadata | undefined;
    try {
      existing = parseInstanceMetadata(JSON.parse(await readFile(metadataPath, "utf8")));
      if (!existing) throw new Error(`Chrome artifact instance owner metadata is invalid: ${metadataPath}`);
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
    }
    if (existing) {
      throw new Error(`Chrome artifact instance scope is already allocated: ${this.instanceRoot}`);
    }
    const now = iso(this.#clock());
    await writeSynced(
      metadataPath,
      stableJson({
        ownerId: this.#ownerId,
        pid: process.pid,
        releasedAt: null,
        startedAt: now,
        updatedAt: now,
      } satisfies InstanceMetadata),
      0o600,
    );
  }

  async #sweepPriorInstances(now: number) {
    const instancesRoot = resolveArtifactInstancesRoot(this.root);
    const entries = await readdir(instancesRoot, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(instancesRoot, entry.name);
      const isPriorInstanceDirectory =
        entry.isDirectory() && isArtifactInstanceScope(entry.name) && path !== this.instanceRoot;
      if (!isPriorInstanceDirectory) continue;

      try {
        let owner: InstanceMetadata | undefined;
        try {
          const decoded: unknown = JSON.parse(await readFile(join(path, INSTANCE_METADATA_NAME), "utf8"));
          owner = parseInstanceMetadata(decoded);
        } catch {
          owner = undefined;
        }
        if (!owner) {
          const metadata = await lstat(path);
          if (now - metadata.mtimeMs <= this.#expiryMs) continue;
          await rm(path, { force: true, recursive: true });
          continue;
        }
        if (owner.releasedAt === null && this.#isProcessAlive(owner.pid)) continue;
        if (!(await this.claimRecovery(path, now))) continue;

        try {
          const recoveryBoundary = Date.parse(owner.releasedAt ?? owner.updatedAt);
          await this.#sweepInstance(path, now, new Set(), recoveryBoundary);

          const remaining = await readdir(path);
          const hasOnlyOwnership = remaining.every(
            (name) => name === INSTANCE_METADATA_NAME || name === RECOVERY_LOCK_NAME,
          );
          if (hasOnlyOwnership) {
            await rm(path, { force: true, recursive: true });
          }
        } finally {
          await rm(join(path, RECOVERY_LOCK_NAME), { force: true });
        }
      } catch (error: unknown) {
        if (isNotFound(error)) continue;

        console.error(
          `Chrome artifact recovery skipped ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async claimRecovery(path: string, now: number) {
    const lockPath = join(path, RECOVERY_LOCK_NAME);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
        return true;
      } catch (error: unknown) {
        if (!isAlreadyExists(error)) throw error;
      }

      if (await this.isRecoveryLockHeld(lockPath, now)) return false;

      await rm(lockPath, { force: true });
    }

    return false;
  }

  private async isRecoveryLockHeld(lockPath: string, now: number) {
    try {
      const holder = Number.parseInt(await readFile(lockPath, "utf8"), 10);
      if (Number.isInteger(holder)) return this.#isProcessAlive(holder);

      const metadata = await lstat(lockPath);
      return now - metadata.mtimeMs < this.#cleanupIntervalMs;
    } catch (error: unknown) {
      if (isNotFound(error)) return false;

      throw error;
    }
  }

  async #sweepInstance(
    path: string,
    now: number,
    activeConnections: ReadonlySet<string>,
    recoveryBoundary: number,
  ) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !TOKEN_PATTERN.test(entry.name) || activeConnections.has(entry.name)) {
        continue;
      }
      const connectionPath = join(path, entry.name);

      let metadata: ConnectionMetadata | undefined;
      try {
        metadata = parseConnectionMetadata(
          JSON.parse(await readFile(join(connectionPath, CONNECTION_METADATA_NAME), "utf8")),
        );
      } catch {
        metadata = undefined;
      }
      if (!metadata || metadata.connectionId !== entry.name) {
        await rm(connectionPath, { force: true, recursive: true });
        continue;
      }

      const priorExpiry =
        metadata.expiresAt === null ? recoveryBoundary + this.#expiryMs : Date.parse(metadata.expiresAt);
      if (!Number.isFinite(priorExpiry) || priorExpiry <= now) {
        await rm(connectionPath, { force: true, recursive: true });
        continue;
      }
      if (metadata.expiresAt === null) {
        await writeAtomic(join(connectionPath, CONNECTION_METADATA_NAME), {
          ...metadata,
          closedAt: iso(recoveryBoundary),
          expiresAt: iso(priorExpiry),
        } satisfies ConnectionMetadata);
      }
      await rm(join(connectionPath, STAGING_DIRECTORY_NAME), { force: true, recursive: true });
      await mkdir(join(connectionPath, STAGING_DIRECTORY_NAME), { mode: 0o700, recursive: true });
    }
  }

  async #heartbeatInstance(now: number) {
    const metadataPath = join(this.instanceRoot, INSTANCE_METADATA_NAME);
    const existing = parseInstanceMetadata(JSON.parse(await readFile(metadataPath, "utf8")));
    if (!existing || existing.ownerId !== this.#ownerId) {
      throw new Error("Chrome artifact instance ownership was lost");
    }
    await writeAtomic(metadataPath, { ...existing, updatedAt: iso(now) } satisfies InstanceMetadata);
  }

  #assertPublicationQuota(state: ConnectionState, publication: PublicationState, bytes: number) {
    if (state.usedBytes + bytes > this.limits.connectionBytes) {
      throw quotaError(
        "Publication exceeds the connection artifact byte limit",
        state.usedBytes + bytes,
        this.limits.connectionBytes,
      );
    }
    if (publication.kind === "ordinary" && publication.bytes + bytes > this.limits.ordinaryCallBytes) {
      throw quotaError(
        "Publication exceeds the ordinary-call artifact byte limit",
        publication.bytes + bytes,
        this.limits.ordinaryCallBytes,
      );
    }
  }

  #assertOwnedSourcePath(publication: PublicationState, sourcePath: string) {
    const fromRoot = relative(resolve(this.instanceRoot), resolve(sourcePath));
    if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) return;
    const ownsReservation = [...publication.reservations.values()].some(
      (reservation) => resolve(reservation.path) === resolve(sourcePath),
    );
    if (!ownsReservation) {
      throw new ArtifactError(
        ARTIFACT_ERROR_CODES.invalidInput,
        "Files inside the artifact store may only be published through their owning reservation",
      );
    }
  }

  #connectionDirectory(connectionId: string) {
    return join(this.instanceRoot, connectionId);
  }

  #artifactDirectory(connectionId: string, artifactId: string) {
    return join(this.#connectionDirectory(connectionId), ARTIFACTS_DIRECTORY_NAME, artifactId);
  }

  #publicationDirectory(connectionId: string, publicationId: string) {
    return join(this.#connectionDirectory(connectionId), STAGING_DIRECTORY_NAME, publicationId);
  }

  #queue(connectionId: string) {
    let queue = this.#queues.get(connectionId);
    if (!queue) {
      queue = new SerialQueue();
      this.#queues.set(connectionId, queue);
    }
    return queue;
  }

  #trackCleanup<Result>(cleanup: Promise<Result>): Promise<Result> {
    let tracked = cleanup;
    tracked = cleanup.then(
      (result) => {
        this.#cleanupTasks.delete(tracked);
        return result;
      },
      (error: unknown) => {
        this.#cleanupTasks.delete(tracked);
        throw error;
      },
    );
    this.#cleanupTasks.add(tracked);
    return tracked;
  }

  #requireConnection(connectionId: string, hideFailure: boolean) {
    if (!TOKEN_PATTERN.test(connectionId)) {
      if (hideFailure) throw artifactNotFound();
      throw new ArtifactError(ARTIFACT_ERROR_CODES.invalidInput, "Invalid artifact connection ID");
    }
    const state = this.#connections.get(connectionId);
    if (!state) throw artifactNotFound();
    return state;
  }

  #requireReadableConnection(connectionId: string) {
    const state = this.#requireConnection(connectionId, true);
    if (!state.active || (state.expiresAt !== null && Date.parse(state.expiresAt) <= this.#clock())) {
      throw artifactNotFound();
    }
    return state;
  }

  #nextId() {
    const value = this.#idGenerator();
    if (!TOKEN_PATTERN.test(value)) {
      throw new Error("Artifact ID generator must return 32 lowercase hexadecimal characters");
    }
    return value;
  }

  #assertOpen() {
    if (this.#disposed) throw new Error("Artifact store is disposed");
  }

  async #removePublicationFiles(state: ConnectionState, publication: PublicationState) {
    publication.reservations.clear();
    publication.consumingReservations.clear();
    await rm(this.#publicationDirectory(state.connectionId, publication.publicationId), {
      force: true,
      recursive: true,
    });
  }

  async #touchConnection(state: ConnectionState) {
    await this.#writeConnectionMetadata(state, iso(this.#clock()), state.active ? null : state.expiresAt);
  }

  async #writeConnectionMetadata(state: ConnectionState, updatedAt: string, closedAt: string | null) {
    const connectionDirectory = this.#connectionDirectory(state.connectionId);
    const existingCreatedAt = await readFile(join(connectionDirectory, CONNECTION_METADATA_NAME), "utf8")
      .then((contents) => parseConnectionMetadata(JSON.parse(contents))?.createdAt)
      .catch(() => undefined);
    const metadata: ConnectionMetadata = {
      closedAt,
      connectionId: state.connectionId,
      createdAt: existingCreatedAt ?? updatedAt,
      expiresAt: state.expiresAt,
      updatedAt,
    };
    await writeAtomic(join(connectionDirectory, CONNECTION_METADATA_NAME), metadata);
  }

  #emit(event: ArtifactStoreEvent) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error: unknown) {
        console.error(
          `Chrome artifact event listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
