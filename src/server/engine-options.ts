import { loadEngineRecipeFile, selectEngine, type RecipeEngine } from "../chrome/runtime/engine-recipes";
import { resolveChromeExecutable, resolveEngineExecutable } from "../platform/chrome-executable";

export const resolveServerEngine = async (
  options: Readonly<{ engine?: string; engineConfigPath?: string; executablePath?: string }>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<{ executablePath: string; engine?: RecipeEngine }>> => {
  const fileRecipes =
    options.engineConfigPath === undefined ? undefined : await loadEngineRecipeFile(options.engineConfigPath);
  const selection = selectEngine(options.engine, fileRecipes);

  if (selection.kind === "chrome") {
    return { executablePath: await resolveChromeExecutable({ executablePath: options.executablePath }) };
  }

  const executablePath = await resolveEngineExecutable(
    selection.engine.name,
    options.executablePath ?? selection.command,
    env,
  );

  return { executablePath, engine: selection.engine };
};
