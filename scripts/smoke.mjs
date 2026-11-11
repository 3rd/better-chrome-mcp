import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  throw new Error("usage: bun scripts/smoke.mjs <command> [...args]");
}

const runtimeRoot = await mkdtemp(join(tmpdir(), "chrome-mcp-smoke-"));
const client = new Client({
  name: "chrome-mcp-smoke",
  version: "0.0.0",
});

const transport = new StdioClientTransport({
  command,
  args,
  cwd: process.cwd(),
  stderr: "pipe",
  env: {
    ...getDefaultEnvironment(),
    CHROME_MCP_RUNTIME_DIR: runtimeRoot,
  },
});
let serverErrors = "";
transport.stderr?.on("data", (chunk) => {
  serverErrors += chunk.toString();
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  for (const name of ["run_playwright", "performance_start_trace", "performance_stop_trace", "performance_analyze_insight", "lighthouse_audit", "take_heapsnapshot", "analyze_heapsnapshot"]) {
    assert.ok(tools.tools.some((tool) => tool.name === name), `Missing tool: ${name}`);
  }

  assert.match(client.getInstructions(), /browserInstanceId/);

  await assert.rejects(client.callTool({
    name: "run_playwright",
    arguments: { code: 42 },
  }), { code: -32602 });

  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === "chrome-docs://run-playwright"));

  const documentation = await client.readResource({ uri: "chrome-docs://run-playwright" });
  const documentationText = documentation.contents.find((content) => "text" in content);
  assert.ok(documentationText);
  assert.match(documentationText.text, /Playwright/);
  console.log(`MCP smoke passed: ${tools.tools.length} tools, ${resources.resources.length} resources.`);
} catch (error) {
  if (serverErrors) {
    console.error(serverErrors);
  }

  throw error;
} finally {
  await client.close();
  await rm(runtimeRoot, { recursive: true, force: true });
}
