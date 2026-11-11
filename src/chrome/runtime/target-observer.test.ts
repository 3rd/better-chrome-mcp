import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeRuntimeError } from "./errors";
import {
  BoundedEventJournal,
  type BrowserJournalEvent,
  type BrowserJournalInput,
  JOURNAL_CRASH_STATUS_BYTES,
} from "./event-journal";
import { FakeCdpClient } from "./fake-cdp-client.test-support";
import { ActiveModalRegistry } from "./modals";
import { PersistentBrowserMutations, PersistentMutationRegistry } from "./persistent-mutations";
import {
  ChromeTargetObserver,
  type DownloadFinishedInput,
  type DownloadPublication,
} from "./target-observer";
import { ChromeTargetRegistry } from "./target-registry";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

class DownloadEventJournal extends BoundedEventJournal {
  readonly finished = Promise.withResolvers<BrowserJournalEvent>();

  override append(targetId: string, input: BrowserJournalInput): BrowserJournalEvent {
    const event = super.append(targetId, input);
    if (input.type === "download_finished") this.finished.resolve(event);
    return event;
  }
}

const createDownloadObserver = async (
  options: Readonly<{
    activeConnectionId: () => string | undefined;
    downloadsPath?: string;
    onDownloadFinished: (input: DownloadFinishedInput) => Promise<DownloadPublication>;
  }>,
) => {
  const connection = new FakeCdpClient();
  connection.command = async ({ method }) => {
    if (method === "Target.getTargets") {
      return { targetInfos: [{ targetId: "page-a", type: "page", url: "https://example.test" }] };
    }
    if (method === "Target.attachToTarget") return { sessionId: "session-a" };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-a" } } };
    return {};
  };
  const journal = new DownloadEventJournal(7);
  const observer = new ChromeTargetObserver({
    activeConnectionId: options.activeConnectionId,
    browserMode: "shared-headless",
    connection,
    ...(options.downloadsPath ? { downloadsPath: options.downloadsPath } : {}),
    journal,
    modals: new ActiveModalRegistry(7),
    onDownloadFinished: options.onDownloadFinished,
    onError: (error) => {
      throw error;
    },
    registry: new ChromeTargetRegistry(7),
  });
  await observer.start();
  return { connection, journal, observer };
};

const startDownload = (connection: FakeCdpClient, downloadId: string): void => {
  connection.emit("Browser.downloadWillBegin", {
    frameId: "frame-a",
    guid: downloadId,
    suggestedFilename: `${downloadId}.txt`,
    url: `https://example.test/${downloadId}.txt`,
  });
};

