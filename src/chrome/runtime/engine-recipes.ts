import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod/v4";
import { ChromeRuntimeError } from "./errors";
import { type BrowserMode, isAttachedMode, isHeadlessMode } from "./modes";

export const ENGINE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
export const RECIPE_PLACEHOLDERS = ["port", "profileDir"] as const;
export const DEFAULT_RECIPE_STARTUP_TIMEOUT_MS = 10_000;
export const MAX_RECIPE_STARTUP_TIMEOUT_MS = 120_000;

export type EngineRecipe = Readonly<{
  command?: string;
  args: readonly string[];
  startupTimeoutMs: number;
}>;

export type RecipeEngine = Readonly<{
  name: string;
  args: readonly string[];
  startupTimeoutMs: number;
}>;

export type EngineSelection =
  | Readonly<{ kind: "chrome" }>
  | Readonly<{ kind: "recipe"; engine: RecipeEngine; command?: string }>;

export const BUILT_IN_ENGINE_RECIPES: Readonly<Record<"obscura" | "lightpanda", EngineRecipe>> = {
  obscura: {
    args: ["serve", "--port", "{port}", "--storage-dir", "{profileDir}", "--allow-private-network"],
    startupTimeoutMs: DEFAULT_RECIPE_STARTUP_TIMEOUT_MS,
  },
  lightpanda: {
    args: ["serve", "--host", "127.0.0.1", "--port", "{port}"],
    startupTimeoutMs: DEFAULT_RECIPE_STARTUP_TIMEOUT_MS,
  },
};

export const recipeEngineSchema = z
  .object({
    name: z.string(),
    args: z.array(z.string()),
    startupTimeoutMs: z.number(),
  })
  .strict();

export const launchedEngineSchema = recipeEngineSchema.extend({ command: z.string().min(1) }).strict();

export type LaunchedEngine = z.infer<typeof launchedEngineSchema>;

const recipeFileEntrySchema = z
  .object({
    command: z.string().refine((command) => isAbsolute(command), "command must be an absolute path"),
    args: z.array(z.string()),
    startupTimeoutMs: z.number().int().min(1).max(MAX_RECIPE_STARTUP_TIMEOUT_MS).default(
      DEFAULT_RECIPE_STARTUP_TIMEOUT_MS,
    ),
  })
  .strict();

const recipeFileSchema = z.object({ engines: z.record(z.string(), recipeFileEntrySchema) }).strict();

const PLACEHOLDER_PATTERN = /\{([^{}]*)\}/gu;

// Windows runs these through cmd.exe, which would interpret the engine arguments.
const WINDOWS_SCRIPT_PATTERN = /\.(?:bat|cmd)$/iu;

const isKnownPlaceholder = (placeholder: string) =>
  RECIPE_PLACEHOLDERS.some((known) => known === placeholder);

export const parseEngineRecipeFile = (
  value: unknown,
  path: string,
  platform: NodeJS.Platform = process.platform,
): Readonly<Record<string, EngineRecipe>> => {
  const fail = (message: string) => new Error(`--engine-config ${path}: ${message}`);

  const parsed = recipeFileSchema.safeParse(value);
  if (!parsed.success) {
    throw fail(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }

  const recipes: Record<string, EngineRecipe> = {};
  for (const [name, recipe] of Object.entries(parsed.data.engines)) {
    if (!ENGINE_NAME_PATTERN.test(name)) {
      throw fail(`engine name "${name}" must match ^[a-z][a-z0-9-]{0,31}$`);
    }
    if (name === "chrome") {
      throw fail('engine "chrome" cannot be overridden; Chrome uses the built-in launcher');
    }
    if (platform === "win32" && WINDOWS_SCRIPT_PATTERN.test(recipe.command)) {
      throw fail(`engines.${name}.command must not be a .bat or .cmd script`);
    }
    for (const arg of recipe.args) {
      for (const match of arg.matchAll(PLACEHOLDER_PATTERN)) {
        const placeholder = match[1] ?? "";
        if (!isKnownPlaceholder(placeholder)) {
          throw fail(
            `engine "${name}" argument "${arg}" uses unknown placeholder {${placeholder}}; use {port} or {profileDir}`,
          );
        }
      }
    }
    if (!recipe.args.some((arg) => arg.includes("{port}"))) {
      throw fail(`engine "${name}" args must contain {port}`);
    }
    recipes[name] = recipe;
  }

  return recipes;
};

export const loadEngineRecipeFile = async (path: string): Promise<Readonly<Record<string, EngineRecipe>>> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    throw new Error(`--engine-config ${path}: cannot read file (${code})`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`--engine-config ${path}: not valid JSON`);
  }

  return parseEngineRecipeFile(value, path);
};

export const selectEngine = (
  name: string | undefined,
  fileRecipes: Readonly<Record<string, EngineRecipe>> = {},
): EngineSelection => {
  if (name === undefined || name === "chrome") return { kind: "chrome" };

  const recipes: Readonly<Record<string, EngineRecipe>> = { ...BUILT_IN_ENGINE_RECIPES, ...fileRecipes };
  const recipe = Object.hasOwn(recipes, name) ? recipes[name] : undefined;
  if (recipe === undefined) {
    const known = ["chrome", ...Object.keys(recipes).sort()];
    throw new Error(`--engine must be one of ${known.join(", ")}; received "${name}"`);
  }

  const { command, ...rest } = recipe;

  return {
    kind: "recipe",
    engine: { name, ...rest },
    ...(command === undefined ? {} : { command }),
  };
};

export const expandRecipeArguments = (
  engine: RecipeEngine,
  values: Readonly<{ port: number; profileDir: string }>,
): string[] =>
  engine.args.map((arg) =>
    arg.replace(PLACEHOLDER_PATTERN, (_match, placeholder: string) =>
      placeholder === "port" ? String(values.port) : values.profileDir,
    ),
  );

// Recipes receive no mode, so an engine launches the same way for every mode: only the headless modes can keep
// their promise of no visible window.
export const assertEngineSupportsMode = (engine: RecipeEngine | undefined, mode: BrowserMode): void => {
  const isModeSupported = engine === undefined || isAttachedMode(mode) || isHeadlessMode(mode);
  if (isModeSupported) return;

  throw new ChromeRuntimeError(
    "CHROME_MCP_ENGINE_UNSUPPORTED_MODE",
    `The ${engine.name} engine runs headless only, so browser "${mode}" is unavailable. Use isolated-headless or shared-headless, or start the server without --engine to use Chrome.`,
  );
};
