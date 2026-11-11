import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChromeExecutable } from "./chrome-executable";

test("uses an explicitly configured executable without relying on PATH", async () => {
  expect(
    await resolveChromeExecutable({
      env: { PATH: "", CHROME_MCP_EXECUTABLE_PATH: process.execPath },
    }),
  ).toBe(process.execPath);
});

test("reports missing Chrome with the supported configuration options", async () => {
  expect(resolveChromeExecutable({ platform: "linux", env: { PATH: "" } })).rejects.toThrow(
    "CHROME_MCP_EXECUTABLE_PATH",
  );
});

test("finds Google Chrome in a Windows install folder when it is not on PATH", async () => {
  const programFiles = await mkdtemp(join(tmpdir(), "chrome-executable-windows-"));
  const applicationFolder = join(programFiles, "Google", "Chrome", "Application");
  await mkdir(applicationFolder, { recursive: true });
  await writeFile(join(applicationFolder, "chrome.exe"), "", { mode: 0o755 });

  try {
    expect(
      await resolveChromeExecutable({ platform: "win32", env: { PATH: "", ProgramFiles: programFiles } }),
    ).toBe(join(applicationFolder, "chrome.exe"));
  } finally {
    await rm(programFiles, { force: true, recursive: true });
  }
});
