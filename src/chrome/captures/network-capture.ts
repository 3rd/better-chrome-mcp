import type { ArtifactPublicationLedger } from "./publication-ledger";
import { captureError, CaptureFinalizeError } from "./errors";
import {
  type ArtifactDescriptor,
  type ArtifactPublication,
  CAPTURE_BODY_LIMITS,
  type CaptureScope,
  type HarCaptureOptions,
  MAX_CAPTURE_NETWORK_ENTRIES,
  MAX_HAR_BYTES,
  type NetworkBodiesCaptureOptions,
  type NetworkBody,
  type NetworkExchange,
} from "./types";

const encoder = new TextEncoder();

type BodyOmission = "body-too-large" | "body-unavailable" | "capture-budget-exhausted" | "mime-type-filtered";

interface LoadedBody {
  state: "loaded";
  bytes: Uint8Array;
  mediaType: string;
}

interface OmittedBody {
  state: "omitted";
  reason: BodyOmission;
  mediaType: string;
  declaredSize?: number;
}

type CapturedBody = LoadedBody | OmittedBody;

interface RecordedExchange {
  exchange: NetworkExchange;
  body?: CapturedBody;
}

export interface CapturePublicationResult {
  artifact: ArtifactDescriptor;
  artifacts: ArtifactDescriptor[];
  warnings: string[];
  byteCount: number;
}

const finiteInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
) => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw captureError(
      "CHROME_MCP_CAPTURE_INVALID_OPTIONS",
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return resolved;
};

export const normalizeNetworkBodiesOptions = (
  options: NetworkBodiesCaptureOptions,
): Required<Omit<NetworkBodiesCaptureOptions, "type">> => {
  const maxBodyBytes = finiteInteger(
    options.maxBodyBytes,
    CAPTURE_BODY_LIMITS.defaultBodyBytes,
    1,
    CAPTURE_BODY_LIMITS.maximumBodyBytes,
    "maxBodyBytes",
  );
  const maxTotalBytes = finiteInteger(
    options.maxTotalBytes,
    CAPTURE_BODY_LIMITS.defaultTotalBytes,
    1,
    CAPTURE_BODY_LIMITS.maximumTotalBytes,
    "maxTotalBytes",
  );
  if (maxBodyBytes > maxTotalBytes) {
    throw captureError(
      "CHROME_MCP_CAPTURE_INVALID_OPTIONS",
      "maxBodyBytes cannot be greater than maxTotalBytes.",
    );
  }

  const mimeTypes = [...new Set(options.mimeTypes ?? [])];
  for (const mediaType of mimeTypes) {
    if (typeof mediaType !== "string" || mediaType.trim() === "" || mediaType.length > 256) {
      throw captureError(
        "CHROME_MCP_CAPTURE_INVALID_OPTIONS",
        "Each MIME type must be a non-empty string no longer than 256 characters.",
      );
    }
  }

  return { maxBodyBytes, maxTotalBytes, mimeTypes };
};

const PLAYWRIGHT_GLOB_ESCAPED_CHARACTERS = new Set([
  "?",
  ".",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "*",
  "\\",
  "^",
  "+",
  "|",
  "$",
]);

