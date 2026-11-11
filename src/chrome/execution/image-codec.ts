export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

const hasPrefix = (bytes: Uint8Array, expected: readonly number[]): boolean =>
  expected.every((byte, index) => bytes[index] === byte);

export const detectImageMediaType = (bytes: Uint8Array): ImageMediaType | undefined => {
  if (hasPrefix(bytes, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return "image/png";
  if (hasPrefix(bytes, [0xFF, 0xD8, 0xFF])) return "image/jpeg";
  if (
    hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
};

export const decodeCanonicalBase64 = (
  value: string,
  maximumBytes: number,
  label: string,
  allowEmpty: boolean,
): Buffer => {
  const maximumEncodedLength = Math.ceil(maximumBytes / 3) * 4;
  if (value.length > maximumEncodedLength) {
    throw new Error(`${label} exceeds ${maximumBytes} decoded bytes`);
  }
  if ((!allowEmpty && value.length === 0) || value.length % 4 !== 0) {
    throw new Error(`${label} must be canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} decoded bytes`);
  if (bytes.toString("base64") !== value) throw new Error(`${label} must be canonical base64`);
  return bytes;
};

export const validateImageBytes = (bytes: Uint8Array, declaredMediaType?: ImageMediaType): ImageMediaType => {
  const detectedMediaType = detectImageMediaType(bytes);
  if (!detectedMediaType) throw new Error("Image bytes must contain a valid PNG, JPEG, or WebP signature");
  if (declaredMediaType && declaredMediaType !== detectedMediaType) {
    throw new Error(
      `Declared image media type ${declaredMediaType} does not match ${detectedMediaType} bytes`,
    );
  }
  return detectedMediaType;
};

export const validateEncodedImage = (
  data: string,
  mediaType: ImageMediaType,
  maximumBytes: number,
  label: string,
): void => {
  const bytes = decodeCanonicalBase64(data, maximumBytes, label, false);
  validateImageBytes(bytes, mediaType);
};
