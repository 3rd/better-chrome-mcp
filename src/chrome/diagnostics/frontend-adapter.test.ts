import { describe, expect, test } from "bun:test";
import { isFrontendLocalesImporter, FRONTEND_MCP_ENTRYPOINT_FILTER } from "./frontend-adapter";

describe("frontend bundle path matching", () => {
  test("matches the mcp entrypoint with either separator", () => {
    expect(FRONTEND_MCP_ENTRYPOINT_FILTER.test("/repo/node_modules/chrome-devtools-frontend/mcp/mcp.ts")).toBe(true);
    expect(FRONTEND_MCP_ENTRYPOINT_FILTER.test("C:\\repo\\node_modules\\chrome-devtools-frontend\\mcp\\mcp.ts")).toBe(
      true,
    );
    expect(FRONTEND_MCP_ENTRYPOINT_FILTER.test("C:\\repo\\chrome-devtools-frontend\\mcp\\other.ts")).toBe(false);
  });

  test("matches the i18n importer with either separator", () => {
    expect(isFrontendLocalesImporter("/x/front_end/core/i18n/i18nImpl.ts")).toBe(true);
    expect(isFrontendLocalesImporter("C:\\x\\front_end\\core\\i18n\\i18nImpl.ts")).toBe(true);
    expect(isFrontendLocalesImporter("C:\\x\\front_end\\core\\i18n\\other.ts")).toBe(false);
  });
});
