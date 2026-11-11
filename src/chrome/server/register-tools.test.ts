import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advertisedAgentToolJsonSchema } from "../../mcp/agent-tool-schema";
import { capturedDefinitionsForSession, CapturingFastMCP } from "../../mcp/capturing-server";
import { createToolSessionContext, type ToolSessionContext } from "../../mcp/session-context";
import { copyJsonValue } from "../execution/json";
import { CHROME_TOOL_NAMES, REMOVED_CHROME_TOOL_NAMES, runPlaywrightOutputSchema } from "./contracts";
import * as reactProjects from "./react-project";
import { type ChromeToolHandlers, registerChromeTools } from "./register-tools";

const completed = async () => ({ content: [{ type: "text" as const, text: "complete" }] });

const handlers: ChromeToolHandlers = {
  analyzeHeapSnapshot: completed,
  runPlaywright: completed,
  performanceStartTrace: completed,
  performanceStopTrace: completed,
  performanceAnalyzeInsight: completed,
  lighthouseAudit: completed,
  takeHeapSnapshot: completed,
  reactListComponents: completed,
  reactInspectComponent: completed,
  reactUpdateComponent: completed,
  reactHighlightComponent: completed,
  reactProfileStart: completed,
  reactProfileStop: completed,
  reactProfileAnalyze: completed,
};

describe("Chrome MCP public tool registry", () => {
  test("enforces the exact public surface at the production MCP boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-tools-react-"));
    await mkdir(join(root, "node_modules", "react"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await writeFile(join(root, "node_modules", "react", "package.json"), "{}\n", "utf8");
    const server = new CapturingFastMCP<ToolSessionContext>({ name: "chrome-tools-test", version: "1.0.0" });

    const structuredContent = {
      ok: true,
      selectedTargetId: null,
      emittedCount: 0,
      artifacts: [],
      value: copyJsonValue(JSON.parse('{"__proto__":{"count":3}}')),
    };
    registerChromeTools(server, {
      ...handlers,
      runPlaywright: async () => ({ content: [], structuredContent }),
    });

    const auth = await createToolSessionContext({ baseCwd: root }, { mode: "off" }, "c".repeat(32));
    const client = new Client({ name: "chrome-tools-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const [session] = await Promise.all([
      server.connect(serverTransport, auth),
      client.connect(clientTransport),
    ]);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...CHROME_TOOL_NAMES]);
      expect(listed.tools.map(({ name, description }) => ({ name, description }))).toEqual(
        server.captured.tools.map(({ name, description }) => ({ name, description })),
      );
      for (const tool of listed.tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(typeof tool.inputSchema.properties).toBe("object");
      }
      expect(Buffer.byteLength(JSON.stringify(listed.tools), "utf8")).toBeLessThanOrEqual(28_672);
      expect<unknown>(listed.tools.map(({ outputSchema: advertisedSchema }) => advertisedSchema)[0]).toEqual(
        advertisedAgentToolJsonSchema(runPlaywrightOutputSchema, "output"),
      );

      const evaluated = await client.callTool({
        name: "run_playwright",
        arguments: { code: "return 3;", browserInstanceId: "registry-value-test" },
      });
      expect(evaluated.isError).not.toBeTrue();
      expect(evaluated.structuredContent).toEqual(structuredContent);
      expect(JSON.stringify(evaluated.structuredContent)).toContain('"__proto__":{"count":3}');

      const outputSchema = server.captured.tools.map((tool) => tool.outputSchema)[0];
      assert(outputSchema, "run_playwright output schema is missing");

      const invalid = await outputSchema["~standard"].validate({
        ...structuredContent,
        value: { ["__proto__"]: 1n },
      });
      expect(invalid.issues).toBeDefined();

      for (const toolName of REMOVED_CHROME_TOOL_NAMES) {
        let rejected = false;
        try {
          const result = await client.callTool({ name: toolName, arguments: {} });
          rejected = result.isError === true;
        } catch {
          rejected = true;
        }
        expect(rejected).toBeTrue();
      }
    } finally {
      await client.close();
      await session.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("hides and rejects React tools outside React projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-tools-non-react-"));
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    const server = new CapturingFastMCP<ToolSessionContext>({ name: "chrome-tools-test", version: "1.0.0" });
    registerChromeTools(server, handlers);
    const auth = await createToolSessionContext({ baseCwd: root }, { mode: "off" }, "n".repeat(32));
    const client = new Client({ name: "chrome-tools-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const [session] = await Promise.all([
      server.connect(serverTransport, auth),
      client.connect(clientTransport),
    ]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(CHROME_TOOL_NAMES.slice(0, 7));
      expect(listed.tools.map(({ name, description }) => ({ name, description }))).toEqual(
        server.captured.tools.slice(0, 7).map(({ name, description }) => ({ name, description })),
      );
      let rejected = false;
      try {
        const result = await client.callTool({ name: "react_list_components", arguments: {} });
        rejected = result.isError === true;
      } catch {
        rejected = true;
      }
      expect(rejected).toBeTrue();
    } finally {
      await client.close();
      await session.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("omits React declarations when project detection fails", async () => {
    const server = new CapturingFastMCP<ToolSessionContext>({ name: "chrome-tools-test", version: "1.0.0" });
    registerChromeTools(server, handlers);
    const auth = await createToolSessionContext({ baseCwd: process.cwd() }, { mode: "off" }, "f".repeat(32));
    const detection = spyOn(reactProjects, "isReactProject").mockImplementation(() => {
      throw new Error("Synthetic project detection failure");
    });
    try {
      expect(capturedDefinitionsForSession(server.captured, auth).tools).toEqual(
        server.captured.tools.slice(0, 7),
      );
    } finally {
      detection.mockRestore();
    }
  });

  test("offers React tools outside React projects when they are switched on", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-tools-react-on-"));
    const server = new CapturingFastMCP<ToolSessionContext>({ name: "chrome-tools-test", version: "1.0.0" });
    registerChromeTools(server, handlers, "on");
    const auth = await createToolSessionContext({ baseCwd: root }, { mode: "off" }, "a".repeat(32));

    try {
      expect(capturedDefinitionsForSession(server.captured, auth).tools.map((tool) => tool.name)).toEqual([
        ...CHROME_TOOL_NAMES,
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("hides React tools in React projects when they are switched off", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-tools-react-off-"));
    await mkdir(join(root, "node_modules", "react"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await writeFile(join(root, "node_modules", "react", "package.json"), "{}\n", "utf8");
    const server = new CapturingFastMCP<ToolSessionContext>({ name: "chrome-tools-test", version: "1.0.0" });
    registerChromeTools(server, handlers, "off");
    const auth = await createToolSessionContext({ baseCwd: root }, { mode: "off" }, "b".repeat(32));

    try {
      expect(capturedDefinitionsForSession(server.captured, auth).tools.map((tool) => tool.name)).toEqual(
        CHROME_TOOL_NAMES.slice(0, 7),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
