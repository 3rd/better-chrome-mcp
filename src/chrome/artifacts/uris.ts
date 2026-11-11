export const ARTIFACT_URI_PROTOCOL = "chrome-artifact:";

export const artifactManifestUri = (connectionId: string, artifactId: string) => {
  return `${ARTIFACT_URI_PROTOCOL}//${connectionId}/${artifactId}/manifest`;
};

export const artifactContentUri = (connectionId: string, artifactId: string) => {
  return `${ARTIFACT_URI_PROTOCOL}//${connectionId}/${artifactId}/content`;
};

export const artifactChunkUri = (connectionId: string, artifactId: string, index: number | string) => {
  return `${ARTIFACT_URI_PROTOCOL}//${connectionId}/${artifactId}/chunks/${index}`;
};
