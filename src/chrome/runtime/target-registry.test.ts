import { describe, expect, test } from "bun:test";
import { ActiveModalRegistry } from "./modals";
import { ChromeTargetRegistry, ClientSelectionStore } from "./target-registry";

const targetInput = (targetId: string) => ({ targetId, title: "Duplicate", url: "https://example.test" });

const readyTarget = (registry: ChromeTargetRegistry, targetId: string) => {
  const record = registry.beginArming(targetInput(targetId));
  registry.markReady(targetId);
  return record;
};

describe("ChromeTargetRegistry and client selection", () => {
  test("keeps arming targets live but excludes them from readiness-based selection", () => {
    const registry = new ChromeTargetRegistry(7);
    const arming = registry.beginArming(targetInput("target-a"));
    const identity = registry.identity("target-a");

    expect(registry.get(identity)).toBe(arming);
    expect(registry.liveRecords()).toEqual([arming]);
    expect(registry.ready(identity)).toBeUndefined();
    expect(registry.readyRecords()).toEqual([]);
    expect(registry.first()).toBeUndefined();
    expect(() => registry.requireReady(identity)).toThrow();

    registry.activate("target-a");
    registry.update("target-a", { title: "Arming" });
    registry.markReady("target-a");
    expect(registry.first()).toEqual(identity);
    expect(registry.mostRecentlyActive()).toEqual(identity);

    const selections = new ClientSelectionStore(registry);
    selections.addClient("client-a");
    const transaction = selections.begin("client-a");
    registry.beginArming(targetInput("target-b"));
    const armingIdentity = registry.identity("target-b");
    expect(() => transaction.select(armingIdentity)).toThrow();
    expect(() => transaction.recordCreated(armingIdentity)).toThrow();
    expect(transaction.commit()).toEqual(identity);

    registry.close("target-a");
    expect(registry.ready(identity)).toBeUndefined();
    expect(registry.readyRecords()).toEqual([]);
  });

  test("uses generation and Chrome target ID instead of duplicate URL, title, or index", () => {
    const registry = new ChromeTargetRegistry(7);
    const first = readyTarget(registry, "target-a");
    const second = readyTarget(registry, "target-b");
    expect(first.creationSequence).toBe(1);
    expect(second.creationSequence).toBe(2);
    expect(registry.identity("target-a")).toEqual({ ownerGeneration: 7, targetId: "target-a" });
    expect(() => registry.require({ ownerGeneration: 6, targetId: "target-a" })).toThrow();
  });

  test("gives new clients the most recently active page without changing existing selection", () => {
    const registry = new ChromeTargetRegistry(1);
    readyTarget(registry, "target-a");
    readyTarget(registry, "target-b");
    const selections = new ClientSelectionStore(registry);
    expect(selections.addClient("client-a").targetId).toBe("target-a");
    registry.activate("target-b");
    expect(selections.addClient("client-b").targetId).toBe("target-b");
    expect(selections.selected("client-a").targetId).toBe("target-a");
  });

  test("commits explicit selection ahead of pages created by the call", () => {
    const registry = new ChromeTargetRegistry(1);
    readyTarget(registry, "target-a");
    const selections = new ClientSelectionStore(registry);
    selections.addClient("client");
    const transaction = selections.begin("client");
    readyTarget(registry, "target-b");
    readyTarget(registry, "target-c");
    transaction.select(registry.identity("target-b"));
    expect(transaction.commit().targetId).toBe("target-b");
    expect(selections.selected("client").targetId).toBe("target-b");
  });

  test("selects the newest page on success and rolls selection back on failure", () => {
    const registry = new ChromeTargetRegistry(1);
    readyTarget(registry, "target-a");
    const selections = new ClientSelectionStore(registry);
    selections.addClient("client");
    const successful = selections.begin("client");
    readyTarget(registry, "target-b");
    readyTarget(registry, "target-c");
    successful.recordCreated(registry.identity("target-b"));
    successful.recordCreated(registry.identity("target-c"));
    expect(successful.commit().targetId).toBe("target-c");

    const failed = selections.begin("client");
    readyTarget(registry, "target-d");
    failed.recordCreated(registry.identity("target-d"));
    failed.select(registry.identity("target-d"));
    expect(failed.rollback().targetId).toBe("target-c");
    expect(selections.selected("client").targetId).toBe("target-c");
  });

  test("ignores unrelated targets not recorded by the call", () => {
    const registry = new ChromeTargetRegistry(1);
    readyTarget(registry, "target-a");
    const selections = new ClientSelectionStore(registry);
    selections.addClient("client");
    const transaction = selections.begin("client");
    readyTarget(registry, "unrelated-tab");
    expect(transaction.commit().targetId).toBe("target-a");
  });

  test("falls back only clients whose selected target closed", () => {
    const registry = new ChromeTargetRegistry(1);
    readyTarget(registry, "target-a");
    readyTarget(registry, "target-b");
    readyTarget(registry, "target-c");
    const selections = new ClientSelectionStore(registry);
    selections.addClient("client-a");
    selections.addClient("client-b");
    const chooseB = selections.begin("client-a");
    chooseB.select(registry.identity("target-b"));
    chooseB.commit();
    const chooseC = selections.begin("client-b");
    chooseC.select(registry.identity("target-c"));
    chooseC.commit();
    const closed = registry.close("target-b");
    if (!closed) throw new Error("Expected target-b to close");
    selections.onTargetClosed(closed);
    expect(selections.selected("client-a").targetId).toBe("target-a");
    expect(selections.selected("client-b").targetId).toBe("target-c");
  });
});

describe("ActiveModalRegistry", () => {
  test("keeps generation-bound dialog and file chooser identities", () => {
    const target = { ownerGeneration: 3, targetId: "target-a" };
    const modals = new ActiveModalRegistry(3);
    const dialog = modals.openDialog(target, "session-a", {
      defaultValue: "",
      dialogType: "alert",
      message: "Confirm",
    });
    expect(modals.dialog(target)?.dialogId).toBe(dialog.dialogId);
    expect(modals.blockingModal(target)).toEqual({ dialog, type: "dialog" });
    expect(() => modals.requireUnblocked(target)).toThrow();
    modals.closeDialog(target, dialog.dialogId);
    expect(() => modals.closeDialog(target, dialog.dialogId)).toThrow();

    const chooser = modals.openFileChooser(target, "session-a", { backendNodeId: 42, multiple: true });
    expect(modals.fileChooser(target)?.chooserId).toBe(chooser.chooserId);
    expect(() => modals.fileChooser({ ownerGeneration: 2, targetId: "target-a" })).toThrow();
  });
});
