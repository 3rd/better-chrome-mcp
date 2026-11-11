import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright-core";
import { PNG } from "pngjs";
import type { ChromeToolContext } from "./register-tools";
import { resolveChromeExecutable } from "../../platform/chrome-executable";
import { isRecord } from "../../platform/records";
import { getMcpRuntimeDir } from "../../platform/runtime-paths";
import { ArtifactStore } from "../artifacts";
import { resolveBrokerRuntimePaths } from "../broker-rpc/paths";
import { heapQueryResultSchema } from "../diagnostics/heap-analysis-protocol";
import { runExecutionWorker } from "../execution/runner";
import {
  chromeLaunchArguments,
  chromeProcessEnvironment,
  readDevToolsEndpoint,
} from "../runtime/browser-launcher";
import { cdpRecord } from "../runtime/cdp-connection";
import { connectPageViewportController, createPageViewportController } from "../runtime/page-viewport";
import { CHROME_CAPABILITY_CDP_METHODS, type ReactUpdateComponentInput } from "./contracts";
import { createChromeMcpServer } from "./create-server";
import { createChromeService } from "./service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const liveTest = process.env.CHROME_MCP_LIVE_ACCEPTANCE === "1" ? test : test.skip;
const linuxLiveTest = process.platform === "linux" ? liveTest : test.skip;

const measureGlyphOffsets = (bytes: Buffer, scale: number) => {
  const png = PNG.sync.read(bytes);
  const offsets: number[] = [];

  for (let row = 0; row < 8; row++) {
    const top = 10 + row * 36;
    let referenceTop: number | undefined;
    let inkBottom: number | undefined;

    for (let y = Math.floor((top - 4) * scale); y < Math.ceil((top + 28) * scale); y++) {
      const reference = (y * png.width + Math.round(16 * scale)) * 4;
      const isRedReference = png.data.readUInt8(reference) > 128 && png.data.readUInt8(reference + 1) < 64;
      if (isRedReference) {
        referenceTop ??= y;
      }

      for (let x = Math.round(32 * scale); x < Math.round(190 * scale); x++) {
        const pixel = (y * png.width + x) * 4;
        const brightness =
          (png.data.readUInt8(pixel) + png.data.readUInt8(pixel + 1) + png.data.readUInt8(pixel + 2)) / 3;
        if (brightness <= 128) continue;

        inkBottom = y;
        break;
      }
    }

    assert(referenceTop !== undefined && inkBottom !== undefined);
    offsets.push(inkBottom + 1 - referenceTop);
  }

  return offsets;
};

const readLiveTargetId = async (page: Page) => {
  const session = await page.context().newCDPSession(page);
  try {
    const result: unknown = await session.send("Target.getTargetInfo");
    const targetId = cdpRecord(cdpRecord(result)?.targetInfo)?.targetId;
    if (typeof targetId !== "string") {
      throw new TypeError("Live page did not expose a target ID");
    }
    return targetId;
  } finally {
    await session.detach();
  }
};

liveTest(
  "leaves dialog answers to the caller after attaching a viewport controller",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-attached-viewport-"));
    roots.push(root);
    const context = await chromium.launchPersistentContext(root, {
      args: chromeLaunchArguments(),
      chromiumSandbox: true,
      env: chromeProcessEnvironment(),
      executablePath,
      headless: true,
    });
    context.on("dialog", () => undefined);
    try {
      const page = await context.newPage();
      const targetId = await readLiveTargetId(page);
      const controller = await connectPageViewportController(await readDevToolsEndpoint(root));
      try {
        await controller.pageViewport({ operation: "read", targetId }, new AbortController().signal);
        const dialogEvent = page.waitForEvent("dialog");
        const answer = page.evaluate(() => confirm("Continue?"));
        const dialog = await dialogEvent;

        await controller.pageViewport({ operation: "read", targetId }, new AbortController().signal);
        await dialog.accept();
        expect(await answer).toBe(true);
      } finally {
        await controller.disconnect();
      }
    } finally {
      await context.close();
    }
  },
  30_000,
);

liveTest(
  "identifies viewport pages once across concurrent and repeated lookups",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-viewport-lookup-"));
    roots.push(root);
    const context = await chromium.launchPersistentContext(root, {
      chromiumSandbox: true,
      env: chromeProcessEnvironment(),
      executablePath,
      headless: true,
      viewport: { width: 960, height: 640 },
    });
    try {
      await context.newPage();
      await context.newPage();
      const pages = context.pages();
      const targetIds = await Promise.all(pages.map(readLiveTargetId));
      const sessions = spyOn(context, "newCDPSession");
      try {
        const controller = createPageViewportController([context]);
        const signal = new AbortController().signal;
        const reads = await Promise.all(
          targetIds.map((targetId) => controller({ operation: "read", targetId }, signal)),
        );
        expect(reads).toEqual(targetIds.map(() => ({ width: 960, height: 640 })));

        for (const targetId of targetIds) {
          expect(await controller({ operation: "read", targetId }, signal)).toEqual({
            width: 960,
            height: 640,
          });
        }
        expect(sessions).toHaveBeenCalledTimes(pages.length);
      } finally {
        sessions.mockRestore();
      }
    } finally {
      await context.close();
    }
  },
  30_000,
);

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

linuxLiveTest(
  "renders native-scale glyphs through MCP and reaps its private display",
  async () => {
    const executablePath = await resolveChromeExecutable();

    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-native-scale-"));
    roots.push(root);

    const font = await readFile(
      require.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
    );
    const fixture = join(root, "glyphs.html");
    await writeFile(
      fixture,
      `<!doctype html><style>
    @font-face { font-family: Fixture; src: url(data:font/woff2;base64,${font.toString("base64")}); font-weight: 100 900; }
    body { margin: 0; background: black; color: white; font-family: Fixture; font-optical-sizing: none; -webkit-font-smoothing: antialiased; }
    section { position: absolute; left: 10px; height: 24px; display: flex; align-items: center; gap: 8px; }
    i { width: 12px; height: 24px; background: red; } span { font-weight: 500; line-height: 24px; }
    </style>${[11, 12, 13, 14, 15, 16, 18, 20]
      .map(
        (size, index) =>
          `<section style="top:${10 + index * 36}px"><i></i><span style="font-size:${size}px">HELM LUNT</span></section>`,
      )
      .join("")}`,
    );
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    const displayPids = new Set<number>();
    let cancellation = new AbortController();
    let emulatedOffsets: number[] | undefined;

    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
        executionKernel: (options) =>
          runExecutionWorker({
            ...options,
            signal: AbortSignal.any([cancellation.signal, ...(options.signal ? [options.signal] : [])]),
            adapter: {
              execute: async (request, context) => {
                const result = await options.adapter.execute(request, context);
                if (request.operation === "progress") {
                  cancellation.abort();
                }

                return result;
              },
            },
          }),
      });
      try {
        const server = createChromeMcpServer(service);
        const client = new Client({ name: "chrome-native-scale-client", version: "1.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const [session] = await Promise.all([
          server.connect(serverTransport, createLiveToolContext(root).session),
          client.connect(clientTransport),
        ]);
        try {
          for (const scale of [1, 1.296_875]) {
            const selection = {
              browser: "isolated-virtual-display",
              browserInstanceId: `native-${scale}`,
              nativeDeviceScaleFactor: scale,
            };
            const native = await client.callTool({
              name: "run_playwright",
              arguments: {
                ...selection,
                args: { url: pathToFileURL(fixture).href },
                code: `
              await page.goto(args.url);
              await page.evaluate(() => document.fonts.ready);
              await page.setViewportSize({ width: 800, height: 600 });
              const cdp = await browser.newBrowserCDPSession();
              const processes = await cdp.send('SystemInfo.getProcessInfo');
              await cdp.detach();
              return { png: (await page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 310 }, scale: 'device' })).toString('base64'),
                ratio: await page.evaluate(() => devicePixelRatio), headless: chrome.capabilities.headless,
                pid: processes.processInfo.find(process => process.type === 'browser').id };
            `,
              },
            });
            expect(native.structuredContent).toMatchObject({
              ok: true,
              rendering: {
                profile: "virtual-display",
                nativeDeviceScaleFactor: scale,
                devicePixelRatio: scale,
                pageZoom: 1,
              },
              value: { ratio: scale, headless: false },
            });
            assert(isRecord(native.structuredContent) && isRecord(native.structuredContent.value));
            assert(
              isRecord(native.structuredContent.rendering) &&
                isRecord(native.structuredContent.rendering.viewport),
            );
            const viewport = native.structuredContent.rendering.viewport;
            assert(typeof viewport.width === "number" && typeof viewport.height === "number");
            expect(Math.abs(viewport.width - 800)).toBeLessThanOrEqual(1);
            expect(Math.abs(viewport.height - 600)).toBeLessThanOrEqual(1);

            const value = native.structuredContent.value;
            assert(typeof value.png === "string" && typeof value.pid === "number");

            const commandLine = await readFile(`/proc/${value.pid}/cmdline`, "utf8");
            const command = commandLine.replaceAll("\0", " ");
            expect(command).toContain(` --force-device-scale-factor=${scale} `);
            expect(command).toContain(" --ozone-platform=x11 ");
            expect(command).not.toContain(" --headless");

            const status = await readFile(`/proc/${value.pid}/status`, "utf8");
            const parent = /^PPid:\s+(\d+)$/mu.exec(status)?.[1];
            assert(parent);
            const childPids = await readFile(`/proc/${parent}/task/${parent}/children`, "utf8");
            const children = childPids.trim().split(/\s+/u);

            for (const pid of children) {
              const executable = await readlink(`/proc/${pid}/exe`);
              if (!executable.endsWith("/Xvfb")) continue;

              displayPids.add(Number(pid));
            }

            expect(displayPids.size).toBe(scale === 1 ? 1 : 2);

            const nativeOffsets = measureGlyphOffsets(Buffer.from(value.png, "base64"), scale);

            if (scale === 1) {
              const emulated = await client.callTool({
                name: "run_playwright",
                arguments: {
                  browser: "isolated-virtual-display",
                  browserInstanceId: "native-1",
                  nativeDeviceScaleFactor: 1,
                  args: { url: pathToFileURL(fixture).href },
                  code: `
                const emulatedContext = await browser.newContext({ deviceScaleFactor: 1.296875, viewport: { width: 400, height: 350 } });
                try {
                  const emulatedPage = await emulatedContext.newPage();
                  await emulatedPage.goto(args.url);
                  await emulatedPage.evaluate(() => document.fonts.ready);
                  return { ratio: await emulatedPage.evaluate(() => devicePixelRatio),
                    png: (await emulatedPage.screenshot({ clip: { x: 0, y: 0, width: 200, height: 310 }, scale: 'device' })).toString('base64') };
                } finally {
                  await emulatedContext.close();
                }
              `,
                },
              });
              expect(emulated.structuredContent).toMatchObject({
                ok: true,
                value: { ratio: 1.296_875 },
                rendering: { nativeDeviceScaleFactor: 1 },
              });
              assert(isRecord(emulated.structuredContent) && isRecord(emulated.structuredContent.value));
              assert(typeof emulated.structuredContent.value.png === "string");
              emulatedOffsets = measureGlyphOffsets(
                Buffer.from(emulated.structuredContent.value.png, "base64"),
                1.296_875,
              );
            }

            assert(emulatedOffsets);

            const control = await chromium.launchPersistentContext(join(root, `control-${scale}`), {
              args: [...chromeLaunchArguments(), `--force-device-scale-factor=${scale}`, "--disable-gpu"],
              chromiumSandbox: true,
              env: chromeProcessEnvironment(),
              executablePath,
              headless: true,
              viewport: null,
            });
            try {
              const page = await control.newPage();
              await page.goto(pathToFileURL(fixture).href);
              await page.evaluate("document.fonts.ready");
              const bytes = await page.screenshot({
                clip: { x: 0, y: 0, width: 200, height: 310 },
                scale: "device",
              });
              const controlOffsets = measureGlyphOffsets(bytes, scale);
              const expectedShift = scale === 1 ? [0, 0, 0, 0, 0, 0, 0, 0] : [1, 0, 1, 1, 0, 1, 0, 1];
              expect(
                controlOffsets.map((offset, index) => {
                  const nativeOffset = nativeOffsets[index];
                  assert(nativeOffset !== undefined);
                  return offset - nativeOffset;
                }),
              ).toEqual(expectedShift);

              if (scale === 1) {
                const browser = control.browser();
                assert(browser);
                const emulatedContext = await browser.newContext({
                  deviceScaleFactor: 1.296_875,
                  viewport: { width: 400, height: 350 },
                });
                try {
                  const emulatedPage = await emulatedContext.newPage();
                  await emulatedPage.goto(pathToFileURL(fixture).href);
                  await emulatedPage.evaluate("document.fonts.ready");
                  const emulatedBytes = await emulatedPage.screenshot({
                    clip: { x: 0, y: 0, width: 200, height: 310 },
                    scale: "device",
                  });
                  expect(measureGlyphOffsets(emulatedBytes, 1.296_875)).toEqual(emulatedOffsets);
                } finally {
                  await emulatedContext.close();
                }
              } else {
                expect(nativeOffsets).not.toEqual(emulatedOffsets);
              }
            } finally {
              await control.close();
            }

            const reused = await client.callTool({
              name: "run_playwright",
              arguments: {
                ...selection,
                code: "chrome.setSessionStateValue('resizeMarker', true); return await page.evaluate(() => devicePixelRatio);",
              },
            });
            expect(reused.structuredContent).toMatchObject({
              ok: true,
              selectedTargetId: native.structuredContent.selectedTargetId,
              value: scale,
            });

            const invalidResize = await client.callTool({
              name: "run_playwright",
              arguments: {
                ...selection,
                code: "await page.setViewportSize({ width: 800.5, height: 600 });",
              },
            });
            expect(invalidResize.structuredContent).toMatchObject({
              ok: false,
              error: { code: "CHROME_MCP_INVALID_INPUT" },
            });

            const retainedAfterResize = await client.callTool({
              name: "run_playwright",
              arguments: {
                ...selection,
                code: "return { marker: chrome.getSessionStateValue('resizeMarker'), viewport: page.viewportSize(), ratio: await page.evaluate(() => devicePixelRatio) };",
              },
            });
            expect(retainedAfterResize.structuredContent).toMatchObject({
              ok: true,
              selectedTargetId: native.structuredContent.selectedTargetId,
              value: { marker: true, viewport: { width: 800, height: 600 }, ratio: scale },
            });

            const renderingFailure = await client.callTool({
              name: "run_playwright",
              arguments: {
                ...selection,
                code: `
              const next = await context.newPage();
              await next.setContent('<title>uncommitted-rendering-page</title>');
              await chrome.selectPageForSession(next);
              chrome.setSessionStateValue('uncommittedRendering', true);
              await next.evaluate(() => Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 0 }));
              return true;
            `,
              },
            });
            expect(renderingFailure.structuredContent).toMatchObject({
              ok: false,
              selectedTargetId: native.structuredContent.selectedTargetId,
            });

            const afterRenderingFailure = await client.callTool({
              name: "run_playwright",
              arguments: {
                ...selection,
                code: `
              const original = page;
              for (const candidate of context.pages()) {
                if (candidate === original || await candidate.title() !== 'uncommitted-rendering-page') continue;
                await candidate.close();
              }
              return { marker: chrome.getSessionStateValue('resizeMarker'), uncommitted: chrome.getSessionStateValue('uncommittedRendering'), ratio: await page.evaluate(() => devicePixelRatio) };
            `,
              },
            });
            expect(afterRenderingFailure.structuredContent).toMatchObject({
              ok: true,
              selectedTargetId: native.structuredContent.selectedTargetId,
              value: { marker: true, ratio: scale },
            });
            assert(isRecord(afterRenderingFailure.structuredContent));
            expect(afterRenderingFailure.structuredContent.value).not.toHaveProperty("uncommitted");

            const conflict = await client.callTool({
              name: "run_playwright",
              arguments: { ...selection, nativeDeviceScaleFactor: 2, code: "return true;" },
            });
            expect(conflict.structuredContent).toMatchObject({
              ok: false,
              error: { code: "CHROME_MCP_INVALID_INPUT" },
            });

            const cancelled = await client.callTool({
              name: "run_playwright",
              arguments: {
                ...selection,
                code: "chrome.setSessionStateValue('cancelled', true); await chrome.reportCallProgress('cancel now'); await new Promise(() => {});",
              },
            });
            expect(cancelled.structuredContent).toMatchObject({
              ok: false,
              error: { code: "CHROME_MCP_CANCELLED" },
            });
            cancellation = new AbortController();

            const recovered = await client.callTool({
              name: "run_playwright",
              arguments: {
                ...selection,
                code: "return { cancelled: chrome.getSessionStateValue('cancelled'), ratio: await page.evaluate(() => devicePixelRatio) };",
              },
            });
            expect(recovered.structuredContent).toMatchObject({ ok: true, value: { ratio: scale } });
            assert(isRecord(recovered.structuredContent));
            expect(recovered.structuredContent.value).not.toHaveProperty("cancelled");

            const dialog = await client.callTool({
              name: "run_playwright",
              arguments: {
                ...selection,
                code: `
              const next = await context.newPage();
              await chrome.selectPageForSession(next);
              const pending = next.waitForEvent('dialog');
              await next.evaluate(() => { setTimeout(() => confirm('Continue?'), 0); });
              return (await pending).message();
            `,
              },
            });
            expect(dialog.structuredContent).toMatchObject({ ok: true, value: "Continue?" });
            expect(dialog.structuredContent).not.toHaveProperty("rendering");
          }
        } finally {
          await client.close();
          await session.close();
        }
      } finally {
        await service.close();
      }

      for (const pid of displayPids) {
        expect(stat(`/proc/${pid}`)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      if (priorDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = priorDataHome;
      }

      if (priorRuntimeDirectory === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
      }
    }
  },
  60_000,
);

linuxLiveTest(
  "keeps main Chrome usable across calls when an unrelated renderer is unresponsive",
  async () => {
    const executablePath = await resolveChromeExecutable();

    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-main-unresponsive-"));
    roots.push(root);
    const priorConfigHome = process.env.XDG_CONFIG_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    const chrome = await chromium.launchPersistentContext(join(root, "config", "google-chrome"), {
      args: chromeLaunchArguments(),
      chromiumSandbox: true,
      env: chromeProcessEnvironment(),
      executablePath,
      headless: true,
    });
    try {
      process.env.XDG_CONFIG_HOME = join(root, "config");
      process.env.XDG_RUNTIME_DIR = join(root, "runtime");
      const browser = chrome.browser();
      if (!browser) {
        throw new Error("Persistent Chrome did not expose its browser");
      }

      const separateContext = await browser.newContext();
      const stalled = await separateContext.newPage();
      const stalledTargetId = await readLiveTargetId(stalled);
      const started = stalled.waitForEvent("console", {
        predicate: (message) => message.text() === "renderer-loop-started",
      });
      const loop = stalled
        .evaluate(() => {
          console.log("renderer-loop-started");
          for (;;) {}
        })
        .catch((error: unknown) => error);
      await started;

      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });
      try {
        const server = createChromeMcpServer(service);
        const client = new Client(
          { name: "chrome-main-unresponsive-client", version: "1.0.0" },
          { capabilities: {} },
        );
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const [session] = await Promise.all([
          server.connect(serverTransport, createLiveToolContext(root).session),
          client.connect(clientTransport),
        ]);
        try {
          for (let call = 0; call < 2; call++) {
            const result = await client.callTool({
              name: "run_playwright",
              arguments: {
                browser: "main",
                timeoutMs: 10_000,
                code: "return { pages: context.pages().length, answer: await page.evaluate(() => 2 + 2) };",
              },
            });
            expect(result.structuredContent).toMatchObject({
              ok: true,
              value: { pages: 1, answer: 4 },
              unavailableTargets: [
                { targetId: stalledTargetId, error: expect.stringContaining("Runtime.enable timed out") },
              ],
            });
            expect(result.content).toContainEqual({
              type: "text",
              text: expect.stringContaining("Unavailable Chrome tabs"),
            });
          }
        } finally {
          await client.close();
          await session.close();
        }
      } finally {
        await service.close();
      }

      expect(browser.isConnected()).toBe(true);
      expect(stalled.isClosed()).toBe(false);
      await chrome.close();
      expect(await loop).toBeInstanceOf(Error);
    } finally {
      await chrome.close();
      if (priorConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = priorConfigHome;
      }
      if (priorRuntimeDirectory === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
      }
    }
  },
  30_000,
);

const buildReactFixture = async (production: boolean): Promise<string> => {
  const result = await Bun.build({
    define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
    entrypoints: [join(import.meta.dir, "fixtures/react-19-app.tsx")],
    target: "browser",
  });
  if (!result.success || !result.outputs[0]) {
    throw new Error(`React fixture build failed: ${result.logs.join("\n")}`);
  }
  return result.outputs[0].text();
};

