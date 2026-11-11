import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT_MARKERS = [".root", ".git", "package.json", "go.mod", "Cargo.toml", "pyproject.toml"];
const PROJECT_SCAN_MAX_DEPTH = 4;
const REACT_PACKAGE_PATH = "node_modules/react/package.json";

const findProjectRoot = (startDirectory: string) => {
  let directory = resolve(startDirectory);

  for (;;) {
    for (const marker of ROOT_MARKERS) {
      if (existsSync(join(directory, marker))) return directory;
    }

    const parent = dirname(directory);
    if (parent === directory) return resolve(startDirectory);

    directory = parent;
  }
};

const findProjectRoots = (startDirectory: string) => {
  const root = findProjectRoot(startDirectory);
  const roots = [root];

  const visitDirectory = (directory: string, depth: number) => {
    if (depth >= PROJECT_SCAN_MAX_DEPTH) return;

    let entries;

    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const isProjectDirectory =
        entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".");
      if (!isProjectDirectory) continue;

      const child = join(directory, entry.name);

      if (ROOT_MARKERS.some((marker) => existsSync(join(child, marker)))) {
        roots.push(child);
      }

      visitDirectory(child, depth + 1);
    }
  };

  visitDirectory(root, 0);

  return roots;
};

export const isReactProject = (directory: string) =>
  findProjectRoots(directory).some((root) => {
    const path = join(root, REACT_PACKAGE_PATH);

    return existsSync(path) && statSync(path).isFile();
  });
