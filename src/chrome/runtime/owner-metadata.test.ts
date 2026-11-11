import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readBrowserOwnerMetadata,
  readProfileMetadata,
  writeBrowserCrashMarker,
  writeBrowserOwnerMetadata,
  writeProfileMetadata,
} from "./owner-metadata";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrome-owner-metadata-"));
  temporaryDirectories.push(directory);
  return {
    crash: join(directory, "crash.json"),
    owner: join(directory, "owner.json"),
    profile: join(directory, "profile.json"),
  };
};

describe("Chrome owner metadata", () => {
  test("writes the current unversioned profile, owner, and crash shapes", async () => {
    const paths = await fixture();
    await writeProfileMetadata(paths.profile, {
      chromeMajorVersion: 151,
      cleanShutdown: false,
      mode: "shared-headless",
      workspaceHash: "a".repeat(64),
    });
    await writeBrowserOwnerMetadata(paths.owner, {
      browserPid: 123,
      cleanShutdown: false,
      endpoint: "ws://127.0.0.1:9222/devtools/browser/current",
      mode: "shared-headless",
      ownerGeneration: 2,
      processStartIdentity: "linux:10",
      profilePathHash: "b".repeat(64),
      updatedAt: new Date(1000).toISOString(),
    });
    await writeBrowserCrashMarker(paths.crash, {
      createdAt: new Date(1000).toISOString(),
      ownerGeneration: 2,
    });

    expect(await readProfileMetadata(paths.profile)).toMatchObject({
      chromeMajorVersion: 151,
      mode: "shared-headless",
    });
    expect(await readBrowserOwnerMetadata(paths.owner)).toMatchObject({
      browserPid: 123,
      ownerGeneration: 2,
    });
    for (const path of [paths.profile, paths.owner, paths.crash]) {
      expect("version" in JSON.parse(await readFile(path, "utf8"))).toBe(false);
    }
  });

  test("rejects unrelated fields", async () => {
    const paths = await fixture();
    await writeFile(
      paths.owner,
      JSON.stringify({
        browserPid: 123,
        cleanShutdown: false,
        endpoint: "ws://127.0.0.1:9222/devtools/browser/old",
        mode: "shared",
        ownerGeneration: 1,
        processStartIdentity: "linux:10",
        profilePathHash: "b".repeat(64),
        updatedAt: new Date(1000).toISOString(),
        extra: true,
      }),
    );
    expect(readBrowserOwnerMetadata(paths.owner)).rejects.toMatchObject({
      code: "CHROME_MCP_INVALID_PROFILE_METADATA",
    });

    await writeFile(
      paths.profile,
      JSON.stringify({
        cleanShutdown: false,
        extra: true,
        mode: "shared",
        workspaceHash: "a".repeat(64),
      }),
    );
    expect(readProfileMetadata(paths.profile)).rejects.toMatchObject({
      code: "CHROME_MCP_INVALID_PROFILE_METADATA",
    });
  });
});
