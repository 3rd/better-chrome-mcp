import { afterEach, expect, test } from "bun:test";
import { ok } from "node:assert";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDP_METHOD_NOT_FOUND, CdpCommandError } from "./cdp-connection";
import { FakeCdpClient } from "./fake-cdp-client.test-support";
import { PwaController } from "./pwa-controller";

const roots: string[] = [];
const manifestId = "https://example.test/app";
const install = { operation: "install", manifestId, installUrl: "https://example.test/" } as const;
const resolvePageTarget = (targetId: string) => Promise.resolve(targetId);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createController = async () => {
  const root = await mkdtemp(join(tmpdir(), "chrome-pwa-test-"));
  roots.push(root);
  const receiptPath = join(root, "pwa-installs.json");
  const connection = new FakeCdpClient();
  return {
    connection,
    receiptPath,
    controller: new PwaController({
      sendCommand: (method, params) => connection.send(method, params),
      mode: "isolated-headless",
      receiptPath,
      resolvePageTarget,
    }),
  };
};

test("records ownership before install, defaults to browser display, and uninstalls on close", async () => {
  const { connection, receiptPath, controller } = await createController();
  const calls: string[] = [];
  const commands = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>([
    [
      "PWA.install",
      async (params) => {
        expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual([manifestId]);
        expect(params).toEqual({ manifestId, installUrlOrBundleUrl: install.installUrl });
        return {};
      },
    ],
    [
      "PWA.changeAppUserSettings",
      (params) => {
        expect(params).toEqual({ manifestId, displayMode: "browser" });
        return Promise.resolve({});
      },
    ],
    ["PWA.getOsAppState", () => Promise.resolve({})],
    ["PWA.uninstall", () => Promise.resolve({})],
  ]);
  connection.command = ({ method, params }) => {
    calls.push(method);

    const command = commands.get(method);
    ok(command, `Unexpected PWA command: ${method}`);
    return command(params);
  };
  expect(await controller.execute(install, new AbortController().signal)).toEqual({
    operation: "install",
    manifestId,
    displayMode: "browser",
  });
  await controller.close();
  expect(calls).toEqual(["PWA.install", "PWA.changeAppUserSettings", "PWA.getOsAppState", "PWA.uninstall"]);
  expect(stat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("recovers canceled installation receipts and preserves them when cleanup fails", async () => {
  const { connection, receiptPath, controller } = await createController();
  const abort = new AbortController();
  connection.command = ({ method }) => {
    if (method === "PWA.install") {
      abort.abort(new Error("Canceled during install"));
    }

    return Promise.resolve({});
  };
  expect(controller.execute(install, abort.signal)).rejects.toThrow("Canceled during install");
  const recovered = new PwaController({
    sendCommand: (method, params) => connection.send(method, params),
    mode: "isolated-headless",
    receiptPath,
    resolvePageTarget,
  });
  connection.command = ({ method }) => {
    if (method === "PWA.uninstall") {
      return Promise.reject(new CdpCommandError("Uninstall failed", -32_000));
    }

    return Promise.resolve({});
  };
  expect(recovered.close()).rejects.toThrow("preserved");
  expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual([manifestId]);
  connection.command = () =>
    Promise.reject(new CdpCommandError(`Unknown web-app manifest id ${manifestId}`, -32_602));
  await recovered.close();
  expect(stat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("finishes an in-flight installation before owner cleanup uninstalls it", async () => {
  const { connection, receiptPath, controller } = await createController();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let isInstalled = false;
  const commands = new Map<string, () => Promise<unknown>>([
    [
      "PWA.install",
      async () => {
        started.resolve();
        await release.promise;
        isInstalled = true;
        return {};
      },
    ],
    [
      "PWA.changeAppUserSettings",
      () => {
        expect(isInstalled).toBe(true);
        return Promise.resolve({});
      },
    ],
    ["PWA.getOsAppState", () => Promise.resolve({ badgeCount: 0, fileHandlers: [] })],
    [
      "PWA.uninstall",
      () => {
        isInstalled = false;
        return Promise.resolve({});
      },
    ],
  ]);
  connection.command = ({ method }) => {
    const command = commands.get(method);
    ok(command, `Unexpected PWA command: ${method}`);
    return command();
  };

  const installation = controller.execute(install, new AbortController().signal);
  await started.promise;

  const cleanup = controller.close();
  release.resolve();
  await Promise.all([installation, cleanup]);
  expect(isInstalled).toBe(false);
  expect(stat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("preserves both installation receipts when installs are requested together", async () => {
  const { receiptPath, controller } = await createController();
  const secondManifestId = "https://example.test/second-app";
  await Promise.all([
    controller.execute(install, new AbortController().signal),
    controller.execute({ ...install, manifestId: secondManifestId }, new AbortController().signal),
  ]);
  expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual([manifestId, secondManifestId]);

  await controller.close();
  expect(stat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects non-isolated modes before CDP and reports unsupported native commands", async () => {
  const { connection, receiptPath, controller } = await createController();
  connection.command = () => Promise.reject(new Error("Unexpected CDP call"));

  for (const mode of ["shared", "shared-headless", "main"] as const) {
    expect(
      new PwaController({
        sendCommand: (method, params) => connection.send(method, params),
        mode,
        receiptPath,
        resolvePageTarget,
      }).execute(install, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CHROME_MCP_INVALID_MODE" });
  }

  connection.command = () => Promise.reject(new CdpCommandError("Method not found", CDP_METHOD_NOT_FOUND));
  expect(
    controller.execute({ operation: "getState", manifestId }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "CHROME_MCP_UNSUPPORTED_CAPABILITY" });
});
