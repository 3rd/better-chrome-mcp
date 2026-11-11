import { CdpCommandError } from "../runtime/cdp-connection";

const PRIVATE_ENDPOINT_PATTERN = /wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/[^\s"']*)?/giu;

export type BrokerRpcErrorCode =
  | "CHROME_MCP_BROKER_CANCELED"
  | "CHROME_MCP_BROKER_CLOSED"
  | "CHROME_MCP_BROKER_DEADLINE"
  | "CHROME_MCP_BROKER_INVALID_REQUEST"
  | "CHROME_MCP_BROKER_UNAVAILABLE"
  | "CHROME_MCP_CDP_COMMAND_FAILED";

type BrokerWireError = Readonly<{
  cdpCode?: number;
  code: string;
  message: string;
}>;

type BrokerRpcErrorOptions = ErrorOptions & Readonly<{ cdpCode?: number }>;

export const redactBrokerErrorMessage = (message: string) => {
  return message.replace(PRIVATE_ENDPOINT_PATTERN, "[private Chrome endpoint]");
};

export class BrokerRpcError extends Error {
  readonly cdpCode: number | undefined;
  readonly code: string;

  constructor(code: string, message: string, options?: BrokerRpcErrorOptions) {
    super(redactBrokerErrorMessage(message), options);
    this.name = "BrokerRpcError";
    this.code = code;
    this.cdpCode = options?.cdpCode;
  }
}

export const brokerError = (
  error: unknown,
  fallbackCode = "CHROME_MCP_BROKER_UNAVAILABLE",
): BrokerRpcError => {
  if (error instanceof BrokerRpcError) return error;
  if (error instanceof CdpCommandError) {
    return new BrokerRpcError("CHROME_MCP_CDP_COMMAND_FAILED", error.message, {
      cause: error,
      cdpCode: error.code,
    });
  }
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : fallbackCode;
    return new BrokerRpcError(code, error.message, { cause: error });
  }
  return new BrokerRpcError(fallbackCode, "Chrome browser broker failed");
};

export const brokerWireError = (error: BrokerRpcError): BrokerWireError => ({
  code: error.code,
  message: redactBrokerErrorMessage(error.message),
  ...(error.cdpCode === undefined ? {} : { cdpCode: error.cdpCode }),
});

export const errorFromBrokerWire = (error: BrokerWireError): Error => {
  if (error.code === "CHROME_MCP_CDP_COMMAND_FAILED") {
    return new CdpCommandError(error.message, error.cdpCode);
  }
  return new BrokerRpcError(error.code, error.message);
};
