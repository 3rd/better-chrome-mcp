import { FastMCPSession } from "#fastmcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "bun:test";
import type { ToolSessionContext } from "../../mcp/session-context";
import { CapturingFastMCP } from "../../mcp/capturing-server";
import { registerChromeDocs, renderChromeHelperDeclarations } from "./register-docs";

describe("Chrome MCP documentation resources", () => {
  test("serves every registered documentation resource through MCP", async () => {
    const server = new CapturingFastMCP<ToolSessionContext>({ name: "chrome-docs-test", version: "1.0.0" });
    registerChromeDocs(server);

    const session = new FastMCPSession({
      logger: console,
      name: server.options.name,
      version: server.options.version,
      tools: server.captured.tools,
      prompts: server.captured.prompts,
      resources: server.captured.resources,
      resourcesTemplates: server.captured.resourceTemplates,
    });
    const client = new Client({ name: "chrome-docs-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([session.connect(serverTransport), client.connect(clientTransport)]);
      const listed = await client.listResources();
      expect(listed.resources.map(({ uri }) => uri).sort()).toEqual(
        [
          "chrome-docs://run-playwright",
          "chrome-docs://instructions",
          "chrome-docs://modes",
          "chrome-docs://react-profiling",
          "chrome-docs://state",
          "chrome-docs://events",
          "chrome-docs://snapshots",
          "chrome-docs://captures",
          "chrome-docs://checkpoints",
          "chrome-docs://artifacts",
          "chrome-docs://capabilities",
          "chrome-docs://registry",
          "chrome-docs://modals",
          "chrome-docs://pwa",
          "chrome-docs://heap-queries",
          "chrome-docs://recipes/playwright",
          "chrome-docs://recipes/cdp",
          "chrome-docs://helper-api.d.ts",
        ].sort(),
      );
      for (const resource of listed.resources) {
        const result = await client.readResource({ uri: resource.uri });
        expect(result.contents).toHaveLength(1);
        const content = result.contents[0];
        if (!content || !("text" in content)) throw new Error(`Missing documentation text: ${resource.uri}`);
        expect(content.uri).toBe(resource.uri);
        expect(content.mimeType).toBe(resource.mimeType);
        expect(content.text.trim().length).toBeGreaterThan(0);
      }
    } finally {
      await client.close();
      await session.close();
    }
  });

  test("assembles selected helpers with shared declarations once", () => {
    const sharedType = "type Item = { id: string };";
    const read = {
      uri: "chrome-docs://synthetic-read",
      imports: ["Page"],
      types: [sharedType],
      members: { readItem: "(page: Page): Promise<Item>;" },
    };
    const write = {
      uri: "chrome-docs://synthetic-write",
      imports: ["Page", "Locator"],
      types: [sharedType, "type Saved = { item: Item };"],
      members: { writeItem: "(page: Page, locator: Locator, item: Item): Promise<Saved>;" },
    };

    const focused = renderChromeHelperDeclarations([read]);
    expect(focused).toContain("readItem(page: Page): Promise<Item>;");
    expect(focused).not.toContain("writeItem");
    expect(focused).not.toContain("Locator");
    const combined = renderChromeHelperDeclarations([read, write]);
    expect(combined.split(sharedType)).toHaveLength(2);
    expect(combined).toContain('import type { Page, Locator } from "playwright-core";');
    expect(combined).toContain("type Saved = { item: Item };");
    expect(combined).toContain("readItem(page: Page): Promise<Item>;");
    expect(combined).toContain("writeItem(page: Page, locator: Locator, item: Item): Promise<Saved>;");
  });
});
