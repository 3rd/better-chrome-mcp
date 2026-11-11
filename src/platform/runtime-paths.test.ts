import { expect, test } from "bun:test";
import { join } from "node:path";
import { findMcpInstanceId, getMcpRuntimeDir } from "./runtime-paths";

test("resolves runtime and session settings from the environment", () => {
  const previousEnvironment = process.env;
  process.env = {
    XDG_RUNTIME_DIR: "/run/test-user",
  };

  try {
    expect(getMcpRuntimeDir()).toBe(join("/run/test-user", `chrome-mcp-u${process.getuid?.()}`));
    expect(findMcpInstanceId()).toBeUndefined();

    process.env.CHROME_MCP_RUNTIME_DIR = "/standalone/runtime";
    process.env.CHROME_MCP_INSTANCE_ID = "standalone-session";

    expect(getMcpRuntimeDir()).toBe("/standalone/runtime");
    expect(findMcpInstanceId()).toBe("standalone-session");
  } finally {
    process.env = previousEnvironment;
  }
});
