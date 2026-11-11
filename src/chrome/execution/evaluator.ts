import type { ExecutionRpcClient } from "./rpc-client";
import { pageViewportStateSchema } from "../runtime/page-viewport";
import { ChromeMcpExecutionError, type ExecutionErrorCode, serializeExecutionError } from "./errors";
import { type ChromeExecutionHelper, createChromeHelperRuntime, encodeImage } from "./helpers";
import { detectImageMediaType } from "./image-codec";
import { canonicalJsonStringify, copyJsonValue, type JsonValue, normalizeJsonResult } from "./json";
import { type ConnectedExecutionBrowserSession, connectExecutionBrowserSession } from "./playwright-session";
import {
  type ArtifactDescriptor,
  type ExecutionKernelFailure,
  type ExecutionKernelResult,
  type ExecutionKernelSuccess,
  type ExecutionWorkerRequest,
  type ImageMediaType,
  INLINE_IMAGE_MAX_BYTES,
  INLINE_IMAGE_MAX_COUNT,
  INLINE_IMAGE_MAX_TOTAL_BYTES,
  INLINE_TEXT_MAX_BYTES,
  type InlineStagedContent,
  RUN_ARTIFACT_MAX_BYTES,
  type StagedContent,
} from "./protocol";

const USER_SOURCE_NAME = "chrome-mcp-user-code.js";

export type CompiledUserCode = (
  page: unknown,
  context: unknown,
  browser: unknown,
  args: JsonValue,
  chrome: ChromeExecutionHelper,
) => Promise<unknown>;

export type ExecutionBrowserConnector = (
  request: ExecutionWorkerRequest,
) => Promise<ConnectedExecutionBrowserSession>;

const asyncFunctionConstructor = (): Function => {
  const asyncFunctionPrototype: unknown = Object.getPrototypeOf(async () => undefined);
  if (typeof asyncFunctionPrototype !== "object" || asyncFunctionPrototype === null) {
    throw new ChromeMcpExecutionError("CHROME_MCP_WORKER_CRASH", "Async function runtime is unavailable");
  }
  const constructor: unknown = Reflect.get(asyncFunctionPrototype, "constructor");
  if (typeof constructor !== "function") {
    throw new ChromeMcpExecutionError("CHROME_MCP_WORKER_CRASH", "Async function constructor is unavailable");
  }
  return constructor;
};

export const compileUserCode = (code: string): CompiledUserCode => {
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_MALFORMED_CODE",
      "Playwright code must be a non-empty statement body",
    );
  }
  let compiled: Function;
  try {
    const AsyncFunction = asyncFunctionConstructor();
    const compiledValue: unknown = Reflect.construct(AsyncFunction, [
      "page",
      "context",
      "browser",
      "args",
      "chrome",
      `"use strict";\n${code}\n//# sourceURL=${USER_SOURCE_NAME}`,
    ]);
    if (typeof compiledValue !== "function") {
      throw new TypeError("Async function compiler did not return a function");
    }
    compiled = compiledValue;
  } catch (error: unknown) {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_MALFORMED_CODE",
      error instanceof Error ? error.message : "Playwright code could not be parsed",
      { cause: error },
    );
  }
  return async (page, context, browser, args, chrome) =>
    Reflect.apply(compiled, undefined, [page, context, browser, args, chrome]);
};

const artifactExtension = (mediaType: ImageMediaType): string => {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  return "png";
};

const publishArtifact = async (
  rpc: ExecutionRpcClient,
  input: { data: string; encoding: "base64" | "utf8"; mediaType: string; name: string },
): Promise<ArtifactDescriptor> => {
  const measuredBytes =
    input.encoding === "base64" ?
      Buffer.from(input.data, "base64").byteLength
    : Buffer.byteLength(input.data, "utf8");
  if (measuredBytes > RUN_ARTIFACT_MAX_BYTES) {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_ARTIFACT_QUOTA",
      `Execution artifact is ${measuredBytes} bytes; per-call maximum is ${RUN_ARTIFACT_MAX_BYTES} bytes`,
    );
  }
  const response = await rpc.request({ operation: "artifact_publish", payload: input });
  const artifact = response.artifacts[0];
  if (!artifact) {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_ARTIFACT_NOT_FOUND",
      "Artifact broker did not return a descriptor after publication",
    );
  }
  return artifact;
};

