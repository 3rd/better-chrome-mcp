import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStoreOptions } from "./store";
import { CapturingFastMCP } from "../../mcp/capturing-server";
import { ARTIFACT_ERROR_CODES } from "./constants";
import { ArtifactError } from "./errors";
import {
  artifactResourceTemplates,
  createArtifactSessionResourceAdapter,
  registerArtifactResourceTemplates,
} from "./resources";
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

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "chrome-artifact-resources-test-"));
  roots.push(root);
  const store = createStore({
    limits: { chunkBytes: 16, directContentBytes: 16 },
    root: join(root, "store"),
  });
  const connection = await store.openConnection();
  const publication = await store.beginPublication(connection);
  const descriptor = await store.publishBytes(publication, Buffer.from("resource body"), {
    mediaType: "text/plain",
    name: "resource.txt",
    origin: { browserMode: "isolated", tool: "run_playwright" },
  });
  return { connection, descriptor, store };
};

describe("FastMCP artifact resource adapter", () => {
  test("registers resource templates through the public FastMCP API", async () => {
    const { connection, store } = await fixture();
    const server = new CapturingFastMCP({ name: "artifact-test", version: "1.0.0" });

    registerArtifactResourceTemplates(server, { owner: () => connection, store });

    expect(server.captured.resourceTemplates.map(({ name }) => name)).toEqual([
      "Chrome Artifact Manifest",
      "Chrome Artifact Content",
      "Chrome Artifact Chunk",
    ]);
    expect(server.captured.resources).toEqual([]);
  });

  test("loads direct content and manifests through the actual template callbacks", async () => {
    const { connection, descriptor, store } = await fixture();
    const templates = artifactResourceTemplates({ owner: () => connection, store });
    const manifestTemplate = templates.find(({ name }) => name === "Chrome Artifact Manifest");
    const contentTemplate = templates.find(({ name }) => name === "Chrome Artifact Content");
    if (!manifestTemplate || !contentTemplate) throw new Error("Artifact resource templates are incomplete");

    const args = { artifactId: descriptor.artifactId, connectionId: connection.connectionId };
    const manifest = await manifestTemplate.load(args);
    const content = await contentTemplate.load(args);
    expect("text" in manifest ? JSON.parse(manifest.text).sha256 : undefined).toBe(descriptor.sha256);
    expect(content).toEqual({ mimeType: "text/plain", text: "resource body", uri: descriptor.uri });
  });

  test("creates only owner-scoped manifest list entries", async () => {
    const { connection, descriptor, store } = await fixture();
    const adapter = createArtifactSessionResourceAdapter({ store });
    const resources = await adapter.manifestResources(connection);

    expect(resources).toHaveLength(1);
    expect(resources[0]?.uri).toBe(
      `chrome-artifact://${connection.connectionId}/${descriptor.artifactId}/manifest`,
    );
    const loaded = await resources[0]?.load();
    expect(loaded && "text" in loaded ? JSON.parse(loaded.text).artifactId : undefined).toBe(
      descriptor.artifactId,
    );
  });

  test("rechecks the session owner when a listed manifest is loaded", async () => {
    const { connection, store } = await fixture();
    const adapter = createArtifactSessionResourceAdapter({ store });
    const resources = await adapter.manifestResources(connection);
    await store.closeConnection(connection);

    try {
      await resources[0]?.load();
      throw new Error("Expected closed owner resource read to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ArtifactError);
      if (!(error instanceof ArtifactError)) throw error;
      expect(error.code).toBe(ARTIFACT_ERROR_CODES.notFound);
    }
  });

  test("loads a virtual chunk through the chunk template without a physical slice file", async () => {
    const { connection, store } = await fixture();
    const publication = await store.beginPublication(connection, "capture");
    const bytes = Buffer.alloc(17, 0x63);
    const descriptor = await store.publishBytes(publication, bytes, {
      mediaType: "application/octet-stream",
      name: "chunked.bin",
      origin: { browserMode: "isolated", tool: "run_playwright" },
    });
    const chunkTemplate = artifactResourceTemplates({ owner: () => connection, store }).find(
      ({ name }) => name === "Chrome Artifact Chunk",
    );
    if (!chunkTemplate) throw new Error("Artifact chunk template is missing");

    const first = await chunkTemplate.load({
      artifactId: descriptor.artifactId,
      connectionId: connection.connectionId,
      index: "0",
    });
    expect("blob" in first ? Buffer.from(first.blob, "base64") : undefined).toEqual(bytes.subarray(0, 16));
  });

  test("does not reveal a foreign connection through template errors", async () => {
    const { connection, descriptor, store } = await fixture();
    const stranger = await store.openConnection();
    const contentTemplate = artifactResourceTemplates({ owner: () => stranger, store }).find(
      ({ name }) => name === "Chrome Artifact Content",
    );
    if (!contentTemplate) throw new Error("Artifact content template is missing");

    try {
      await contentTemplate.load({
        artifactId: descriptor.artifactId,
        connectionId: connection.connectionId,
      });
      throw new Error("Expected foreign resource read to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ArtifactError);
      if (!(error instanceof ArtifactError)) throw error;
      expect(error.code).toBe(ARTIFACT_ERROR_CODES.notFound);
      expect(error instanceof Error ? error.message : "").not.toContain(connection.connectionId);
    }
  });
});