const firstReactHookId = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) return undefined;
  for (const hook of value) {
    if (!isRecord(hook)) continue;
    if (typeof hook.hookId === "string") return hook.hookId;
    const nested = firstReactHookId(hook.subHooks);
    if (nested !== undefined) return nested;
  }
  return undefined;
};

const snapshotRefsNamed = (result: unknown, name: string): string[] => {
  if (!isRecord(result) || !isRecord(result.structuredContent) || !isRecord(result.structuredContent.value)) {
    throw new Error(`Snapshot result is invalid: ${JSON.stringify(result)}`);
  }
  const refs = result.structuredContent.value.refs;
  if (!isRecord(refs)) {
    throw new Error(`Snapshot returned no retained refs: ${JSON.stringify(result.structuredContent)}`);
  }
  return Object.entries(refs).flatMap(([ref, metadata]) =>
    isRecord(metadata) && metadata.name === name ? [ref] : [],
  );
};

const inspectedComponentId = (result: unknown): string => {
  if (
    !isRecord(result) ||
    !isRecord(result.structuredContent) ||
    result.structuredContent.ok !== true ||
    !isRecord(result.structuredContent.data) ||
    !isRecord(result.structuredContent.data.component) ||
    typeof result.structuredContent.data.component.componentId !== "string"
  ) {
    throw new Error(`React snapshot-ref inspection failed: ${JSON.stringify(result)}`);
  }
  return result.structuredContent.data.component.componentId;
};

liveTest(
  "disables password prompts and preserves trusted input after login across worker calls",
  async () => {
    const executablePath = await resolveChromeExecutable();

    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-password-prompts-"));
    roots.push(root);

    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new Response(
          new URL(request.url).pathname === "/login" ?
            '<!doctype html><form action="/signed-in" method="post"><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>'
          : `<!doctype html><title>Signed in</title><button id="probe">Probe</button><script>
          window.inputEvents = [];
          for (const type of ['pointerdown', 'click', 'keydown']) {
            window.addEventListener(type, event => window.inputEvents.push({ type: event.type, isTrusted: event.isTrusted }), true);
          }
        </script>`,
          { headers: { "Content-Type": "text/html" } },
        ),
    });

    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    const context = createLiveToolContext(root);

    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });

      const run = (code: string) =>
        service.handlers.runPlaywright(
          {
            args: { origin: fixture.url.origin },
            browser: "isolated-headless",
            browserInstanceId: "password-prompts",
            code,
            timeoutMs: 10_000,
          },
          context,
        );

      try {
        const preferences = await run(`
        await page.goto('chrome://password-manager/settings');
        return await page.evaluate(async () => {
          const values = await Promise.all(['credentials_enable_service', 'profile.password_manager_leak_detection'].map(key => new Promise(resolve => chrome.settingsPrivate.getPref(key, resolve))));
          return values.map(({ key, value }) => ({ key, value }));
        });
      `);
        expect(preferences.structuredContent).toMatchObject({
          ok: true,
          value: [
            { key: "credentials_enable_service", value: false },
            { key: "profile.password_manager_leak_detection", value: false },
          ],
        });

        const loggedIn = await run(`
        await page.goto(args.origin + '/login');
        await page.locator('input[name=username]').fill('test@example.test');
        await page.locator('input[name=password]').fill('example-password');
        await page.locator('button').click();
        await page.waitForURL(args.origin + '/signed-in');
        return await page.title();
      `);
        expect(loggedIn.structuredContent).toMatchObject({ ok: true, value: "Signed in" });
        assert(isRecord(loggedIn.structuredContent));

        const clicked = await run(`
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.reload();
        await page.screenshot();
        await page.locator('#probe').click();
        await page.keyboard.press('Shift');
        return await page.evaluate(() => window.inputEvents);
      `);
        expect(clicked.structuredContent).toMatchObject({
          ok: true,
          selectedTargetId: loggedIn.structuredContent.selectedTargetId,
          value: [
            { type: "pointerdown", isTrusted: true },
            { type: "click", isTrusted: true },
            { type: "keydown", isTrusted: true },
          ],
        });
      } finally {
        await service.closeConnection(context);
        await service.close();
      }
    } finally {
      await fixture.stop(true);

      if (priorDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = priorDataHome;
      }

      if (priorRuntimeDirectory === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
      }
    }
  },
  45_000,
);

liveTest(
  "retains each page viewport across worker calls and reload screenshots",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-viewport-"));
    roots.push(root);
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    const context = createLiveToolContext(root);
    const service = await createChromeService({
      artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
      executablePath,
      workspacePath: root,
    });
    const measurement = `
    const viewport = page.viewportSize();
    const before = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const png = await page.screenshot();
    const after = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    return { viewport, before, after, screenshot: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } };
  `;
    const run = async (code: string, browserInstanceId = "viewport") => {
      const result = await service.handlers.runPlaywright(
        {
          args: {},
          browser: "isolated-headless",
          browserInstanceId,
          code,
          timeoutMs: 10_000,
        },
        context,
      );
      if (!isRecord(result.structuredContent) || result.structuredContent.ok !== true) {
        throw new Error(`Viewport call failed: ${JSON.stringify(result.structuredContent)}`);
      }
      return result.structuredContent.value;
    };
    const desktop = { width: 1440, height: 900 };
    const compact = { width: 1024, height: 768 };
    const initial = { width: 1920, height: 1080 };
    try {
      expect(
        await run(`
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('data:text/html,<title>viewport</title><h1>Viewport</h1>');
      ${measurement}
    `),
      ).toEqual({ viewport: desktop, before: desktop, after: desktop, screenshot: desktop });
      expect(await run(`await page.reload(); ${measurement}`)).toEqual({
        viewport: desktop,
        before: desktop,
        after: desktop,
        screenshot: desktop,
      });
      expect(
        await run(`
      await page.locator('body').evaluate(body => { body.style.height = '1800px'; });
      const full = await page.screenshot({ fullPage: true });
      const fullWidth = full.readUInt32BE(16);
      if (fullWidth !== 1440) {
        throw new Error('Full-page screenshot changed viewport width: ' + fullWidth);
      }
      ${measurement}
    `),
      ).toEqual({ viewport: desktop, before: desktop, after: desktop, screenshot: desktop });
      expect(await run(measurement, "independent")).toEqual({
        viewport: initial,
        before: initial,
        after: initial,
        screenshot: initial,
      });
      expect(
        await run(`
      const created = await context.newPage();
      await created.setViewportSize({ width: 1440, height: 900 });
      await chrome.selectPageForSession(created);
      page = created;
      ${measurement}
    `),
      ).toEqual({ viewport: desktop, before: desktop, after: desktop, screenshot: desktop });
      const failed = await service.handlers.runPlaywright(
        {
          args: {},
          browser: "isolated-headless",
          browserInstanceId: "viewport",
          timeoutMs: 10_000,
          code: "await page.setViewportSize({ width: 1024, height: 768 }); throw new Error('after resize');",
        },
        context,
      );
      expect(failed.isError).toBeTrue();
      expect(await run(`await page.reload(); ${measurement}`)).toEqual({
        viewport: compact,
        before: compact,
        after: compact,
        screenshot: compact,
      });
      expect(
        await run(`
      await page.close();
      page = context.pages()[0];
      await chrome.selectPageForSession(page);
      ${measurement}
    `),
      ).toEqual({ viewport: desktop, before: desktop, after: desktop, screenshot: desktop });
      const peerContext = createLiveToolContext(root);
      const sharedResize = await service.handlers.runPlaywright(
        {
          args: {},
          browser: "shared-headless",
          timeoutMs: 10_000,
          code: "await page.setViewportSize({ width: 1024, height: 768 }); return page.viewportSize();",
        },
        context,
      );
      expect(sharedResize.structuredContent).toMatchObject({ ok: true, value: compact });
      const sharedRead = await service.handlers.runPlaywright(
        {
          args: {},
          browser: "shared-headless",
          timeoutMs: 10_000,
          code: `await page.reload(); ${measurement}`,
        },
        peerContext,
      );
      expect(sharedRead.structuredContent).toMatchObject({
        ok: true,
        value: { viewport: compact, before: compact, after: compact, screenshot: compact },
      });
      await service.closeConnection(peerContext);
    } finally {
      await service.closeConnection(context);
      await service.close();
      if (priorDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = priorDataHome;
      }
      if (priorRuntimeDirectory === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
      }
    }
  },
  120_000,
);

liveTest(
  "retains page media features across calls, navigation, updates, and failed executions",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-media-"));
    roots.push(root);
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    const context = createLiveToolContext(root);
    try {
      const nativeBrowser = await chromium.launch({
        executablePath,
        headless: true,
        env: chromeProcessEnvironment(),
      });
      const nativeResetMedia = await nativeBrowser
        .newPage()
        .then(async (page) => {
          await page.emulateMedia({ colorScheme: "dark", contrast: "more", reducedMotion: "reduce" });
          await page.emulateMedia({
            colorScheme: null,
            contrast: null,
            forcedColors: null,
            reducedMotion: null,
          });
          const value: unknown = await page.evaluate(`({
        contrast: matchMedia("(prefers-contrast: more)").matches,
        dark: matchMedia("(prefers-color-scheme: dark)").matches,
        forcedColors: matchMedia("(forced-colors: active)").matches,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      })`);
          if (!isRecord(value)) throw new Error("Native media reset did not return an object");
          return value;
        })
        .finally(() => nativeBrowser.close());
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });
      try {
        const readMedia = `await page.evaluate(() => ({
        contrast: matchMedia('(prefers-contrast: more)').matches,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
        forcedColors: matchMedia('(forced-colors: active)').matches,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      }))`;
        const run = async (code: string, browserInstanceId = "media") => {
          const result = await service.handlers.runPlaywright(
            {
              args: {},
              browser: "isolated-headless",
              browserInstanceId,
              code,
              timeoutMs: 10_000,
            },
            context,
          );
          if (!isRecord(result.structuredContent) || result.structuredContent.ok !== true) {
            throw new Error(`Media emulation call failed: ${JSON.stringify(result.structuredContent)}`);
          }
          return result.structuredContent.value;
        };
        const baseline = await run(`return ${readMedia};`);
        const emulated = { contrast: true, dark: true, forcedColors: false, reducedMotion: true };
        expect(
          await run(`
        await page.emulateMedia({ colorScheme: 'dark', contrast: 'more', reducedMotion: 'reduce' });
        return ${readMedia};
      `),
        ).toEqual(emulated);
        expect(await run(`return ${readMedia};`)).toEqual(emulated);
        expect(
          await run(`await page.goto('data:text/html,<title>media</title>'); return ${readMedia};`),
        ).toEqual(emulated);
        expect(
          await run(`
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: undefined });
        return ${readMedia};
      `),
        ).toEqual({ ...emulated, dark: false });
        expect(await run(`return ${readMedia};`)).toEqual({ ...emulated, dark: false });
        expect(await run(`return ${readMedia};`, "media-independent")).toEqual(baseline);

        const failed = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated-headless",
            browserInstanceId: "media",
            code: "await page.emulateMedia({ colorScheme: 'dark' }); throw new Error('after media change');",
            timeoutMs: 10_000,
          },
          context,
        );
        expect(failed.isError).toBeTrue();
        expect(await run(`return ${readMedia};`)).toEqual(emulated);

        expect(
          await run(`
        const created = await context.newPage();
        page = created;
        const before = ${readMedia};
        await created.emulateMedia({ reducedMotion: 'reduce' });
        await chrome.selectPageForSession(created);
        return before;
      `),
        ).toEqual(baseline);
        if (!isRecord(baseline)) throw new Error("Media baseline is not an object");
        expect(await run(`return ${readMedia};`)).toEqual({ ...baseline, reducedMotion: true });
        expect(
          await run(`
        await page.close();
        page = context.pages()[0];
        await chrome.selectPageForSession(page);
        return ${readMedia};
      `),
        ).toEqual(emulated);
        expect(
          await run(`
        await page.emulateMedia({ colorScheme: null, contrast: null, forcedColors: null, reducedMotion: null });
        return ${readMedia};
      `),
        ).toEqual(nativeResetMedia);
        expect(await run(`return ${readMedia};`)).toEqual(nativeResetMedia);
        expect(
          await run(`
        await page.emulateMedia({ forcedColors: 'active' });
        return ${readMedia};
      `),
        ).toEqual({ ...nativeResetMedia, forcedColors: true });
        expect(await run(`return ${readMedia};`)).toEqual({ ...nativeResetMedia, forcedColors: true });
        expect(await run(`await page.emulateMedia({ forcedColors: null }); return ${readMedia};`)).toEqual(
          nativeResetMedia,
        );
        expect(await run(`return ${readMedia};`)).toEqual(nativeResetMedia);
        expect(
          await run(`
        const ownedContext = await browser.newContext({ colorScheme: 'dark', contrast: 'more', forcedColors: 'active' });
        page = await ownedContext.newPage();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const media = ${readMedia};
        await ownedContext.close();
        return media;
      `),
        ).toEqual({ contrast: true, dark: true, forcedColors: true, reducedMotion: true });
        expect(
          await run(`
        page = await browser.newPage({ colorScheme: 'dark', reducedMotion: 'reduce' });
        await page.emulateMedia({ contrast: 'more' });
        const media = ${readMedia};
        await page.close();
        return media;
      `),
        ).toEqual({ contrast: true, dark: true, forcedColors: false, reducedMotion: true });
      } finally {
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      if (priorRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
    }
  },
  60_000,
);

