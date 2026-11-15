import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_ENGINE_RECIPES } from "../chrome/runtime/engine-recipes";
import { resolveServerEngine } from "./engine-options";

const withConfig = async (engines: unknown, run: (path: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "engine-options-"));
  try {
    const path = join(directory, "engines.json");
    await writeFile(path, JSON.stringify({ engines }));
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("resolves Chrome exactly as before when no engine is selected", async () => {
  expect(await resolveServerEngine({ executablePath: process.execPath })).toEqual({
    executablePath: process.execPath,
  });
});

test("uses --executable-path as a built-in engine's program", async () => {
  expect(await resolveServerEngine({ engine: "obscura", executablePath: process.execPath })).toEqual({
    executablePath: process.execPath,
    engine: { name: "obscura", ...BUILT_IN_ENGINE_RECIPES.obscura },
  });
});

test("prefers --executable-path over a file recipe's command", async () => {
  await withConfig({ custom: { command: join(tmpdir(), "missing.exe"), args: ["{port}"] } }, async (path) => {
    const result = await resolveServerEngine({
      engine: "custom",
      engineConfigPath: path,
      executablePath: process.execPath,
    });
    expect(result.executablePath).toBe(process.execPath);
    expect(result.engine?.name).toBe("custom");
  });
});

test("ignores CHROME_MCP_EXECUTABLE_PATH for a recipe engine", async () => {
  await expect(
    resolveServerEngine({ engine: "obscura" }, { CHROME_MCP_EXECUTABLE_PATH: process.execPath, PATH: "" }),
  ).rejects.toThrow(
    'The obscura engine needs its program path: pass --executable-path <path>, or set "command" for it in --engine-config',
  );
});

test("validates the engine file even when --engine is absent", async () => {
  await withConfig({ bad: { command: join(tmpdir(), "b"), args: ["{port}", "{host}"] } }, async (path) => {
    await expect(resolveServerEngine({ engineConfigPath: path, executablePath: process.execPath })).rejects.toThrow(
      'engine "bad" argument "{host}" uses unknown placeholder {host}',
    );
  });
});

test("reports an inaccessible engine program", async () => {
  const missing = join(tmpdir(), "no-such-engine.exe");
  await expect(resolveServerEngine({ engine: "obscura", executablePath: missing })).rejects.toThrow(
    `Engine "obscura" program is not accessible: ${missing}`,
  );
});
