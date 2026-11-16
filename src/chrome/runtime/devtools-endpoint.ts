import { isRecord } from "../../platform/records";
import { BROWSER_LAUNCH_TIMEOUT_MS } from "./browser-launcher";
import { redactEndpointUrl } from "./endpoint-redaction";
import { ChromeRuntimeError } from "./errors";

export const fetchWebSocketDebuggerUrl = async (versionUrl: URL, signal: AbortSignal): Promise<string> => {
  const response = await fetch(versionUrl, { signal });
  const body: unknown = await response.json().catch(() => undefined);
  const webSocketDebuggerUrl = isRecord(body) ? body.webSocketDebuggerUrl : undefined;
  if (
    typeof webSocketDebuggerUrl !== "string" ||
    !(webSocketDebuggerUrl.startsWith("ws://") || webSocketDebuggerUrl.startsWith("wss://"))
  ) {
    throw new Error(`${redactEndpointUrl(versionUrl.href)} did not return a webSocketDebuggerUrl`);
  }
  return webSocketDebuggerUrl;
};

export const loopbackEndpoint = (webSocketDebuggerUrl: string, port: number): string => {
  const { pathname, search } = new URL(webSocketDebuggerUrl);
  return `ws://127.0.0.1:${port}${pathname}${search}`;
};

export const resolveRemoteCdpEndpoint = async (
  cdpEndpoint: string,
  timeoutMs = BROWSER_LAUNCH_TIMEOUT_MS,
): Promise<string> => {
  const endpoint = new URL(cdpEndpoint);
  if (endpoint.protocol === "ws:" || endpoint.protocol === "wss:") return cdpEndpoint;
  const base = endpoint.href.endsWith("/") ? endpoint.href : `${endpoint.href}/`;
  const versionUrl = new URL("json/version", base);
  try {
    return await fetchWebSocketDebuggerUrl(versionUrl, AbortSignal.timeout(timeoutMs));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ChromeRuntimeError(
      "CHROME_MCP_REMOTE_UNAVAILABLE",
      `Could not read the browser's DevTools endpoint from ${redactEndpointUrl(versionUrl.href)}: ${detail}`,
      { cause: error },
    );
  }
};
