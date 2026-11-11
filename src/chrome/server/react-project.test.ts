import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReactProject } from "./react-project";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test("admits React in a marked monorepo subproject from a nested working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "chrome-react-project-"));
  roots.push(root);

  const workspace = join(root, "packages", "app");
  const workingDirectory = join(root, "docs");
  const reactDirectory = join(workspace, "node_modules", "react");
  await mkdir(reactDirectory, { recursive: true });
  await mkdir(workingDirectory);
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(workspace, "package.json"), "{}");
  await writeFile(join(reactDirectory, "package.json"), "{}");

  expect(isReactProject(workingDirectory)).toBe(true);
});

test("does not admit a vendored React dependency as a project", async () => {
  const root = await mkdtemp(join(tmpdir(), "chrome-vendored-react-"));
  roots.push(root);

  const dependency = join(root, "node_modules", "package");
  const reactDirectory = join(dependency, "node_modules", "react");
  await mkdir(reactDirectory, { recursive: true });
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(dependency, "package.json"), "{}");
  await writeFile(join(reactDirectory, "package.json"), "{}");

  expect(isReactProject(root)).toBe(false);
});
