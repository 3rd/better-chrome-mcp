import { describe, expect, test } from "bun:test";
import type { ArtifactDescriptor, ArtifactPublication, ArtifactPublisher } from "./types";
import { ArtifactPublicationLedger, artifactsFromError } from "./publication-ledger";

class ArtifactQuotaError extends Error {
  readonly code = "CHROME_MCP_ARTIFACT_QUOTA";
  readonly details = Object.freeze({ allowed: 4, measured: 5, scope: "ordinary-call" });

  constructor() {
    super("Artifact publication quota was exceeded.");
    this.name = "ArtifactQuotaError";
  }
}

const descriptor = (publication: ArtifactPublication): ArtifactDescriptor => ({
  artifactId: "artifact-1",
  name: publication.name,
  uri: "chrome-artifact://connection/artifact-1/content",
  mediaType: publication.mediaType,
  size: 1,
  sha256: "00",
  complete: publication.complete,
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
});

describe("ArtifactPublicationLedger", () => {
  test("preserves the operation error when finalization also fails", () => {
    const operationError = new Error("publication failed");
    let hasFinished = false;
    const artifacts: ArtifactPublisher = {
      begin: () =>
        Promise.resolve({
          publish: (publication) => Promise.resolve(descriptor(publication)),
          finish: () => {
            hasFinished = true;

            return Promise.reject(new Error("finalization failed"));
          },
        }),
    };
    const ledger = new ArtifactPublicationLedger(artifacts, {
      connectionId: "connection-1",
      kind: "capture",
    });
    const result = ledger.run(() => Promise.reject(operationError));
    expect(result).rejects.toMatchObject({ cause: operationError, message: "publication failed" });
    expect(hasFinished).toBeTrue();
  });

  test("attaches successful descriptors when publication-session finalization fails", async () => {
    const artifacts: ArtifactPublisher = {
      begin() {
        return Promise.resolve({
          publish: (publication) => Promise.resolve(descriptor(publication)),
          finish: () => Promise.reject(new ArtifactQuotaError()),
        });
      },
    };
    const ledger = new ArtifactPublicationLedger(artifacts, {
      connectionId: "connection-1",
      kind: "capture",
    });

    try {
      await ledger.run(async (publicationLedger) => {
        await publicationLedger.publish({
          connectionId: "connection-1",
          browserMode: "shared",
          targetId: "target-1",
          name: "capture.har",
          mediaType: "application/json",
          complete: true,
          origin: "capture",
          source: { kind: "bytes", bytes: new Uint8Array([1]) },
        });
        return "published";
      });
      throw new Error("Expected publication finalization to fail.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "CHROME_MCP_ARTIFACT_QUOTA",
        details: { allowed: 4, measured: 5, scope: "ordinary-call" },
      });
      expect(artifactsFromError(error)).toEqual([
        expect.objectContaining({ artifactId: "artifact-1", name: "capture.har", expiresAt: null }),
      ]);
    }
  });

  test("does not copy unvalidated error details onto the returned ledger error", async () => {
    const artifacts: ArtifactPublisher = {
      begin() {
        return Promise.resolve({
          publish: (publication) => Promise.resolve(descriptor(publication)),
          finish: () =>
            Promise.reject(
              Object.assign(new Error("invalid details"), {
                code: "CHROME_MCP_ARTIFACT_QUOTA",
                details: { allowed: 4, measured: { bytes: 5 } },
              }),
            ),
        });
      },
    };

    expect(
      new ArtifactPublicationLedger(artifacts, { connectionId: "connection-1", kind: "capture" }).run(
        async () => "published",
      ),
    ).rejects.toMatchObject({ code: "CHROME_MCP_ARTIFACT_QUOTA", details: undefined });
  });
});
