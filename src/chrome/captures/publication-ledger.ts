import type {
  ArtifactDescriptor,
  ArtifactPublication,
  ArtifactPublicationScope,
  ArtifactPublicationSession,
  ArtifactPublisher,
} from "./types";
import { isRecord } from "../../platform/records";

const isDescriptor = (value: unknown): value is ArtifactDescriptor => {
  if (!isRecord(value)) return false;
  return (
    typeof value.artifactId === "string" &&
    typeof value.name === "string" &&
    typeof value.uri === "string" &&
    typeof value.mediaType === "string" &&
    typeof value.size === "number" &&
    typeof value.sha256 === "string" &&
    typeof value.complete === "boolean" &&
    typeof value.createdAt === "string" &&
    (value.expiresAt === null || typeof value.expiresAt === "string")
  );
};

const errorCode = (error: unknown) => {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

const errorDetails = (error: unknown): Readonly<Record<string, number | string>> | undefined => {
  if (!isRecord(error) || !isRecord(error.details)) return undefined;
  const entries = Object.entries(error.details);
  if (entries.length === 0 || entries.length > 32) return undefined;
  const details: Record<string, number | string> = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > 128) return undefined;
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > 512) return undefined;
      details[key] = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    details[key] = value;
  }
  return Object.freeze(details);
};

export type ArtifactPublicationError = Error &
  Readonly<{
    artifacts: readonly ArtifactDescriptor[];
    code: string | undefined;
    details: Readonly<Record<string, number | string>> | undefined;
  }>;

class LedgerError extends Error {
  readonly code: string | undefined;
  readonly details: Readonly<Record<string, number | string>> | undefined;
  readonly #ledger: ArtifactPublicationLedger;

  constructor(error: unknown, ledger: ArtifactPublicationLedger) {
    const source = error instanceof Error ? error : undefined;
    super(source?.message ?? String(error), source ? { cause: source } : undefined);
    this.name = source?.name ?? "Error";
    this.code = errorCode(error);
    this.details = errorDetails(error);
    this.#ledger = ledger;
  }

  get artifacts(): readonly ArtifactDescriptor[] {
    return this.#ledger.artifacts;
  }
}

export const artifactsFromError = (error: unknown): readonly ArtifactDescriptor[] => {
  if (!isRecord(error) || !Array.isArray(error.artifacts) || !error.artifacts.every(isDescriptor)) return [];
  return error.artifacts;
};

export const codeFromError = errorCode;

export class ArtifactPublicationLedger {
  readonly #descriptors: ArtifactDescriptor[] = [];
  readonly #session: Promise<ArtifactPublicationSession>;
  #finish?: Promise<void>;

  constructor(publisher: ArtifactPublisher, scope: ArtifactPublicationScope) {
    this.#session = publisher.begin(scope);
    this.#session.catch(() => undefined);
  }

  get artifacts(): readonly ArtifactDescriptor[] {
    return Object.freeze([...this.#descriptors]);
  }

  async publish(publication: ArtifactPublication) {
    if (this.#finish) throw new Error("Artifact publication has already finished.");
    const session = await this.#session;
    const descriptor = await session.publish(publication);
    this.#descriptors.push(descriptor);
    return descriptor;
  }

  finish() {
    this.#finish ??= this.#session.then((session) => session.finish());
    return this.#finish;
  }

  attach(error: unknown): ArtifactPublicationError {
    return new LedgerError(error, this);
  }

  async run<T>(operation: (ledger: ArtifactPublicationLedger) => Promise<T>) {
    let value: T;
    let hasOperationFailed = false;
    let cleanupFailure: ArtifactPublicationError | undefined;
    try {
      value = await operation(this);
    } catch (error) {
      hasOperationFailed = true;
      throw this.attach(error);
    } finally {
      try {
        await this.finish();
      } catch (error) {
        if (!hasOperationFailed) {
          cleanupFailure = this.attach(error);
        }
      }
    }

    if (cleanupFailure) throw cleanupFailure;

    return value;
  }
}