export const playwrightGlobToRegexPattern = (glob: string) => {
  const tokens = ["^"];
  let inGroup = false;
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] ?? "";
    if (character === "\\" && index + 1 < glob.length) {
      const escaped = glob[++index] ?? "";
      tokens.push(PLAYWRIGHT_GLOB_ESCAPED_CHARACTERS.has(escaped) ? `\\${escaped}` : escaped);
      continue;
    }
    if (character === "*") {
      const characterBefore = glob[index - 1];
      let starCount = 1;
      while (glob[index + 1] === "*") {
        starCount += 1;
        index += 1;
      }
      if (starCount > 1) {
        const characterAfter = glob[index + 1];
        if (characterAfter === "/") {
          tokens.push(characterBefore === "/" ? "((.+/)|)" : "(.*/)");
          index += 1;
        } else {
          tokens.push("(.*)");
        }
      } else {
        tokens.push("([^/]*)");
      }
      continue;
    }
    if (character === "{") {
      if (inGroup) {
        throw captureError(
          "CHROME_MCP_CAPTURE_INVALID_OPTIONS",
          `Invalid URL glob ${JSON.stringify(glob)}: nested '{' is not supported.`,
        );
      }
      inGroup = true;
      tokens.push("(");
      continue;
    }
    if (character === "}") {
      if (!inGroup) {
        throw captureError(
          "CHROME_MCP_CAPTURE_INVALID_OPTIONS",
          `Invalid URL glob ${JSON.stringify(glob)}: unmatched '}'.`,
        );
      }
      inGroup = false;
      tokens.push(")");
      continue;
    }
    if (character === "," && inGroup) {
      tokens.push("|");
      continue;
    }
    tokens.push(PLAYWRIGHT_GLOB_ESCAPED_CHARACTERS.has(character) ? `\\${character}` : character);
  }
  if (inGroup) {
    throw captureError(
      "CHROME_MCP_CAPTURE_INVALID_OPTIONS",
      `Invalid URL glob ${JSON.stringify(glob)}: unmatched '{'.`,
    );
  }
  tokens.push("$");
  return tokens.join("");
};

export const normalizeHarOptions = (
  options: HarCaptureOptions,
): Required<Omit<HarCaptureOptions, "type">> => {
  const content = options.content ?? "attach";
  if (content !== "omit" && content !== "embed" && content !== "attach") {
    throw captureError("CHROME_MCP_CAPTURE_INVALID_OPTIONS", "HAR content must be omit, embed, or attach.");
  }
  const urlFilter = options.urlFilter ?? "**";
  if (urlFilter.length === 0 || urlFilter.length > 2048) {
    throw captureError(
      "CHROME_MCP_CAPTURE_INVALID_OPTIONS",
      "urlFilter must contain from 1 through 2,048 characters.",
    );
  }
  playwrightGlobToRegexPattern(urlFilter);
  return { content, urlFilter };
};

export const urlMatchesGlob = (url: string, glob: string) =>
  new RegExp(playwrightGlobToRegexPattern(glob)).test(url);

const normalizedMediaType = (exchange: NetworkExchange, body?: NetworkBody) =>
  body?.mediaType ?? exchange.response?.mediaType ?? "application/octet-stream";

const loadBoundedBody = async (
  exchange: NetworkExchange,
  maxBodyBytes: number,
  remainingBytes: number,
  signal: AbortSignal,
): Promise<CapturedBody> => {
  const mediaType = normalizedMediaType(exchange);
  const declaredSize = exchange.response?.bodySize;
  if (declaredSize !== undefined && declaredSize > maxBodyBytes) {
    return { state: "omitted", reason: "body-too-large", mediaType, declaredSize };
  }
  if (remainingBytes <= 0) {
    return { state: "omitted", reason: "capture-budget-exhausted", mediaType, declaredSize };
  }
  if (!exchange.loadBody) {
    return { state: "omitted", reason: "body-unavailable", mediaType, declaredSize };
  }

  let body: NetworkBody | undefined;
  try {
    body = await exchange.loadBody(signal);
  } catch {
    return { state: "omitted", reason: "body-unavailable", mediaType, declaredSize };
  }
  if (!body) return { state: "omitted", reason: "body-unavailable", mediaType, declaredSize };
  const bodyMediaType = normalizedMediaType(exchange, body);
  if (body.bytes.byteLength > maxBodyBytes) {
    return {
      state: "omitted",
      reason: "body-too-large",
      mediaType: bodyMediaType,
      declaredSize: body.bytes.byteLength,
    };
  }
  if (body.bytes.byteLength > remainingBytes) {
    return {
      state: "omitted",
      reason: "capture-budget-exhausted",
      mediaType: bodyMediaType,
      declaredSize: body.bytes.byteLength,
    };
  }
  return { state: "loaded", bytes: new Uint8Array(body.bytes), mediaType: bodyMediaType };
};