liveTest(
  "inspects, updates, highlights, and profiles React 19 development and production pages",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-react-"));
    roots.push(root);
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    const brokerPaths = await resolveBrokerRuntimePaths(root, getMcpRuntimeDir());
    const context = createLiveToolContext(root);
    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });
      try {
        const verifyReactLifecycle = async (browserInstanceId: string, staleComponentId: string) => {
          const reloaded = await service.handlers.runPlaywright(
            {
              args: {},
              browser: "isolated-headless",
              browserInstanceId,
              code: "await page.reload(); await page.locator('#react-counter').waitFor(); return await page.locator('#react-counter').textContent();",
              timeoutMs: 10_000,
            },
            context,
          );
          expect(isRecord(reloaded.structuredContent) ? reloaded.structuredContent.ok : false).toBeTrue();
          const relisted = await service.handlers.reactListComponents(
            {
              browser: "isolated-headless",
              browserInstanceId,
              limit: 100,
            },
            context,
          );
          if (
            !isRecord(relisted.structuredContent) ||
            relisted.structuredContent.ok !== true ||
            !isRecord(relisted.structuredContent.data)
          ) {
            throw new Error(`React list after reload failed: ${JSON.stringify(relisted.structuredContent)}`);
          }
          const components = relisted.structuredContent.data.components;
          const counter =
            Array.isArray(components) ?
              components.find((component) => isRecord(component) && component.displayName === "Counter")
            : undefined;
          if (!isRecord(counter) || typeof counter.componentId !== "string") {
            throw new Error(`React Counter was not listed after reload: ${JSON.stringify(components)}`);
          }
          const stale = await service.handlers.reactInspectComponent(
            {
              browser: "isolated-headless",
              browserInstanceId,
              lookup: { componentId: staleComponentId, type: "component" },
            },
            context,
          );
          if (!isRecord(stale.structuredContent) || !isRecord(stale.structuredContent.error)) {
            throw new Error(
              `Expired React component returned an invalid result: ${JSON.stringify(stale.structuredContent)}`,
            );
          }
          expect(stale.structuredContent.error.code).toBe("CHROME_MCP_REACT_STALE_COMPONENT");
          return counter;
        };

        const verifyReactBuild = async (buildMode: "development" | "production") => {
          const isProduction = buildMode === "production";

          const browserInstanceId = isProduction ? "react-production" : "react-development";
          const bundle = await buildReactFixture(isProduction);
          const fixturePath = join(root, `react-${isProduction ? "production" : "development"}.html`);
          const html = `<!doctype html><div id="root"></div><script>${bundle.replaceAll("</script", "<\\/script")}</script>`;
          await writeFile(fixturePath, html);
          const loaded = await service.handlers.runPlaywright(
            {
              args: { url: pathToFileURL(fixturePath).href },
              browser: "isolated-headless",
              browserInstanceId,
              code: `
            await page.goto(args.url);
            await page.locator('#react-counter').waitFor();
            return await page.locator('#react-counter').textContent();
          `,
              timeoutMs: 30_000,
            },
            context,
          );
          if (!isRecord(loaded.structuredContent) || loaded.structuredContent.ok !== true) {
            throw new Error(`React fixture navigation failed: ${JSON.stringify(loaded.structuredContent)}`);
          }
          expect(loaded.structuredContent.value).toBe("count:1");

          const listed = await service.handlers.reactListComponents(
            {
              browser: "isolated-headless",
              browserInstanceId,
              limit: 100,
            },
            context,
          );
          if (
            !isRecord(listed.structuredContent) ||
            listed.structuredContent.ok !== true ||
            !isRecord(listed.structuredContent.data)
          ) {
            const brokerLog = await readFile(brokerPaths.logPath, "utf8").catch(
              () => "broker log unavailable",
            );
            const diagnostic = await service.handlers.runPlaywright(
              {
                args: {},
                browser: "isolated-headless",
                browserInstanceId,
                code: `return await page.evaluate(() => {
              const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
              return {
                renderers: hook?.renderers instanceof Map ? Array.from(hook.renderers, ([id, renderer]) => ({ id, version: renderer.version })) : null,
                stateKeys: Object.keys(globalThis).filter(key => key.startsWith('__chromeMcpReactState_')),
              };
            });`,
                timeoutMs: 10_000,
              },
              context,
            );
            throw new Error(
              `React list failed: ${JSON.stringify(listed.structuredContent)}\n${JSON.stringify(diagnostic.structuredContent)}\n${brokerLog}`,
            );
          }
          const components = listed.structuredContent.data.components;
          if (!Array.isArray(components)) throw new Error("React list returned no component array");
          const app = components.find((component) => isRecord(component) && component.displayName === "App");
          if (!isRecord(app)) {
            throw new Error(`React App component was not listed: ${JSON.stringify(components)}`);
          }
          expect(app.parentComponentId).toBeNull();
          const counters = components.filter(
            (component) => isRecord(component) && component.displayName === "Counter",
          );
          const counter = counters[0];
          if (!isRecord(counter) || typeof counter.componentId !== "string") {
            throw new Error(`React Counter component was not listed: ${JSON.stringify(components)}`);
          }
          const counterComponentId = counter.componentId;

          if (!isRecord(counter.capabilities)) {
            throw new Error(`React Counter capabilities were not listed: ${JSON.stringify(counter)}`);
          }
          expect(counter.capabilities.canEditHooks).toBe(!isProduction);
          const secondaryCounter = counters[1];
          if (!isRecord(secondaryCounter) || typeof secondaryCounter.componentId !== "string") {
            throw new Error(`Second React Counter component was not listed: ${JSON.stringify(components)}`);
          }
          const secondaryCounterComponentId = secondaryCounter.componentId;

          if (!isProduction) {
            expect(counter.sourceAvailable).toBeTrue();
            const sourceSearch = await service.handlers.reactListComponents(
              {
                browser: "isolated-headless",
                browserInstanceId,
                limit: 100,
                search: "react-development.html",
              },
              context,
            );
            if (
              !isRecord(sourceSearch.structuredContent) ||
              sourceSearch.structuredContent.ok !== true ||
              !isRecord(sourceSearch.structuredContent.data)
            ) {
              throw new Error(
                `React source search failed: ${JSON.stringify(sourceSearch.structuredContent)}`,
              );
            }
            const sourceMatches = sourceSearch.structuredContent.data.components;
            expect(
              Array.isArray(sourceMatches) &&
                sourceMatches.some((component) => isRecord(component) && component.displayName === "Counter"),
            ).toBeTrue();
          }

          const inspected = await service.handlers.reactInspectComponent(
            {
              browser: "isolated-headless",
              browserInstanceId,
              lookup: { componentId: counterComponentId, type: "component" },
            },
            context,
          );
          if (
            !isRecord(inspected.structuredContent) ||
            inspected.structuredContent.ok !== true ||
            !isRecord(inspected.structuredContent.data)
          ) {
            throw new Error(`React inspect failed: ${JSON.stringify(inspected.structuredContent)}`);
          }
          expect(Array.isArray(inspected.structuredContent.data.hostNodes)).toBeTrue();
          expect(inspected.structuredContent.data.hostNodeCount).toBeGreaterThan(0);
          expect(inspected.structuredContent.data.hostNodesTruncated).toBeFalse();
          expect(
            isRecord(inspected.structuredContent.rendererCapabilities) ?
              inspected.structuredContent.rendererCapabilities.canInspect
            : false,
          ).toBeTrue();
          expect(
            isRecord(inspected.structuredContent.data.component) ?
              inspected.structuredContent.data.component.hostNodeCount
            : 0,
          ).toBeGreaterThan(0);
          if (
            !isRecord(inspected.structuredContent.data.capabilities) ||
            !isRecord(inspected.structuredContent.data.component)
          ) {
            throw new Error(
              `React inspect capabilities were malformed: ${JSON.stringify(inspected.structuredContent.data)}`,
            );
          }
          expect(inspected.structuredContent.data.component.capabilities).toEqual(
            inspected.structuredContent.data.capabilities,
          );
          expect(inspected.structuredContent.data.capabilities).toEqual(counter.capabilities);
          if (!isProduction) {
            expect(isRecord(inspected.structuredContent.data.source)).toBeTrue();
            const owners = inspected.structuredContent.data.owners;
            expect(
              Array.isArray(owners) && owners.some((owner) => isRecord(owner) && owner.displayName === "App"),
            ).toBeTrue();
          }
          const hooks = inspected.structuredContent.data.hooks;
          const hookId = firstReactHookId(hooks);
          if (hookId === undefined) {
            throw new Error(
              `React Counter state hook was not inspectable: ${JSON.stringify(inspected.structuredContent.data)}`,
            );
          }
          const secondaryInspected = await service.handlers.reactInspectComponent(
            {
              browser: "isolated-headless",
              browserInstanceId,
              lookup: { componentId: secondaryCounter.componentId, type: "component" },
            },
            context,
          );
          if (
            !isRecord(secondaryInspected.structuredContent) ||
            secondaryInspected.structuredContent.ok !== true ||
            !isRecord(secondaryInspected.structuredContent.data)
          ) {
            throw new Error(
              `Second React Counter inspect failed: ${JSON.stringify(secondaryInspected.structuredContent)}`,
            );
          }
          const secondaryHooks = secondaryInspected.structuredContent.data.hooks;
          const secondaryHookId = firstReactHookId(secondaryHooks);
          if (secondaryHookId === undefined) {
            throw new Error(
              `Second React Counter state hook was not inspectable: ${JSON.stringify(secondaryInspected.structuredContent.data)}`,
            );
          }
          expect(secondaryHookId).not.toBe(hookId);

          const verifyReactInspectionLookups = async () => {
            const primedSelection = await service.handlers.runPlaywright(
              {
                args: {},
                browser: "isolated-headless",
                browserInstanceId,
                code: "return await page.evaluate(() => { globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__.$0 = 'selection-sentinel'; return true; });",
                timeoutMs: 10_000,
              },
              context,
            );
            expect(
              isRecord(primedSelection.structuredContent) ? primedSelection.structuredContent.ok : false,
            ).toBeTrue();
            const selectorInspected = await service.handlers.reactInspectComponent(
              {
                browser: "isolated-headless",
                browserInstanceId,
                lookup: { selector: "#react-counter", type: "selector" },
              },
              context,
            );
            expect(
              isRecord(selectorInspected.structuredContent) ? selectorInspected.structuredContent.ok : false,
            ).toBeTrue();

            const retainedSnapshot = await service.handlers.runPlaywright(
              {
                args: {},
                browser: "isolated-headless",
                browserInstanceId,
                code: "return await chrome.captureAccessibilitySnapshot({ depth: 20, maxBytes: 80000 });",
                timeoutMs: 10_000,
              },
              context,
            );
            const primaryRef = snapshotRefsNamed(retainedSnapshot, "count:1")[0];
            const secondaryRef = snapshotRefsNamed(retainedSnapshot, "count:10")[0];
            if (!primaryRef || !secondaryRef) {
              throw new Error(
                `React snapshot returned no counter refs: ${JSON.stringify(retainedSnapshot.structuredContent)}`,
              );
            }
            const primaryRefInspected = await service.handlers.reactInspectComponent(
              {
                browser: "isolated-headless",
                browserInstanceId,
                lookup: { ref: primaryRef, type: "snapshot-ref" },
              },
              context,
            );
            const secondaryRefInspected = await service.handlers.reactInspectComponent(
              {
                browser: "isolated-headless",
                browserInstanceId,
                lookup: { ref: secondaryRef, type: "snapshot-ref" },
              },
              context,
            );
            expect(inspectedComponentId(primaryRefInspected)).toBe(counterComponentId);
            expect(inspectedComponentId(secondaryRefInspected)).toBe(secondaryCounterComponentId);

            if (isProduction) {
              const duplicateText = await service.handlers.runPlaywright(
                {
                  args: {},
                  browser: "isolated-headless",
                  browserInstanceId,
                  code: `
              for (let index = 0; index < 9; index += 1) await page.locator('#react-counter').click();
              await page.locator('#react-counter').filter({ hasText: 'count:10' }).waitFor();
              return await chrome.captureAccessibilitySnapshot({ depth: 20, maxBytes: 80000 });
            `,
                  timeoutMs: 10_000,
                },
                context,
              );
              const duplicateRefs = snapshotRefsNamed(duplicateText, "count:10");
              if (duplicateRefs.length !== 2 || !duplicateRefs[0] || !duplicateRefs[1]) {
                throw new Error(
                  `Duplicate React nodes returned invalid refs: ${JSON.stringify(duplicateText.structuredContent)}`,
                );
              }
              const duplicateInspections = await Promise.all(
                duplicateRefs.map((ref) =>
                  service.handlers.reactInspectComponent(
                    {
                      browser: "isolated-headless",
                      browserInstanceId,
                      lookup: { ref, type: "snapshot-ref" },
                    },
                    context,
                  ),
                ),
              );
              expect(new Set(duplicateInspections.map(inspectedComponentId))).toEqual(
                new Set([counterComponentId, secondaryCounterComponentId]),
              );
            }

            const shadowSnapshot = await service.handlers.runPlaywright(
              {
                args: {},
                browser: "isolated-headless",
                browserInstanceId,
                code: `
            await page.evaluate(() => {
              const counter = document.querySelector('#react-counter');
              if (!(counter instanceof HTMLElement)) throw new Error('Primary React counter is unavailable');
              counter.setAttribute('aria-label', 'shadow counter');
              const host = document.createElement('div');
              host.id = 'react-shadow-host';
              counter.after(host);
              host.attachShadow({ mode: 'open' }).append(counter);
            });
            return await chrome.captureAccessibilitySnapshot({ depth: 20, maxBytes: 80000 });
          `,
                timeoutMs: 10_000,
              },
              context,
            );
            const shadowRef = snapshotRefsNamed(shadowSnapshot, "shadow counter")[0];
            if (!shadowRef) {
              throw new Error(
                `Open-shadow React snapshot returned no ref: ${JSON.stringify(shadowSnapshot.structuredContent)}`,
              );
            }
            const shadowInspected = await service.handlers.reactInspectComponent(
              {
                browser: "isolated-headless",
                browserInstanceId,
                lookup: { ref: shadowRef, type: "snapshot-ref" },
              },
              context,
            );
            expect(inspectedComponentId(shadowInspected)).toBe(counterComponentId);
            const restoredShadowNode = await service.handlers.runPlaywright(
              {
                args: {},
                browser: "isolated-headless",
                browserInstanceId,
                code: `
            return await page.evaluate(() => {
              const host = document.querySelector('#react-shadow-host');
              const counter = host?.shadowRoot?.querySelector('#react-counter');
              if (!(host instanceof HTMLElement) || !(counter instanceof HTMLElement)) return false;
              counter.removeAttribute('aria-label');
              host.before(counter);
              host.remove();
              return true;
            });
          `,
                timeoutMs: 10_000,
              },
              context,
            );
            expect(
              isRecord(restoredShadowNode.structuredContent) ?
                restoredShadowNode.structuredContent.value
              : false,
            ).toBeTrue();

            const frameSnapshot = await service.handlers.runPlaywright(
              {
                args: {},
                browser: "isolated-headless",
                browserInstanceId,
                code: `
            await page.evaluate(() => {
              const frame = document.createElement('iframe');
              frame.id = 'react-child-frame';
              frame.src = 'data:text/html,<button aria-label="child frame node">child</button>';
              document.body.append(frame);
            });
            await page.frameLocator('#react-child-frame').getByRole('button', { name: 'child frame node' }).waitFor();
            return await chrome.captureAccessibilitySnapshot({ depth: 20, maxBytes: 80000 });
          `,
                timeoutMs: 10_000,
              },
              context,
            );
            const childFrameRef = snapshotRefsNamed(frameSnapshot, "child frame node")[0];
            if (!childFrameRef) {
              throw new Error(
                `Child-frame snapshot returned no ref: ${JSON.stringify(frameSnapshot.structuredContent)}`,
              );
            }
            const childFrameInspected = await service.handlers.reactInspectComponent(
              {
                browser: "isolated-headless",
                browserInstanceId,
                lookup: { ref: childFrameRef, type: "snapshot-ref" },
              },
              context,
            );
            if (
              !isRecord(childFrameInspected.structuredContent) ||
              !isRecord(childFrameInspected.structuredContent.error)
            ) {
              throw new Error(
                `Child-frame React lookup returned an invalid result: ${JSON.stringify(childFrameInspected.structuredContent)}`,
              );
            }
            expect(childFrameInspected.structuredContent.error.code).toBe(
              "CHROME_MCP_REACT_UNSUPPORTED_OPERATION",
            );
            await service.handlers.runPlaywright(
              {
                args: {},
                browser: "isolated-headless",
                browserInstanceId,
                code: "await page.locator('#react-child-frame').evaluate(node => node.remove()); return true;",
                timeoutMs: 10_000,
              },
              context,
            );

            if (isProduction) {
              const replacementSnapshot = await service.handlers.runPlaywright(
                {
                  args: {},
                  browser: "isolated-headless",
                  browserInstanceId,
                  code: `
              await page.locator('#react-counter-secondary').evaluate(node => node.setAttribute('aria-label', 'replace this counter'));
              return await chrome.captureAccessibilitySnapshot({ depth: 20, maxBytes: 80000 });
            `,
                  timeoutMs: 10_000,
                },
                context,
              );
              const replacementRef = snapshotRefsNamed(replacementSnapshot, "replace this counter")[0];
              if (!replacementRef) {
                throw new Error(
                  `Replacement snapshot returned no ref: ${JSON.stringify(replacementSnapshot.structuredContent)}`,
                );
              }
              await service.handlers.runPlaywright(
                {
                  args: {},
                  browser: "isolated-headless",
                  browserInstanceId,
                  code: `
              await page.locator('#react-counter-secondary').evaluate(node => {
                const replacement = node.cloneNode(true);
                node.replaceWith(replacement);
              });
              return true;
            `,
                  timeoutMs: 10_000,
                },
                context,
              );
              const replaced = await service.handlers.reactInspectComponent(
                {
                  browser: "isolated-headless",
                  browserInstanceId,
                  lookup: { ref: replacementRef, type: "snapshot-ref" },
                },
                context,
              );
              if (!isRecord(replaced.structuredContent) || !isRecord(replaced.structuredContent.error)) {
                throw new Error(
                  `Replaced React snapshot ref returned an invalid result: ${JSON.stringify(replaced.structuredContent)}`,
                );
              }
              expect(replaced.structuredContent.error.code).toBe("CHROME_MCP_STALE_REF");
            }

            const stagingKeys = await service.handlers.runPlaywright(
              {
                args: {},
                browser: "isolated-headless",
                browserInstanceId,
                code: "return await page.evaluate(() => Object.getOwnPropertyNames(globalThis).filter(key => key.startsWith('__chromeMcpReactNode_')));",
                timeoutMs: 10_000,
              },
              context,
            );
            expect(
              isRecord(stagingKeys.structuredContent) ? stagingKeys.structuredContent.value : null,
            ).toEqual([]);
            const invalidSelector = await service.handlers.reactInspectComponent(
              {
                browser: "isolated-headless",
                browserInstanceId,
                lookup: { selector: "[", type: "selector" },
              },
              context,
            );
            if (
              !isRecord(invalidSelector.structuredContent) ||
              !isRecord(invalidSelector.structuredContent.error)
            ) {
              throw new Error(
                `Invalid React selector returned an invalid result: ${JSON.stringify(invalidSelector.structuredContent)}`,
              );
            }
            expect(invalidSelector.structuredContent.error.code).toBe("CHROME_MCP_INVALID_INPUT");
            const restoredSelection = await service.handlers.runPlaywright(
              {
                args: {},
                browser: "isolated-headless",
                browserInstanceId,
                code: "return await page.evaluate(() => globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__.$0 === 'selection-sentinel');",
                timeoutMs: 10_000,
              },
              context,
            );
            expect(
              isRecord(restoredSelection.structuredContent) ?
                restoredSelection.structuredContent.value
              : false,
            ).toBeTrue();
          };
          await verifyReactInspectionLookups();

          const highlighted = await service.handlers.reactHighlightComponent(
            {
              action: { componentId: counterComponentId, type: "show" },
              browser: "isolated-headless",
              browserInstanceId,
            },
            context,
          );
          expect(
            isRecord(highlighted.structuredContent) ? highlighted.structuredContent.ok : false,
          ).toBeTrue();
          expect(
            isRecord(highlighted.structuredContent) && isRecord(highlighted.structuredContent.data) ?
              highlighted.structuredContent.data.hostNodeCount
            : 0,
          ).toBeGreaterThan(0);

          const updated = await service.handlers.reactUpdateComponent(
            {
              browser: "isolated-headless",
              browserInstanceId,
              componentId: counterComponentId,
              location: { hookId, path: [], type: "hook-state" },
              value: { type: "json", value: 7 },
            },
            context,
          );
          if (isProduction) {
            if (!isRecord(updated.structuredContent) || !isRecord(updated.structuredContent.error)) {
              throw new Error(
                `React production update returned an invalid result: ${JSON.stringify(updated.structuredContent)}`,
              );
            }
            expect(updated.structuredContent.error.code).toBe("CHROME_MCP_REACT_UNSUPPORTED_OPERATION");
          } else {
            const wrongComponentHook = await service.handlers.reactUpdateComponent(
              {
                browser: "isolated-headless",
                browserInstanceId,
                componentId: counterComponentId,
                location: { hookId: secondaryHookId, path: [], type: "hook-state" },
                value: { type: "json", value: 9 },
              },
              context,
            );
            if (
              !isRecord(wrongComponentHook.structuredContent) ||
              !isRecord(wrongComponentHook.structuredContent.error)
            ) {
              throw new Error(
                `Cross-component hook update returned an invalid result: ${JSON.stringify(wrongComponentHook.structuredContent)}`,
              );
            }
            expect(wrongComponentHook.structuredContent.error.code).toBe("CHROME_MCP_REACT_STALE_COMPONENT");
            if (
              !isRecord(updated.structuredContent) ||
              updated.structuredContent.ok !== true ||
              !isRecord(updated.structuredContent.data)
            ) {
              throw new Error(`React update failed: ${JSON.stringify(updated.structuredContent)}`);
            }
            expect(updated.structuredContent.data.status).toBe("applied");
            const hiddenSecondary = await service.handlers.runPlaywright(
              {
                args: {},
                browser: "isolated-headless",
                browserInstanceId,
                code: "await page.locator('#react-hide-secondary').click(); return await page.locator('#react-counter-secondary').count();",
                timeoutMs: 10_000,
              },
              context,
            );
            expect(
              isRecord(hiddenSecondary.structuredContent) ? hiddenSecondary.structuredContent.value : null,
            ).toBe(0);
            const staleParentFilter = await service.handlers.reactListComponents(
              {
                browser: "isolated-headless",
                browserInstanceId,
                limit: 100,
                parentComponentId: secondaryCounter.componentId,
              },
              context,
            );
            if (
              !isRecord(staleParentFilter.structuredContent) ||
              !isRecord(staleParentFilter.structuredContent.error)
            ) {
              throw new Error(
                `Stale React parent filter returned an invalid result: ${JSON.stringify(staleParentFilter.structuredContent)}`,
              );
            }
            expect(staleParentFilter.structuredContent.error.code).toBe("CHROME_MCP_REACT_STALE_COMPONENT");
          }

          const verifyReactProfiling = async () => {
            const started = await service.handlers.reactProfileStart(
              {
                browser: "isolated-headless",
                browserInstanceId,
              },
              context,
            );
            if (isProduction) {
              if (!isRecord(started.structuredContent) || !isRecord(started.structuredContent.error)) {
                throw new Error(
                  `React production profile start returned an invalid result: ${JSON.stringify(started.structuredContent)}`,
                );
              }
              expect(started.structuredContent.error.code).toBe("CHROME_MCP_REACT_UNSUPPORTED_OPERATION");
              await verifyReactLifecycle(browserInstanceId, counterComponentId);

              return;
            }
            if (
              !isRecord(started.structuredContent) ||
              !isRecord(started.structuredContent.data) ||
              typeof started.structuredContent.data.profileId !== "string"
            ) {
              throw new Error(`React profile start failed: ${JSON.stringify(started.structuredContent)}`);
            }
            const profileId = started.structuredContent.data.profileId;
            const profileTargetId = started.structuredContent.targetId;
            if (typeof profileTargetId !== "string") {
              throw new TypeError(
                `React profile start returned no target ID: ${JSON.stringify(started.structuredContent)}`,
              );
            }
            await service.handlers.runPlaywright(
              {
                args: {},
                browser: "isolated-headless",
                browserInstanceId,
                code: "await page.locator('#react-counter').click(); await page.locator('#react-show-secondary').click(); await page.locator('#react-counter-secondary').click(); await page.locator('#react-unmount').click(); return await page.locator('#root').evaluate(node => node.childElementCount);",
                timeoutMs: 10_000,
              },
              context,
            );
            const selectedOtherPage = await service.handlers.runPlaywright(
              {
                args: {},
                browser: "isolated-headless",
                browserInstanceId,
                code: `
            const otherPage = await context.newPage();
            await otherPage.setContent('<title>react-profile-selection-b</title>');
            await chrome.selectPageForSession(otherPage);
            return await otherPage.title();
          `,
                timeoutMs: 10_000,
              },
              context,
            );
            expect(
              isRecord(selectedOtherPage.structuredContent) ?
                selectedOtherPage.structuredContent.value
              : null,
            ).toBe("react-profile-selection-b");
            const stopped = await service.handlers.reactProfileStop({ profileId }, context);
            if (
              !isRecord(stopped.structuredContent) ||
              stopped.structuredContent.ok !== true ||
              !isRecord(stopped.structuredContent.data)
            ) {
              throw new Error(`React profile stop failed: ${JSON.stringify(stopped.structuredContent)}`);
            }
            expect(stopped.structuredContent.targetId).toBe(profileTargetId);
            const profile = stopped.structuredContent.data.profile;
            if (!isRecord(profile) || !Array.isArray(profile.dataForRoots)) {
              throw new Error(
                `React profile data was not normalized: ${JSON.stringify(stopped.structuredContent.data)}`,
              );
            }
            const snapshots = profile.dataForRoots.flatMap((profileRoot) => {
              if (!isRecord(profileRoot)) return [];

              const rootSnapshots = profileRoot.snapshots;
              if (!Array.isArray(rootSnapshots)) return [];

              return rootSnapshots;
            });
            expect(snapshots.length).toBeGreaterThan(0);
            for (const snapshotEntry of snapshots) {
              if (
                !Array.isArray(snapshotEntry) ||
                typeof snapshotEntry[0] !== "string" ||
                !isRecord(snapshotEntry[1])
              ) {
                throw new Error(
                  `React profile snapshot has an invalid shape: ${JSON.stringify(snapshotEntry)}`,
                );
              }
              expect(snapshotEntry[1].id).toBeString();
              expect(
                Array.isArray(snapshotEntry[1].children) &&
                  snapshotEntry[1].children.every((id) => typeof id === "string"),
              ).toBeTrue();
            }
            const analyzed = await service.handlers.reactProfileAnalyze({ limit: 25, profileId }, context);
            expect(isRecord(analyzed.structuredContent) ? analyzed.structuredContent.ok : false).toBeTrue();
            if (!isRecord(analyzed.structuredContent) || !Array.isArray(analyzed.structuredContent.results)) {
              throw new Error(
                `React analysis returned no rows: ${JSON.stringify(analyzed.structuredContent)}`,
              );
            }
            const counterRows = analyzed.structuredContent.results.filter(
              (row) => isRecord(row) && row.displayName === "Counter",
            );
            expect(counterRows).toHaveLength(2);
            expect(
              counterRows.some((row) => isRecord(row) && row.componentId === counterComponentId),
            ).toBeTrue();
            const capturedIds = new Set(snapshots.map((entry) => (Array.isArray(entry) ? entry[0] : null)));
            expect(counterRows.some((row) => isRecord(row) && !capturedIds.has(row.componentId))).toBeTrue();
            expect(counterRows.every((row) => isRecord(row) && !("changeDescriptions" in row))).toBeTrue();

            const restoredOriginalPage = await service.handlers.runPlaywright(
              {
                args: { originalUrl: pathToFileURL(fixturePath).href },
                browser: "isolated-headless",
                browserInstanceId,
                code: `
            const originalPage = context.pages().find(candidate => candidate.url() === args.originalUrl);
            if (!originalPage) throw new Error('Original React profile page is unavailable');
            await chrome.selectPageForSession(originalPage);
            for (const candidate of context.pages()) {
              if (candidate !== originalPage && await candidate.title() === 'react-profile-selection-b') await candidate.close();
            }
            return originalPage.url();
          `,
                timeoutMs: 10_000,
              },
              context,
            );
            expect(
              isRecord(restoredOriginalPage.structuredContent) ?
                restoredOriginalPage.structuredContent.value
              : null,
            ).toBe(pathToFileURL(fixturePath).href);

            await verifyReactLifecycle(browserInstanceId, counterComponentId);
          };
          await verifyReactProfiling();
        };

        await verifyReactBuild("development");
        await verifyReactBuild("production");

        const sharedFixtureUrl = pathToFileURL(join(root, "react-development.html")).href;
        const sharedLoaded = await service.handlers.runPlaywright(
          {
            args: { url: sharedFixtureUrl },
            browser: "shared-headless",
            code: "await page.goto(args.url); await page.locator('#react-counter').waitFor(); return true;",
            timeoutMs: 10_000,
          },
          context,
        );
        expect(
          isRecord(sharedLoaded.structuredContent) ? sharedLoaded.structuredContent.ok : false,
        ).toBeTrue();
        const sharedPrimaryList = await service.handlers.reactListComponents(
          {
            browser: "shared-headless",
            limit: 100,
          },
          context,
        );
        expect(
          isRecord(sharedPrimaryList.structuredContent) ? sharedPrimaryList.structuredContent.ok : false,
        ).toBeTrue();
        const secondaryContext = createLiveToolContext(root);
        const secondaryListed = await service.handlers.reactListComponents(
          {
            browser: "shared-headless",
            limit: 100,
          },
          secondaryContext,
        );
        if (
          !isRecord(secondaryListed.structuredContent) ||
          secondaryListed.structuredContent.ok !== true ||
          !isRecord(secondaryListed.structuredContent.data)
        ) {
          throw new Error(
            `Second React connection could not list components: ${JSON.stringify(secondaryListed.structuredContent)}`,
          );
        }
        const secondaryComponents = secondaryListed.structuredContent.data.components;
        const secondaryConnectionCounter =
          Array.isArray(secondaryComponents) ?
            secondaryComponents.find(
              (component) => isRecord(component) && component.displayName === "Counter",
            )
          : undefined;
        if (
          !isRecord(secondaryConnectionCounter) ||
          typeof secondaryConnectionCounter.componentId !== "string"
        ) {
          throw new Error(
            `Second React connection returned no Counter: ${JSON.stringify(secondaryComponents)}`,
          );
        }
        const secondaryHighlight = await service.handlers.reactHighlightComponent(
          {
            action: { componentId: secondaryConnectionCounter.componentId, type: "show" },
            browser: "shared-headless",
          },
          secondaryContext,
        );
        expect(
          isRecord(secondaryHighlight.structuredContent) ? secondaryHighlight.structuredContent.ok : false,
        ).toBeTrue();
        const secondaryProfile = await service.handlers.reactProfileStart(
          { browser: "shared-headless" },
          secondaryContext,
        );
        if (
          !isRecord(secondaryProfile.structuredContent) ||
          !isRecord(secondaryProfile.structuredContent.data)
        ) {
          throw new Error(
            `Second React connection could not start profiling: ${JSON.stringify(secondaryProfile.structuredContent)}`,
          );
        }
        const profileConflict = await service.handlers.reactProfileStart(
          { browser: "shared-headless" },
          context,
        );
        if (
          !isRecord(profileConflict.structuredContent) ||
          !isRecord(profileConflict.structuredContent.error)
        ) {
          throw new Error(
            `Concurrent React profile returned an invalid result: ${JSON.stringify(profileConflict.structuredContent)}`,
          );
        }
        expect(profileConflict.structuredContent.error.code).toBe("CHROME_MCP_REACT_PROFILE_ACTIVE");
        await service.closeConnection(secondaryContext);
        const clearedAfterDisconnect = await service.handlers.reactHighlightComponent(
          {
            action: { type: "clear" },
            browser: "shared-headless",
          },
          context,
        );
        expect(
          isRecord(clearedAfterDisconnect.structuredContent) ?
            clearedAfterDisconnect.structuredContent.ok
          : false,
        ).toBeTrue();
        const restartedProfile = await service.handlers.reactProfileStart(
          { browser: "shared-headless" },
          context,
        );
        if (
          !isRecord(restartedProfile.structuredContent) ||
          !isRecord(restartedProfile.structuredContent.data) ||
          typeof restartedProfile.structuredContent.data.profileId !== "string"
        ) {
          throw new Error(
            `React profile was not released on disconnect: ${JSON.stringify(restartedProfile.structuredContent)}`,
          );
        }
        const restartedStopped = await service.handlers.reactProfileStop(
          {
            profileId: restartedProfile.structuredContent.data.profileId,
          },
          context,
        );
        expect(
          isRecord(restartedStopped.structuredContent) ? restartedStopped.structuredContent.ok : false,
        ).toBeTrue();

        const lateRendererInstanceId = "react-late-renderer";
        await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated-headless",
            browserInstanceId: lateRendererInstanceId,
            code: "await page.setContent('<div id=\"root\"></div>'); return true;",
            timeoutMs: 10_000,
          },
          context,
        );
        const absentRenderer = await service.handlers.reactListComponents(
          {
            browser: "isolated-headless",
            browserInstanceId: lateRendererInstanceId,
            limit: 100,
          },
          context,
        );
        if (
          !isRecord(absentRenderer.structuredContent) ||
          !isRecord(absentRenderer.structuredContent.error)
        ) {
          throw new Error(
            `Missing React renderer returned an invalid result: ${JSON.stringify(absentRenderer.structuredContent)}`,
          );
        }
        expect(absentRenderer.structuredContent.error.code).toBe("CHROME_MCP_REACT_NO_RENDERER");
        const lateBundle = await buildReactFixture(false);
        const attachedLateRenderer = await service.handlers.runPlaywright(
          {
            args: { bundle: lateBundle },
            browser: "isolated-headless",
            browserInstanceId: lateRendererInstanceId,
            code: `
          await page.evaluate(bundle => {
            document.body.innerHTML = '<div id="root"></div>';
            (0, eval)(bundle);
          }, args.bundle);
          await page.locator('#react-counter').waitFor();
          return true;
        `,
            timeoutMs: 10_000,
          },
          context,
        );
        expect(
          isRecord(attachedLateRenderer.structuredContent) ?
            attachedLateRenderer.structuredContent.ok
          : false,
        ).toBeTrue();
        const lateListed = await service.handlers.reactListComponents(
          {
            browser: "isolated-headless",
            browserInstanceId: lateRendererInstanceId,
            limit: 100,
          },
          context,
        );
        if (!isRecord(lateListed.structuredContent) || lateListed.structuredContent.ok !== true) {
          throw new Error(
            `Prepared React instrumentation did not observe a late renderer: ${JSON.stringify(lateListed.structuredContent)}`,
          );
        }
        expect(lateListed.structuredContent.reloaded).toBeTrue();

        const stubBundle = await buildReactFixture(false);
        const stubPath = join(root, "react-devtools-stub.html");
        const stub = `if (!globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__) globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        renderers: new Map(),
        supportsFiber: true,
        inject() { return 1; },
        onScheduleFiberRoot() {},
        onCommitFiberRoot() {},
        onCommitFiberUnmount() {},
      };`;
        await writeFile(
          stubPath,
          `<!doctype html><div id="root"></div><script>${stub}</script><script>${stubBundle.replaceAll("</script", "<\\/script")}</script>`,
        );
        const stubInstanceId = "react-incompatible-hook";
        await service.handlers.runPlaywright(
          {
            args: { url: pathToFileURL(stubPath).href },
            browser: "isolated-headless",
            browserInstanceId: stubInstanceId,
            code: "await page.goto(args.url); await page.locator('#react-counter').waitFor(); return true;",
            timeoutMs: 10_000,
          },
          context,
        );
        const preInstrumentationSnapshot = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated-headless",
            browserInstanceId: stubInstanceId,
            code: "return await chrome.captureAccessibilitySnapshot({ depth: 20, maxBytes: 80000 });",
            timeoutMs: 10_000,
          },
          context,
        );
        const preInstrumentationRef = snapshotRefsNamed(preInstrumentationSnapshot, "count:1")[0];
        if (!preInstrumentationRef) {
          throw new Error(
            `Pre-instrumentation snapshot returned no ref: ${JSON.stringify(preInstrumentationSnapshot.structuredContent)}`,
          );
        }
        const invalidatedByPreparation = await service.handlers.reactInspectComponent(
          {
            browser: "isolated-headless",
            browserInstanceId: stubInstanceId,
            lookup: { ref: preInstrumentationRef, type: "snapshot-ref" },
          },
          context,
        );
        if (
          !isRecord(invalidatedByPreparation.structuredContent) ||
          !isRecord(invalidatedByPreparation.structuredContent.error)
        ) {
          throw new Error(
            `Pre-instrumentation snapshot ref returned an invalid result: ${JSON.stringify(invalidatedByPreparation.structuredContent)}`,
          );
        }
        expect(invalidatedByPreparation.structuredContent.error.code).toBe("CHROME_MCP_STALE_REF");
        const postInstrumentationSnapshot = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated-headless",
            browserInstanceId: stubInstanceId,
            code: "return await chrome.captureAccessibilitySnapshot({ depth: 20, maxBytes: 80000 });",
            timeoutMs: 10_000,
          },
          context,
        );
        const postInstrumentationRef = snapshotRefsNamed(postInstrumentationSnapshot, "count:1")[0];
        if (!postInstrumentationRef) {
          throw new Error(
            `Post-instrumentation snapshot returned no ref: ${JSON.stringify(postInstrumentationSnapshot.structuredContent)}`,
          );
        }
        expect(
          inspectedComponentId(
            await service.handlers.reactInspectComponent(
              {
                browser: "isolated-headless",
                browserInstanceId: stubInstanceId,
                lookup: { ref: postInstrumentationRef, type: "snapshot-ref" },
              },
              context,
            ),
          ),
        ).toBeString();
        const stubResult = await service.handlers.reactListComponents(
          {
            browser: "isolated-headless",
            browserInstanceId: stubInstanceId,
            limit: 100,
          },
          context,
        );
        if (!isRecord(stubResult.structuredContent) || stubResult.structuredContent.ok !== true) {
          throw new Error(
            `Conditional React hook stub was not recovered through reload: ${JSON.stringify(stubResult.structuredContent)}`,
          );
        }
        expect(stubResult.structuredContent.reloaded).toBeTrue();
        const stubReloaded = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated-headless",
            browserInstanceId: stubInstanceId,
            code: "await page.reload(); await page.locator('#react-counter').waitFor(); return true;",
            timeoutMs: 10_000,
          },
          context,
        );
        expect(
          isRecord(stubReloaded.structuredContent) ? stubReloaded.structuredContent.ok : false,
        ).toBeTrue();
        const stubRelisted = await service.handlers.reactListComponents(
          {
            browser: "isolated-headless",
            browserInstanceId: stubInstanceId,
            limit: 100,
          },
          context,
        );
        expect(
          isRecord(stubRelisted.structuredContent) ? stubRelisted.structuredContent.ok : false,
        ).toBeTrue();
      } finally {
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      if (priorRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
    }
  },
  120_000,
);

