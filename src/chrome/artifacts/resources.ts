import type { FastMCP, FastMCPSessionAuth, LoadContext, Resource } from "#fastmcp";
import type { ArtifactConnection, ArtifactResource } from "./types";
import { artifactNotFound } from "./errors";
import { artifactChunkUri, artifactContentUri, artifactManifestUri } from "./uris";

type ResourceTemplateInput<T extends FastMCPSessionAuth> = Parameters<FastMCP<T>["addResourceTemplate"]>[0];

export type ArtifactResourceStore = Readonly<{
  list: (
    connection: ArtifactConnection,
  ) => Promise<readonly { artifactId: string; mediaType: string; name: string; uri: string }[]>;
  readResource: (connection: ArtifactConnection, uri: string) => Promise<ArtifactResource>;
}>;

export type ArtifactResourceOwnerResolver<T extends FastMCPSessionAuth> = (
  auth: T | undefined,
  context: LoadContext<T> | undefined,
) => ArtifactConnection;

export type ArtifactResourceRegistrar<T extends FastMCPSessionAuth> = Pick<FastMCP<T>, "addResourceTemplate">;
export type ArtifactResourceAdapterOptions<T extends FastMCPSessionAuth> = Readonly<{
  owner: ArtifactResourceOwnerResolver<T>;
  store: ArtifactResourceStore;
}>;

export type ArtifactSessionResourceAdapterOptions = Readonly<{
  store: ArtifactResourceStore;
}>;

export type ArtifactSessionResourceAdapter<T extends FastMCPSessionAuth> = Readonly<{
  manifestResources: (owner: ArtifactConnection) => Promise<readonly Resource<T>[]>;
}>;

const resourceResult = (resource: ArtifactResource) =>
  resource.text === undefined ?
    { blob: resource.blob, mimeType: resource.mimeType, uri: resource.uri }
  : { mimeType: resource.mimeType, text: resource.text, uri: resource.uri };

const requiredArgument = (value: string | undefined): string => {
  if (value === undefined) throw artifactNotFound();
  return value;
};

const loadResource = async <T extends FastMCPSessionAuth>(
  options: ArtifactResourceAdapterOptions<T>,
  uri: string,
  auth: T | undefined,
  context: LoadContext<T> | undefined,
) => {
  const owner = options.owner(auth, context);
  return resourceResult(await options.store.readResource(owner, uri));
};

export const artifactResourceTemplates = <T extends FastMCPSessionAuth>(
  options: ArtifactResourceAdapterOptions<T>,
): readonly ResourceTemplateInput<T>[] => [
  {
    arguments: [
      { name: "connectionId", required: true },
      { name: "artifactId", required: true },
    ],
    description: "Read the immutable manifest for one connection-owned Chrome MCP artifact.",
    mimeType: "application/json",
    name: "Chrome Artifact Manifest",
    uriTemplate: artifactManifestUri("{connectionId}", "{artifactId}"),
    load: async ({ artifactId, connectionId }, auth, context) =>
      loadResource(
        options,
        artifactManifestUri(requiredArgument(connectionId), requiredArgument(artifactId)),
        auth,
        context,
      ),
  },
  {
    arguments: [
      { name: "connectionId", required: true },
      { name: "artifactId", required: true },
    ],
    description: "Read direct content for a connection-owned Chrome MCP artifact no larger than 8 MiB.",
    load: async ({ artifactId, connectionId }, auth, context) =>
      loadResource(
        options,
        artifactContentUri(requiredArgument(connectionId), requiredArgument(artifactId)),
        auth,
        context,
      ),
    name: "Chrome Artifact Content",
    uriTemplate: artifactContentUri("{connectionId}", "{artifactId}"),
  },
  {
    arguments: [
      { name: "connectionId", required: true },
      { name: "artifactId", required: true },
      { name: "index", required: true },
    ],
    description: "Read one virtual 8 MiB chunk from a larger connection-owned Chrome MCP artifact.",
    load: async ({ artifactId, connectionId, index }, auth, context) =>
      loadResource(
        options,
        artifactChunkUri(
          requiredArgument(connectionId),
          requiredArgument(artifactId),
          requiredArgument(index),
        ),
        auth,
        context,
      ),
    name: "Chrome Artifact Chunk",
    uriTemplate: artifactChunkUri("{connectionId}", "{artifactId}", "{index}"),
  },
];

export const registerArtifactResourceTemplates = <T extends FastMCPSessionAuth>(
  server: ArtifactResourceRegistrar<T>,
  options: ArtifactResourceAdapterOptions<T>,
): void => {
  for (const template of artifactResourceTemplates(options)) server.addResourceTemplate(template);
};

export const artifactSessionManifestResources = async <T extends FastMCPSessionAuth>(
  options: ArtifactSessionResourceAdapterOptions,
  owner: ArtifactConnection,
) => {
  const artifacts = await options.store.list(owner);
  return artifacts.map(
    (artifact): Resource<T> => ({
      description: `${artifact.mediaType} Chrome MCP artifact manifest`,
      load: async () =>
        resourceResult(
          await options.store.readResource(
            owner,
            artifactManifestUri(owner.connectionId, artifact.artifactId),
          ),
        ),
      mimeType: "application/json",
      name: artifact.name,
      uri: artifactManifestUri(owner.connectionId, artifact.artifactId),
    }),
  );
};

export const createArtifactSessionResourceAdapter = <T extends FastMCPSessionAuth>(
  options: ArtifactSessionResourceAdapterOptions,
): ArtifactSessionResourceAdapter<T> =>
  Object.freeze({
    manifestResources: (owner) => artifactSessionManifestResources(options, owner),
  });