const normalizeEmittedContent = async (
  rpc: ExecutionRpcClient,
  staged: StagedContent[],
): Promise<{
  content: StagedContent[];
  inlineImageCount: number;
  remainingImageBytes: number;
  remainingTextBytes: number;
}> => {
  const content: StagedContent[] = [];
  let remainingImageBytes = INLINE_IMAGE_MAX_TOTAL_BYTES;
  let remainingTextBytes = INLINE_TEXT_MAX_BYTES;
  let inlineImageCount = 0;
  let textArtifactIndex = 1;
  let imageArtifactIndex = 1;

  for (const item of staged) {
    if (item.type === "resource") {
      content.push(item);
      continue;
    }
    if (item.type === "text") {
      const measuredBytes = Buffer.byteLength(item.text, "utf8");
      if (measuredBytes <= remainingTextBytes) {
        content.push(item);
        remainingTextBytes -= measuredBytes;
      } else {
        const artifact = await publishArtifact(rpc, {
          data: item.text,
          encoding: "utf8",
          mediaType: "text/plain",
          name: `playwright-output-${textArtifactIndex}.txt`,
        });
        textArtifactIndex += 1;
        content.push({ artifact, type: "resource" });
      }
      continue;
    }

    const measuredBytes = Buffer.from(item.data, "base64").byteLength;
    if (
      measuredBytes <= INLINE_IMAGE_MAX_BYTES &&
      measuredBytes <= remainingImageBytes &&
      inlineImageCount < INLINE_IMAGE_MAX_COUNT
    ) {
      content.push(item);
      remainingImageBytes -= measuredBytes;
      inlineImageCount += 1;
    } else {
      const artifact = await publishArtifact(rpc, {
        data: item.data,
        encoding: "base64",
        mediaType: item.mediaType,
        name: `playwright-image-${imageArtifactIndex}.${artifactExtension(item.mediaType)}`,
      });
      imageArtifactIndex += 1;
      content.push({ artifact, type: "resource" });
    }
  }

  return { content, inlineImageCount, remainingImageBytes, remainingTextBytes };
};

const normalizeSuccessfulResult = async (options: {
  helperRuntime: ReturnType<typeof createChromeHelperRuntime>;
  returned: unknown;
  rpc: ExecutionRpcClient;
}): Promise<ExecutionKernelSuccess> => {
  const staged = options.helperRuntime.stagedContent();
  const normalized = await normalizeEmittedContent(options.rpc, staged);
  const result: ExecutionKernelSuccess = {
    artifacts: options.rpc.artifacts(),
    content: normalized.content,
    emittedCount: staged.length,
    ok: true,
    selectedTargetId: options.helperRuntime.selectedTargetId(),
    state: options.helperRuntime.stateSnapshot(),
  };

  if (options.returned === undefined) return result;
  if (options.returned instanceof Uint8Array && detectImageMediaType(options.returned) !== undefined) {
    const image = encodeImage(options.returned);
    if (
      image.size <= INLINE_IMAGE_MAX_BYTES &&
      image.size <= normalized.remainingImageBytes &&
      normalized.inlineImageCount < INLINE_IMAGE_MAX_COUNT
    ) {
      result.valueImage = { data: image.data, mediaType: image.mediaType };
    } else {
      result.valueArtifact = await publishArtifact(options.rpc, {
        data: image.data,
        encoding: "base64",
        mediaType: image.mediaType,
        name: `playwright-result.${artifactExtension(image.mediaType)}`,
      });
      result.artifacts = options.rpc.artifacts();
    }
    return result;
  }

  let value: JsonValue;
  try {
    value = normalizeJsonResult(options.returned, "Playwright return value");
  } catch (error: unknown) {
    throw new ChromeMcpExecutionError(
      "CHROME_MCP_INVALID_INPUT",
      `Playwright code completed, but its return value could not be serialized. ${error instanceof Error ? error.message : "Playwright return value is not JSON-safe"} Browser actions were not undone; do not repeat them solely to fix the returned value.`,
      { cause: error },
    );
  }
  const serialized = canonicalJsonStringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= normalized.remainingTextBytes) {
    result.value = value;
  } else {
    result.valueArtifact = await publishArtifact(options.rpc, {
      data: serialized,
      encoding: "utf8",
      mediaType: "application/json",
      name: "playwright-result.json",
    });
    result.artifacts = options.rpc.artifacts();
  }
  return result;
};