describe("ChromeTargetObserver", () => {
  test("resolves a native PWA tab to its page and detaches its temporary session", async () => {
    const { connection, observer } = await createDownloadObserver({
      activeConnectionId: () => undefined,
      onDownloadFinished: () => Promise.resolve({}),
    });
    const send = connection.command;
    const replies = new Map<string, () => Promise<unknown>>([
      [
        "Target.getTargetInfo",
        () =>
          Promise.resolve({ targetInfo: { targetId: "tab-a", type: "tab", url: "https://example.test" } }),
      ],
      ["Target.attachToTarget", () => Promise.resolve({ sessionId: "tab-session" })],
      [
        "Target.setAutoAttach",
        () => {
          connection.emit(
            "Target.attachedToTarget",
            {
              sessionId: "child-session",
              targetInfo: { targetId: "page-a", type: "page", url: "https://example.test" },
            },
            "tab-session",
          );
          return Promise.resolve({});
        },
      ],
    ]);
    connection.command = (command) => replies.get(command.method)?.() ?? send(command);

    try {
      expect(await observer.resolvePwaPageTarget("tab-a", new AbortController().signal)).toBe("page-a");
      expect(connection.commands.at(-1)).toMatchObject({
        method: "Target.detachFromTarget",
        params: { sessionId: "tab-session" },
      });
    } finally {
      await observer.stop();
    }
  });

  test("detaches a native PWA tab session when page registration is canceled", async () => {
    const { connection, observer } = await createDownloadObserver({
      activeConnectionId: () => undefined,
      onDownloadFinished: () => Promise.resolve({}),
    });
    const send = connection.command;
    const controller = new AbortController();
    const replies = new Map<string, () => Promise<unknown>>([
      [
        "Target.getTargetInfo",
        () =>
          Promise.resolve({ targetInfo: { targetId: "tab-a", type: "tab", url: "https://example.test" } }),
      ],
      ["Target.attachToTarget", () => Promise.resolve({ sessionId: "tab-session" })],
      [
        "Target.setAutoAttach",
        () => {
          controller.abort(new Error("Launch canceled"));
          return Promise.resolve({});
        },
      ],
    ]);
    connection.command = (command) => replies.get(command.method)?.() ?? send(command);

    try {
      expect(observer.resolvePwaPageTarget("tab-a", controller.signal)).rejects.toThrow("Launch canceled");
      expect(connection.commands.at(-1)).toMatchObject({
        method: "Target.detachFromTarget",
        params: { sessionId: "tab-session" },
      });
    } finally {
      await observer.stop();
    }
  });

  test.each(["event", "snapshot"])(
    "isolates an unresponsive main tab and recovers navigation from a target %s",
    async (source) => {
      const connection = new FakeCdpClient();
      let unresponsive = true;
      const stalled = { targetId: "stalled", type: "page", url: "https://stalled.example.test" };
      const targets = [{ targetId: "healthy", type: "page", url: "https://healthy.example.test" }, stalled];
      connection.command = async ({ method, params, sessionId }) => {
        if (method === "Target.getTargets") return { targetInfos: targets };
        if (method === "Target.attachToTarget") return { sessionId: params.targetId };
        if (method === "Runtime.enable" && sessionId === "stalled" && unresponsive) {
          throw new ChromeRuntimeError("CHROME_MCP_TIMEOUT", "Runtime.enable did not respond");
        }
        return {};
      };
      const registry = new ChromeTargetRegistry(1);
      const observer = new ChromeTargetObserver({
        browserMode: "main",
        connection,
        journal: new BoundedEventJournal(1),
        modals: new ActiveModalRegistry(1),
        onError: (error) => {
          throw error;
        },
        registry,
      });
      try {
        await observer.start();
        expect(await observer.ensurePage()).toEqual({ ownerGeneration: 1, targetId: "healthy" });
        expect(registry.unavailableTargets()).toEqual([
          { targetId: "stalled", error: "Runtime.enable did not respond" },
        ]);
        expect(connection.commands).toContainEqual({
          method: "Target.detachFromTarget",
          params: { sessionId: "stalled" },
        });
        await observer.synchronizeTargets();
        expect(connection.commands.filter(({ method }) => method === "Target.attachToTarget")).toHaveLength(
          2,
        );
        expect(connection.closed).toBe(false);

        unresponsive = false;
        stalled.url = "https://recovered.example.test";
        if (source === "snapshot") {
          await observer.synchronizeTargets();
        }
        connection.emit("Target.targetInfoChanged", { targetInfo: stalled });
        await observer.synchronizeTargets();
        expect(registry.readyRecords().map(({ targetId }) => targetId)).toEqual(["healthy", "stalled"]);
        expect(registry.unavailableTargets()).toEqual([]);
      } finally {
        await observer.stop();
      }
    },
  );

  test("retains bounded renderer crash details without closing the browser or target", async () => {
    const connection = new FakeCdpClient();
    connection.command = async ({ method }) => {
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "page-a", type: "page", url: "about:blank" }] };
      }
      if (method === "Target.attachToTarget") {
        return { sessionId: "session-a" };
      }
      return {};
    };
    const journal = new BoundedEventJournal(7);
    const registry = new ChromeTargetRegistry(7);
    const observer = new ChromeTargetObserver({
      browserMode: "isolated-headless",
      connection,
      journal,
      modals: new ActiveModalRegistry(7),
      onError: (error) => {
        throw error;
      },
      registry,
    });
    await observer.start();

    connection.emit("Target.targetCrashed", { errorCode: 4, status: "crashed", targetId: "page-a" });

    expect(journal.read().events).toMatchObject([
      {
        errorCode: 4,
        ownerGeneration: 7,
        status: { preview: "crashed", previewTruncated: false, originalBytes: 7 },
        targetId: "page-a",
        type: "target_crashed",
      },
    ]);
    expect(connection.closed).toBe(false);
    expect(registry.get({ ownerGeneration: 7, targetId: "page-a" })).toBeDefined();

    const after = journal.currentCursor;
    connection.emit("Target.targetCrashed", {
      errorCode: 4,
      status: "x".repeat(JOURNAL_CRASH_STATUS_BYTES + 1),
      targetId: "page-a",
    });
    expect(journal.read({ after }).events).toMatchObject([
      {
        status: {
          originalBytes: JOURNAL_CRASH_STATUS_BYTES + 1,
          preview: "x".repeat(JOURNAL_CRASH_STATUS_BYTES),
          previewTruncated: true,
        },
      },
    ]);
    await observer.stop();
  });

  test("records a dialog that opens while a new target is being armed", async () => {
    const connection = new FakeCdpClient();
    connection.command = async ({ method }) => {
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "page-a", type: "page", url: "https://example.test" }] };
      }
      if (method === "Target.attachToTarget") return { sessionId: "session-a" };
      if (method === "Page.enable") {
        connection.emit(
          "Page.javascriptDialogOpening",
          { defaultPrompt: "", message: "early dialog", type: "alert" },
          "session-a",
        );
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-a" } } };
      return {};
    };
    const journal = new BoundedEventJournal(1);
    const observer = new ChromeTargetObserver({
      browserMode: "main",
      connection,
      journal,
      modals: new ActiveModalRegistry(1),
      onError: (error) => {
        throw error;
      },
      registry: new ChromeTargetRegistry(1),
    });

    await observer.start();

    expect(journal.read({ target: "all", types: ["dialog_opened"] }).events).toMatchObject([
      { message: { preview: "early dialog" }, targetId: "page-a", type: "dialog_opened" },
    ]);
    await observer.stop();
  });

  test("joins duplicate target arms until the original target becomes ready", async () => {
    const pageEnableStarted = Promise.withResolvers<void>();
    const releasePageEnable = Promise.withResolvers<void>();
    let pageEnableCalls = 0;
    const connection = new FakeCdpClient(undefined, async ({ method }) => {
      if (method === "Target.getTargets") {
        return {
          targetInfos: [{ targetId: "page-a", title: "Initial", type: "page", url: "https://initial.test" }],
        };
      }
      if (method === "Target.attachToTarget") return { sessionId: "session-a" };
      if (method === "Page.enable") {
        pageEnableCalls++;
        pageEnableStarted.resolve();
        await releasePageEnable.promise;
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-a" } } };
      return {};
    });
    const registry = new ChromeTargetRegistry(1);
    const observer = new ChromeTargetObserver({
      browserMode: "main",
      connection,
      journal: new BoundedEventJournal(1),
      modals: new ActiveModalRegistry(1),
      onError: (error) => {
        throw error;
      },
      registry,
    });

    const started = observer.start();
    await pageEnableStarted.promise;
    connection.emit("Target.targetCreated", {
      targetInfo: {
        openerId: "opener-a",
        targetId: "page-a",
        title: "Duplicate",
        type: "page",
        url: "https://duplicate.test",
      },
    });

    const identity = registry.identity("page-a");
    expect(registry.get(identity)).toBeDefined();
    expect(registry.ready(identity)).toBeUndefined();
    releasePageEnable.resolve();
    await started;

    expect(pageEnableCalls).toBe(1);
    expect(registry.requireReady(identity)).toMatchObject({
      openerTargetId: "opener-a",
      title: "Duplicate",
      url: "https://duplicate.test",
    });
    await observer.stop();
  });

  test("returns a ready target without waiting for another target arm", async () => {
    const pageEnableStarted = Promise.withResolvers<void>();
    const releasePageEnable = Promise.withResolvers<void>();
    let createdPages = 0;
    const connection = new FakeCdpClient(undefined, async ({ method }) => {
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "page-b", type: "page", url: "https://arming.test" }] };
      }
      if (method === "Target.attachToTarget") return { sessionId: "session-b" };
      if (method === "Page.enable") {
        pageEnableStarted.resolve();
        await releasePageEnable.promise;
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-b" } } };
      if (method === "Target.createTarget") {
        createdPages++;
        return { targetId: "unexpected-blank" };
      }
      return {};
    });
    const registry = new ChromeTargetRegistry(1);
    registry.beginArming({ targetId: "page-a", title: "Ready", url: "https://ready.test" });
    registry.markReady("page-a");
    const observer = new ChromeTargetObserver({
      browserMode: "main",
      connection,
      journal: new BoundedEventJournal(1),
      modals: new ActiveModalRegistry(1),
      onError: (error) => {
        throw error;
      },
      registry,
    });

    const started = observer.start();
    await pageEnableStarted.promise;
    const ensured = observer.ensurePage();
    const outcome = await Promise.race([
      ensured.then((target) => ({ state: "ready" as const, target })),
      new Promise<Readonly<{ state: "blocked" }>>((resolve) => {
        queueMicrotask(() => resolve({ state: "blocked" }));
      }),
    ]);

    expect(outcome).toEqual({ state: "ready", target: { ownerGeneration: 1, targetId: "page-a" } });
    expect(createdPages).toBe(0);
    releasePageEnable.resolve();
    await started;
    await observer.stop();
  });

  test("shares one ensurePage operation across concurrent callers", async () => {
    let createdPages = 0;
    const connection = new FakeCdpClient(undefined, async ({ method }) => {
      if (method === "Target.createTarget") {
        createdPages++;
        return { targetId: "blank-a" };
      }
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { targetId: "blank-a", type: "page", url: "about:blank" } };
      }
      if (method === "Target.attachToTarget") return { sessionId: "session-a" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-a" } } };
      return {};
    });
    const registry = new ChromeTargetRegistry(1);
    const observer = new ChromeTargetObserver({
      browserMode: "isolated-headless",
      connection,
      journal: new BoundedEventJournal(1),
      modals: new ActiveModalRegistry(1),
      onError: (error) => {
        throw error;
      },
      registry,
    });

    const first = observer.ensurePage();
    const second = observer.ensurePage();
    expect(second).toBe(first);
    expect(Promise.all([first, second])).resolves.toEqual([
      { ownerGeneration: 1, targetId: "blank-a" },
      { ownerGeneration: 1, targetId: "blank-a" },
    ]);
    expect(createdPages).toBe(1);
    expect(registry.readyRecords().map((record) => record.targetId)).toEqual(["blank-a"]);
    await observer.stop();
  });

  test("ignores a rejected captured arm before creating one successful blank", async () => {
    const pageEnableStarted = Promise.withResolvers<void>();
    const releasePageEnable = Promise.withResolvers<void>();
    let createdPages = 0;
    const connection = new FakeCdpClient(undefined, async ({ method, params }) => {
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "page-a", type: "page", url: "https://failing.test" }] };
      }
      if (method === "Target.createTarget") {
        createdPages++;
        return { targetId: "blank-a" };
      }
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { targetId: params.targetId, type: "page", url: "about:blank" } };
      }
      if (method === "Target.attachToTarget") return { sessionId: `session:${params.targetId}` };
      if (method === "Page.enable" && params.targetId === undefined) {
        const targetId = connection.commands.findLast((command) => command.method === "Target.attachToTarget")
          ?.params.targetId;
        if (targetId === "page-a") {
          pageEnableStarted.resolve();
          await releasePageEnable.promise;
          throw new Error("captured target arm failed");
        }
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-a" } } };
      return {};
    });
    const registry = new ChromeTargetRegistry(1);
    const observer = new ChromeTargetObserver({
      browserMode: "isolated-headless",
      connection,
      journal: new BoundedEventJournal(1),
      modals: new ActiveModalRegistry(1),
      onError: (error) => {
        throw error;
      },
      registry,
    });

    const started = observer.start();
    await pageEnableStarted.promise;
    const ensured = observer.ensurePage();
    releasePageEnable.resolve();

    expect(started).rejects.toThrow();
    expect(ensured).resolves.toEqual({ ownerGeneration: 1, targetId: "blank-a" });
    expect(createdPages).toBe(1);
    expect(registry.readyRecords().map((record) => record.targetId)).toEqual(["blank-a"]);
    await observer.stop();
  });

  test("propagates a created blank arm failure and creates one distinct blank on the next ensure", async () => {
    let createdPages = 0;
    const connection = new FakeCdpClient(undefined, async ({ method, params, sessionId }) => {
      if (method === "Target.createTarget") {
        createdPages++;
        return { targetId: createdPages === 1 ? "blank-failed" : "blank-ready" };
      }
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { targetId: params.targetId, type: "page", url: "about:blank" } };
      }
      if (method === "Target.attachToTarget") return { sessionId: `session:${params.targetId}` };
      if (method === "Page.enable" && sessionId === "session:blank-failed") {
        throw new Error("created blank arm failed");
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: `frame:${sessionId}` } } };
      return {};
    });
    const registry = new ChromeTargetRegistry(1);
    const observer = new ChromeTargetObserver({
      browserMode: "isolated-headless",
      connection,
      journal: new BoundedEventJournal(1),
      modals: new ActiveModalRegistry(1),
      onError: (error) => {
        throw error;
      },
      registry,
    });

    expect(observer.ensurePage()).rejects.toThrow();
    expect(createdPages).toBe(1);
    expect(registry.readyRecords()).toEqual([]);

    expect(observer.ensurePage()).resolves.toEqual({ ownerGeneration: 1, targetId: "blank-ready" });
    expect(createdPages).toBe(2);
    expect(registry.readyRecords().map((record) => record.targetId)).toEqual(["blank-ready"]);
    await observer.stop();
  });

  test("replaces a pending target destroyed before it becomes ready", async () => {
    const pageEnableStarted = Promise.withResolvers<void>();
    const releasePageEnable = Promise.withResolvers<void>();
    let createdPages = 0;
    const connection = new FakeCdpClient(undefined, async ({ method, params, sessionId }) => {
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "page-a", type: "page", url: "https://initial.test" }] };
      }
      if (method === "Target.createTarget") {
        createdPages++;
        return { targetId: "blank-a" };
      }
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { targetId: params.targetId, type: "page", url: "about:blank" } };
      }
      if (method === "Target.attachToTarget") return { sessionId: `session:${params.targetId}` };
      if (method === "Page.enable" && sessionId === "session:page-a") {
        pageEnableStarted.resolve();
        await releasePageEnable.promise;
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: `frame:${sessionId}` } } };
      return {};
    });
    const registry = new ChromeTargetRegistry(1);
    const observer = new ChromeTargetObserver({
      browserMode: "isolated",
      connection,
      journal: new BoundedEventJournal(1),
      modals: new ActiveModalRegistry(1),
      onError: (error) => {
        throw error;
      },
      registry,
    });

    const started = observer.start();
    await pageEnableStarted.promise;
    const ensured = observer.ensurePage();
    connection.emit("Target.targetDestroyed", { targetId: "page-a" });
    releasePageEnable.resolve();

    await started;
    expect(ensured).resolves.toEqual({ ownerGeneration: 1, targetId: "blank-a" });
    expect(createdPages).toBe(1);
    expect(registry.readyRecords().map((record) => record.targetId)).toEqual(["blank-a"]);
    await observer.stop();
  });

  test("marks popup targets ready only after mutations and synchronous popup journaling", async () => {
    const mutationStarted = Promise.withResolvers<void>();
    const releaseMutation = Promise.withResolvers<void>();
    const connection = new FakeCdpClient(undefined, async ({ method }) => {
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            {
              openerId: "page-opener",
              targetId: "popup-a",
              type: "page",
              url: "https://popup.test",
            },
          ],
        };
      }
      if (method === "Target.attachToTarget") return { sessionId: "session-popup" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-popup" } } };
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        mutationStarted.resolve();
        await releaseMutation.promise;
        return { identifier: "script-a" };
      }
      return {};
    });
    const registry = new ChromeTargetRegistry(1);
    let readyDuringPopupAppend: boolean | undefined;
    class PopupJournal extends BoundedEventJournal {
      override append(targetId: string, input: BrowserJournalInput): BrowserJournalEvent {
        if (input.type === "popup") {
          readyDuringPopupAppend = registry.ready({ ownerGeneration: 1, targetId }) !== undefined;
        }
        return super.append(targetId, input);
      }
    }
    const journal = new PopupJournal(1);
    const mutations = new PersistentBrowserMutations(connection, () => undefined);
    const mutationRegistry = new PersistentMutationRegistry({ newId: () => "init-a" });
    await mutationRegistry.add({ kind: "initScript", source: "globalThis.marker = true" });
    mutations.addClient("client-a", mutationRegistry);
    const observer = new ChromeTargetObserver({
      activeConnectionId: () => "client-a",
      browserMode: "main",
      connection,
      journal,
      modals: new ActiveModalRegistry(1),
      mutations,
      onError: (error) => {
        throw error;
      },
      registry,
    });

    const started = observer.start();
    await mutationStarted.promise;
    const identity = registry.identity("popup-a");
    expect(registry.get(identity)).toBeDefined();
    expect(registry.ready(identity)).toBeUndefined();
    expect(journal.read({ target: "all", types: ["popup"] }).events).toEqual([]);
    releaseMutation.resolve();
    await started;

    expect(readyDuringPopupAppend).toBeFalse();
    expect(journal.read({ target: "all", types: ["popup"] }).events).toMatchObject([
      { openerTargetId: "page-opener", popupTargetId: "popup-a", targetId: "popup-a", type: "popup" },
    ]);
    expect(registry.ready(identity)).toBeDefined();
    await observer.stop();
  });

  test("detaches a target session when arming fails", async () => {
    const connection = new FakeCdpClient();
    connection.command = async ({ method }) => {
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "page-a", type: "page", url: "https://example.test" }] };
      }
      if (method === "Target.attachToTarget") return { sessionId: "session-a" };
      if (method === "Page.enable") throw new Error("Page domain failed to enable");
      return {};
    };
    const registry = new ChromeTargetRegistry(1);
    const observer = new ChromeTargetObserver({
      browserMode: "main",
      connection,
      journal: new BoundedEventJournal(1),
      modals: new ActiveModalRegistry(1),
      onError: (error) => {
        throw error;
      },
      registry,
    });

    expect(observer.start()).rejects.toThrow();

    expect(connection.commands).toContainEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "session-a" },
    });
    expect(registry.first()).toBeUndefined();
    await observer.stop();
  });

  test.each(["destroyed", "detached"])(
    "stops arming a %s target without failing observer startup",
    async (ending) => {
      const pageEnabled = Promise.withResolvers<void>();
      const releasePageEnable = Promise.withResolvers<void>();
      const closedTargets: string[] = [];
      const connection = new FakeCdpClient();
      connection.command = async ({ method }) => {
        if (method === "Target.getTargets") {
          return { targetInfos: [{ targetId: "page-a", type: "page", url: "https://example.test" }] };
        }
        if (method === "Target.attachToTarget") return { sessionId: "session-a" };
        if (method === "Page.enable") {
          pageEnabled.resolve();
          await releasePageEnable.promise;
        }
        return {};
      };
      const registry = new ChromeTargetRegistry(1);
      const observer = new ChromeTargetObserver({
        browserMode: "isolated",
        connection,
        journal: new BoundedEventJournal(1),
        modals: new ActiveModalRegistry(1),
        onError: (error) => {
          throw error;
        },
        onTargetClosed: (targetId) => {
          closedTargets.push(targetId);
        },
        registry,
      });

      const started = observer.start();
      await pageEnabled.promise;
      if (ending === "detached") {
        connection.emit("Target.detachedFromTarget", { sessionId: "session-a" });
        releasePageEnable.reject(new Error("Session detached"));
      } else {
        connection.emit("Target.targetDestroyed", { targetId: "page-a" });
        releasePageEnable.resolve();
      }
      await started;
      connection.emit("Target.targetDestroyed", { targetId: "page-a" });

      expect(connection.commands.some((command) => command.method === "Page.getFrameTree")).toBe(false);
      expect(registry.first()).toBeUndefined();
      expect(closedTargets).toEqual(["page-a"]);
      await observer.stop();
    },
  );

  test("drops pending persistent mutation ownership when target arming fails", async () => {
    const connection = new FakeCdpClient(undefined, async ({ method }) => {
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "page-a", type: "page", url: "https://example.test" }] };
      }
      if (method === "Target.attachToTarget") return { sessionId: "session-a" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-a" } } };
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        throw new Error("init script failed to install");
      }
      return {};
    });
    const mutations = new PersistentBrowserMutations(connection, () => undefined);
    const ownerRegistry = new PersistentMutationRegistry({ newId: () => "init-a" });
    await ownerRegistry.add({ kind: "initScript", source: "globalThis.marker = true" });
    mutations.addClient("client-a", ownerRegistry);
    mutations.addClient("client-b", new PersistentMutationRegistry());
    const observer = new ChromeTargetObserver({
      activeConnectionId: () => "client-a",
      browserMode: "main",
      connection,
      journal: new BoundedEventJournal(1),
      modals: new ActiveModalRegistry(1),
      mutations,
      onError: (error) => {
        throw error;
      },
      registry: new ChromeTargetRegistry(1),
    });

    expect(observer.start()).rejects.toThrow();

    expect(() =>
      mutations.assertTargetAccessible("client-b", {
        ownerGeneration: 1,
        targetId: "page-a",
      }),
    ).not.toThrow();
    await observer.stop();
  });

  test("seeds existing frame trees, observes main download events without changing download behavior, and clears terminal maps", async () => {
    const connection = new FakeCdpClient();
    connection.command = async ({ method }) => {
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "page-a", type: "page", url: "https://example.test" }] };
      }
      if (method === "Target.attachToTarget") return { sessionId: "session-a" };
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            childFrames: [{ frame: { id: "child-frame" } }],
            frame: { id: "main-frame" },
          },
        };
      }
      return {};
    };
    const journal = new BoundedEventJournal(4);
    const registry = new ChromeTargetRegistry(4);
    const observer = new ChromeTargetObserver({
      browserMode: "main",
      connection,
      journal,
      modals: new ActiveModalRegistry(4),
      onError: (error) => {
        throw error;
      },
      registry,
    });
    await observer.start();
    expect(connection.commands.some((command) => command.method === "Browser.setDownloadBehavior")).toBe(
      false,
    );

    connection.emit("Browser.downloadWillBegin", {
      frameId: "child-frame",
      guid: "download-a",
      suggestedFilename: "report.txt",
      url: "https://example.test/report.txt",
    });
    connection.emit("Browser.downloadProgress", { guid: "download-a", state: "completed" });
    expect(
      journal.read({ target: "all", types: ["download_started", "download_finished"] }).events,
    ).toMatchObject([
      { downloadId: "download-a", targetId: "page-a", type: "download_started" },
      { downloadId: "download-a", status: "completed", targetId: "page-a", type: "download_finished" },
    ]);

    connection.emit(
      "Network.requestWillBeSent",
      { request: { headers: {}, method: "GET", url: "https://example.test/fail" }, requestId: "request-a" },
      "session-a",
    );
    connection.emit(
      "Network.loadingFailed",
      { errorText: "failed once", requestId: "request-a" },
      "session-a",
    );
    connection.emit(
      "Network.loadingFailed",
      { errorText: "failed twice", requestId: "request-a" },
      "session-a",
    );
    const failures = journal.read({ target: "all", types: ["request_failed"] }).events;
    expect(failures[0]).toMatchObject({ requestId: "request-a", url: "https://example.test/fail" });
    expect(failures[1]).not.toHaveProperty("url");

    const eventCount = journal.count;
    connection.emit("Target.targetDestroyed", { targetId: "page-a" });
    connection.emit("Browser.downloadWillBegin", {
      frameId: "child-frame",
      guid: "download-after-close",
      suggestedFilename: "stale.txt",
      url: "https://example.test/stale.txt",
    });
    expect(journal.count).toBe(eventCount);
    await observer.stop();
  });

  test("cleans request state when loading finishes", async () => {
    const connection = new FakeCdpClient();
    connection.command = async ({ method }) => {
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "page-a", type: "page", url: "about:blank" }] };
      }
      if (method === "Target.attachToTarget") return { sessionId: "session-a" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-a" } } };
      return {};
    };
    const journal = new BoundedEventJournal(1);
    const observer = new ChromeTargetObserver({
      browserMode: "main",
      connection,
      journal,
      modals: new ActiveModalRegistry(1),
      onError: (error) => {
        throw error;
      },
      registry: new ChromeTargetRegistry(1),
    });
    await observer.start();
    connection.emit(
      "Network.requestWillBeSent",
      { request: { headers: {}, method: "GET", url: "https://example.test/done" }, requestId: "request-a" },
      "session-a",
    );
    connection.emit("Network.loadingFinished", { requestId: "request-a" }, "session-a");
    connection.emit(
      "Network.loadingFailed",
      { errorText: "late failure", requestId: "request-a" },
      "session-a",
    );
    const failures = journal.read({ target: "all", types: ["request_failed"] }).events;
    expect(failures).toHaveLength(1);
    expect(failures[0]).not.toHaveProperty("url");
    await observer.stop();
  });

  test("omits the response byte count Chrome reports as unknown", async () => {
    const connection = new FakeCdpClient();
    connection.command = async ({ method }) => {
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "page-a", type: "page", url: "about:blank" }] };
      }
      if (method === "Target.attachToTarget") return { sessionId: "session-a" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-a" } } };
      return {};
    };
    const journal = new BoundedEventJournal(1);
    const observer = new ChromeTargetObserver({
      browserMode: "main",
      connection,
      journal,
      modals: new ActiveModalRegistry(1),
      onError: (error) => {
        throw error;
      },
      registry: new ChromeTargetRegistry(1),
    });
    await observer.start();
    connection.emit(
      "Network.responseReceived",
      {
        requestId: "request-a",
        response: {
          encodedDataLength: -1,
          headers: {},
          status: 200,
          statusText: "OK",
          url: "data:text/html,x",
        },
      },
      "session-a",
    );
    connection.emit(
      "Network.responseReceived",
      {
        requestId: "request-b",
        response: {
          encodedDataLength: 12,
          headers: {},
          status: 200,
          statusText: "OK",
          url: "https://example.test/",
        },
      },
      "session-a",
    );
    const responses = journal.read({ target: "all", types: ["response"] }).events;
    expect(responses).toHaveLength(2);
    expect(responses[0]).not.toHaveProperty("encodedDataLength");
    expect(responses[1]).toMatchObject({ encodedDataLength: 12 });
    await observer.stop();
  });

  test("clears attribution when Chrome cancels a download", async () => {
    const publications: DownloadFinishedInput[] = [];
    const { connection, journal, observer } = await createDownloadObserver({
      activeConnectionId: () => "connection-a",
      onDownloadFinished: async (input) => {
        publications.push(input);
        return {};
      },
    });

    startDownload(connection, "canceled-download");
    connection.emit("Browser.downloadProgress", { guid: "canceled-download", state: "canceled" });
    connection.emit("Browser.downloadProgress", { guid: "canceled-download", state: "completed" });

    expect(publications).toEqual([]);
    expect(journal.read({ target: "all", types: ["download_finished"] }).events).toMatchObject([
      { downloadId: "canceled-download", status: "canceled", targetId: "page-a" },
    ]);
    await observer.stop();
  });

  test("clears attribution when the download target closes", async () => {
    const publications: DownloadFinishedInput[] = [];
    const { connection, journal, observer } = await createDownloadObserver({
      activeConnectionId: () => "connection-a",
      onDownloadFinished: async (input) => {
        publications.push(input);
        return {};
      },
    });

    startDownload(connection, "closed-target-download");
    connection.emit("Target.targetDestroyed", { targetId: "page-a" });
    connection.emit("Browser.downloadProgress", { guid: "closed-target-download", state: "completed" });

    expect(publications).toEqual([]);
    expect(journal.read({ target: "all", types: ["download_finished"] }).events).toEqual([]);
    await observer.stop();
  });

  test("journals an unowned background download without publishing it", async () => {
    const downloadsPath = await mkdtemp(join(tmpdir(), "chrome-download-attribution-"));
    temporaryDirectories.push(downloadsPath);
    const publications: DownloadFinishedInput[] = [];
    const { connection, journal, observer } = await createDownloadObserver({
      activeConnectionId: () => undefined,
      downloadsPath,
      onDownloadFinished: async (input) => {
        publications.push(input);
        return {};
      },
    });
    await writeFile(join(downloadsPath, "background-download"), "background");

    startDownload(connection, "background-download");
    connection.emit("Browser.downloadProgress", { guid: "background-download", state: "completed" });
    await journal.finished.promise;

    expect(publications).toEqual([]);
    expect(
      journal.read({ target: "all", types: ["download_started", "download_finished"] }).events,
    ).toMatchObject([
      { downloadId: "background-download", targetId: "page-a", type: "download_started" },
      { byteCount: 10, downloadId: "background-download", status: "completed", targetId: "page-a" },
    ]);
    await observer.stop();
  });
});
