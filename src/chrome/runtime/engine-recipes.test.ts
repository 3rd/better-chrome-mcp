import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertEngineSupportsMode,
  BUILT_IN_ENGINE_RECIPES,
  expandRecipeArguments,
  loadEngineRecipeFile,
  parseEngineRecipeFile,
  selectEngine,
} from "./engine-recipes";

const absolute = (name: string) => join(tmpdir(), name);

test("defines obscura and lightpanda as headless-only built-ins without a command", () => {
  expect(BUILT_IN_ENGINE_RECIPES).toEqual({
    obscura: {
      args: ["serve", "--port", "{port}", "--storage-dir", "{profileDir}", "--allow-private-network"],
      headlessOnly: true,
      startupTimeoutMs: 10000,
    },
    lightpanda: {
      args: ["serve", "--host", "127.0.0.1", "--port", "{port}"],
      headlessOnly: true,
      startupTimeoutMs: 10000,
    },
  });
});

test("selects Chrome when no engine or chrome is named", () => {
  expect(selectEngine(undefined)).toEqual({ kind: "chrome" });
  expect(selectEngine("chrome")).toEqual({ kind: "chrome" });
});

test("selects a built-in recipe and lets a file recipe of the same name replace it", () => {
  expect(selectEngine("obscura")).toEqual({
    kind: "recipe",
    engine: { name: "obscura", ...BUILT_IN_ENGINE_RECIPES.obscura },
  });
  const file = parseEngineRecipeFile(
    { engines: { obscura: { command: absolute("obscura"), args: ["--port", "{port}"] } } },
    "/cfg.json",
  );
  expect(selectEngine("obscura", file)).toEqual({
    kind: "recipe",
    command: absolute("obscura"),
    engine: { name: "obscura", args: ["--port", "{port}"], headlessOnly: true, startupTimeoutMs: 10000 },
  });
});

test("rejects an unknown engine and lists the known names", () => {
  const file = parseEngineRecipeFile({ engines: { custom: { command: absolute("c"), args: ["{port}"] } } }, "/cfg.json");
  expect(() => selectEngine("firefox", file)).toThrow(
    '--engine must be one of chrome, custom, lightpanda, obscura; received "firefox"',
  );
});

test("validates every file recipe, including ones not selected", () => {
  expect(() =>
    parseEngineRecipeFile(
      {
        engines: {
          good: { command: absolute("g"), args: ["{port}"] },
          bad: { command: absolute("b"), args: ["{port}", "{host}"] },
        },
      },
      "/cfg.json",
    ),
  ).toThrow(
    '--engine-config /cfg.json: engine "bad" argument "{host}" uses unknown placeholder {host}; use {port} or {profileDir}',
  );
  expect(() =>
    parseEngineRecipeFile({ engines: { bad: { command: absolute("b"), args: ["{port}", "{}"] } } }, "/c"),
  ).toThrow("unknown placeholder {}");
});

test("rejects unknown keys, a relative command, missing {port}, the chrome name and unsafe names", () => {
  const parse = (engines: Record<string, unknown>) => () => parseEngineRecipeFile({ engines }, "/cfg.json");
  const ok = { command: absolute("x"), args: ["{port}"] };

  expect(parse({ typo: { ...ok, headles: true } })).toThrow(/engines\.typo: Unrecognized key/);
  expect(parse({ rel: { command: "obscura.exe", args: ["{port}"] } })).toThrow(
    "engines.rel.command: command must be an absolute path",
  );
  expect(parse({ noport: { command: absolute("x"), args: ["serve"] } })).toThrow(
    'engine "noport" args must contain {port}',
  );
  expect(parse({ chrome: ok })).toThrow('engine "chrome" cannot be overridden; Chrome uses the built-in launcher');
  for (const name of ["../x", "Obscura", "a".repeat(64)]) {
    expect(parse({ [name]: ok })).toThrow("must match ^[a-z][a-z0-9-]{0,31}$");
  }
});

test("expands {port} and {profileDir} inside every argument and keeps shell syntax literal", () => {
  expect(
    expandRecipeArguments(
      { name: "x", args: ["--port={port}", "{profileDir}/x", "a && b"], headlessOnly: true, startupTimeoutMs: 1 },
      { port: 9333, profileDir: "C:/p" },
    ),
  ).toEqual(["--port=9333", "C:/p/x", "a && b"]);
});

test("reports an unreadable or malformed recipe file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "engine-recipes-"));
  try {
    const missing = join(directory, "missing.json");
    await expect(loadEngineRecipeFile(missing)).rejects.toThrow(
      `--engine-config ${missing}: cannot read file (ENOENT)`,
    );
    const malformed = join(directory, "bad.json");
    await writeFile(malformed, "{");
    await expect(loadEngineRecipeFile(malformed)).rejects.toThrow(`--engine-config ${malformed}: not valid JSON`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("allows only headless modes for a headless-only engine and never the virtual display", () => {
  const OBSCURA = { name: "obscura", ...BUILT_IN_ENGINE_RECIPES.obscura };
  for (const mode of ["isolated", "shared", "isolated-virtual-display"] as const) {
    expect(() => assertEngineSupportsMode(OBSCURA, mode)).toThrow(
      expect.objectContaining({ code: "CHROME_MCP_ENGINE_UNSUPPORTED_MODE" }),
    );
  }
  for (const mode of ["isolated-headless", "shared-headless", "main", "remote"] as const) {
    expect(() => assertEngineSupportsMode(OBSCURA, mode)).not.toThrow();
  }
  const visible = { ...OBSCURA, headlessOnly: false };
  expect(() => assertEngineSupportsMode(visible, "isolated")).not.toThrow();
  expect(() => assertEngineSupportsMode(visible, "isolated-virtual-display")).toThrow(
    "cannot run isolated-virtual-display",
  );
  expect(() => assertEngineSupportsMode(undefined, "isolated")).not.toThrow();
});

test("rejects a .bat or .cmd command on Windows because cmd.exe would interpret its arguments", () => {
  const recipe = (command: string) => ({ engines: { wrapped: { command, args: ["{port}"] } } });
  for (const name of ["engine.bat", "engine.CMD", "engine.Bat"]) {
    expect(() => parseEngineRecipeFile(recipe(absolute(name)), "/cfg.json", "win32")).toThrow(
      "--engine-config /cfg.json: engines.wrapped.command must not be a .bat or .cmd script",
    );
  }
  expect(parseEngineRecipeFile(recipe(absolute("engine.exe")), "/cfg.json", "win32")).toHaveProperty("wrapped");
  expect(parseEngineRecipeFile(recipe(absolute("engine.cmd")), "/cfg.json", "linux")).toHaveProperty("wrapped");
});
