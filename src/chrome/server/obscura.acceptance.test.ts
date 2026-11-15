import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../artifacts";
import { BUILT_IN_ENGINE_RECIPES } from "../runtime/engine-recipes";
import type { ChromeToolContext } from "./register-tools";
import { createChromeMcpServer } from "./create-server";
import { createChromeService } from "./service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

// Set OBSCURA_BIN to the obscura executable to run these tests.
const obscuraTest = process.env.OBSCURA_BIN ? test : test.skip;

// Copied verbatim from SETUP.md section 4, step 3.
const SETUP_STEP_3_CODE = `await page.setContent("<title>MCP setup check</title><button>Increment</button><output>0</output>");
await page.evaluate(() => {
  const button = document.querySelector("button");
  const output = document.querySelector("output");
  button.addEventListener("click", () => {
    output.textContent = String(Number(output.textContent) + 1);
  });
});
await page.getByRole("button", { name: "Increment" }).click();
const count = await page.locator("output").textContent();
if (count !== "1") throw new Error(\`Expected count 1, received \${count}\`);
return { title: await page.title(), count };`;

// Copied verbatim from SETUP.md section 4, step 4.
const SETUP_STEP_4_CODE = `try {
  const count = await page.locator("output").textContent();
  if (count !== "1") throw new Error(\`Expected persisted count 1, received \${count}\`);
  return { persistedCount: count };
} finally {
  await browser.close();
}`;

const createLiveToolContext = (root: string, connectionId = crypto.randomUUID()): ChromeToolContext => ({
  client: { version: undefined },
  elicit: () => Promise.reject(new Error("Live acceptance does not use elicitation")),
  log: {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  },
  reportProgress: () => Promise.resolve(),
  session: {
    connectionId,
    pathContext: { baseCwd: root },
    recording: { mode: "off" },
  },
  streamContent: () => Promise.resolve(),
});

const restoreEnvironment = (name: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

const withObscura = async (run: (client: Client, root: string) => Promise<void>) => {
  const executablePath = process.env.OBSCURA_BIN;
  if (!executablePath) {
    throw new Error("OBSCURA_BIN is required");
  }
  const root = await mkdtemp(join(tmpdir(), "chrome-mcp-obscura-"));
  roots.push(root);
  const priorDataHome = process.env.XDG_DATA_HOME;
  const priorRuntimeDir = process.env.CHROME_MCP_RUNTIME_DIR;
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.CHROME_MCP_RUNTIME_DIR = join(root, "runtime");
  try {
    const service = await createChromeService({
      artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
      engine: { name: "obscura", ...BUILT_IN_ENGINE_RECIPES.obscura },
      executablePath,
      workspacePath: root,
    });
    try {
      const server = createChromeMcpServer(service);
      const client = new Client({ name: "obscura-acceptance-client", version: "1.0.0" }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const [session] = await Promise.all([
        server.connect(serverTransport, createLiveToolContext(root).session),
        client.connect(clientTransport),
      ]);
      try {
        await run(client, root);
      } finally {
        await client.close();
        await session.close();
      }
    } finally {
      await service.close();
    }
  } finally {
    restoreEnvironment("XDG_DATA_HOME", priorDataHome);
    restoreEnvironment("CHROME_MCP_RUNTIME_DIR", priorRuntimeDir);
  }
};

obscuraTest(
  "runs the SETUP.md click-and-persist check on obscura through isolated-headless",
  async () => {
    await withObscura(async (client) => {
      const selection = { browser: "isolated-headless", browserInstanceId: "obscura-setup-check" };
      const first = await client.callTool({
        name: "run_playwright",
        arguments: { ...selection, code: SETUP_STEP_3_CODE },
      });
      expect(first.structuredContent).toMatchObject({ ok: true, value: { title: "MCP setup check", count: "1" } });
      const second = await client.callTool({
        name: "run_playwright",
        arguments: { ...selection, code: SETUP_STEP_4_CODE },
      });
      expect(second.structuredContent).toMatchObject({ ok: true, value: { persistedCount: "1" } });
      const refused = await client.callTool({
        name: "run_playwright",
        arguments: { browser: "isolated", code: "return 1" },
      });
      expect(refused.structuredContent).toMatchObject({
        ok: false,
        error: { code: "CHROME_MCP_ENGINE_UNSUPPORTED_MODE" },
      });
    });
  },
  60_000,
);

obscuraTest(
  "takes a heap snapshot on obscura",
  async () => {
    await withObscura(async (client, root) => {
      const selection = { browser: "isolated-headless", browserInstanceId: "obscura-heap" };
      const filePath = join(root, "obscura.heapsnapshot");
      const snapshot = await client.callTool({
        name: "take_heapsnapshot",
        arguments: { ...selection, filePath },
      });
      expect(snapshot.isError).not.toBe(true);
      expect(snapshot.structuredContent).toMatchObject({ message: expect.stringContaining("Heap snapshot saved") });
      expect((await stat(filePath)).size).toBeGreaterThan(0);

      const closed = await client.callTool({
        name: "run_playwright",
        arguments: { ...selection, code: "await browser.close();" },
      });
      expect(closed.structuredContent).toMatchObject({ ok: true });
    });
  },
  60_000,
);