liveTest(
  "verifies compound React mutations without mistaking previews for overwritten values",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-react-mutations-"));
    roots.push(root);

    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    const context = createLiveToolContext(root);
    const browser = { browser: "isolated-headless", browserInstanceId: "mutations" } satisfies Pick<
      ReactUpdateComponentInput,
      "browser" | "browserInstanceId"
    >;

    const reactData = (result: unknown) => {
      if (
        !isRecord(result) ||
        !isRecord(result.structuredContent) ||
        result.structuredContent.ok !== true ||
        !isRecord(result.structuredContent.data)
      ) {
        throw new Error(`React mutation check failed: ${JSON.stringify(result)}`);
      }
      return result.structuredContent.data;
    };

    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });
      try {
        const bundle = await buildReactFixture(false);
        const fixturePath = join(root, "mutations.html");
        await writeFile(
          fixturePath,
          `<!doctype html><div id="root"></div><script>${bundle.replaceAll("</script", "<\\/script")}</script>`,
        );

        const loaded = await service.handlers.runPlaywright(
          {
            ...browser,
            args: { url: pathToFileURL(fixturePath).href },
            code: "await page.goto(args.url); await page.locator('#react-items').waitFor(); return await page.locator('#react-items').textContent();",
            timeoutMs: 10_000,
          },
          context,
        );
        expect(loaded.structuredContent).toMatchObject({
          ok: true,
          value: '[{"details":{"label":"baseline"}}]',
        });

        const inspected = await service.handlers.reactInspectComponent(
          {
            ...browser,
            lookup: { type: "selector", selector: "#react-items" },
          },
          context,
        );
        const componentId = inspectedComponentId(inspected);
        expect(reactData(inspected).truncated).toBeTrue();
        const items = [{ details: { label: `synthetic-${"x".repeat(600)}` } }];
        const updated = await service.handlers.reactUpdateComponent(
          {
            ...browser,
            componentId,
            location: { type: "props", path: ["items"] },
            value: { type: "json", value: items },
          },
          context,
        );
        expect(reactData(updated).status).toBe("applied");
        expect(JSON.stringify(reactData(updated).observedValue)).toContain("synthetic");

        const activated = await service.handlers.reactUpdateComponent(
          {
            ...browser,
            componentId,
            location: { type: "props", path: ["active"] },
            value: { type: "json", value: true },
          },
          context,
        );
        expect(reactData(activated).status).toBe("applied");

        const rendered = await service.handlers.runPlaywright(
          {
            ...browser,
            code: "return {items:await page.locator('#react-items').textContent(),indicator:await page.locator('#react-indicator').count()};",
            args: {},
            timeoutMs: 10_000,
          },
          context,
        );
        expect(rendered.structuredContent).toMatchObject({
          ok: true,
          value: { items: JSON.stringify(items), indicator: 1 },
        });

        const rerendered = await service.handlers.runPlaywright(
          {
            ...browser,
            code: "await page.locator('#react-hide-secondary').click(); await page.locator('#react-counter-secondary').waitFor({state:'detached'}); return {items:await page.locator('#react-items').textContent(),indicator:await page.locator('#react-indicator').count()};",
            args: {},
            timeoutMs: 10_000,
          },
          context,
        );
        expect(rerendered.structuredContent).toMatchObject({
          ok: true,
          value: { items: '[{"details":{"label":"baseline"}}]', indicator: 0 },
        });

        const hookId = firstReactHookId(reactData(inspected).hooks);
        if (!hookId) {
          throw new Error("React mutation fixture state hook is unavailable");
        }

        const classInspected = await service.handlers.reactInspectComponent(
          {
            ...browser,
            lookup: { type: "selector", selector: "#react-class-state" },
          },
          context,
        );
        const classComponentId = inspectedComponentId(classInspected);
        const contexts = reactData(classInspected).contexts;
        if (!Array.isArray(contexts) || !isRecord(contexts[0]) || typeof contexts[0].contextId !== "string") {
          throw new Error("React mutation fixture class context is unavailable");
        }

        const record = { details: { label: "changed" } };
        const mutations: {
          componentId: string;
          selector: string;
          location: ReactUpdateComponentInput["location"];
          value: ReactUpdateComponentInput["value"];
        }[] = [
          {
            componentId,
            selector: "#react-hook-value",
            location: { type: "hook-state", hookId, path: [] },
            value: { type: "json", value: record },
          },
          {
            componentId: classComponentId,
            selector: "#react-class-props",
            location: { type: "props", path: ["record"] },
            value: { type: "json", value: record },
          },
          {
            componentId: classComponentId,
            selector: "#react-class-state",
            location: { type: "class-state", path: ["record"] },
            value: { type: "json", value: record },
          },
          {
            componentId: classComponentId,
            selector: "#react-context",
            location: { type: "context", contextId: contexts[0].contextId, path: ["value", "details"] },
            value: { type: "json", value: record.details },
          },
        ];
        for (const mutation of mutations) {
          const changed = await service.handlers.reactUpdateComponent(
            {
              ...browser,
              componentId: mutation.componentId,
              location: mutation.location,
              value: mutation.value,
            },
            context,
          );
          expect(reactData(changed).status).toBe("applied");

          const observation = await service.handlers.runPlaywright(
            {
              ...browser,
              args: { selector: mutation.selector },
              code: "return await page.locator(args.selector).textContent();",
              timeoutMs: 10_000,
            },
            context,
          );
          expect(observation.structuredContent).toMatchObject({ ok: true, value: JSON.stringify(record) });
        }
      } finally {
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = priorDataHome;
      }
      if (priorRuntimeDirectory === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
      }
    }
  },
  60_000,
);

liveTest.each([
  { script: "a parser", delayMs: 0, attribute: "", hasUnsupportedRenderer: false },
  { script: "an async", delayMs: 6000, attribute: "async", hasUnsupportedRenderer: false },
  { script: "an async mixed-renderer", delayMs: 6000, attribute: "async", hasUnsupportedRenderer: true },
])(
  "starts React profiling from $script script while an image holds page load",
  async ({ attribute, delayMs, hasUnsupportedRenderer }) => {
    const executablePath = Bun.which("google-chrome-stable");
    assert(executablePath);

    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-react-held-load-"));
    roots.push(root);

    const bundle = await buildReactFixture(false);
    let earlyScript = "";

    if (hasUnsupportedRenderer) {
      earlyScript = `<script>(() => {
      const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      const inject = hook?.inject;
      if (hook) {
        hook.inject = function(renderer) {
          return inject.call(this, { ...renderer, version: '20.0.0' });
        };
      }

      ${bundle.replaceAll("</script", "<\\/script")}

      if (hook) {
        hook.inject = inject;
      }

      document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('root').id = 'unsupported-root';
        const root = document.createElement('div');
        root.id = 'root';
        document.body.append(root);
      }, { once: true });
    })();</script>`;
    }

    const releaseResponses: (() => void)[] = [];
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/app.js") {
          return new Promise<Response>((resolve) => {
            const timer = setTimeout(
              () =>
                resolve(
                  new Response(bundle, {
                    headers: { "content-type": "text/javascript" },
                  }),
                ),
              delayMs,
            );
            releaseResponses.push(() => {
              clearTimeout(timer);
              resolve(new Response(null, { status: 404 }));
            });
          });
        }

        if (new URL(request.url).pathname === "/held.svg") {
          return new Promise<Response>((resolve) => {
            releaseResponses.push(() => resolve(new Response(null, { status: 404 })));
          });
        }

        return new Response(
          `<!doctype html><div id="root"></div>${earlyScript}<script ${attribute} src="/app.js"></script><img src="/held.svg" alt="">`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });

    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    const context = createLiveToolContext(root);
    const browser = { browser: "isolated-headless", browserInstanceId: "held-load" } satisfies Pick<
      ReactUpdateComponentInput,
      "browser" | "browserInstanceId"
    >;

    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });

      try {
        const opened = await service.handlers.runPlaywright(
          {
            ...browser,
            args: { url: fixture.url.href },
            code: "await page.goto(args.url, { waitUntil: 'domcontentloaded' }); await page.locator('#root #react-counter').waitFor(); return await page.evaluate(() => document.readyState);",
            timeoutMs: 10_000,
          },
          context,
        );
        expect(opened.structuredContent).toMatchObject({ ok: true, value: "interactive" });

        const started = await service.handlers.reactProfileStart(browser, context);
        expect(started.structuredContent).toMatchObject({
          ok: true,
          reloaded: true,
          data: {
            includedRendererIds: [expect.any(String)],
            excludedRenderers: hasUnsupportedRenderer ? [expect.any(String)] : [],
          },
        });

        const reloaded = await service.handlers.runPlaywright(
          {
            ...browser,
            args: {},
            code: "await page.locator('#root #react-counter').waitFor(); return await page.evaluate(() => document.readyState);",
            timeoutMs: 10_000,
          },
          context,
        );
        expect(reloaded.structuredContent).toMatchObject({ ok: true, value: "interactive" });
      } finally {
        await service.close();
      }
    } finally {
      for (const releaseResponse of releaseResponses) {
        releaseResponse();
      }

      await fixture.stop(true);

      if (priorDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = priorDataHome;
      }

      if (priorRuntimeDirectory === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
      }
    }
  },
  60_000,
);

