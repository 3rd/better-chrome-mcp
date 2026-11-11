import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOwnerKey,
  resolveChromeRuntimePaths,
  resolveMainChromeUserDataDir,
  workspaceIdentity,
} from "./paths";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("Chrome runtime paths", () => {
  test("keys isolated owners by client and shared owners by workspace", () => {
    const workspaceHash = "a".repeat(64);
    expect(createOwnerKey("isolated", workspaceHash, "client-a").id).not.toBe(
      createOwnerKey("isolated", workspaceHash, "client-b").id,
    );
    expect(createOwnerKey("shared", workspaceHash, "client-a").id).toBe(
      createOwnerKey("shared", workspaceHash, "client-b").id,
    );
    expect(createOwnerKey("shared", workspaceHash, "client-a").id).not.toBe(
      createOwnerKey("shared-headless", workspaceHash, "client-a").id,
    );
  });

  test("places persistent and temporary profiles in their owning roots", () => {
    const workspaceHash = "b".repeat(64);
    const options = { dataHome: "/data", home: "/home/test", runtimeRoot: "/run/chrome-mcp" };
    const shared = resolveChromeRuntimePaths(createOwnerKey("shared", workspaceHash, "a"), options);
    const isolated = resolveChromeRuntimePaths(createOwnerKey("isolated", workspaceHash, "a"), options);
    expect(shared.profileRoot).toBe(`/data/chrome-mcp/profiles/${workspaceHash}/shared`);
    expect(isolated.profileRoot).toStartWith("/run/chrome-mcp/chrome-mcp/chrome-profiles/");
    expect(shared.downloadsPath).toStartWith("/run/chrome-mcp/chrome-mcp/chrome-artifacts/");
    expect(shared.userDataDir).toBe(join(shared.profileRoot, "user-data"));
  });

  test("hashes the canonical workspace and never stores its path in the owner key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chrome-runtime-paths-"));
    temporaryDirectories.push(directory);
    const identity = await workspaceIdentity(directory);
    expect(identity.canonicalPath).toBe(directory);
    expect(identity.hash).toMatch(/^[\da-f]{64}$/);
    expect(createOwnerKey("shared", identity.hash, "client").id).not.toContain(directory);
  });

  test("resolves Chrome Stable data roots for main attachment", () => {
    expect(resolveMainChromeUserDataDir({ HOME: "/home/test" }, "linux")).toBe(
      "/home/test/.config/google-chrome",
    );
    expect(resolveMainChromeUserDataDir({ HOME: "/home/test", XDG_CONFIG_HOME: "/config" }, "linux")).toBe(
      "/config/google-chrome",
    );
    expect(resolveMainChromeUserDataDir({ HOME: "/Users/test" }, "darwin")).toBe(
      "/Users/test/Library/Application Support/Google/Chrome",
    );
    expect(resolveMainChromeUserDataDir({ HOME: "C:/Users/test", LOCALAPPDATA: "C:/Local" }, "win32")).toBe(
      "C:/Local/Google/Chrome/User Data",
    );
  });
});
