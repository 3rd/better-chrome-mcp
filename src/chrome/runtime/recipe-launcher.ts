import { mkdir } from "node:fs/promises";
import { isNodeError } from "../../platform/node-errors";
import {
  chromeProcessEnvironment,
  type LaunchedBrowserHandle,
  type RecipeProcessInfo,
} from "./browser-launcher";
import { fetchWebSocketDebuggerUrl, loopbackEndpoint } from "./devtools-endpoint";
import { expandRecipeArguments, type RecipeEngine } from "./engine-recipes";
import { ChromeRuntimeError } from "./errors";

export const RECIPE_CLOSE_GRACE_MS = 2000;
export const RECIPE_STDERR_TAIL_LINES = 20;
export const RECIPE_POLL_INTERVAL_MS = 50;

const STDERR_BUFFER_CHARS = 8 * 1024;
const POSIX_TERM_WAIT_MS = 1000;
const STOP_WAIT_MS = 5000;
const STDERR_DRAIN_WAIT_MS = 500;
const POLL_TIMEOUT_MS = 1000;

export type RecipeLaunchOptions = Readonly<{
  command: string;
  engine: RecipeEngine;
  profileDir: string;
  closeGraceMs?: number;
  sourceEnv?: NodeJS.ProcessEnv;
}>;

export type RecipeBrowserHandle = LaunchedBrowserHandle & Readonly<{ recipe: RecipeProcessInfo }>;

export type RecipeBrowserLauncher = Readonly<{
  launch: (options: RecipeLaunchOptions) => Promise<RecipeBrowserHandle>;
}>;

const liveProcesses = new Set<Bun.Subprocess>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const pickFreePort = (): number => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
};

const ignoreNoSuchProcess = (error: unknown) => {
  if (!isNodeError(error, "ESRCH")) throw error;
};

const killGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    ignoreNoSuchProcess(error);
  }

  // No group with this ID: an engine that moved itself to another group (setsid/setpgid) still has a live leader.
  try {
    process.kill(pid, signal);
  } catch (error) {
    ignoreNoSuchProcess(error);
  }
};

const taskkillCommand = (pid: number) => [
  `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`,
  "/PID",
  String(pid),
  "/T",
  "/F",
];

const stopProcessTree = async (proc: Bun.Subprocess) => {
  if (process.platform === "win32") {
    await Bun.spawn(taskkillCommand(proc.pid), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    }).exited;
    return;
  }

  killGroup(proc.pid, "SIGTERM");
  await withTimeout(proc.exited, POSIX_TERM_WAIT_MS);
  // Always follow with SIGKILL: the leader may have exited while a child in the group ignored SIGTERM.
  killGroup(proc.pid, "SIGKILL");
};

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "EPERM")) return true;
    ignoreNoSuchProcess(error);
    return false;
  }
};

// Stops an engine this server did not spawn (an adopted browser). The caller must have verified the PID's identity.
export const stopRecipeProcessTreeByPid = async (pid: number): Promise<void> => {
  if (process.platform === "win32") {
    await Bun.spawn(taskkillCommand(pid), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    }).exited;
    return;
  }

  killGroup(pid, "SIGTERM");
  const deadline = Date.now() + POSIX_TERM_WAIT_MS;
  while (processAlive(pid) && Date.now() < deadline) await sleep(RECIPE_POLL_INTERVAL_MS);
  killGroup(pid, "SIGKILL");
};

