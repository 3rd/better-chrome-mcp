import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserMode } from "./modes";
import type { PwaCommand } from "./pwa-controller";
import { isGlDriverEnvName } from "../../platform/desktop-env";
import { isNodeError } from "../../platform/node-errors";
import { isRecord } from "../../platform/records";
import { windowsSystemEnvironment } from "../../platform/windows/environment";
import { writeFileAtomic } from "../../platform/write-file-atomic";
import { CDP_METHOD_NOT_FOUND, CdpCommandError } from "./cdp-connection";
import { ChromeRuntimeError } from "./errors";
import { assertNativeDeviceScaleFactor, isHeadlessMode } from "./modes";
import { createPageViewportController, type PageViewportController } from "./page-viewport";
import { launchVirtualDisplay } from "./virtual-display";

export type LaunchedBrowserHandle = Readonly<{
  close: () => Promise<void>;
  pageViewport: PageViewportController;
  sendPwaCommand?: PwaCommand;
}>;

export type BrowserLauncher = Readonly<{
  launch: (options: LaunchChromeOptions) => Promise<LaunchedBrowserHandle>;
}>;

export type LaunchChromeOptions = Readonly<{
  args: string[];
  chromiumSandbox: true;
  downloadsPath: string;
  executablePath: string;
  headless: boolean;
  nativeDeviceScaleFactor?: number;
  userDataDir: string;
  viewport: Readonly<{ height: number; width: number }> | null;
}>;

export const HEADLESS_VIEWPORT = Object.freeze({ height: 1080, width: 1920 });
export const BROWSER_LAUNCH_TIMEOUT_MS = 10_000;
export const MAIN_CHROME_CONNECT_TIMEOUT_MS = 60_000;

const CHROME_ENVIRONMENT_KEYS = [
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
] as const;

export const chromeProcessEnvironment = (source: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const environment: Record<string, string> = windowsSystemEnvironment(source);
  for (const key of CHROME_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (typeof value === "string") environment[key] = value;
  }

  for (const [key, value] of Object.entries(source)) {
    const isGlDriverSetting = isGlDriverEnvName(key) && typeof value === "string";
    if (!isGlDriverSetting) continue;

    environment[key] = value;
  }

  return environment;
};

export const loadPlaywrightBrowserLauncher = async (): Promise<BrowserLauncher> => {
  const { chromium } = await import("playwright-core");
  return Object.freeze({
    launch: async (options: LaunchChromeOptions): Promise<LaunchedBrowserHandle> => {
      const virtualDisplay =
        options.nativeDeviceScaleFactor === undefined ? undefined : await launchVirtualDisplay();
      const environment = chromeProcessEnvironment();
      if (virtualDisplay) {
        environment.DISPLAY = virtualDisplay.display;
        delete environment.WAYLAND_DISPLAY;
        delete environment.XAUTHORITY;
      }

      let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;

      try {
        context = await chromium.launchPersistentContext(options.userDataDir, {
          acceptDownloads: true,
          args: options.args,
          chromiumSandbox: options.chromiumSandbox,
          downloadsPath: options.downloadsPath,
          ...(options.nativeDeviceScaleFactor === undefined ?
            {}
          : { deviceScaleFactor: options.nativeDeviceScaleFactor }),
          env: environment,
          executablePath: options.executablePath,
          headless: options.headless,
          timeout: BROWSER_LAUNCH_TIMEOUT_MS,
          viewport: options.viewport,
        });
      } catch (error: unknown) {
        await virtualDisplay?.close();
        throw error;
      }

      if (virtualDisplay) {
        context.on("close", virtualDisplay.stop);
      }

      context.on("dialog", () => undefined);

      const browser = context.browser();
      if (!browser) {
        await context.close();
        await virtualDisplay?.close();
        throw new ChromeRuntimeError(
          "CHROME_MCP_BROWSER_DISCONNECTED",
          "Launched Chrome did not provide its browser connection",
        );
      }

      let pwaSession: ReturnType<typeof browser.newBrowserCDPSession> | undefined;

      const sendPwaCommand: PwaCommand = async (method, params) => {
        pwaSession ??= browser.newBrowserCDPSession();
        const session = await pwaSession;

        try {
          return await session.send(method, params);
        } catch (error: unknown) {
          if (!(error instanceof Error)) {
            throw error;
          }

          const prefix = `Protocol error (${method}): `;
          const offset = error.message.indexOf(prefix);
          if (offset < 0) {
            throw error;
          }

          const message = error.message.slice(offset + prefix.length).split("\n")[0] ?? error.message;
          throw new CdpCommandError(
            message,
            message === `'${method}' wasn't found` ? CDP_METHOD_NOT_FOUND : undefined,
          );
        }
      };

      return Object.freeze({
        pageViewport: createPageViewportController([context]),
        sendPwaCommand,
        close: async () => {
          const detachResults =
            pwaSession ? await Promise.allSettled([pwaSession.then((session) => session.detach())]) : [];
          const closeResults = await Promise.allSettled([context.close()]);
          const displayResults = virtualDisplay ? await Promise.allSettled([virtualDisplay.close()]) : [];
          const errors = [...detachResults, ...closeResults, ...displayResults]
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => result.reason);
          if (errors.length > 0) {
            throw new AggregateError(errors, "Chrome launch connection cleanup failed");
          }
        },
      });
    },
  });
};

export const chromeLaunchArguments = (uid = process.getuid?.()): string[] => {
  const args = ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"];
  if (uid === 0) args.push("--no-sandbox");
  return args;
};

export const assertChromeExecutable = async (executablePath: string): Promise<void> =>
  access(executablePath, constants.X_OK);