const failureResult = (
  request: ExecutionWorkerRequest,
  rpc: ExecutionRpcClient,
  error: unknown,
  fallbackCode: ExecutionErrorCode,
  staged?: readonly StagedContent[],
): ExecutionKernelFailure => {
  const result: ExecutionKernelFailure = {
    artifacts: rpc.artifacts(),
    error: serializeExecutionError(error, fallbackCode, [request.cdpEndpoint]),
    ok: false,
    selectedTargetId: request.selectedTargetId,
  };
  if (staged === undefined) return result;

  const candidates = staged.filter((item): item is InlineStagedContent => item.type !== "resource");
  const partialContent: InlineStagedContent[] = [];
  let remainingImageBytes = INLINE_IMAGE_MAX_TOTAL_BYTES;
  let remainingTextBytes = INLINE_TEXT_MAX_BYTES;
  let inlineImageCount = 0;
  for (const item of candidates) {
    if (item.type === "text") {
      const measuredBytes = Buffer.byteLength(item.text, "utf8");
      if (measuredBytes > remainingTextBytes) break;
      partialContent.push(item);
      remainingTextBytes -= measuredBytes;
      continue;
    }
    const measuredBytes = Buffer.from(item.data, "base64").byteLength;
    if (
      measuredBytes > INLINE_IMAGE_MAX_BYTES ||
      measuredBytes > remainingImageBytes ||
      inlineImageCount >= INLINE_IMAGE_MAX_COUNT
    ) {
      break;
    }
    partialContent.push(item);
    remainingImageBytes -= measuredBytes;
    inlineImageCount += 1;
  }
  result.partialContent = partialContent;
  result.partialEmittedCount = partialContent.length;
  result.partialOmittedCount = candidates.length - partialContent.length;
  return result;
};

export const executeWorkerRequest = async (
  request: ExecutionWorkerRequest,
  options: {
    connect?: ExecutionBrowserConnector;
    rpc: ExecutionRpcClient;
  },
): Promise<ExecutionKernelResult> => {
  let userCode: CompiledUserCode;
  try {
    userCode = compileUserCode(request.code);
  } catch (error: unknown) {
    return {
      artifacts: options.rpc.artifacts(),
      error: serializeExecutionError(error, "CHROME_MCP_MALFORMED_CODE", [request.cdpEndpoint]),
      ok: false,
      selectedTargetId: request.selectedTargetId,
    };
  }

  let session: ConnectedExecutionBrowserSession | undefined;
  let result: ExecutionKernelResult;
  let helperRuntime: ReturnType<typeof createChromeHelperRuntime> | undefined;
  let fallbackCode: ExecutionErrorCode = "CHROME_MCP_INVALID_INPUT";
  try {
    const connect =
      options.connect ??
      ((workerRequest: ExecutionWorkerRequest) =>
        connectExecutionBrowserSession(workerRequest, {
          authorizeOwnerClose: async (resource) => {
            await options.rpc.request({ operation: "owner_close_authorize", payload: { resource } });
          },
          emulateMedia: async (targetId, mediaOptions) => {
            await options.rpc.request({
              operation: "media_emulate",
              payload: { options: mediaOptions, targetId },
            });
          },
          pageViewport: async (payload) => {
            const response = await options.rpc.request({ operation: "page_viewport", payload });
            return pageViewportStateSchema.parse(response.value);
          },
        }));
    session = await connect(request);
    helperRuntime = createChromeHelperRuntime({
      capabilities: request.capabilities,
      dialog: request.dialog,
      fileChooser: request.fileChooser,
      initialState: request.state,
      rpc: options.rpc,
      selectedTargetId: request.selectedTargetId,
      session,
    });
    const userArgs = copyJsonValue(request.args, "Playwright args");
    fallbackCode = "CHROME_MCP_EXECUTION_FAILED";
    const returned = await userCode(
      session.page,
      session.context,
      session.browser,
      userArgs,
      helperRuntime.helper,
    );
    fallbackCode = "CHROME_MCP_INVALID_INPUT";
    await helperRuntime.cancelPending();
    result = await normalizeSuccessfulResult({ helperRuntime, returned, rpc: options.rpc });
  } catch (error: unknown) {
    let failure = error;
    if (helperRuntime) {
      try {
        await helperRuntime.cancelPending();
      } catch (cleanupError: unknown) {
        if (cleanupError !== error) {
          const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          const code = serializeExecutionError(
            error,
            session ? fallbackCode : "CHROME_MCP_BROWSER_DISCONNECTED",
          ).code;
          failure = new ChromeMcpExecutionError(
            code,
            `${error instanceof Error ? error.message : String(error)}; snapshot cleanup failed: ${message}`,
            { cause: cleanupError },
          );
        }
      }
    }
    result = failureResult(
      request,
      options.rpc,
      failure,
      session ? fallbackCode : "CHROME_MCP_BROWSER_DISCONNECTED",
      helperRuntime?.stagedContent(),
    );
  }

  if (session) {
    try {
      await session.disconnect();
    } catch (error: unknown) {
      if (result.ok) result = failureResult(request, options.rpc, error, "CHROME_MCP_BROWSER_DISCONNECTED");
    }
  }
  return result;
};