liveTest(
  "runs launched Chrome modes in a custom runtime directory with their intended viewports",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-service-"));
    roots.push(root);
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    const priorMcpRuntimeDirectory = process.env.CHROME_MCP_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    process.env.CHROME_MCP_RUNTIME_DIR = join(root, "mcp");
    const brokerPaths = await resolveBrokerRuntimePaths(root);
    const context = createLiveToolContext(root);
    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });
      let operationFailed = false;
      try {
        const created = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated",
            code: `
          const created = await context.newPage();
          const controls = Array.from({ length: 128 }, (_, index) => "<button>Action " + index + "</button>").join("");
          await created.setContent("<main><h1>broker-selected-page</h1>" + controls + "</main>");
          await chrome.selectPageForSession(created);
          const snapshot = await chrome.captureAccessibilitySnapshot({ depth: 20, maxBytes: 80000 });
          const ref = Object.keys(snapshot.refs)[0];
          if (!ref) throw new Error("Same-call snapshot did not return a retained ref");
          const locator = await chrome.resolveSnapshotRefToLocator(ref);
          return {
            heading: await created.locator("h1").textContent(),
            locatorCount: await locator.count(),
            snapshotTargetId: snapshot.targetId,
            tree: snapshot.tree,
          };
        `,
            timeoutMs: 10_000,
          },
          context,
        );
        if (!isRecord(created.structuredContent) || created.structuredContent.ok !== true) {
          throw new Error(`Live broker call failed: ${JSON.stringify(created.structuredContent)}`);
        }
        if (!isRecord(created.structuredContent.value)) {
          throw new Error(
            `Live same-call selection result is invalid: ${JSON.stringify(created.structuredContent)}`,
          );
        }
        expect(created.structuredContent.value.heading).toBe("broker-selected-page");
        expect(created.structuredContent.value.locatorCount).toBe(1);
        expect(created.structuredContent.value.snapshotTargetId).toBeString();
        expect(created.structuredContent.value.tree).toContain("broker-selected-page");
        const brokerMetadata = await stat(brokerPaths.metadataPath);
        expect(brokerMetadata.isFile()).toBe(true);

        const selected = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated",
            code: "return await page.locator('h1').textContent();",
            timeoutMs: 10_000,
          },
          context,
        );
        if (!isRecord(selected.structuredContent) || selected.structuredContent.ok !== true) {
          throw new Error(
            `Live broker selection check failed: ${JSON.stringify(selected.structuredContent)}`,
          );
        }
        expect(selected.structuredContent.value).toBe("broker-selected-page");

        const snapshot = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated",
            code: "return await chrome.captureAccessibilitySnapshot({ depth: 20, maxBytes: 80000 });",
            timeoutMs: 10_000,
          },
          context,
        );
        if (!isRecord(snapshot.structuredContent) || !isRecord(snapshot.structuredContent.value)) {
          throw new Error(`Live broker snapshot failed: ${JSON.stringify(snapshot.structuredContent)}`);
        }
        expect(snapshot.structuredContent.value.tree).toContain("broker-selected-page");

        const expectedHelperFailures = [
          {
            code: "CHROME_MCP_UNKNOWN_REF",
            source: 'return await chrome.resolveSnapshotRefToLocator("s99e99");',
          },
          {
            code: "CHROME_MCP_CAPTURE_NOT_FOUND",
            source: 'return await chrome.capture.stop("missing-capture");',
          },
          {
            code: "CHROME_MCP_CHECKPOINT_NOT_FOUND",
            source: 'return await chrome.checkpoint.diff("missing-checkpoint");',
          },
        ] as const;
        for (const failure of expectedHelperFailures) {
          const result = await service.handlers.runPlaywright(
            {
              args: {},
              browser: "isolated",
              code: failure.source,
              timeoutMs: 10_000,
            },
            context,
          );
          const error =
            isRecord(result.structuredContent) && isRecord(result.structuredContent.error) ?
              result.structuredContent.error
            : undefined;
          expect(result.isError).toBeTrue();
          expect(error?.code).toBe(failure.code);
        }

        const registeredMutations = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated",
            code: `
          const route = await chrome.routes.add({
            action: {
              body: "<title>persistent-route</title><main>STUBBED</main>",
              headers: { "content-type": "text/html; charset=utf-8" },
              status: 200,
              type: "fulfill",
            },
            method: "GET",
            urlPattern: "https://chrome-mcp.invalid/persistent",
          });
          const initScript = await chrome.initScripts.add(
            "globalThis.__chromeMcpInitMarker = (globalThis.__chromeMcpInitMarker ?? 0) + 1",
          );
          const binding = await chrome.bindings.add({
            name: "__chromeMcpEcho",
            source: "value => ({ echo: value, source: 'binding-subprocess' })",
          });
          return { bindingId: binding.id, initScriptId: initScript.id, routeId: route.id };
        `,
            timeoutMs: 10_000,
          },
          context,
        );
        if (
          !isRecord(registeredMutations.structuredContent) ||
          registeredMutations.structuredContent.ok !== true
        ) {
          throw new Error(
            `Persistent mutation registration failed: ${JSON.stringify(registeredMutations.structuredContent)}`,
          );
        }

        const persistedMutations = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated",
            code: `
          await page.goto("https://chrome-mcp.invalid/persistent");
          return await page.evaluate(async () => ({
            binding: await globalThis.__chromeMcpEcho("cross-call"),
            body: document.body.textContent,
            initMarker: globalThis.__chromeMcpInitMarker,
            title: document.title,
          }));
        `,
            timeoutMs: 10_000,
          },
          context,
        );
        if (
          !isRecord(persistedMutations.structuredContent) ||
          persistedMutations.structuredContent.ok !== true
        ) {
          throw new Error(
            `Persistent mutation replay failed: ${JSON.stringify(persistedMutations.structuredContent)}`,
          );
        }
        expect(persistedMutations.structuredContent.value).toEqual({
          binding: { echo: "cross-call", source: "binding-subprocess" },
          body: "STUBBED",
          initMarker: 1,
          title: "persistent-route",
        });

        const listedMutations = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated",
            code: `
          return {
            bindings: await chrome.bindings.list(),
            initScripts: await chrome.initScripts.list(),
            routes: await chrome.routes.list(),
          };
        `,
            timeoutMs: 10_000,
          },
          context,
        );
        if (
          !isRecord(listedMutations.structuredContent) ||
          !isRecord(listedMutations.structuredContent.value)
        ) {
          throw new Error(
            `Persistent mutation listing failed: ${JSON.stringify(listedMutations.structuredContent)}`,
          );
        }
        expect(listedMutations.structuredContent.value.bindings).toHaveLength(1);
        expect(listedMutations.structuredContent.value.initScripts).toHaveLength(1);
        expect(listedMutations.structuredContent.value.routes).toHaveLength(1);

        const clearedMutations = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated",
            code: `
          const routes = await chrome.routes.clear();
          const initScripts = await chrome.initScripts.clear();
          const bindings = await chrome.bindings.clear();
          return { bindings, initScripts, routes };
        `,
            timeoutMs: 10_000,
          },
          context,
        );
        if (!isRecord(clearedMutations.structuredContent) || clearedMutations.structuredContent.ok !== true) {
          throw new Error(
            `Persistent mutation cleanup failed: ${JSON.stringify(clearedMutations.structuredContent)}`,
          );
        }
        expect(clearedMutations.structuredContent.value).toEqual({ bindings: 1, initScripts: 1, routes: 1 });

        const cleanedMutationState = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated",
            code: `
          await page.goto("data:text/html,<title>clean</title><main>CLEAN</main>");
          return await page.evaluate(() => ({
            bindingType: typeof globalThis.__chromeMcpEcho,
            initMarker: globalThis.__chromeMcpInitMarker ?? null,
          }));
        `,
            timeoutMs: 10_000,
          },
          context,
        );
        if (
          !isRecord(cleanedMutationState.structuredContent) ||
          cleanedMutationState.structuredContent.ok !== true
        ) {
          throw new Error(
            `Persistent mutation cleanup check failed: ${JSON.stringify(cleanedMutationState.structuredContent)}`,
          );
        }
        expect(cleanedMutationState.structuredContent.value).toEqual({
          bindingType: "undefined",
          initMarker: null,
        });

        const verifyLiveTargetSnapshot = async (targetUrl: string) => {
          const navigation = await service.handlers.runPlaywright(
            {
              args: { targetUrl },
              browser: "shared",
              code: `
            const target = await context.newPage();
            await target.goto(args.targetUrl, { waitUntil: "domcontentloaded" });
            await chrome.selectPageForSession(target);
            return { title: await target.title(), url: target.url() };
          `,
              timeoutMs: 30_000,
            },
            context,
          );
          if (!isRecord(navigation.structuredContent) || navigation.structuredContent.ok !== true) {
            throw new Error(`Live target navigation failed: ${JSON.stringify(navigation.structuredContent)}`);
          }

          let retainedRef: string | undefined;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const targetSnapshot = await service.handlers.runPlaywright(
              {
                args: {},
                browser: "shared",
                code: `
              const snapshot = await chrome.captureAccessibilitySnapshot({ depth: 20, maxBytes: 80000 });
              return {
                alive: await page.evaluate(() => document.readyState),
                snapshot,
                url: page.url(),
              };
            `,
                timeoutMs: 30_000,
              },
              context,
            );
            const targetSnapshotResult =
              isRecord(targetSnapshot.structuredContent) ? targetSnapshot.structuredContent.value : undefined;
            const targetSnapshotValue =
              isRecord(targetSnapshotResult) ? targetSnapshotResult.snapshot : undefined;
            if (
              !isRecord(targetSnapshot.structuredContent) ||
              !isRecord(targetSnapshotResult) ||
              !isRecord(targetSnapshotValue)
            ) {
              throw new Error(
                `Live target snapshot failed: ${JSON.stringify(targetSnapshot.structuredContent)}`,
              );
            }
            expect(targetSnapshotResult.alive).toBe("complete");
            expect(targetSnapshotResult.url).toBe(targetUrl);
            expect(targetSnapshotValue.tree).not.toContain("broker-selected-page");
            expect(targetSnapshotValue.targetId).toBeString();
            if (!retainedRef && isRecord(targetSnapshotValue.refs)) {
              retainedRef = Object.keys(targetSnapshotValue.refs)[0];
            }
          }
          if (!retainedRef) throw new Error("Live target snapshot did not return a retained ref");
          const retained = await service.handlers.runPlaywright(
            {
              args: { retainedRef },
              browser: "shared",
              code: `
            const locator = await chrome.resolveSnapshotRefToLocator(args.retainedRef);
            return { count: await locator.count(), url: page.url() };
          `,
              timeoutMs: 10_000,
            },
            context,
          );
          if (!isRecord(retained.structuredContent) || retained.structuredContent.ok !== true) {
            throw new Error(`Live retained ref failed: ${JSON.stringify(retained.structuredContent)}`);
          }
          expect(retained.structuredContent.value).toEqual({ count: 1, url: targetUrl });
        };

        const targetUrl = process.env.CHROME_MCP_LIVE_TARGET_URL;
        if (targetUrl) {
          await verifyLiveTargetSnapshot(targetUrl);
        }

        const headedViewport = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated",
            code: `
          const before = await page.evaluate(() => ({ height: window.innerHeight, width: window.innerWidth }));
          const cdp = await context.newCDPSession(page);
          try {
            await cdp.send('Emulation.clearDeviceMetricsOverride');
            const native = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
              resolve({ height: window.innerHeight, width: window.innerWidth });
            })));
            return { before, native };
          } finally {
            await cdp.detach();
          }
        `,
            timeoutMs: 10_000,
          },
          context,
        );
        if (
          !isRecord(headedViewport.structuredContent) ||
          headedViewport.structuredContent.ok !== true ||
          !isRecord(headedViewport.structuredContent.value)
        ) {
          throw new Error(
            `Live headed viewport check failed: ${JSON.stringify(headedViewport.structuredContent)}`,
          );
        }
        const { before, native } = headedViewport.structuredContent.value;
        if (!isRecord(native) || typeof native.height !== "number" || typeof native.width !== "number") {
          throw new Error(
            `Live headed viewport returned invalid dimensions: ${JSON.stringify(headedViewport.structuredContent)}`,
          );
        }
        expect(native.height).toBeGreaterThan(0);
        expect(native.width).toBeGreaterThan(0);
        expect(before).toEqual(native);

        const headlessViewport = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated-headless",
            browserInstanceId: "viewport",
            code: "return await page.evaluate(() => ({ height: window.innerHeight, width: window.innerWidth }));",
            timeoutMs: 10_000,
          },
          context,
        );
        if (!isRecord(headlessViewport.structuredContent) || headlessViewport.structuredContent.ok !== true) {
          throw new Error(
            `Live headless viewport check failed: ${JSON.stringify(headlessViewport.structuredContent)}`,
          );
        }
        expect(headlessViewport.structuredContent.value).toEqual({ height: 1080, width: 1920 });

        const heapPath = join(root, "selected-page.heapsnapshot");
        const heap = await service.handlers.takeHeapSnapshot(
          {
            analysis: {
              limit: 5,
              maxRetainingPathDepth: 6,
              modes: ["summary", "dominators", "retainers"],
            },
            browser: "isolated",
            filePath: heapPath,
          },
          context,
        );
        expect(heap.content[0]?.type).toBe("text");
        const heapMetadata = await stat(heapPath);
        expect(heapMetadata.size).toBeGreaterThan(0);
        if (!isRecord(heap.structuredContent) || !isRecord(heap.structuredContent.analysis)) {
          throw new Error(`Live heap analysis is invalid: ${JSON.stringify(heap.structuredContent)}`);
        }
        const heapSummary = heap.structuredContent.analysis.snapshot;
        if (!isRecord(heapSummary) || typeof heapSummary.nodeCount !== "number") {
          throw new Error(`Live heap summary is invalid: ${JSON.stringify(heap.structuredContent)}`);
        }
        expect(heapSummary.nodeCount).toBeGreaterThan(0);
        for (const query of [{ kind: "objects", sort: "retainedSize" }, { kind: "contexts" }] as const) {
          const queried = await service.handlers.analyzeHeapSnapshot(
            { filePath: heapPath, query, limit: 2 },
            context,
          );
          const result = heapQueryResultSchema.parse(queried.structuredContent);
          expect(result.kind).toBe(query.kind);
          expect(result.rows.length).toBeLessThanOrEqual(2);
          expect(result.totalMatches).toBeGreaterThan(0);
        }
      } catch (error: unknown) {
        operationFailed = true;
        const brokerLog = await readFile(brokerPaths.logPath, "utf8").catch(() => "Broker log unavailable");
        throw new AggregateError([error, new Error(brokerLog.slice(-4000))], "Live broker operation failed");
      } finally {
        await service.closeConnection(context).catch((error: unknown) => {
          if (!operationFailed) throw error;
        });
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      if (priorRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;

      if (priorMcpRuntimeDirectory === undefined) {
        delete process.env.CHROME_MCP_RUNTIME_DIR;
      } else {
        process.env.CHROME_MCP_RUNTIME_DIR = priorMcpRuntimeDirectory;
      }
    }
  },
  120_000,
);

