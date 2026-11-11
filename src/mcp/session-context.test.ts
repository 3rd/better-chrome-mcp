import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStandaloneToolSessionContext,
  isToolSessionContext,
  resolveToolOutputPath,
} from "./session-context";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test("creates independent connection identities rooted in the standalone working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "chrome-session-context-"));
  roots.push(root);

  const first = await createStandaloneToolSessionContext(root);
  const second = await createStandaloneToolSessionContext(root);
  expect(first.connectionId).toMatch(/^[0-9a-f]{32}$/u);
  expect(second.connectionId).not.toBe(first.connectionId);
  expect(first.pathContext.baseCwd).toBe(await realpath(root));
  expect(first.recording).toEqual({ mode: "off" });
  expect(isToolSessionContext(first)).toBe(true);
  expect(Object.isFrozen(first)).toBe(true);
});

test("resolves relative output paths while allowing absolute output directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "chrome-session-output-"));
  roots.push(root);
  const baseCwd = join(root, "project");
  await mkdir(baseCwd);

  const session = await createStandaloneToolSessionContext(baseCwd);
  const canonicalRoot = await realpath(root);
  expect(await resolveToolOutputPath(session.pathContext, "snapshot.json")).toBe(
    join(canonicalRoot, "project", "snapshot.json"),
  );
  expect(await resolveToolOutputPath(session.pathContext, join(root, "snapshot.json"))).toBe(
    join(canonicalRoot, "snapshot.json"),
  );
});

test("canonicalizes directory links and rejects symbolic-link output files", async () => {
  const root = await mkdtemp(join(tmpdir(), "chrome-session-link-"));
  roots.push(root);
  const directory = join(root, "directory");
  const linkedDirectory = join(root, "link");
  await mkdir(directory);
  await symlink(directory, linkedDirectory);
  await symlink(join(directory, "snapshot.json"), join(directory, "output.json"));

  const session = await createStandaloneToolSessionContext(linkedDirectory);
  expect(session.pathContext.baseCwd).toBe(await realpath(directory));
  expect(resolveToolOutputPath(session.pathContext, "output.json")).rejects.toThrow(
    "must not be a symbolic link",
  );
});
