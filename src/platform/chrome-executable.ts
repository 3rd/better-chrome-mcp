import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type ChromeExecutableOptions = Readonly<{
  executablePath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}>;

const listInstalledChromePaths = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => {
  if (platform === "darwin") {
    const homeDirectory = env.HOME ?? homedir();

    return ["/Applications", join(homeDirectory, "Applications")].flatMap((applicationsDirectory) =>
      ["Google Chrome", "Chromium"].map((application) =>
        join(applicationsDirectory, `${application}.app`, "Contents", "MacOS", application),
      ),
    );
  }

  if (platform === "win32") {
    const installRoots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(
      (installRoot) => installRoot !== undefined,
    );

    return installRoots.flatMap((installRoot) => [
      join(installRoot, "Google", "Chrome", "Application", "chrome.exe"),
      join(installRoot, "Chromium", "Application", "chrome.exe"),
    ]);
  }

  return [];
};

const resolveProgramPath = async (path: string, programLabel: string, env: NodeJS.ProcessEnv) => {
  const resolved = Bun.which(path, { PATH: env.PATH }) ?? resolve(path);

  try {
    await access(resolved, constants.X_OK);
  } catch {
    throw new Error(`${programLabel} is not accessible: ${resolved}`);
  }

  return resolved;
};

export const resolveChromeExecutable = async (options: ChromeExecutableOptions = {}) => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const executablePath = options.executablePath ?? env.CHROME_MCP_EXECUTABLE_PATH;
  if (executablePath) return resolveProgramPath(executablePath, "Chrome executable", env);

  for (const command of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    const path = Bun.which(command, { PATH: env.PATH });
    if (path) return path;
  }

  for (const path of listInstalledChromePaths(platform, env)) {
    try {
      await access(path, constants.X_OK);

      return path;
    } catch {
      continue;
    }
  }

  throw new Error(
    "Chrome was not found. Install Google Chrome or set --executable-path (CHROME_MCP_EXECUTABLE_PATH).",
  );
};

export const resolveEngineExecutable = async (
  engineName: string,
  path: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
) => {
  if (!path) {
    throw new Error(
      `The ${engineName} engine needs its program path: pass --executable-path <path>, or set "command" for it in --engine-config`,
    );
  }

  return resolveProgramPath(path, `Engine "${engineName}" program`, env);
};