const createLiveNavigationFixture = () =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/manifest.json") {
        return Response.json({
          id: "/app-id",
          name: "Synthetic Test App",
          short_name: "Test App",
          start_url: "/",
          scope: "/",
          display: "standalone",
          icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
        });
      }

      if (url.pathname.endsWith(".svg")) {
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="blue"/></svg>',
          { headers: { "content-type": "image/svg+xml" } },
        );
      }

      return new Response(
        `<!doctype html><html><head><link rel="manifest" href="/manifest.json"><title>Synthetic App</title></head><body><button onclick="history.pushState({}, '', '/second'); document.querySelector('main').innerHTML = '<h1 style=font-size:96px>Second route</h1><img src=/hero.svg width=512 height=512>'; console.trace('route changed')">Continue</button><main><h1>First route</h1></main></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });

linuxLiveTest(
  "installs and launches a PWA Page across calls, then removes the native installation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-pwa-"));
    roots.push(root);
    const fixture = createLiveNavigationFixture();
    const priorDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = join(root, "data");
    const brokerPaths = await resolveBrokerRuntimePaths(root);
    const service = await createChromeService({
      artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
      executablePath: await resolveChromeExecutable(),
      workspacePath: root,
    });
    const context = createLiveToolContext(root);
    const manifestId = `${fixture.url.origin}/app-id`;
    const run = (code: string) =>
      service.handlers.runPlaywright(
        {
          args: { manifestId, origin: fixture.url.origin },
          browser: "isolated-headless",
          browserInstanceId: "pwa",
          code,
          timeoutMs: 30_000,
        },
        context,
      );
    let operationError: unknown;

    try {
      const installed = await run(`
      await page.goto(args.origin);
      return await chrome.pwa.install({ manifestId: args.manifestId, installUrl: args.origin });
    `);
      expect(installed.structuredContent).toMatchObject({ ok: true, value: { displayMode: "browser" } });

      const launched = await run(`
      const appPage = await chrome.pwa.launch({ manifestId: args.manifestId });
      await appPage.getByRole('button', { name: 'Continue' }).click();
      return { url: appPage.url(), heading: await appPage.getByRole('heading').innerText(), state: await chrome.pwa.getState({ manifestId: args.manifestId }) };
    `);
      expect(launched.structuredContent).toMatchObject({
        ok: true,
        value: {
          url: `${fixture.url.origin}/second`,
          heading: "Second route",
          state: { badgeCount: 0, fileHandlers: [] },
        },
      });
      const removed = await run(`
      const selectedUrl = page.url();
      const survivor = await context.newPage();
      await survivor.goto(args.origin);
      await chrome.selectPageForSession(survivor);
      const result = await chrome.pwa.uninstall({ manifestId: args.manifestId });
      let missingCode;
      try { await chrome.pwa.getState({ manifestId: args.manifestId }); } catch (error) { missingCode = error.code; }
      return { selectedUrl, result, missingCode };
    `);
      expect(removed.structuredContent).toMatchObject({
        ok: true,
        value: {
          selectedUrl: `${fixture.url.origin}/second`,
          result: { operation: "uninstall", manifestId },
          missingCode: "CHROME_MCP_PWA_FAILED",
        },
      });
      const standalone = await run(`
      const installed = await chrome.pwa.install({ manifestId: args.manifestId, installUrl: args.origin, displayMode: 'standalone' });
      const appPage = await chrome.pwa.launch({ manifestId: args.manifestId });
      return { installed, title: await appPage.title() };
    `);
      expect(standalone.structuredContent).toMatchObject({
        ok: true,
        value: { installed: { displayMode: "standalone" }, title: "Synthetic App" },
      });
    } catch (error: unknown) {
      operationError = error;
    }

    const cleanup = await Promise.allSettled([service.closeConnection(context)]);
    cleanup.push(...(await Promise.allSettled([service.close(), fixture.stop(true)])));
    if (priorDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = priorDataHome;
    }

    const errors = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (operationError !== undefined) {
      errors.unshift(operationError);
    }

    if (errors.length === 0) return;

    const brokerLog = await readFile(brokerPaths.logPath, "utf8");
    throw new AggregateError(
      [...errors, new Error(brokerLog.slice(-4000))],
      "Live PWA operation or cleanup failed",
    );
  },
  90_000,
);

liveTest(
  "reports live console stacks and soft-navigation insight metadata for a SPA interaction",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-soft-navigation-"));
    roots.push(root);
    const fixture = createLiveNavigationFixture();
    const service = await createChromeService({
      artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
      executablePath: await resolveChromeExecutable(),
      workspacePath: root,
    });
    const context = createLiveToolContext(root);
    const browser = { browser: "isolated-headless", browserInstanceId: "spa" } as const;

    try {
      await service.handlers.performanceStartTrace({ ...browser, reload: false, autoStop: false }, context);
      const navigation = await service.handlers.runPlaywright(
        {
          ...browser,
          args: { origin: fixture.url.origin },
          timeoutMs: 30_000,
          code: `
      await page.goto(args.origin);
      const cursor = await chrome.events.mark();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('heading', { name: 'Second route' }).waitFor();
      await page.locator('img').evaluate(image => image.decode());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return await chrome.events.read({ after: cursor, types: ['console'], includeStackTraces: true });
    `,
        },
        context,
      );
      expect(navigation.structuredContent).toMatchObject({
        ok: true,
        value: {
          events: [{ type: "console", stackTrace: { frames: [{ asyncDepth: 0, functionName: "onclick" }] } }],
        },
      });
      const trace = await service.handlers.performanceStopTrace(
        { ...browser, filePath: join(root, "spa.json") },
        context,
      );
      if (!isRecord(trace.structuredContent) || !Array.isArray(trace.structuredContent.traceInsights)) {
        throw new Error(`Live SPA trace did not expose insights: ${JSON.stringify(trace.structuredContent)}`);
      }

      const traceSummary = trace.structuredContent.traceSummary;
      if (typeof traceSummary !== "string") {
        throw new TypeError("Live SPA trace did not expose a timing summary");
      }

      expect(traceSummary).toContain("Synchronous timing coverage (raw trace)");
      expect(traceSummary).toContain("DevTools-handler task wall time");
      expect(trace.content).toContainEqual(
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Synchronous timing coverage (raw trace)"),
        }),
      );

      const soft = trace.structuredContent.traceInsights.find(
        (value: unknown) => isRecord(value) && value.navigationKind === "soft",
      );
      expect(soft).toMatchObject({
        navigationKind: "soft",
        url: `${fixture.url.origin}/second`,
        bounds: { startMicroseconds: expect.any(Number), endMicroseconds: expect.any(Number) },
      });
      if (!isRecord(soft) || typeof soft.insightSetId !== "string" || typeof soft.insightName !== "string") {
        throw new Error("Live SPA trace did not provide an addressable soft-navigation insight");
      }

      const insight = await service.handlers.performanceAnalyzeInsight(
        { ...browser, insightSetId: soft.insightSetId, insightName: soft.insightName },
        context,
      );
      expect(insight.isError).not.toBe(true);
    } finally {
      await service.closeConnection(context);
      await service.close();
      await fixture.stop(true);
    }
  },
  90_000,
);

liveTest(
  "reuses each named isolated-headless browser independently",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-named-headless-"));
    roots.push(root);
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    const context = createLiveToolContext(root);
    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });
      try {
        const first = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated-headless",
            browserInstanceId: "first",
            code: `
          await page.setContent("<title>first-instance</title>");
          chrome.setSessionStateValue("instance", "first");
          const missing = chrome.getSessionStateValue("unset");
          return { instance: chrome.getSessionStateValue("instance"), title: await page.title(), missing, items: [missing] };
        `,
            timeoutMs: 10_000,
          },
          context,
        );
        expect(first.structuredContent).toMatchObject({
          ok: true,
        });
        if (!isRecord(first.structuredContent)) throw new Error("Live worker returned no structured result");
        expect(first.structuredContent.value).toStrictEqual({
          instance: "first",
          title: "first-instance",
          items: [null],
        });

        const second = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated-headless",
            browserInstanceId: "second",
            code: `
          const priorInstance = chrome.getSessionStateValue("instance");
          chrome.setSessionStateValue("instance", "second");
          return { priorInstance: priorInstance ?? null, title: await page.title() };
        `,
            timeoutMs: 10_000,
          },
          context,
        );
        expect(second.structuredContent).toMatchObject({
          ok: true,
          value: { priorInstance: null, title: "" },
        });

        const reused = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated-headless",
            browserInstanceId: "first",
            code: `
          const { captures, cdp } = chrome.capabilities;
          return { instance: chrome.getSessionStateValue('instance'), title: await page.title(), cdp, networkBodies: captures["network-bodies"].supported };
        `,
            timeoutMs: 10_000,
          },
          context,
        );
        expect(reused.structuredContent).toMatchObject({
          ok: true,
          value: {
            cdp: Object.fromEntries(CHROME_CAPABILITY_CDP_METHODS.map((method) => [method, true])),
            instance: "first",
            networkBodies: true,
            title: "first-instance",
          },
        });
      } finally {
        await service.closeConnection(context);
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      if (priorRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
    }
  },
  120_000,
);

liveTest(
  "evaluates a dedicated worker across calls without reloading its page",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-worker-evaluation-"));
    roots.push(root);
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    const context = createLiveToolContext(root);

    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });
      try {
        const server = createChromeMcpServer(service);
        const client = new Client({ name: "chrome-worker-evaluation-client", version: "1.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const [session] = await Promise.all([
          server.connect(serverTransport, context.session),
          client.connect(clientTransport),
        ]);
        const run = (code: string, args = {}) =>
          client.callTool({
            name: "run_playwright",
            arguments: {
              args,
              browser: "isolated-headless",
              browserInstanceId: "worker",
              code,
              timeoutMs: 10_000,
            },
          });

        try {
          const created = await run(`
          await page.goto('data:text/html,<title>worker-fixture</title>');
          await page.evaluate(async () => {
            globalThis.workerUrl = URL.createObjectURL(new Blob([
              "self.count = 0; self.onmessage = () => postMessage(++self.count); postMessage('ready');"
            ], { type: 'text/javascript' }));
            globalThis.testWorker = new Worker(globalThis.workerUrl);
            await new Promise(resolve => globalThis.testWorker.addEventListener('message', resolve, { once: true }));
          });
          const cdp = await browser.newBrowserCDPSession();

          try {
            const { targetInfos } = await cdp.send('Target.getTargets');
            const target = targetInfos.find(candidate => candidate.type === 'worker');
            if (!target) throw new Error('Synthetic worker target missing');
            chrome.setSessionStateValue('workerTargetId', target.targetId);
            return { targetId: target.targetId, title: await page.title() };
          } finally {
            await cdp.detach();
          }
        `);
          expect(created.structuredContent).toMatchObject({
            ok: true,
            selectedTargetId: expect.any(String),
            value: { targetId: expect.any(String), title: "worker-fixture" },
          });
          const evaluated = await run(`
          const targetId = chrome.getSessionStateValue('workerTargetId');
          const [value, title] = await Promise.all([
            chrome.evaluateWorker({ targetId, expression: 'Promise.resolve({ count: ++self.count, items: [undefined, true], missing: undefined })' }),
            page.title()
          ]);
          const ping = await page.evaluate(() => new Promise(resolve => {
            globalThis.testWorker.addEventListener('message', event => resolve(event.data), { once: true });
            globalThis.testWorker.postMessage('ping');
          }));
          return { targetId, value, title, ping };
        `);
          if (!isRecord(created.structuredContent) || !isRecord(created.structuredContent.value)) {
            throw new Error("Live fixture did not return its target");
          }
          expect(evaluated.structuredContent).toMatchObject({
            ok: true,
            selectedTargetId: created.structuredContent.selectedTargetId,
            value: {
              targetId: created.structuredContent.value.targetId,
              value: { count: 1, items: [null, true] },
              title: "worker-fixture",
              ping: 2,
            },
          });

          for (const expression of [
            "(() => { throw new Error('worker exception'); })()",
            "Promise.reject(new Error('worker exception'))",
          ]) {
            const failed = await run(
              `return chrome.evaluateWorker({ targetId: chrome.getSessionStateValue('workerTargetId'), expression: args.expression });`,
              { expression },
            );
            expect(failed.structuredContent).toMatchObject({
              ok: false,
              error: {
                code: "CHROME_MCP_EXECUTION_FAILED",
                message: expect.stringContaining("worker exception"),
              },
            });
          }

          for (const expression of [
            "({ value: NaN })",
            "({ value: 1n })",
            "(() => { const value = {}; value.self = value; return value; })()",
            "new (class Sample { constructor() { this.count = 3; } })()",
            "(() => { self.didReadGetter = false; return { get count() { self.didReadGetter = true; return 4; } }; })()",
            "({ count: 5, [Symbol('hidden')]: 6 })",
          ]) {
            const failed = await run(
              `return chrome.evaluateWorker({ targetId: chrome.getSessionStateValue('workerTargetId'), expression: args.expression });`,
              { expression },
            );
            expect(failed.structuredContent).toMatchObject({
              ok: false,
              error: { code: "CHROME_MCP_INVALID_INPUT" },
            });
          }

          const getterState = await run(
            `return chrome.evaluateWorker({ targetId: chrome.getSessionStateValue('workerTargetId'), expression: 'self.didReadGetter' });`,
          );
          expect(getterState.structuredContent).toMatchObject({ ok: true, value: false });

          const nullPrototype = await run(
            `return chrome.evaluateWorker({ targetId: chrome.getSessionStateValue('workerTargetId'), expression: 'Object.assign(Object.create(null), { count: 7 })' });`,
          );
          expect(nullPrototype.structuredContent).toMatchObject({ ok: true, value: { count: 7 } });

          const prototypeKey = await run(
            `return chrome.evaluateWorker({ targetId: chrome.getSessionStateValue('workerTargetId'), expression: args.expression });`,
            { expression: `JSON.parse('{"__proto__":{"count":3}}')` },
          );
          expect(prototypeKey.structuredContent).toMatchObject({
            ok: true,
            value: { ["__proto__"]: { count: 3 } },
          });

          const repeated = await run(`
          const value = await chrome.evaluateWorker({
            targetId: chrome.getSessionStateValue('workerTargetId'),
            expression: '(() => { const shared = { value: 3, zero: -0 }; return [shared, shared]; })()'
          });
          return { value, isNegativeZero: Object.is(value[0].zero, -0) };
        `);
          expect(repeated.structuredContent).toMatchObject({
            ok: true,
            value: {
              value: [
                { value: 3, zero: 0 },
                { value: 3, zero: 0 },
              ],
              isNegativeZero: true,
            },
          });
          const undefinedValue = await run(
            `return chrome.evaluateWorker({ targetId: chrome.getSessionStateValue('workerTargetId'), expression: 'undefined' });`,
          );
          expect(undefinedValue.structuredContent).toMatchObject({ ok: true });
          expect(
            isRecord(undefinedValue.structuredContent) &&
              Object.hasOwn(undefinedValue.structuredContent, "value"),
          ).toBe(false);
          const wrongTarget = await run(`
          const cdp = await context.newCDPSession(page);

          try {
            const { targetInfo } = await cdp.send('Target.getTargetInfo');
            return await chrome.evaluateWorker({ targetId: targetInfo.targetId, expression: '1' });
          } finally {
            await cdp.detach();
          }
        `);
          expect(wrongTarget.structuredContent).toMatchObject({
            ok: false,
            error: { code: "CHROME_MCP_INVALID_INPUT" },
          });
          const stale = await run(
            `return chrome.evaluateWorker({ targetId: 'missing-worker-target', expression: '1' });`,
          );
          expect(stale.structuredContent).toMatchObject({
            ok: false,
            error: { code: "CHROME_MCP_EXECUTION_FAILED" },
          });
          const cleaned = await run(`
          await page.evaluate(() => {
            globalThis.testWorker.terminate();
            URL.revokeObjectURL(globalThis.workerUrl);
            delete globalThis.testWorker;
            delete globalThis.workerUrl;
          });
          return await page.title();
        `);
          expect(cleaned.structuredContent).toMatchObject({ ok: true, value: "worker-fixture" });
        } finally {
          await client.close();
          await session.close();
        }
      } finally {
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = priorDataHome;
      }

      if (priorRuntimeDirectory === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
      }
    }
  },
  90_000,
);

liveTest(
  "rejects a pending worker script without evaluation and accepts the same worker once ready",
  async () => {
    const executablePath = await resolveChromeExecutable();

    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-worker-startup-"));
    roots.push(root);

    const scriptResponse = Promise.withResolvers<Response>();
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/worker.js") return scriptResponse.promise;

        return new Response("<!doctype html><title>worker-startup</title>", {
          headers: { "Content-Type": "text/html" },
        });
      },
    });

    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");

    const context = createLiveToolContext(root);

    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });

      try {
        const server = createChromeMcpServer(service);
        const client = new Client({ name: "chrome-worker-startup-client", version: "1.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const [session] = await Promise.all([
          server.connect(serverTransport, context.session),
          client.connect(clientTransport),
        ]);

        const run = (code: string, timeoutMs = 10_000) =>
          client.callTool({
            name: "run_playwright",
            arguments: {
              args: { origin: fixture.url.origin },
              browser: "isolated-headless",
              browserInstanceId: "startup",
              code,
              timeoutMs,
            },
          });

        try {
          const created = await run(`
          await page.goto(args.origin);
          const cdp = await browser.newBrowserCDPSession();

          try {
            await cdp.send('Target.setDiscoverTargets', { discover: true });
            const workerTarget = new Promise(resolve => cdp.on('Target.targetCreated', ({ targetInfo }) => {
              if (targetInfo.type === 'worker') {
                resolve(targetInfo);
              }
            }));

            await page.evaluate(() => {
              globalThis.workerReady = new Promise(resolve => {
                globalThis.testWorker = new Worker('/worker.js', { type: 'module' });
                globalThis.testWorker.onmessage = resolve;
              });
            });
            const target = await workerTarget;
            chrome.setSessionStateValue('workerTargetId', target.targetId);
            return { targetId: target.targetId, url: target.url };
          } finally {
            await cdp.detach();
          }
        `);
          assert(isRecord(created.structuredContent) && isRecord(created.structuredContent.value));
          const targetId = created.structuredContent.value.targetId;
          assert(typeof targetId === "string");
          expect(created.structuredContent).toMatchObject({ ok: true, value: { targetId, url: "" } });

          const rejected = await run(
            `return chrome.evaluateWorker({ targetId: chrome.getSessionStateValue('workerTargetId'), expression: 'self.didEvaluateBeforeReady = true' });`,
            3000,
          );
          expect(rejected.structuredContent).toMatchObject({
            ok: false,
            selectedTargetId: created.structuredContent.selectedTargetId,
            error: {
              code: "CHROME_MCP_EXECUTION_FAILED",
              message: expect.stringContaining(`Worker target "${targetId}" has an empty URL`),
            },
          });
          expect(JSON.stringify(rejected)).not.toContain("cleanup could not be confirmed");

          scriptResponse.resolve(
            new Response("self.count = 7; postMessage('ready');", {
              headers: { "Content-Type": "text/javascript" },
            }),
          );

          const evaluated = await run(`
          await page.evaluate(() => globalThis.workerReady.then(() => undefined));
          const targetId = chrome.getSessionStateValue('workerTargetId');
          const value = await chrome.evaluateWorker({ targetId, expression: '({ count: self.count, didEvaluateBeforeReady: self.didEvaluateBeforeReady === true })' });
          return { targetId, value, title: await page.title() };
        `);
          expect(evaluated.structuredContent).toMatchObject({
            ok: true,
            selectedTargetId: created.structuredContent.selectedTargetId,
            value: { targetId, value: { count: 7, didEvaluateBeforeReady: false }, title: "worker-startup" },
          });
        } finally {
          await client.close();
          await session.close();
        }
      } finally {
        await service.close();
      }
    } finally {
      scriptResponse.resolve(new Response("", { status: 410 }));
      await fixture.stop(true);

      if (priorDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = priorDataHome;
      }

      if (priorRuntimeDirectory === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
      }
    }
  },
  45_000,
);

liveTest(
  "cleans up worker evaluation after timeout, cancellation, and execution-worker crash",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-worker-evaluation-cleanup-"));
    roots.push(root);
    let cancellation = new AbortController();
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        cancellation.abort();
        return new Response("cancelled");
      },
    });
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    const context = createLiveToolContext(root);

    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        executionKernel: (options) =>
          runExecutionWorker({
            ...options,
            signal: AbortSignal.any([cancellation.signal, ...(options.signal ? [options.signal] : [])]),
          }),
        workspacePath: root,
      });
      const run = (code: string, timeoutMs = 10_000) =>
        service.handlers.runPlaywright(
          {
            args: { origin: fixture.url.origin },
            browser: "isolated-headless",
            browserInstanceId: "cleanup",
            code,
            timeoutMs,
          },
          context,
        );

      try {
        const created = await run(`
        await page.goto('data:text/html,<title>worker-cleanup</title>');
        await page.evaluate(async () => {
          globalThis.workerUrl = URL.createObjectURL(new Blob(["self.count = 5; postMessage('ready');"], { type: 'text/javascript' }));
          globalThis.testWorker = new Worker(globalThis.workerUrl);
          await new Promise(resolve => globalThis.testWorker.addEventListener('message', resolve, { once: true }));
        });
        const cdp = await browser.newBrowserCDPSession();
        try {
          const { targetInfos } = await cdp.send('Target.getTargets');
          const target = targetInfos.find(candidate => candidate.type === 'worker');
          if (!target) throw new Error('Synthetic worker target missing');
          chrome.setSessionStateValue('workerTargetId', target.targetId);
          return target.targetId;
        } finally {
          await cdp.detach();
        }
      `);
        expect(created.structuredContent).toMatchObject({ ok: true });

        for (const ending of [
          { code: "await new Promise(() => {});", timeoutMs: 2000, errorCode: "CHROME_MCP_TIMEOUT" },
          {
            code: "await fetch(args.origin); await new Promise(() => {});",
            timeoutMs: 10_000,
            errorCode: "CHROME_MCP_CANCELLED",
          },
          { code: "process.exit(23);", timeoutMs: 10_000, errorCode: "CHROME_MCP_WORKER_CRASH" },
        ]) {
          cancellation = new AbortController();
          const failed = await run(
            `
          await page.evaluate(() => {
            globalThis.workerStarted = new Promise(resolve => {
              globalThis.testWorker.addEventListener('message', event => {
                if (event.data === 'evaluating') resolve();
              }, { once: true });
            });
          });
          const started = page.evaluate(() => globalThis.workerStarted);
          const pending = chrome.evaluateWorker({
            targetId: chrome.getSessionStateValue('workerTargetId'),
            expression: "self.postMessage('evaluating'); while (true) {}"
          });
          pending.catch(() => undefined);
          await started;
          ${ending.code}
        `,
            ending.timeoutMs,
          );
          expect(failed.structuredContent).toMatchObject({ ok: false, error: { code: ending.errorCode } });
          cancellation = new AbortController();
          const recovered = await run(`
          return {
            count: await chrome.evaluateWorker({ targetId: chrome.getSessionStateValue('workerTargetId'), expression: 'self.count' }),
            title: await page.title()
          };
        `);
          expect(recovered.structuredContent).toMatchObject({
            ok: true,
            value: { count: 5, title: "worker-cleanup" },
          });
        }
      } finally {
        await service.closeConnection(context);
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = priorDataHome;
      }

      if (priorRuntimeDirectory === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
      }

      await fixture.stop(true);
    }
  },
  90_000,
);

liveTest(
  "reuses the same browser and pages after a worker times out during page execution",
  async () => {
    const executablePath = await resolveChromeExecutable();

    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-execution-timeout-"));
    roots.push(root);

    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");

    const context = createLiveToolContext(root);
    const service = await createChromeService({
      artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
      executablePath,
      workspacePath: root,
    });

    const run = (code: string, timeoutMs = 10_000) =>
      service.handlers.runPlaywright(
        {
          args: {},
          browser: "isolated-headless",
          browserInstanceId: "timeout",
          code,
          timeoutMs,
        },
        context,
      );

    try {
      const initial = await run(`
      await page.setContent('<title>selected</title>');
      const extra = await context.newPage();
      await extra.setContent('<title>evaluated</title>');
      await chrome.selectPageForSession(page);
      return true;
    `);
      if (!isRecord(initial.structuredContent)) {
        throw new Error("Expected initial Chrome result");
      }
      expect(initial.structuredContent).toMatchObject({ ok: true });

      const timedOut = await run(
        `
      const extra = context.pages().find(candidate => candidate !== page);
      return await extra.evaluate(() => {
        document.body.dataset.started = 'yes';
        const end = performance.now() + 30_000;
        while (performance.now() < end) {}
        document.body.dataset.finished = 'yes';
      });
    `,
        2000,
      );
      expect(timedOut.structuredContent).toMatchObject({ ok: false, error: { code: "CHROME_MCP_TIMEOUT" } });

      const recovered = await run(`
      const extra = context.pages().find(candidate => candidate !== page);
      return {
        selected: await page.title(),
        evaluated: await extra.title(),
        markers: await extra.evaluate(() => ({ ...document.body.dataset })),
      };
    `);
      if (!isRecord(recovered.structuredContent)) {
        throw new Error("Expected recovered Chrome result");
      }
      expect(recovered.structuredContent).toMatchObject({
        ok: true,
        selectedTargetId: initial.structuredContent.selectedTargetId,
        value: { selected: "selected", evaluated: "evaluated", markers: { started: "yes" } },
      });
      expect(recovered.structuredContent.value).toEqual({
        selected: "selected",
        evaluated: "evaluated",
        markers: { started: "yes" },
      });

      for (const code of [
        "await new Promise(() => {});",
        "await page.evaluate(() => new Promise(() => {}));",
      ]) {
        const pendingTimeout = await run(code, 2000);
        expect(pendingTimeout.structuredContent).toMatchObject({
          ok: false,
          error: { code: "CHROME_MCP_TIMEOUT" },
        });
        const pendingRecovery = await run("return await page.evaluate(() => document.title);");
        expect(pendingRecovery.structuredContent).toMatchObject({
          ok: true,
          selectedTargetId: initial.structuredContent.selectedTargetId,
          value: "selected",
        });
      }
    } finally {
      await service.close();

      if (priorDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = priorDataHome;
      }

      if (priorRuntimeDirectory === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
      }
    }
  },
  60_000,
);

liveTest(
  "aborts unresolved native routes on every worker exit without sending their mutations",
  async () => {
    const executablePath = await resolveChromeExecutable();

    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-native-routes-"));
    roots.push(root);
    const received: string[] = [];
    let cancellation = new AbortController();
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/cancel") {
          cancellation.abort();
          return new Response("cancelled");
        }

        if (request.method === "POST") {
          received.push(path);
          return new Response("sent");
        }

        return new Response(
          `<!doctype html><button onclick="fetch('/mutate${path}', { method: 'POST' }).then(() => document.body.dataset.state = 'sent', () => document.body.dataset.state = 'blocked')">Send</button>${path === "/main" ? '<iframe src="/frame"></iframe>' : ""}`,
          {
            headers: { "content-type": "text/html" },
          },
        );
      },
    });
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    const context = createLiveToolContext(root);

    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        executionKernel: (options) =>
          runExecutionWorker({
            ...options,
            signal: AbortSignal.any([cancellation.signal, ...(options.signal ? [options.signal] : [])]),
          }),
        workspacePath: root,
      });
      const run = (code: string, args: Record<string, string> = {}, timeoutMs = 10_000) =>
        service.handlers.runPlaywright(
          {
            args: { ...args, origin: fixture.url.origin },
            browser: "isolated-headless",
            browserInstanceId: "routes",
            code,
            timeoutMs,
          },
          context,
        );

      try {
        for (const routeOwner of ["page", "context"]) {
          for (const ending of [
            { code: "return pausedCount;", timeoutMs: 10_000, expected: { ok: true, value: 3 } },
            {
              code: "throw new Error('fixture error after interception');",
              timeoutMs: 10_000,
              expected: { ok: false, error: { code: "CHROME_MCP_EXECUTION_FAILED" } },
            },
            {
              code: "await new Promise(() => {});",
              timeoutMs: 2000,
              expected: { ok: false, error: { code: "CHROME_MCP_TIMEOUT" } },
            },
            {
              code: "await page.evaluate(() => { const end = performance.now() + 30_000; while (performance.now() < end) {} });",
              timeoutMs: 2000,
              expected: { ok: false, error: { code: "CHROME_MCP_TIMEOUT" } },
            },
            {
              code: "await fetch(args.origin + '/cancel'); await new Promise(() => {});",
              timeoutMs: 10_000,
              expected: { ok: false, error: { code: "CHROME_MCP_CANCELLED" } },
            },
            {
              code: "process.exit(23);",
              timeoutMs: 10_000,
              expected: { ok: false, error: { code: "CHROME_MCP_WORKER_CRASH" } },
            },
          ]) {
            cancellation = new AbortController();
            const result = await run(
              `
            await page.goto(args.origin + '/main');
            const extra = context.pages().find(candidate => candidate !== page) ?? await context.newPage();
            await extra.goto(args.origin + '/extra');
            const paused = Promise.withResolvers();
            let pausedCount = 0;
            const hold = () => {
              pausedCount += 1;
              if (pausedCount === 3) {
                paused.resolve();
              }
            };
            if (args.routeOwner === 'context') {
              await context.route('**/mutate/**', hold);
            } else {
              await page.route('**/mutate/**', hold);
              await extra.route('**/mutate/**', hold);
            }
            await page.getByRole('button').click();
            await page.frameLocator('iframe').getByRole('button').click();
            await extra.getByRole('button').click();
            await paused.promise;
            ${ending.code}
          `,
              { routeOwner },
              ending.timeoutMs,
            );
            expect(result.structuredContent).toMatchObject(ending.expected);

            cancellation = new AbortController();
            const recovered = await run(`
            const frames = context.pages().flatMap(candidate => candidate.frames());
            for (const frame of frames) {
              await frame.waitForFunction(() => document.body.dataset.state === 'blocked');
            }
            return { states: await Promise.all(frames.map(frame => frame.evaluate(() => document.body.dataset.state))) };
          `);
            expect(recovered.structuredContent).toMatchObject({
              ok: true,
              value: { states: ["blocked", "blocked", "blocked"] },
            });
            expect(received).toEqual([]);
          }
        }

        const explicit = await run(`
        await page.goto(args.origin + '/main');
        await page.route('**/mutate/main', route => route.continue());
        await page.getByRole('button').click();
        await page.waitForFunction(() => document.body.dataset.state === 'sent');
        await chrome.routes.add({ urlPattern: args.origin + '/mutate/main', action: { type: 'abort' } });
        return true;
      `);
        expect(explicit.structuredContent).toMatchObject({ ok: true });
        expect(received).toEqual(["/mutate/main"]);
        const persistent = await run(`
        await page.goto(args.origin + '/main');
        await page.route('**/unrelated', route => route.abort());
        await page.getByRole('button').click();
        await page.waitForFunction(() => document.body.dataset.state === 'blocked');
        await chrome.routes.clear();
        return true;
      `);
        expect(persistent.structuredContent).toMatchObject({ ok: true });
        expect(received).toEqual(["/mutate/main"]);
      } finally {
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = priorDataHome;
      }

      if (priorRuntimeDirectory === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
      }

      await fixture.stop(true);
    }
  },
  90_000,
);

liveTest(
  "returns bounded snapshot previews with complete readable data and valid omitted refs",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-bounded-snapshot-"));
    roots.push(root);
    const fixture = join(root, "oversized.html");
    await writeFile(
      fixture,
      `<!doctype html><main>${Array.from(
        { length: 400 },
        (_, index) =>
          `<button id="action-${index}" onclick="document.body.dataset.clicked='${index}'">Action ${index}</button>`,
      ).join("")}</main>`,
    );
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({
          root: join(root, "artifacts"),
          limits: { directContentBytes: 16 * 1024, chunkBytes: 32 * 1024 },
        }),
        executablePath,
        workspacePath: root,
      });
      try {
        const server = createChromeMcpServer(service);
        const client = new Client({ name: "chrome-bounded-snapshot-client", version: "1.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const [session] = await Promise.all([
          server.connect(serverTransport, createLiveToolContext(root).session),
          client.connect(clientTransport),
        ]);
        try {
          const result = await client.callTool({
            name: "run_playwright",
            arguments: {
              browserInstanceId: "bounded-snapshot",
              args: { url: pathToFileURL(fixture).href },
              timeoutMs: 60_000,
              code: `
            await page.goto(args.url);
            const preview = await chrome.captureAccessibilitySnapshot();
            const first = Object.entries(preview.refs).find(([, node]) => node.role === 'button');
            if (!first) throw new Error('Bounded preview has no button ref');
            await (await chrome.resolveSnapshotRefToLocator(first[0])).click();
            const firstClicked = await page.locator('body').getAttribute('data-clicked');
            const full = await chrome.captureAccessibilitySnapshot({ view: 'full' });
            const last = Object.entries(full.refs).find(([, node]) => node.name === 'Action 399');
            if (!last) throw new Error('Full view has no last button');
            await (await chrome.resolveSnapshotRefToLocator(last[0])).click();
            return { preview, firstClicked, lastClicked: await page.locator('body').getAttribute('data-clicked'), fullRefCount: Object.keys(full.refs).length };
          `,
            },
          });
          expect(result.isError).not.toBeTrue();
          if (!isRecord(result.structuredContent) || !isRecord(result.structuredContent.value)) {
            throw new Error("Snapshot result is missing");
          }
          const value = result.structuredContent.value;
          const preview = value.preview;
          if (
            !isRecord(preview) ||
            !isRecord(preview.refs) ||
            !isRecord(preview.omitted) ||
            !isRecord(preview.dataArtifact) ||
            typeof preview.dataArtifact.uri !== "string"
          ) {
            throw new Error("Snapshot preview is missing");
          }
          expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(16 * 1024);
          expect(preview.omissionReason).toBe("maxBytes");
          expect(preview.omitted.refs).toBeGreaterThan(0);
          expect(value).toMatchObject({ firstClicked: "0", lastClicked: "399" });
          expect(value.fullRefCount).toBeGreaterThanOrEqual(400);
          expect(result.structuredContent).not.toHaveProperty("valueArtifact");
          expect(result.structuredContent.artifacts).toHaveLength(3);
          const read = await client.readResource({ uri: preview.dataArtifact.uri });
          const resource = read.contents[0];
          if (!resource || !("text" in resource)) throw new Error("Snapshot manifest is missing");
          const manifest: unknown = JSON.parse(resource.text);
          if (!isRecord(manifest) || !Array.isArray(manifest.chunks)) {
            throw new Error("Snapshot chunks are missing");
          }
          const chunks: Buffer[] = [];
          for (const chunk of manifest.chunks) {
            if (!isRecord(chunk) || typeof chunk.uri !== "string") {
              throw new Error("Snapshot chunk URI is missing");
            }
            const part = await client.readResource({ uri: chunk.uri });
            const content = part.contents[0];
            if (!content || !("blob" in content)) throw new Error("Snapshot chunk is missing");
            const bytes = Buffer.from(content.blob, "base64");
            expect(chunk.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
            chunks.push(bytes);
          }
          const bytes = Buffer.concat(chunks);
          expect(preview.dataArtifact.size).toBe(bytes.byteLength);
          expect(preview.dataArtifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
          const complete: unknown = JSON.parse(bytes.toString("utf8"));
          if (!isRecord(complete) || !isRecord(complete.refs)) throw new Error("Complete refs are missing");
          expect(complete.snapshotId).toBe(preview.snapshotId);
          const omitted = Object.entries(complete.refs).find(
            ([, node]) => isRecord(node) && node.name === "Action 399",
          );
          if (!omitted) throw new Error("Complete artifact has no final ref");
          expect(preview.refs[omitted[0]]).toBeUndefined();
          const used = await client.callTool({
            name: "run_playwright",
            arguments: {
              browserInstanceId: "bounded-snapshot",
              args: { ref: omitted[0] },
              timeoutMs: 10_000,
              code: "const locator = await chrome.resolveSnapshotRefToLocator(args.ref); return await locator.textContent();",
            },
          });
          expect(used.structuredContent).toMatchObject({ ok: true, value: "Action 399" });
        } finally {
          await client.close();
          await session.close();
        }
      } finally {
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      if (priorRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
    }
  },
  120_000,
);

liveTest(
  "compares DOM identity without exposing comparison data or weakening action refs",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-comparison-"));
    roots.push(root);
    const fixture = join(root, "comparison.html");
    await writeFile(
      fixture,
      `<!doctype html><main>
    <button id="save">Save</button><button id="replace">Replace</button><button id="gone">Gone</button>
    <iframe srcdoc="<button>Frame action</button>"></iframe><div id="shadow"></div>
    <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>';</script>
  </main>`,
    );
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });
      try {
        const server = createChromeMcpServer(service);
        const client = new Client({ name: "chrome-comparison-client", version: "1.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const [session] = await Promise.all([
          server.connect(serverTransport, createLiveToolContext(root).session),
          client.connect(clientTransport),
        ]);
        try {
          const result = await client.callTool({
            name: "run_playwright",
            arguments: {
              args: { url: pathToFileURL(fixture).href },
              browserInstanceId: "comparison",
              timeoutMs: 60_000,
              code: `
              await page.goto(args.url);
              await page.frameLocator('iframe').getByRole('button').waitFor();
              const options = { depth: 20, maxBytes: 80000, view: 'full' };
              const counts = value => ({ added: value.added.length, removed: value.removed.length, changed: value.changed.length });
              const refNamed = (snapshot, name) => {
                const entry = Object.entries(snapshot.refs).find(([, value]) => value.name === name);
                if (!entry) throw new Error('Missing snapshot ref: ' + name);
                return entry[0];
              };
              const [checkpoint, first] = await Promise.all([
                chrome.checkpoint.create(),
                chrome.captureAccessibilitySnapshot(options),
              ]);
              const unchanged = await chrome.captureAccessibilitySnapshot({ ...options, diffFrom: first.snapshotId });
              const unchangedCheckpoint = await chrome.checkpoint.diff(checkpoint.checkpointId, { events: false });
              const firstSave = refNamed(first, 'Save');
              const freshRefs = firstSave !== refNamed(unchanged, 'Save');
              const framePresent = Boolean(refNamed(first, 'Frame action'));
              const shadowPresent = Boolean(refNamed(first, 'Shadow action'));
              await page.locator('#save').evaluate(node => {
                node.textContent = 'Saved';
                node.setAttribute('role', 'switch');
                node.setAttribute('aria-checked', 'true');
              });
              const retained = await chrome.resolveSnapshotRefToLocator(firstSave);
              const retainedName = await retained.textContent();
              const edited = await chrome.captureAccessibilitySnapshot({ ...options, diffFrom: first.snapshotId });
              const editedCheckpoint = await chrome.checkpoint.diff(checkpoint.checkpointId, { events: false });
              const editedRef = refNamed(edited, 'Saved');
              const editedRefInChange = edited.changed.some(line => line.includes(editedRef));
              const checkpointRef = editedCheckpoint.report.snapshot.changed[0].ref;
              const checkpointLocator = await chrome.resolveSnapshotRefToLocator(checkpointRef);
              const checkpointRefName = await checkpointLocator.textContent();
              const replacementBase = await chrome.captureAccessibilitySnapshot(options);
              const firstReplace = refNamed(replacementBase, 'Replace');
              await page.locator('#replace').evaluate(node => node.replaceWith(node.cloneNode(true)));
              await page.locator('#gone').evaluate(node => node.remove());
              await page.locator('main').evaluate(node => {
                const added = document.createElement('button');
                added.textContent = 'Added';
                node.append(added);
              });
              const replaced = await chrome.captureAccessibilitySnapshot({ ...options, diffFrom: replacementBase.snapshotId });
              let replacementError;
              try { await chrome.resolveSnapshotRefToLocator(firstReplace); }
              catch (error) {
                if (error.code !== 'CHROME_MCP_STALE_REF') throw error;
                replacementError = error.code;
              }
              const retainedCheckpoint = await chrome.checkpoint.create();
              for (let index = 0; index < 10; index += 1) await chrome.captureAccessibilitySnapshot(options);
              const afterEviction = await chrome.checkpoint.diff(retainedCheckpoint.checkpointId, { events: false });
              const beforeHash = await chrome.captureAccessibilitySnapshot(options);
              await page.evaluate(() => { location.hash = 'same-document'; });
              await page.waitForURL('**#same-document');
              const sameDocument = await chrome.captureAccessibilitySnapshot({ ...options, diffFrom: beforeHash.snapshotId });
              await page.locator('#save').evaluate(node => node.setAttribute('aria-label', 'Show [ref=alpha]'));
              const literalBase = await chrome.captureAccessibilitySnapshot(options);
              const literalCheckpoint = await chrome.checkpoint.create();
              await page.locator('#save').evaluate(node => node.setAttribute('aria-label', 'Show [ref=beta]'));
              const literalEdit = await chrome.captureAccessibilitySnapshot({ ...options, diffFrom: literalBase.snapshotId });
              const literalCheckpointEdit = await chrome.checkpoint.diff(literalCheckpoint.checkpointId, { events: false });
              await page.locator('#save').evaluate(node => node.removeAttribute('aria-label'));
              const beforeNavigation = await chrome.captureAccessibilitySnapshot(options);
              const navigationRef = refNamed(beforeNavigation, 'Saved');
              await page.goto(args.url);
              await page.frameLocator('iframe').getByRole('button').waitFor();
              const navigated = await chrome.captureAccessibilitySnapshot({ ...options, diffFrom: beforeNavigation.snapshotId });
              let navigationError;
              try { await chrome.resolveSnapshotRefToLocator(navigationRef); }
              catch (error) {
                if (error.code !== 'CHROME_MCP_STALE_REF') throw error;
                navigationError = error.code;
              }
              return {
                unchanged: counts(unchanged), unchangedCheckpoint: counts(unchangedCheckpoint.report.snapshot),
                edited: counts(edited), editedCheckpoint: counts(editedCheckpoint.report.snapshot),
                replaced: counts(replaced), afterEviction: counts(afterEviction.report.snapshot),
                sameDocument: counts(sameDocument), navigated: counts(navigated),
                literalEdit: counts(literalEdit), literalCheckpointEdit: counts(literalCheckpointEdit.report.snapshot),
                freshRefs, framePresent, shadowPresent, retainedName, editedRefInChange, checkpointRefName,
                replacementError, navigationError,
                checkpointArtifact: checkpoint.artifact.uri, diffArtifact: editedCheckpoint.artifact.uri,
              };
            `,
            },
          });
          expect(result.structuredContent).toMatchObject({
            ok: true,
            value: {
              unchanged: { added: 0, removed: 0, changed: 0 },
              unchangedCheckpoint: { added: 0, removed: 0, changed: 0 },
              edited: { added: 0, removed: 0, changed: 1 },
              editedCheckpoint: { added: 0, removed: 0, changed: 1 },
              replaced: { added: 2, removed: 2, changed: 0 },
              afterEviction: { added: 0, removed: 0, changed: 0 },
              sameDocument: { added: 0, removed: 0, changed: 0 },
              literalEdit: { added: 0, removed: 0, changed: 1 },
              literalCheckpointEdit: { added: 0, removed: 0, changed: 1 },
              navigated: { changed: 0 },
              freshRefs: true,
              framePresent: true,
              shadowPresent: true,
              retainedName: "Saved",
              editedRefInChange: true,
              checkpointRefName: "Saved",
              replacementError: "CHROME_MCP_STALE_REF",
              navigationError: "CHROME_MCP_STALE_REF",
            },
          });
          if (!isRecord(result.structuredContent) || !isRecord(result.structuredContent.value)) {
            throw new Error("Snapshot comparison result is missing");
          }
          const value = result.structuredContent.value;
          if (!isRecord(value.navigated)) throw new Error("Navigation comparison is missing");
          expect(value.navigated.added).toBeGreaterThan(0);
          expect(value.navigated.removed).toBeGreaterThan(0);
          for (const uri of [value.checkpointArtifact, value.diffArtifact]) {
            if (typeof uri !== "string") throw new Error("Checkpoint artifact URI is missing");
            const read = await client.readResource({ uri });
            const content = read.contents[0];
            if (!content || !("text" in content)) throw new Error("Checkpoint artifact content is missing");
            const artifact: unknown = JSON.parse(content.text);
            if (!isRecord(artifact) || !isRecord(artifact.snapshot)) {
              throw new Error("Checkpoint snapshot data is missing");
            }
            const expectedKeys =
              uri === value.checkpointArtifact ?
                ["lines", "snapshotId", "text"]
              : ["added", "changed", "removed"];
            expect(Object.keys(artifact.snapshot).sort()).toEqual(expectedKeys);
            expect(content.text).not.toContain("comparisonText");
            expect(content.text).not.toContain("byIdentity");
          }
        } finally {
          await client.close();
          await session.close();
        }
      } finally {
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      if (priorRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
    }
  },
  120_000,
);

liveTest(
  "returns target crash diagnostics through MCP while the browser remains connected",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-target-crash-"));
    roots.push(root);
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });
      try {
        const server = createChromeMcpServer(service);
        const client = new Client({ name: "chrome-crash-client", version: "1.0.0" }, { capabilities: {} });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const [session] = await Promise.all([
          server.connect(serverTransport, createLiveToolContext(root).session),
          client.connect(clientTransport),
        ]);
        try {
          const result = await client.callTool({
            name: "run_playwright",
            arguments: {
              browserInstanceId: "renderer-crash",
              timeoutMs: 10_000,
              code: `
              const control = await context.newPage();
              const browserCdp = await browser.newBrowserCDPSession();
              await browserCdp.send('Target.setDiscoverTargets', { discover: true });
              const crashEvent = new Promise(resolve => browserCdp.once('Target.targetCrashed', resolve));
              const failedWait = page.waitForFunction(() => false, undefined, { timeout: 5000 }).catch(error => error);
              await page.goto('chrome://crash', { timeout: 5000 }).catch(error => error);
              const [failure, crash] = await Promise.all([failedWait, crashEvent]);
              await chrome.emitTextResult(JSON.stringify({ control: await control.evaluate(() => 2 + 2), crash }));
              await browserCdp.detach();
              throw failure;
            `,
            },
          });

          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            ok: false,
            diagnostics: {
              browserConnection: "connected",
              chromeProduct: expect.stringContaining("Chrome/"),
              journal: { droppedBefore: null, ownerReset: false },
              targetCrash: {
                ownerGeneration: 1,
                status: { preview: "crashed", previewTruncated: false },
                type: "target_crashed",
              },
            },
            error: {
              code: "CHROME_MCP_EXECUTION_FAILED",
              message: expect.stringContaining("Target crashed"),
            },
            partialEmittedCount: 1,
            partialOmittedCount: 0,
          });
          if (!Array.isArray(result.content)) {
            throw new TypeError("Expected MCP content blocks");
          }
          const observation = result.content.find(
            (item) =>
              isRecord(item) &&
              item.type === "text" &&
              typeof item.text === "string" &&
              item.text.startsWith('{"control":'),
          );
          if (!isRecord(observation) || typeof observation.text !== "string") {
            throw new Error("Expected the surviving browser control and raw CDP crash event");
          }
          const observed: unknown = JSON.parse(observation.text);
          if (
            !isRecord(observed) ||
            !isRecord(observed.crash) ||
            typeof observed.crash.errorCode !== "number" ||
            typeof observed.crash.targetId !== "string"
          ) {
            throw new Error("Expected the recorded crash observation");
          }
          expect(observed.control).toBe(4);
          if (
            !isRecord(result.structuredContent) ||
            !isRecord(result.structuredContent.diagnostics) ||
            !isRecord(result.structuredContent.diagnostics.targetCrash)
          ) {
            throw new Error("Expected structured target crash diagnostics");
          }
          expect(result.structuredContent.diagnostics.targetCrash.targetId).toBe(
            result.structuredContent.selectedTargetId,
          );
          expect(result.structuredContent.diagnostics.targetCrash.errorCode).toBe(observed.crash.errorCode);
          expect(result.structuredContent.diagnostics.targetCrash.targetId).toBe(observed.crash.targetId);
        } finally {
          await client.close();
          await session.close();
        }
      } finally {
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = priorDataHome;
      }
      if (priorRuntimeDirectory === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
      }
    }
  },
  30_000,
);

liveTest(
  "handles a dialog during its triggering click through the public MCP boundary",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-dialog-"));
    roots.push(root);
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });
      try {
        const server = createChromeMcpServer(service);
        const client = new Client({ name: "chrome-dialog-client", version: "1.0.0" }, { capabilities: {} });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const [session] = await Promise.all([
          server.connect(serverTransport, createLiveToolContext(root).session),
          client.connect(clientTransport),
        ]);
        try {
          expect(
            client.callTool({ name: "run_playwright", arguments: { code: "return true;" } }),
          ).rejects.toThrow("browserInstanceId is required for isolated-headless");
          for (const observer of ["none", "snapshot", "trace"]) {
            const result = await client.callTool({
              name: "run_playwright",
              arguments: {
                args: { observer },
                browserInstanceId: `dialog-${observer}`,
                timeoutMs: 10_000,
                code: `
              await page.setContent('<button onclick="document.body.dataset.confirmed = String(confirm(&quot;Continue?&quot;))">Continue</button>');
              if (args.observer === 'snapshot') await chrome.captureAccessibilitySnapshot();
              const capture = args.observer === 'trace' ? await chrome.capture.start({ type: 'trace' }) : undefined;
              const dialogPromise = page.waitForEvent('dialog');
              const clickPromise = page.getByRole('button', { name: 'Continue' }).click();
              const dialog = await dialogPromise;
              const message = dialog.message();
              await dialog.accept();
              await clickPromise;
              const confirmed = await page.locator('body').getAttribute('data-confirmed');
              await page.getByRole('button', { name: 'Continue' }).click();
              const unhandled = await page.locator('body').getAttribute('data-confirmed');
              if (capture) await chrome.capture.stop(capture.captureId);
              return { message, confirmed, unhandled, headless: chrome.capabilities.headless };
              `,
              },
            });
            expect(result.structuredContent).toMatchObject({
              ok: true,
              value: { message: "Continue?", confirmed: "true", unhandled: "false", headless: true },
            });
          }
        } finally {
          await client.close();
          await session.close();
        }
      } finally {
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      if (priorRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
    }
  },
  120_000,
);

liveTest(
  "delivers Playwright download events for an owned browser and publishes the downloaded file",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-download-"));
    roots.push(root);
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });
      try {
        const server = createChromeMcpServer(service);
        const client = new Client({ name: "chrome-download-client", version: "1.0.0" }, { capabilities: {} });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const [session] = await Promise.all([
          server.connect(serverTransport, createLiveToolContext(root).session),
          client.connect(clientTransport),
        ]);
        try {
          const result = await client.callTool({
            name: "run_playwright",
            arguments: {
              browserInstanceId: "download",
              timeoutMs: 10_000,
              code: `
            await page.setContent('<button id="export">Export</button><script>document.getElementById("export").onclick = () => { const url = URL.createObjectURL(new Blob(["exported"], { type: "text/plain" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "export.txt"; anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove(); };</script>');
            const cursor = await chrome.events.mark();
            const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
            await page.getByRole('button', { name: 'Export' }).click();
            const download = await downloadPromise;
            const path = await download.path();
            if (!path) throw new Error('Download did not produce a file');
            const artifact = await chrome.publishFileArtifact(path, 'text/plain');
            const journal = await chrome.events.read({ after: cursor, types: ['download_started', 'download_finished'] });
            return { suggestedFilename: download.suggestedFilename(), size: artifact.size, journal: journal.events.map((event) => event.type) };
            `,
            },
          });
          expect(result.structuredContent).toMatchObject({
            ok: true,
            value: {
              journal: ["download_started", "download_finished"],
              size: 8,
              suggestedFilename: "export.txt",
            },
          });
        } finally {
          await client.close();
          await session.close();
        }
      } finally {
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      if (priorRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
    }
  },
  120_000,
);

liveTest(
  "returns typed diagnostic samples and preserves browser actions when result serialization fails",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-results-"));
    roots.push(root);
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    const context = createLiveToolContext(root);
    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });
      const input = {
        args: {},
        browser: "isolated-headless",
        browserInstanceId: "diagnostics",
        timeoutMs: 10_000,
      } as const;
      try {
        const samples = await service.handlers.runPlaywright(
          {
            ...input,
            code: `
          await page.setContent('<title>measurements</title><output>0</output>');
          chrome.setSessionStateValue('marker', 'before');
          const measured = await page.evaluate(() => ({
            samples: { offsets: new Float64Array([99, 0.25, -1.5, 2]).subarray(1) },
          }));
          return { measured, bytes: new Uint8Array([0, 127, 255]) };
        `,
          },
          context,
        );
        expect(samples.structuredContent).toMatchObject({
          ok: true,
          value: { measured: { samples: { offsets: [0.25, -1.5, 2] } }, bytes: [0, 127, 255] },
        });

        const bytes = await service.handlers.runPlaywright(
          {
            ...input,
            code: "return new Uint8Array([0, 127, 255]);",
          },
          context,
        );
        expect(bytes.structuredContent).toMatchObject({ ok: true, value: [0, 127, 255] });

        const screenshot = await service.handlers.runPlaywright(
          {
            ...input,
            code: "return await page.screenshot();",
          },
          context,
        );
        expect(screenshot.structuredContent).toMatchObject({ ok: true });
        expect(screenshot.content).toContainEqual(
          expect.objectContaining({ type: "image", mimeType: "image/png" }),
        );

        const failed = await service.handlers.runPlaywright(
          {
            ...input,
            code: `
          await page.locator('output').evaluate(element => { element.textContent = '1'; });
          chrome.setSessionStateValue('marker', 'after');
          class Measurement { value = 1; }
          return { sample: new Measurement() };
        `,
          },
          context,
        );
        expect(failed.isError).toBeTrue();
        expect(failed.structuredContent).toMatchObject({
          ok: false,
          error: { code: "CHROME_MCP_INVALID_INPUT" },
        });
        if (!isRecord(failed.structuredContent) || !isRecord(failed.structuredContent.error)) {
          throw new Error(
            `Serialization failure returned no structured error: ${JSON.stringify(failed.structuredContent)}`,
          );
        }
        expect(failed.structuredContent.error.message).toContain("Playwright return value.sample");
        expect(failed.structuredContent.error.message).toContain("Measurement");
        expect(failed.structuredContent.error.message).toContain("completed");
        expect(failed.structuredContent.error.message).toContain("Browser actions were not undone");

        const preserved = await service.handlers.runPlaywright(
          {
            ...input,
            code: "return { text: await page.locator('output').textContent(), marker: chrome.getSessionStateValue('marker') };",
          },
          context,
        );
        expect(preserved.structuredContent).toMatchObject({
          ok: true,
          value: { text: "1", marker: "before" },
        });

        const strictState = await service.handlers.runPlaywright(
          {
            ...input,
            code: "chrome.setSessionStateValue('samples', new Float64Array([1, 2])); return true;",
          },
          context,
        );
        expect(strictState.structuredContent).toMatchObject({
          ok: false,
          error: { code: "CHROME_MCP_INVALID_STATE" },
        });

        const closedWithInvalidResult = await service.handlers.runPlaywright(
          {
            ...input,
            code: `
          chrome.emitTextResult('measurement captured before close');
          await page.close();
          class Measurement { value = 1; }
          return { sample: new Measurement() };
        `,
          },
          context,
        );
        expect(closedWithInvalidResult.structuredContent).toMatchObject({
          ok: false,
          error: {
            code: "CHROME_MCP_INVALID_INPUT",
          },
          partialEmittedCount: 1,
          partialOmittedCount: 0,
          selectedTargetId: null,
        });
        if (
          !isRecord(closedWithInvalidResult.structuredContent) ||
          !isRecord(closedWithInvalidResult.structuredContent.error)
        ) {
          throw new Error("Expected the serialization error after closing the last page");
        }
        expect(closedWithInvalidResult.structuredContent.error.message).toContain(
          "Playwright return value.sample",
        );
        expect(closedWithInvalidResult.structuredContent.error.message).toContain("CHROME_MCP_PAGE_CLOSED");
        expect(closedWithInvalidResult.content).toContainEqual({
          text: "measurement captured before close",
          type: "text",
        });
      } finally {
        await service.closeConnection(context);
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      if (priorRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
    }
  },
  120_000,
);

liveTest(
  "selects a surviving page after closure and reports last-page cleanup without undoing browser actions",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-page-close-"));
    roots.push(root);
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    const context = createLiveToolContext(root);
    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });
      const input = {
        args: {},
        browser: "isolated-headless",
        browserInstanceId: "page-close",
        timeoutMs: 10_000,
      } as const;
      try {
        const ready = await service.handlers.runPlaywright(
          {
            ...input,
            code: `
          await page.setContent('<title>surviving-page</title>');
          chrome.setSessionStateValue('marker', 'before-close');
          const extraPage = await context.newPage();
          await extraPage.setContent('<title>extra-page</title>');
          return true;
        `,
          },
          context,
        );
        expect(ready.structuredContent).toMatchObject({ ok: true });

        const extraClosed = await service.handlers.runPlaywright(
          {
            ...input,
            code: "const title = await page.title(); await page.close(); return { title, closed: page.isClosed() };",
          },
          context,
        );
        expect(extraClosed.structuredContent).toMatchObject({
          ok: true,
          value: { closed: true, title: "extra-page" },
        });

        const survivor = await service.handlers.runPlaywright(
          {
            ...input,
            code: "return { title: await page.title(), pages: context.pages().length };",
          },
          context,
        );
        expect(survivor.structuredContent).toMatchObject({
          ok: true,
          value: { pages: 1, title: "surviving-page" },
        });

        const lastClosed = await service.handlers.runPlaywright(
          {
            ...input,
            code: "chrome.setSessionStateValue('marker', 'after-close'); await page.close(); return { closed: true };",
          },
          context,
        );
        expect(lastClosed.structuredContent).toMatchObject({
          error: {
            code: "CHROME_MCP_PAGE_CLOSED",
            message:
              "No usable page remains to select after this call. Browser actions, including page closure, were not undone. Do not retry a completed close; leave the prebound page open when finishing a task.",
          },
          ok: false,
          selectedTargetId: null,
        });

        const recovered = await service.handlers.runPlaywright(
          {
            ...input,
            code: "return { marker: chrome.getSessionStateValue('marker'), pages: context.pages().length, title: await page.title(), url: page.url() };",
          },
          context,
        );
        expect(recovered.structuredContent).toMatchObject({
          ok: true,
          value: { marker: "before-close", pages: 1, title: "", url: "about:blank" },
        });
      } finally {
        await service.closeConnection(context);
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      if (priorRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
    }
  },
  120_000,
);

liveTest(
  "protects a shared browser owner while allowing caller-owned and exclusive closes",
  async () => {
    const executablePath = await resolveChromeExecutable();
    const root = await mkdtemp(join(tmpdir(), "chrome-mcp-live-close-"));
    roots.push(root);
    const priorDataHome = process.env.XDG_DATA_HOME;
    const priorRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_RUNTIME_DIR = join(root, "runtime");
    const brokerPaths = await resolveBrokerRuntimePaths(root, getMcpRuntimeDir());
    const context = createLiveToolContext(root);
    const peerContext = createLiveToolContext(root);
    try {
      const service = await createChromeService({
        artifactStore: new ArtifactStore({ root: join(root, "artifacts") }),
        executablePath,
        workspacePath: root,
      });
      let operationFailed = false;
      try {
        const peerReady = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "shared-headless",
            code: `
          const peerPage = await context.newPage();
          await peerPage.setContent("<title>shared-peer-close-test</title>");
          await chrome.selectPageForSession(peerPage);
          return page.url();
        `,
            timeoutMs: 10_000,
          },
          peerContext,
        );
        if (!isRecord(peerReady.structuredContent) || peerReady.structuredContent.ok !== true) {
          throw new Error(`Shared peer setup failed: ${JSON.stringify(peerReady.structuredContent)}`);
        }

        const ownedPageReady = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "shared-headless",
            code: `
          const ownedPage = await context.newPage();
          await ownedPage.setContent("<title>caller-owned-close-test</title>");
          return true;
        `,
            timeoutMs: 10_000,
          },
          context,
        );
        if (!isRecord(ownedPageReady.structuredContent) || ownedPageReady.structuredContent.ok !== true) {
          throw new Error(
            `Caller-owned page setup failed: ${JSON.stringify(ownedPageReady.structuredContent)}`,
          );
        }

        const protectedClose = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "shared-headless",
            code: `
          const candidates = await Promise.all(context.pages().map(async (candidate) => ({
            candidate,
            title: candidate.isClosed() ? "" : await candidate.title(),
          })));
          const ownedPage = candidates.find((entry) => entry.title === "caller-owned-close-test")?.candidate;
          if (!ownedPage) throw new Error("Caller-owned page is unavailable");
          const replacementPage = candidates.find((entry) =>
            entry.candidate !== ownedPage && entry.title !== "shared-peer-close-test"
          )?.candidate;
          if (!replacementPage) throw new Error("Replacement page is unavailable");
          await chrome.selectPageForSession(replacementPage);
          await ownedPage.close();
          const ownedContext = await browser.newContext();
          const ownedContextPage = await ownedContext.newPage();
          await ownedContext.close();
          const closeCode = async (resource) => {
            try {
              await resource.close();
              return null;
            } catch (error) {
              return error?.code ?? null;
            }
          };
          const cdp = await browser.newBrowserCDPSession();
          let rawBrowserCloseCode = null;
          try {
            await cdp.send("Browser.close");
          } catch (error) {
            rawBrowserCloseCode = error.code;
          } finally {
            await cdp.detach();
          }
          return {
            browserCloseCode: await closeCode(browser),
            contextCloseCode: await closeCode(context),
            ownedContextClosed: ownedContextPage.isClosed(),
            ownedPageClosed: ownedPage.isClosed(),
            rawBrowserCloseCode,
          };
        `,
            timeoutMs: 10_000,
          },
          context,
        );
        if (!isRecord(protectedClose.structuredContent) || protectedClose.structuredContent.ok !== true) {
          throw new Error(
            `Shared close protection failed: ${JSON.stringify(protectedClose.structuredContent)}`,
          );
        }
        expect(protectedClose.structuredContent.value).toEqual({
          browserCloseCode: "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
          contextCloseCode: "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
          ownedContextClosed: true,
          ownedPageClosed: true,
          rawBrowserCloseCode: "CHROME_MCP_BROWSER_CLOSE_FORBIDDEN",
        });

        const peerAfterRejectedClose = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "shared-headless",
            code: "return { alive: true, url: page.url() };",
            timeoutMs: 10_000,
          },
          peerContext,
        );
        if (
          !isRecord(peerAfterRejectedClose.structuredContent) ||
          peerAfterRejectedClose.structuredContent.ok !== true
        ) {
          throw new Error(
            `Shared peer was disrupted: ${JSON.stringify(peerAfterRejectedClose.structuredContent)}`,
          );
        }
        expect(peerAfterRejectedClose.structuredContent.value).toMatchObject({ alive: true });

        const reusedOwnerReady = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated",
            code: "return { ready: true, url: page.url() };",
            timeoutMs: 10_000,
          },
          context,
        );
        if (!isRecord(reusedOwnerReady.structuredContent) || reusedOwnerReady.structuredContent.ok !== true) {
          throw new Error(`Reused owner setup failed: ${JSON.stringify(reusedOwnerReady.structuredContent)}`);
        }

        const reusedVisibleClose = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated",
            code: `
          await browser.close();
          return { closed: true };
        `,
            timeoutMs: 10_000,
          },
          context,
        );
        if (
          !isRecord(reusedVisibleClose.structuredContent) ||
          reusedVisibleClose.structuredContent.ok !== true
        ) {
          throw new Error(
            `Reused visible browser close failed: ${JSON.stringify(reusedVisibleClose.structuredContent)}`,
          );
        }
        expect(reusedVisibleClose.structuredContent.value).toEqual({ closed: true });

        const recoveredVisibleOwner = await service.handlers.runPlaywright(
          {
            args: {},
            browser: "isolated",
            code: "return { ready: true, url: page.url() };",
            timeoutMs: 10_000,
          },
          context,
        );
        if (
          !isRecord(recoveredVisibleOwner.structuredContent) ||
          recoveredVisibleOwner.structuredContent.ok !== true
        ) {
          throw new Error(
            `Visible owner recovery failed: ${JSON.stringify(recoveredVisibleOwner.structuredContent)}`,
          );
        }
        expect(recoveredVisibleOwner.structuredContent.value).toMatchObject({ ready: true });

        for (const selection of [
          { browser: "isolated-headless", browserInstanceId: "owner-close" },
          {
            browser: "isolated-virtual-display",
            browserInstanceId: "owner-close",
            nativeDeviceScaleFactor: 1,
          },
        ] as const) {
          const isUnsupportedVirtualDisplay =
            selection.browser === "isolated-virtual-display" && process.platform !== "linux";
          if (isUnsupportedVirtualDisplay) continue;

          const exclusiveReady = await service.handlers.runPlaywright(
            {
              ...selection,
              args: {},
              code: `
            await page.setContent("<title>exclusive-owner-close-marker</title>");
            return await page.title();
          `,
              timeoutMs: 10_000,
            },
            context,
          );
          expect(exclusiveReady.structuredContent).toMatchObject({
            ok: true,
            value: "exclusive-owner-close-marker",
          });

          const exclusiveClose = await service.handlers.runPlaywright(
            {
              ...selection,
              args: {},
              code: "await browser.close(); return { closed: true };",
              timeoutMs: 10_000,
            },
            context,
          );
          expect(exclusiveClose.structuredContent).toMatchObject({
            ok: true,
            selectedTargetId: null,
            value: { closed: true },
          });

          const recoveredExclusiveOwner = await service.handlers.runPlaywright(
            {
              ...selection,
              args: {},
              code: `
            const titles = await Promise.all(context.pages().map((candidate) => candidate.title()));
            return { markerSurvived: titles.includes("exclusive-owner-close-marker"), url: page.url() };
          `,
              timeoutMs: 10_000,
            },
            context,
          );
          expect(recoveredExclusiveOwner.structuredContent).toMatchObject({
            ok: true,
            value: { markerSurvived: false, url: "about:blank" },
          });

          const recoveredClose = await service.handlers.runPlaywright(
            {
              ...selection,
              args: {},
              code: "await context.close(); return { closed: true };",
              timeoutMs: 10_000,
            },
            context,
          );
          expect(recoveredClose.structuredContent).toMatchObject({
            ok: true,
            selectedTargetId: null,
            value: { closed: true },
          });
        }
      } catch (error: unknown) {
        operationFailed = true;
        const brokerLog = await readFile(brokerPaths.logPath, "utf8").catch(() => "Broker log unavailable");
        throw new AggregateError(
          [error, new Error(brokerLog.slice(-4000))],
          "Live close ownership operation failed",
        );
      } finally {
        await service.closeConnection(peerContext).catch((error: unknown) => {
          if (!operationFailed) throw error;
        });
        await service.closeConnection(context).catch((error: unknown) => {
          if (!operationFailed) throw error;
        });
        await service.close();
      }
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      if (priorRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = priorRuntimeDirectory;
    }
  },
  120_000,
);
