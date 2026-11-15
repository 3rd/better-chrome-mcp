import { describe, expect, test } from "bun:test";
import {
  describeFrontendBundleFailure,
  isFrontendLocalesImporter,
  isFrontendMcpEntrypoint,
  FRONTEND_MCP_ENTRYPOINT_FILTER,
} from "./frontend-adapter";

describe("frontend bundle path matching", () => {
  test("matches the mcp entrypoint with either separator", () => {
    expect(FRONTEND_MCP_ENTRYPOINT_FILTER.test("/repo/node_modules/chrome-devtools-frontend/mcp/mcp.ts")).toBe(true);
    expect(FRONTEND_MCP_ENTRYPOINT_FILTER.test("C:\\repo\\node_modules\\chrome-devtools-frontend\\mcp\\mcp.ts")).toBe(
      true,
    );
    expect(isFrontendMcpEntrypoint("C:\\repo\\chrome-devtools-frontend\\mcp\\mcp.ts")).toBe(true);
    expect(isFrontendMcpEntrypoint("C:\\repo\\chrome-devtools-frontend\\mcp\\other.ts")).toBe(false);
  });

  test("matches the i18n importer with either separator", () => {
    expect(isFrontendLocalesImporter("/x/front_end/core/i18n/i18nImpl.ts")).toBe(true);
    expect(isFrontendLocalesImporter("C:\\x\\front_end\\core\\i18n\\i18nImpl.ts")).toBe(true);
    expect(isFrontendLocalesImporter("C:\\x\\front_end\\core\\i18n\\other.ts")).toBe(false);
  });
});

describe("frontend bundle failures", () => {
  test("includes the underlying build messages", () => {
    const thrown = Object.assign(new Error("Bundle failed"), {
      errors: [{ message: 'Could not resolve: "./locales.js"' }, { message: "second problem" }],
    });
    const error = describeFrontendBundleFailure(thrown);
    expect(error.message).toContain("Bundle failed");
    expect(error.message).toContain('Could not resolve: "./locales.js"');
    expect(error.message).toContain("second problem");
  });

  test("keeps the original message when there are no build messages", () => {
    expect(describeFrontendBundleFailure(new Error("boom")).message).toContain("boom");
  });
});
