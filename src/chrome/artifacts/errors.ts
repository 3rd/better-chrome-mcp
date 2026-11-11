import { ARTIFACT_ERROR_CODES, type ArtifactErrorCode } from "./constants";

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;
  readonly details: Readonly<Record<string, number | string>> | undefined;

  constructor(code: ArtifactErrorCode, message: string, details?: Readonly<Record<string, number | string>>) {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
    this.details = details;
  }
}

export const artifactNotFound = () => {
  return new ArtifactError(ARTIFACT_ERROR_CODES.notFound, "Artifact was not found or is no longer available");
};
