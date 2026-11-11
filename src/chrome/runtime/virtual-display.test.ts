import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchVirtualDisplay } from "./virtual-display";

test("rejects unavailable Xvfb instead of falling back to headless", async () => {
  expect(launchVirtualDisplay(null)).rejects.toMatchObject({
    code: "CHROME_MCP_UNSUPPORTED_CAPABILITY",
  });
  expect(launchVirtualDisplay("/nonexistent/chrome-mcp-Xvfb")).rejects.toMatchObject({
    code: "CHROME_MCP_BROWSER_DISCONNECTED",
  });
});

test("waits for virtual-display readiness and terminal process cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "chrome-virtual-display-test-"));
  const executable = join(root, "display");
  const receipt = join(root, "stopped");
  await writeFile(
    executable,
    `#!${process.execPath}\nimport { writeSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(receipt)}, "stopped"); process.exit(0); });
writeSync(3, "123\\n");
await new Promise(() => {});
`,
  );
  await chmod(executable, 0o700);
  let display: Awaited<ReturnType<typeof launchVirtualDisplay>> | undefined;

  try {
    display = await launchVirtualDisplay(executable);
    expect(display.display).toBe(":123");
    await display.close();
    expect(await readFile(receipt, "utf8")).toBe("stopped");
    await display.close();
  } finally {
    await display?.close();
    await rm(root, { recursive: true, force: true });
  }
});
