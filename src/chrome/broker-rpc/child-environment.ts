import { fileURLToPath } from "node:url";
import { ISOLATED_BUN_CONFIG_ARGUMENT } from "../../platform/bun-child";
import { createWorkerEnvironment } from "../execution/runner";
import { chromeProcessEnvironment } from "../runtime/browser-launcher";
import { type RecipeEngine, recipeEngineSchema } from "../runtime/engine-recipes";
import {
  BROKER_CHILD_CDP_ENDPOINT_ENV,
  BROKER_CHILD_ENGINE_ENV,
  BROKER_CHILD_EXECUTABLE_ENV,
  BROKER_CHILD_RUNTIME_ENV,
  BROKER_CHILD_WORKSPACE_ENV,
} from "./constants";

const BROKER_CHILD_PATH = fileURLToPath(new URL("./child.ts", import.meta.url));

export type BrokerChildProcessOptions = Readonly<{
  cdpEndpoint?: string;
  engine?: RecipeEngine;
  executablePath: string;
  runtimeRoot?: string;
  source?: NodeJS.ProcessEnv;
  workspacePath: string;
}>;

export const createBrokerChildEnvironment = (options: BrokerChildProcessOptions): Record<string, string> => ({
  ...createWorkerEnvironment(options.source),
  ...chromeProcessEnvironment(options.source),
  [BROKER_CHILD_EXECUTABLE_ENV]: options.executablePath,
  [BROKER_CHILD_RUNTIME_ENV]: options.runtimeRoot ?? "",
  [BROKER_CHILD_WORKSPACE_ENV]: options.workspacePath,
  ...(options.engine ? { [BROKER_CHILD_ENGINE_ENV]: JSON.stringify(options.engine) } : {}),
  ...(options.cdpEndpoint ? { [BROKER_CHILD_CDP_ENDPOINT_ENV]: options.cdpEndpoint } : {}),
});

export const readBrokerChildLaunch = (
  env: NodeJS.ProcessEnv = process.env,
): Readonly<{ engine?: RecipeEngine; cdpEndpoint?: string }> => {
  const rawEngine = env[BROKER_CHILD_ENGINE_ENV];
  const cdpEndpoint = env[BROKER_CHILD_CDP_ENDPOINT_ENV];
  let engine: RecipeEngine | undefined;
  if (rawEngine) {
    try {
      engine = recipeEngineSchema.parse(JSON.parse(rawEngine));
    } catch (error: unknown) {
      throw new Error(`Chrome broker child received a malformed ${BROKER_CHILD_ENGINE_ENV}`, { cause: error });
    }
  }
  return { ...(engine ? { engine } : {}), ...(cdpEndpoint ? { cdpEndpoint } : {}) };
};

export const resolveBrokerChildProcess = (options: BrokerChildProcessOptions) => ({
  args: [ISOLATED_BUN_CONFIG_ARGUMENT, BROKER_CHILD_PATH],
  command: process.execPath,
  cwd: options.workspacePath,
  env: createBrokerChildEnvironment(options),
});
