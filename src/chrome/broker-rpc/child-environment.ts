import { fileURLToPath } from "node:url";
import { ISOLATED_BUN_CONFIG_ARGUMENT } from "../../platform/bun-child";
import { createWorkerEnvironment } from "../execution/runner";
import { chromeProcessEnvironment } from "../runtime/browser-launcher";
import {
  BROKER_CHILD_EXECUTABLE_ENV,
  BROKER_CHILD_RUNTIME_ENV,
  BROKER_CHILD_WORKSPACE_ENV,
} from "./constants";

const BROKER_CHILD_PATH = fileURLToPath(new URL("./child.ts", import.meta.url));

export type BrokerChildProcessOptions = Readonly<{
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
});

export const resolveBrokerChildProcess = (options: BrokerChildProcessOptions) => ({
  args: [ISOLATED_BUN_CONFIG_ARGUMENT, BROKER_CHILD_PATH],
  command: process.execPath,
  cwd: options.workspacePath,
  env: createBrokerChildEnvironment(options),
});
