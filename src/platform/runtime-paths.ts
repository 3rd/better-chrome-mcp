import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const getMcpRuntimeDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.CHROME_MCP_RUNTIME_DIR ??
  join(env.XDG_RUNTIME_DIR ?? tmpdir(), `chrome-mcp-u${process.getuid?.() ?? userInfo().uid}`);

export const findMcpInstanceId = () => process.env.CHROME_MCP_INSTANCE_ID;
