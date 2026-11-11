import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromeLaunchArguments,
  chromeProcessEnvironment,
  HEADLESS_VIEWPORT,
  modeLaunchOptions,
  parseDevToolsActivePort,
  prepareLaunchProfile,
} from "./browser-launcher";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("Chrome browser launch", () => {
  test("disables password leak warnings and save prompts in a new launch profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chrome-launch-profile-"));
    temporaryDirectories.push(directory);

    const userDataDir = join(directory, "user-data");

    await prepareLaunchProfile(userDataDir, join(directory, "downloads"));

    expect(JSON.parse(await readFile(join(userDataDir, "Default", "Preferences"), "utf8"))).toEqual({
      credentials_enable_service: false,
      profile: { password_manager_leak_detection: false },
    });
  });

  test("preserves other preferences when disabling password prompts in a reused profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chrome-launch-profile-"));
    temporaryDirectories.push(directory);

    const userDataDir = join(directory, "user-data");
    const profileDirectory = join(userDataDir, "Default");
    const preferencesPath = join(profileDirectory, "Preferences");
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(
      preferencesPath,
      JSON.stringify({
        credentials_enable_service: true,
        profile: { name: "Automation", password_manager_leak_detection: true },
        browser: { show_home_button: true },
      }),
    );

    await prepareLaunchProfile(userDataDir, join(directory, "downloads"));

    expect(JSON.parse(await readFile(preferencesPath, "utf8"))).toEqual({
      credentials_enable_service: false,
      profile: { name: "Automation", password_manager_leak_detection: false },
      browser: { show_home_button: true },
    });
  });

  test("leaves malformed profile preferences intact when preparation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chrome-launch-profile-"));
    temporaryDirectories.push(directory);

    const userDataDir = join(directory, "user-data");
    const profileDirectory = join(userDataDir, "Default");
    const preferencesPath = join(profileDirectory, "Preferences");
    await mkdir(profileDirectory, { recursive: true });
    const original = JSON.stringify({ profile: null });
    await writeFile(preferencesPath, original);

    expect(prepareLaunchProfile(userDataDir, join(directory, "downloads"))).rejects.toThrow();

    expect(await readFile(preferencesPath, "utf8")).toBe(original);
  });

  test("parses only loopback DevToolsActivePort endpoints and preserves root launch behavior", () => {
    expect(parseDevToolsActivePort("9222\n/devtools/browser/id\n")).toBe(
      "ws://127.0.0.1:9222/devtools/browser/id",
    );
    expect(() => parseDevToolsActivePort("0\n/devtools/browser/id\n")).toThrow();
    expect(() => parseDevToolsActivePort("9222\nhttp://example.test\n")).toThrow();
    expect(chromeLaunchArguments(0)).toContain("--no-sandbox");
    expect(chromeLaunchArguments(1)).not.toContain("--no-sandbox");
  });

  test("uses hardware GPU selection and a full-HD viewport in headless modes", () => {
    const paths = { executablePath: "/chrome", userDataDir: "/profile", downloadsPath: "/downloads" };
    const headed = modeLaunchOptions({ mode: "isolated", ...paths });
    const headless = modeLaunchOptions({ mode: "isolated-headless", ...paths });
    const sharedHeadless = modeLaunchOptions({ mode: "shared-headless", ...paths });
    expect(headed.headless).toBe(false);
    expect(headed.args).not.toContain("--enable-gpu");
    expect(headed.viewport).toBeNull();
    expect(headless.headless).toBe(true);
    expect(headless.args).toContain("--enable-gpu");
    expect(headless.viewport).toEqual(HEADLESS_VIEWPORT);
    expect(sharedHeadless.args).toContain("--enable-gpu");
  });

  test("launches virtual-display Chrome headed with native scale and a resizable viewport", () => {
    const options = modeLaunchOptions({
      mode: "isolated-virtual-display",
      nativeDeviceScaleFactor: 1.296_875,
      executablePath: "/chrome",
      userDataDir: "/profile",
      downloadsPath: "/downloads",
    });
    expect(options.headless).toBe(false);
    expect(options.viewport).toEqual(HEADLESS_VIEWPORT);
    expect(options.args).toContain("--force-device-scale-factor=1.296875");
    expect(options.args).toContain("--ozone-platform=x11");
    expect(options.args).toContain("--disable-gpu");
    expect(options.nativeDeviceScaleFactor).toBe(1.296_875);
  });

  test("passes GL driver settings but not preloaded libraries or credentials to Chrome", () => {
    expect(
      chromeProcessEnvironment({
        API_TOKEN: "secret",
        DISPLAY: ":1",
        HOME: "/home/test",
        LD_PRELOAD: "/tmp/preload.so",
        PATH: "/bin",
        XDG_RUNTIME_DIR: "/run/user/1000",
        __GL_SYNC_DISPLAY_DEVICE: "DP-2",
      }),
    ).toEqual({
      DISPLAY: ":1",
      HOME: "/home/test",
      PATH: "/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      __GL_SYNC_DISPLAY_DEVICE: "DP-2",
    });
  });
});
