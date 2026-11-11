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

export const resolveChromeExecutable = async (options: ChromeExecutableOptions = {}) => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const executablePath = options.executablePath ?? env.CHROME_MCP_EXECUTABLE_PATH;
  if (executablePath) {
    const path = Bun.which(executablePath, { PATH: env.PATH }) ?? resolve(executablePath);

    try {
      await access(path, constants.X_OK);
    } catch {
      throw new Error(`Chrome executable is not accessible: ${path}`);
    }

    return path;
  }

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