const artifactMetadata = (captureId: string, type: "har" | "network-bodies", warnings: string[]) => ({
  captureId,
  captureType: type,
  warnings,
});

const publicationBase = (
  scope: CaptureScope,
): Pick<ArtifactPublication, "browserMode" | "connectionId" | "origin" | "targetId"> => ({
  connectionId: scope.connectionId,
  browserMode: scope.browserMode,
  targetId: scope.targetId,
  origin: "capture",
});

const assertNotAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason;
};

const headerList = (headers: Record<string, string> | undefined) =>
  Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));

const isTextMediaType = (mediaType: string) => {
  const essence = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    essence.startsWith("text/") ||
    essence.endsWith("+json") ||
    essence.endsWith("+xml") ||
    essence === "application/json" ||
    essence === "application/javascript" ||
    essence === "application/xml" ||
    essence === "image/svg+xml"
  );
};

const bodyText = (body: LoadedBody) => {
  if (isTextMediaType(body.mediaType)) return new TextDecoder().decode(body.bytes);
  return Buffer.from(body.bytes).toString("base64");
};

const elapsedMilliseconds = (startedAt: string, completedAt: string | undefined) => {
  if (!completedAt) return 0;
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
};

export class HarRecorder {
  readonly options: Required<Omit<HarCaptureOptions, "type">>;
  private readonly records: RecordedExchange[] = [];
  private retainedBodyBytes = 0;
  private admittedEntries = 0;
  private droppedRecords = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: HarCaptureOptions) {
    this.options = normalizeHarOptions(options);
  }

  matches(exchange: NetworkExchange) {
    return urlMatchesGlob(exchange.request.url, this.options.urlFilter);
  }

  record(exchange: NetworkExchange, signal: AbortSignal) {
    if (!this.matches(exchange)) return undefined;
    if (this.admittedEntries >= MAX_CAPTURE_NETWORK_ENTRIES) {
      this.droppedRecords += 1;
      return undefined;
    }
    this.admittedEntries += 1;
    const operation = this.queue.then(() => this.recordOne(exchange, signal));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async recordOne(exchange: NetworkExchange, signal: AbortSignal) {
    if (this.options.content === "omit" || !exchange.response) {
      this.records.push({ exchange });
      return;
    }
    const body = await loadBoundedBody(
      exchange,
      MAX_HAR_BYTES,
      MAX_HAR_BYTES - this.retainedBodyBytes,
      signal,
    );
    if (body.state === "loaded") this.retainedBodyBytes += body.bytes.byteLength;
    this.records.push({ exchange, body });
  }

  async publish(
    publisher: ArtifactPublicationLedger,
    captureId: string,
    scope: CaptureScope,
    complete: boolean,
    signal?: AbortSignal,
  ): Promise<CapturePublicationResult> {
    const warnings = new Set<string>();
    if (this.droppedRecords > 0) {
      warnings.add(`${this.droppedRecords} network exchanges were omitted after the capture entry limit.`);
    }
    const entries: unknown[] = [];

    for (const [index, record] of this.records.entries()) {
      assertNotAborted(signal);
      const { exchange, body } = record;
      const response = exchange.response;
      let content: Record<string, unknown> = {
        size: response?.bodySize ?? (body?.state === "loaded" ? body.bytes.byteLength : 0),
        mimeType: response?.mediaType ?? body?.mediaType ?? "application/octet-stream",
      };

      if (body?.state === "omitted") {
        warnings.add(`${exchange.request.requestId}: ${body.reason}`);
        content = {
          ...content,
          comment: `Response content was not retained: ${body.reason}.`,
          _chromeMcp: { omitted: body.reason, declaredSize: body.declaredSize },
        };
      } else if (body?.state === "loaded" && this.options.content === "embed") {
        content = {
          ...content,
          text: bodyText(body),
          ...(isTextMediaType(body.mediaType) ? {} : { encoding: "base64" }),
        };
      } else if (body?.state === "loaded" && this.options.content === "attach") {
        const bodyArtifact = await publisher.publish({
          ...publicationBase(scope),
          name: `har-body-${index + 1}.bin`,
          mediaType: body.mediaType,
          complete,
          source: { kind: "bytes", bytes: body.bytes },
          metadata: { captureId, captureType: "har", requestId: exchange.request.requestId },
          signal,
        });
        content = {
          ...content,
          comment: "Response content is stored in the linked MCP artifact.",
          _chromeMcpArtifact: bodyArtifact,
        };
      }

      entries.push({
        startedDateTime: exchange.request.startedAt,
        time: elapsedMilliseconds(exchange.request.startedAt, response?.completedAt),
        request: {
          method: exchange.request.method,
          url: exchange.request.url,
          httpVersion: exchange.request.httpVersion ?? "HTTP/1.1",
          headers: headerList(exchange.request.headers),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize:
            exchange.request.postData === undefined ?
              0
            : encoder.encode(exchange.request.postData).byteLength,
          ...(exchange.request.postData === undefined ?
            {}
          : {
              postData: {
                mimeType: exchange.request.headers?.["content-type"] ?? "application/octet-stream",
                text: exchange.request.postData,
              },
            }),
        },
        response: {
          status: response?.status ?? 0,
          statusText: response?.statusText ?? exchange.failureText ?? "",
          httpVersion: response?.httpVersion ?? exchange.request.httpVersion ?? "HTTP/1.1",
          headers: headerList(response?.headers),
          cookies: [],
          content,
          redirectURL: response?.headers?.location ?? "",
          headersSize: -1,
          bodySize: response?.bodySize ?? -1,
          ...(exchange.failureText === undefined ? {} : { _failureText: exchange.failureText }),
        },
        cache: {},
        timings: {
          send: 0,
          wait: elapsedMilliseconds(exchange.request.startedAt, response?.completedAt),
          receive: 0,
        },
        serverIPAddress: response?.remoteAddress?.ip,
        connection:
          response?.remoteAddress?.port === undefined ? undefined : String(response.remoteAddress.port),
        _chromeMcp: {
          requestId: exchange.request.requestId,
          targetId: exchange.targetId,
          sequence: exchange.sequence,
        },
      });
    }

    const warningList = [...warnings];
    const har = {
      log: {
        version: "1.2",
        creator: { name: "chrome-mcp", version: "0.0.0" },
        pages: [],
        entries,
        _chromeMcp: { captureId, targetId: scope.targetId, warnings: warningList },
      },
    };
    const bytes = encoder.encode(JSON.stringify(har));
    if (bytes.byteLength > MAX_HAR_BYTES) {
      throw new CaptureFinalizeError(
        `Final HAR is ${bytes.byteLength} bytes; the maximum is ${MAX_HAR_BYTES} bytes.`,
      );
    }
    const artifact = await publisher.publish({
      ...publicationBase(scope),
      name: `${captureId}.har`,
      mediaType: "application/json",
      complete,
      source: { kind: "bytes", bytes },
      metadata: artifactMetadata(captureId, "har", warningList),
      signal,
    });
    return {
      artifact,
      artifacts: [...publisher.artifacts],
      warnings: warningList,
      byteCount: publisher.artifacts.reduce((total, descriptor) => total + descriptor.size, 0),
    };
  }
}

