import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpConnection } from "./cdp-connection";
import type { RecipeEngine } from "./engine-recipes";
import {
  launchRecipeBrowser,
  type RecipeBrowserHandle,
  stopAllRecipeProcesses,
  stopRecipeProcessTreeByPid,
} from "./recipe-launcher";

const FAKE_ENGINE = fileURLToPath(new URL("./fake-cdp-engine.test-support.ts", import.meta.url));

const fakeEngine = (behavior: string, extra: readonly string[] = [], startupTimeoutMs = 10_000): RecipeEngine => ({
  name: "fake",
  args: [FAKE_ENGINE, "--port", "{port}", "--storage-dir", "{profileDir}", "--behavior", behavior, ...extra],
  startupTimeoutMs,
});

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (condition: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(25);
};

let root: string;
const handles: RecipeBrowserHandle[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "recipe-launcher-"));
});

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
  await rm(root, { recursive: true, force: true });
});

const launch = async (
  engine: RecipeEngine,
  profileDir: string,
  extra: Readonly<{ closeGraceMs?: number; sourceEnv?: NodeJS.ProcessEnv }> = {},
) => {
  const handle = await launchRecipeBrowser({
    command: process.execPath,
    engine,
    profileDir,
    closeGraceMs: 200,
    ...extra,
  });
  handles.push(handle);
  return handle;
};

const readRecord = async (profileDir: string) =>
  JSON.parse(await readFile(join(profileDir, "fake-engine.json"), "utf8")) as {
    argv: string[];
    envKeys: string[];
    pid: number;
    childPid?: number;
  };

describe("launchRecipeBrowser", () => {
  test("starts the engine with expanded arguments, a created profile folder, the filtered environment and a loopback endpoint", async () => {
    const profileDir = join(root, "missing", "user-data");
    const handle = await launch(fakeEngine("ready", ["--literal", "a && echo injected"]), profileDir, {
      sourceEnv: { ...process.env, CHROME_MCP_TEST_SECRET: "secret" },
    });
    const record = await readRecord(profileDir);
    const port = new URL(handle.recipe.endpoint).port;

    expect(handle.recipe.endpoint).toBe(`ws://127.0.0.1:${port}/devtools/browser/fake`);
    expect(record.argv).toEqual([
      "--port",
      port,
      "--storage-dir",
      profileDir,
      "--behavior",
      "ready",
      "--literal",
      "a && echo injected",
    ]);
    expect(record.envKeys).not.toContain("CHROME_MCP_TEST_SECRET");
    expect(record.pid).toBe(handle.recipe.browserPid);
  });

  test("fails at once with the exit code and stderr tail when the engine exits before it is ready", async () => {
    const started = Date.now();
    const failure = launchRecipeBrowser({
      command: process.execPath,
      engine: fakeEngine("exit-early"),
      profileDir: join(root, "profile"),
    });

    await expect(failure).rejects.toMatchObject({ code: "CHROME_MCP_BROWSER_DISCONNECTED" });
    await expect(failure).rejects.toThrow("exited with code 3");
    await expect(failure).rejects.toThrow("fake engine failed: bad flag");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("stops the engine and reports the stderr tail when it is not ready within startupTimeoutMs", async () => {
    const profileDir = join(root, "profile");
    const failure = launchRecipeBrowser({
      command: process.execPath,
      engine: fakeEngine("never-ready", [], 500),
      profileDir,
    });

    await expect(failure).rejects.toMatchObject({ code: "CHROME_MCP_BROWSER_DISCONNECTED" });
    await expect(failure).rejects.toThrow("within 500 ms");
    await expect(failure).rejects.toThrow("fake engine warming up");
    const { pid } = await readRecord(profileDir);
    await waitFor(() => !isRunning(pid), 3000);
    expect(isRunning(pid)).toBe(false);
  });

  test("keeps draining a chatty stderr so the engine is never blocked", async () => {
    const handle = await launch(fakeEngine("ready", ["--stderr-bytes", "1048576"]), join(root, "profile"));

    expect(handle.recipe.endpoint).toStartWith("ws://127.0.0.1:");
  });

  test("closes an engine that exited on Browser.close without signalling its freed PID", async () => {
    const handle = await launch(fakeEngine("ready"), join(root, "profile"));
    const connection = await CdpConnection.connect(handle.recipe.endpoint);
    await connection.send("Browser.close");
    connection.close();

    const kill = spyOn(process, "kill");

    try {
      await handle.close();

      expect(await handle.recipe.exited).toBe(0);
      expect(kill.mock.calls.filter(([pid]) => pid === handle.recipe.browserPid)).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });

  test("stops the process tree when the engine ignores Browser.close", async () => {
    const started = Date.now();
    const handle = await launch(fakeEngine("ignore-close"), join(root, "profile"), { closeGraceMs: 200 });
    const connection = await CdpConnection.connect(handle.recipe.endpoint);
    await connection.send("Browser.close");
    connection.close();

    await handle.close();

    expect(Date.now() - started).toBeLessThan(4000);
    expect(isRunning(handle.recipe.browserPid)).toBe(false);
  });

  test("stops a child process of the engine along with the engine", async () => {
    const profileDir = join(root, "profile");
    const handle = await launch(fakeEngine("ignore-close", ["--spawn-child"]), profileDir);
    const { childPid } = await readRecord(profileDir);
    try {
      expect(childPid).toBeNumber();
      expect(isRunning(childPid ?? 0)).toBe(true);

      await handle.close();
      await waitFor(() => !isRunning(childPid ?? 0), 3000);

      expect(isRunning(childPid ?? 0)).toBe(false);
    } finally {
      if (childPid !== undefined && isRunning(childPid)) process.kill(childPid, "SIGKILL");
    }
  });

  test("stops an engine and its child by PID", async () => {
    const profileDir = join(root, "profile");
    const handle = await launch(fakeEngine("ignore-close", ["--spawn-child"]), profileDir);
    const { childPid } = await readRecord(profileDir);
    try {
      await stopRecipeProcessTreeByPid(handle.recipe.browserPid);
      await waitFor(() => !isRunning(handle.recipe.browserPid) && !isRunning(childPid ?? 0), 3000);

      expect(isRunning(handle.recipe.browserPid)).toBe(false);
      expect(isRunning(childPid ?? 0)).toBe(false);
    } finally {
      if (childPid !== undefined && isRunning(childPid)) process.kill(childPid, "SIGKILL");
    }
  });

  test("stops every live engine when the broker exits", async () => {
    const handle = await launch(fakeEngine("ready"), join(root, "profile"));

    stopAllRecipeProcesses();

    await Promise.race([handle.recipe.exited, Bun.sleep(3000)]);
    await waitFor(() => !isRunning(handle.recipe.browserPid), 3000);
    expect(isRunning(handle.recipe.browserPid)).toBe(false);
  });
});
