export type ArtifactOrigin = Readonly<{
  browserMode: string;
  targetId?: string;
  tool: string;
}>;

export type ArtifactDescriptor = Readonly<{
  artifactId: string;
  complete: boolean;
  createdAt: string;
  /** Null while the owning connection is live; fixed to the cleanup deadline when it closes. */
  expiresAt: string | null;
  mediaType: string;
  name: string;
  sha256: string;
  size: number;
  uri: string;
}>;

export type ArtifactChunk = Readonly<{
  /** Zero-based exclusive byte offset. */
  end: number;
  index: number;
  sha256: string;
  size: number;
  start: number;
  uri: string;
}>;

export type ArtifactManifest = Readonly<{
  artifactId: string;
  chunks: readonly ArtifactChunk[];
  complete: boolean;
  createdAt: string;
  /** Null while the owning connection is live; fixed to the cleanup deadline when it closes. */
  expiresAt: string | null;
  mediaType: string;
  name: string;
  origin: ArtifactOrigin;
  sha256: string;
  size: number;
  uri: string;
}>;

export type ArtifactConnection = Readonly<{
  connectionId: string;
}>;

export type ArtifactPublicationKind = "capture" | "ordinary";

export type ArtifactPublication = Readonly<{
  connectionId: string;
  publicationId: string;
}>;

export type ArtifactPublicationLedger = Readonly<{
  artifacts: readonly ArtifactDescriptor[];
  bytes: number;
  connectionId: string;
  kind: ArtifactPublicationKind;
  publicationId: string;
}>;

export type ArtifactReservation = Readonly<{
  connectionId: string;
  mediaType: string;
  name: string;
  path: string;
  publicationId: string;
  reservationId: string;
}>;

export type ArtifactStoreLimits = Readonly<{
  artifactBytes: number;
  chunkBytes: number;
  connectionBytes: number;
  directContentBytes: number;
  ordinaryCallArtifacts: number;
  ordinaryCallBytes: number;
}>;

export type ArtifactStoreEvent = Readonly<{
  connectionId: string;
  kind: "deleted" | "expired" | "published";
}>;

export type ArtifactResource =
  | Readonly<{ blob: string; mimeType: string; text?: never; uri: string }>
  | Readonly<{ blob?: never; mimeType: string; text: string; uri: string }>;