const mimeMatches = (mediaType: string, allowed: string[]) => {
  if (allowed.length === 0) return true;
  const essence = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return allowed.some((pattern) => {
    const normalized = pattern.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (normalized.endsWith("/*")) return essence.startsWith(normalized.slice(0, -1));
    return essence === normalized;
  });
};

export class NetworkBodiesRecorder {
  readonly options: Required<Omit<NetworkBodiesCaptureOptions, "type">>;
  private readonly records: RecordedExchange[] = [];
  private retainedBodyBytes = 0;
  private admittedEntries = 0;
  private droppedRecords = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: NetworkBodiesCaptureOptions) {
    this.options = normalizeNetworkBodiesOptions(options);
  }

  record(exchange: NetworkExchange, signal: AbortSignal) {
    if (this.admittedEntries >= MAX_CAPTURE_NETWORK_ENTRIES) {
      this.droppedRecords += 1;
      return undefined;
    }
    this.admittedEntries += 1;
    const operation = this.queue.then(() => this.recordOne(exchange, signal));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async recordOne(exchange: NetworkExchange, signal: AbortSignal) {
    if (!exchange.response) return;
    const mediaType = normalizedMediaType(exchange);
    if (!mimeMatches(mediaType, this.options.mimeTypes)) {
      this.records.push({
        exchange,
        body: {
          state: "omitted",
          reason: "mime-type-filtered",
          mediaType,
          declaredSize: exchange.response.bodySize,
        },
      });
      return;
    }
    const body = await loadBoundedBody(
      exchange,
      this.options.maxBodyBytes,
      this.options.maxTotalBytes - this.retainedBodyBytes,
      signal,
    );
    if (body.state === "loaded") this.retainedBodyBytes += body.bytes.byteLength;
    this.records.push({ exchange, body });
  }

  async publish(
    publisher: ArtifactPublicationLedger,
    captureId: string,
    scope: CaptureScope,
    complete: boolean,
    signal?: AbortSignal,
  ): Promise<CapturePublicationResult> {
    const warnings: string[] = [];
    if (this.droppedRecords > 0) {
      warnings.push(`${this.droppedRecords} network exchanges were omitted after the capture entry limit.`);
    }
    const bodies: Record<string, unknown>[] = [];

    for (const [index, record] of this.records.entries()) {
      assertNotAborted(signal);
      const { exchange, body } = record;
      if (!body || body.state === "omitted") {
        const reason = body?.reason ?? "body-unavailable";
        warnings.push(`${exchange.request.requestId}: ${reason}`);
        bodies.push({
          requestId: exchange.request.requestId,
          url: exchange.request.url,
          status: exchange.response?.status,
          mediaType: body?.mediaType ?? exchange.response?.mediaType,
          omitted: reason,
          declaredSize: body?.declaredSize ?? exchange.response?.bodySize,
        });
        continue;
      }
      const artifact = await publisher.publish({
        ...publicationBase(scope),
        name: `network-body-${index + 1}.bin`,
        mediaType: body.mediaType,
        complete,
        source: { kind: "bytes", bytes: body.bytes },
        metadata: { captureId, captureType: "network-bodies", requestId: exchange.request.requestId },
        signal,
      });
      bodies.push({
        requestId: exchange.request.requestId,
        url: exchange.request.url,
        status: exchange.response?.status,
        mediaType: body.mediaType,
        size: body.bytes.byteLength,
        artifact,
      });
    }

    const manifestBytes = encoder.encode(
      JSON.stringify({ captureId, targetId: scope.targetId, bodies, warnings }),
    );
    const artifact = await publisher.publish({
      ...publicationBase(scope),
      name: `${captureId}-network-bodies.json`,
      mediaType: "application/json",
      complete,
      source: { kind: "bytes", bytes: manifestBytes },
      metadata: artifactMetadata(captureId, "network-bodies", warnings),
      signal,
    });
    return {
      artifact,
      artifacts: [...publisher.artifacts],
      warnings,
      byteCount: publisher.artifacts.reduce((total, descriptor) => total + descriptor.size, 0),
    };
  }
}
