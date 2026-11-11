import { launchVirtualDisplay } from "../src/chrome/runtime/virtual-display";

const display = process.platform === "linux" ? await launchVirtualDisplay() : undefined;

try {
  const child = Bun.spawn([
    process.execPath,
    "test",
    "./src/chrome/execution/live-chrome.acceptance.test.ts",
    "./src/chrome/server/live-service.acceptance.test.ts",
  ], {
    env: {
      ...process.env,
      CHROME_MCP_LIVE_ACCEPTANCE: "1",
      ...(display ? { DISPLAY: display.display } : {}),
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
} finally {
  await display?.close();
}