const stopProcessTreeSync = (proc: Bun.Subprocess) => {
  if (process.platform === "win32") {
    Bun.spawnSync(taskkillCommand(proc.pid), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    return;
  }

  killGroup(proc.pid, "SIGKILL");
};

export const stopAllRecipeProcesses = (): void => {
  for (const proc of [...liveProcesses]) {
    try {
      stopProcessTreeSync(proc);
    } catch {
      // The broker is exiting; keep stopping the remaining engines.
    }
  }
};

const startStderrTail = (proc: Bun.Subprocess<"ignore", "ignore", "pipe">) => {
  let buffer = "";
  const decoder = new TextDecoder();
  const append = (text: string) => {
    buffer = (buffer + text).slice(-STDERR_BUFFER_CHARS);
  };
  const drained = (async () => {
    try {
      for await (const chunk of proc.stderr) append(decoder.decode(chunk, { stream: true }));
    } catch {
      // A closed pipe ends the tail.
    }
    append(decoder.decode());
  })();

  return {
    drained,
    tail: () =>
      buffer
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .slice(-RECIPE_STDERR_TAIL_LINES)
        .join("\n"),
  };
};

export const launchRecipeBrowser = async (options: RecipeLaunchOptions): Promise<RecipeBrowserHandle> => {
  const { command, engine, profileDir } = options;
  const closeGraceMs = options.closeGraceMs ?? RECIPE_CLOSE_GRACE_MS;
  const port = pickFreePort();

  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const proc = Bun.spawn({
    cmd: [command, ...expandRecipeArguments(engine, { port, profileDir })],
    env: chromeProcessEnvironment(options.sourceEnv ?? process.env),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  liveProcesses.add(proc);
  const exited = proc.exited;
  void exited.then(() => liveProcesses.delete(proc));

  const stderr = startStderrTail(proc);
  const failure = async (message: string) => {
    await withTimeout(stderr.drained, STDERR_DRAIN_WAIT_MS);
    return new ChromeRuntimeError("CHROME_MCP_BROWSER_DISCONNECTED", `${message}\n${stderr.tail()}`);
  };

  const versionUrl = new URL(`http://127.0.0.1:${port}/json/version`);
  const deadline = Date.now() + engine.startupTimeoutMs;
  const exitSignal = exited.then((code) => ({ exitCode: code }));
  let webSocketDebuggerUrl: string | undefined;
  while (webSocketDebuggerUrl === undefined) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await stopProcessTree(proc);
      throw await failure(
        `Engine "${engine.name}" did not publish a DevTools endpoint at ${versionUrl.href} within ${engine.startupTimeoutMs} ms`,
      );
    }

    const poll = fetchWebSocketDebuggerUrl(
      versionUrl,
      AbortSignal.timeout(Math.min(POLL_TIMEOUT_MS, remaining)),
    ).then(
      (url) => ({ url }),
      () => ({ url: undefined }),
    );
    const outcome = await Promise.race([poll, exitSignal]);
    if ("exitCode" in outcome) {
      throw await failure(
        `Engine "${engine.name}" exited with code ${outcome.exitCode} before publishing its DevTools endpoint`,
      );
    }
    if (outcome.url !== undefined) {
      webSocketDebuggerUrl = outcome.url;
      break;
    }

    const slept = await Promise.race([sleep(RECIPE_POLL_INTERVAL_MS).then(() => undefined), exitSignal]);
    if (slept !== undefined) {
      throw await failure(
        `Engine "${engine.name}" exited with code ${slept.exitCode} before publishing its DevTools endpoint`,
      );
    }
  }

  const recipe: RecipeProcessInfo = Object.freeze({
    browserPid: proc.pid,
    endpoint: loopbackEndpoint(webSocketDebuggerUrl, port),
    exited,
  });

  return Object.freeze({
    recipe,
    close: async () => {
      if ((await withTimeout(exited, closeGraceMs)) === undefined) {
        await stopProcessTree(proc);
        if ((await withTimeout(exited, STOP_WAIT_MS)) === undefined) {
          throw new ChromeRuntimeError(
            "CHROME_MCP_BROWSER_DISCONNECTED",
            `Engine "${engine.name}" PID ${proc.pid} did not exit`,
          );
        }
      } else if (process.platform !== "win32") {
        // The leader exited on its own, but a child of a multi-process engine may still be in its group.
        killGroup(proc.pid, "SIGKILL");
      }
      liveProcesses.delete(proc);
    },
  });
};

export const recipeBrowserLauncher: RecipeBrowserLauncher = Object.freeze({ launch: launchRecipeBrowser });
