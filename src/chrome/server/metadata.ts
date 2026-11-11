type ChromeMcpMetadata = Readonly<{
  name: string;
  version: `${number}.${number}.${number}`;
}>;

export const CHROME_MCP_METADATA: ChromeMcpMetadata = {
  name: "chrome-mcp",
  version: "0.0.0",
};