export const parseDevToolsActivePort = (value: string): string => {
  const [rawPort, rawPath] = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const port = rawPort ? Number(rawPort) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !rawPath?.startsWith("/")) {
    throw new Error("DevToolsActivePort contains an invalid loopback endpoint");
  }
  return `ws://127.0.0.1:${port}${rawPath}`;
};

export const readDevToolsEndpoint = async (userDataDir: string): Promise<string> =>
  parseDevToolsActivePort(await readFile(join(userDataDir, "DevToolsActivePort"), "utf8"));

export const waitForDevToolsEndpoint = async (userDataDir: string, timeoutMs = 10_000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readDevToolsEndpoint(userDataDir);
    } catch (error: unknown) {
      if (
        !isNodeError(error, "ENOENT") &&
        !(error instanceof Error && error.message.includes("DevToolsActivePort"))
      ) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new ChromeRuntimeError(
          "CHROME_MCP_BROWSER_DISCONNECTED",
          `Chrome did not publish DevToolsActivePort within ${timeoutMs} ms`,
          { cause: error },
        );
      }
      await Bun.sleep(25);
    }
  }
};

export const prepareLaunchProfile = async (userDataDir: string, downloadsPath: string) => {
  await mkdir(dirname(userDataDir), { recursive: true, mode: 0o700 });
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });
  await mkdir(downloadsPath, { recursive: true, mode: 0o700 });

  const profileDirectory = join(userDataDir, "Default");
  const preferencesPath = join(profileDirectory, "Preferences");
  let preferences: unknown = {};

  try {
    preferences = JSON.parse(await readFile(preferencesPath, "utf8"));
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }

  if (!isRecord(preferences)) {
    throw new Error("Chrome profile preferences must be a JSON object");
  }

  const profile = preferences.profile === undefined ? {} : preferences.profile;
  if (!isRecord(profile)) {
    throw new Error("Chrome profile preferences.profile must be a JSON object");
  }

  const hasDisabledPasswordPrompts =
    preferences.credentials_enable_service === false && profile.password_manager_leak_detection === false;
  if (hasDisabledPasswordPrompts) return;

  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    preferencesPath,
    `${JSON.stringify({
      ...preferences,
      credentials_enable_service: false,
      profile: { ...profile, password_manager_leak_detection: false },
    })}\n`,
    { mode: 0o600 },
  );
};

const ENABLE_REMOTE_DEBUGGING_REMEDY = `Enable remote debugging at chrome://inspect/#remote-debugging, then retry with browser: "main"`;

export const discoverMainChromeEndpoint = async (
  userDataDir: string,
): Promise<{ endpoint: string; userDataDir: string }> => {
  try {
    return { endpoint: await readDevToolsEndpoint(userDataDir), userDataDir };
  } catch (error: unknown) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_MAIN_UNAVAILABLE",
      `Could not attach to Chrome in ${userDataDir}. ${ENABLE_REMOTE_DEBUGGING_REMEDY}. If the browser keeps its profile in another folder, restart the server with --main-user-data-dir <folder>`,
      { cause: error },
    );
  }
};

const isLoopbackPortClosed = async (hostname: string, port: number) => {
  try {
    const socket = await Bun.connect({ hostname, port, socket: { data: () => undefined } });
    socket.end();
    return false;
  } catch (error: unknown) {
    return isNodeError(error, "ECONNREFUSED");
  }
};

export const diagnoseMainChromeConnectFailure = async (
  endpoint: string,
  userDataDir: string,
  error: unknown,
) => {
  const detail = error instanceof Error ? error.message : String(error);
  const { hostname, port } = new URL(endpoint);
  if (await isLoopbackPortClosed(hostname, Number(port))) {
    return new ChromeRuntimeError(
      "CHROME_MCP_MAIN_UNAVAILABLE",
      `Chrome's DevToolsActivePort in ${userDataDir} names port ${port}, but nothing is listening there, so the file is stale and remote debugging is off. ${ENABLE_REMOTE_DEBUGGING_REMEDY}. ${detail}`,
      { cause: error },
    );
  }

  return new ChromeRuntimeError(
    "CHROME_MCP_MAIN_UNAVAILABLE",
    `Chrome published its debugging endpoint in ${userDataDir}, but the connection was not accepted. Approval was not observed. Check Chrome's connection prompt, then retry with browser: "main". ${detail}`,
    { cause: error },
  );
};

type ModeLaunchOptions = Readonly<{
  mode: BrowserMode;
  executablePath: string;
  userDataDir: string;
  downloadsPath: string;
  nativeDeviceScaleFactor?: number;
}>;

export const modeLaunchOptions = ({
  mode,
  executablePath,
  userDataDir,
  downloadsPath,
  nativeDeviceScaleFactor,
}: ModeLaunchOptions): LaunchChromeOptions => {
  if (mode === "main") throw new Error("Main Chrome is attach-only");

  assertNativeDeviceScaleFactor(mode, nativeDeviceScaleFactor);
  const isHeadless = isHeadlessMode(mode);
  const hasFixedViewport = isHeadless || nativeDeviceScaleFactor !== undefined;
  const args = isHeadless ? [...chromeLaunchArguments(), "--enable-gpu"] : chromeLaunchArguments();
  if (nativeDeviceScaleFactor !== undefined) {
    args.push(
      "--ozone-platform=x11",
      `--force-device-scale-factor=${nativeDeviceScaleFactor}`,
      "--disable-gpu",
    );
  }

  return Object.freeze({
    args,
    chromiumSandbox: true,
    downloadsPath,
    executablePath,
    headless: isHeadless,
    ...(nativeDeviceScaleFactor === undefined ? {} : { nativeDeviceScaleFactor }),
    userDataDir,
    viewport: hasFixedViewport ? HEADLESS_VIEWPORT : null,
  });
};
