import { describe, expect, test } from "bun:test";
import {
  BoundedEventJournal,
  boundedHeaders,
  boundedText,
  type BrowserJournalInput,
  ClientEventCursorStore,
  collectConsoleStackTrace,
} from "./event-journal";

const consoleEvent = (text: string) =>
  ({
    argumentPreviews: [],
    level: "log",
    text: boundedText(text, 32 * 1024),
    type: "console",
  }) satisfies BrowserJournalInput;

describe("BoundedEventJournal", () => {
  test("projects console stacks without changing retained events or cursors", () => {
    const journal = new BoundedEventJournal(1);
    const frame = {
      columnNumber: 2,
      functionName: "caller",
      lineNumber: 3,
      url: "https://example.test/app.js",
    };
    const stackTrace = collectConsoleStackTrace({
      callFrames: [frame],
      parent: { callFrames: [frame], parentId: { id: "unavailable" } },
    });
    journal.append("target-a", { ...consoleEvent("hello"), stackTrace });
    expect(journal.read().events[0]).not.toHaveProperty("stackTrace");
    const detailed = journal.read({ includeStackTraces: true });
    expect(detailed.events[0]).toHaveProperty("stackTrace", {
      frames: [
        { ...frame, asyncDepth: 0 },
        { ...frame, asyncDepth: 1 },
      ],
      truncated: false,
      unavailableParents: true,
    });
    expect(journal.read().nextCursor).toEqual(detailed.nextCursor);
    expect(collectConsoleStackTrace(undefined)).toBeUndefined();
    expect(collectConsoleStackTrace({ callFrames: Array.from({ length: 40 }, () => frame) })).toMatchObject({
      truncated: true,
    });
    expect(collectConsoleStackTrace({ callFrames: [{ ...frame, url: "x".repeat(40_000) }] })).toEqual({
      frames: [],
      truncated: true,
      unavailableParents: false,
    });
  });

  test("assigns generation-local sequence and both timestamp forms", () => {
    let monotonic = 100;
    let wall = 1000;
    const journal = new BoundedEventJournal(4, {
      monotonicNow: () => monotonic,
      wallNow: () => wall,
    });
    monotonic = 125;
    wall = 2000;
    const event = journal.append("target-a", consoleEvent("hello"));
    expect(event).toMatchObject({
      monotonicTime: 25,
      ownerGeneration: 4,
      sequence: 1,
      targetId: "target-a",
      wallTime: new Date(2000).toISOString(),
    });
  });

  test("evicts oldest complete events and reports the cursor gap", () => {
    const journal = new BoundedEventJournal(1, { maxBytes: 1_000_000, maxEvents: 2 });
    journal.append("target-a", consoleEvent("one"));
    journal.append("target-a", consoleEvent("two"));
    journal.append("target-a", consoleEvent("three"));
    const result = journal.read({ after: { ownerGeneration: 1, sequence: 0 }, target: "all" });
    expect(result.events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(result.droppedBefore).toEqual({ ownerGeneration: 1, sequence: 2 });
  });

  test("replaces an oversized event with one journal_drop at the same sequence", () => {
    const journal = new BoundedEventJournal(1, { maxBytes: 10_000, maxEventBytes: 400, maxEvents: 10 });
    const dropped = journal.append("target-a", consoleEvent("x".repeat(2000)));
    expect(dropped).toMatchObject({ originalType: "console", sequence: 1, type: "journal_drop" });
    expect(journal.currentCursor.sequence).toBe(1);
    expect(journal.read({ target: "all" }).events).toHaveLength(1);
  });

  test("filters by target and type while advancing past scanned noise", () => {
    const journal = new BoundedEventJournal(1);
    journal.append("target-a", consoleEvent("a"));
    journal.append("target-b", consoleEvent("b"));
    journal.append("target-a", {
      headers: boundedHeaders({ Accept: "text/html" }),
      isNavigation: true,
      method: "GET",
      requestId: "request-1",
      resourceType: "Document",
      type: "request",
      url: "https://example.test",
    });
    const result = journal.read({ target: "target-a", types: ["request"] });
    expect(result.events.map((event) => event.type)).toEqual(["request"]);
    expect(result.nextCursor.sequence).toBe(3);
  });

  test("reports owner reset and manages independent client cursors", () => {
    const old = new BoundedEventJournal(1);
    const cursors = new ClientEventCursorStore();
    old.append("target-a", consoleEvent("old"));
    cursors.mark("client-a", old);
    const current = new BoundedEventJournal(2);
    current.append("target-a", consoleEvent("new"));
    const reset = cursors.read("client-a", current, { target: "all" });
    expect(reset.ownerReset).toBe(true);
    expect(reset.events).toHaveLength(1);
    expect(cursors.read("client-a", current, { target: "all" }).events).toEqual([]);
    expect(cursors.read("client-b", current, { target: "all" }).events).toHaveLength(1);
  });

  test("caps text on UTF-8 code-point boundaries and normalizes header names", () => {
    expect(boundedText("🙂🙂", 4)).toEqual({ originalBytes: 8, preview: "🙂", previewTruncated: true });
    expect(boundedHeaders({ "X-Test": "value" })).toEqual({
      "x-test": { originalBytes: 5, preview: "value", previewTruncated: false },
    });
  });
});
