import { z } from "zod/v4";

export const CONSOLE_STACK_MAX_FRAMES = 32;
export const CONSOLE_STACK_MAX_ASYNC_DEPTH = 4;
export const CONSOLE_STACK_MAX_BYTES = 32 * 1024;

export const consoleStackTraceSchema = z
  .object({
    frames: z
      .array(
        z
          .object({
            asyncDepth: z.number().int().min(0).max(CONSOLE_STACK_MAX_ASYNC_DEPTH),
            columnNumber: z.number().int().nonnegative(),
            functionName: z.string(),
            lineNumber: z.number().int().nonnegative(),
            url: z.string(),
          })
          .strict(),
      )
      .max(CONSOLE_STACK_MAX_FRAMES),
    truncated: z.boolean(),
    unavailableParents: z.boolean(),
  })
  .strict();

type ConsoleStackTrace = z.infer<typeof consoleStackTraceSchema>;

export const JOURNAL_MAX_EVENTS = 5000;
export const JOURNAL_MAX_BYTES = 16 * 1024 * 1024;
export const JOURNAL_MAX_EVENT_BYTES = 256 * 1024;
export const JOURNAL_HEADER_VALUE_BYTES = 8 * 1024;
export const JOURNAL_FRAME_PREVIEW_BYTES = 64 * 1024;
export const JOURNAL_BINARY_PREVIEW_BYTES = 256;
export const JOURNAL_ERROR_TEXT_BYTES = 32 * 1024;
export const JOURNAL_CRASH_STATUS_BYTES = 256;

export const JOURNAL_READ_DEFAULT_LIMIT = 50;
export const JOURNAL_READ_MAX_LIMIT = 200;
export const JOURNAL_READ_MIN_LIMIT = 1;

export const JOURNAL_EVENT_TYPES = [
  "console",
  "page_error",
  "target_crashed",
  "request",
  "response",
  "request_failed",
  "websocket_open",
  "websocket_frame_sent",
  "websocket_frame_received",
  "websocket_error",
  "websocket_closed",
  "popup",
  "download_started",
  "download_finished",
  "dialog_opened",
  "dialog_closed",
  "file_chooser_opened",
  "file_chooser_closed",
  "journal_drop",
] as const;

export type JournalEventType = (typeof JOURNAL_EVENT_TYPES)[number];

export type BoundedText = Readonly<{
  originalBytes: number;
  preview: string;
  previewTruncated: boolean;
}>;

export type JournalHeaders = Readonly<Record<string, BoundedText>>;

export type BrowserJournalInput =
  | Readonly<{
      accept?: string;
      chooserId: string;
      multiple: boolean;
      type: "file_chooser_opened";
    }>
  | Readonly<{
      accepted: boolean;
      dialogId: string;
      promptText?: string;
      type: "dialog_closed";
    }>
  | Readonly<{
      argumentPreviews: BoundedText[];
      column?: number;
      level: string;
      line?: number;
      sourceUrl?: string;
      stackTrace?: ConsoleStackTrace;
      text: BoundedText;
      type: "console";
    }>
  | Readonly<{
      artifactUri?: string;
      byteCount?: number;
      downloadId: string;
      failureText?: BoundedText;
      status: "canceled" | "completed" | "failed";
      type: "download_finished";
    }>
  | Readonly<{
      binaryBytes?: number;
      binaryHexPreview?: string;
      opcode: number;
      socketId: string;
      text?: BoundedText;
      type: "websocket_frame_received" | "websocket_frame_sent";
    }>
  | Readonly<{ chooserId: string; type: "file_chooser_closed" }>
  | Readonly<{
      defaultValue: string;
      dialogId: string;
      dialogType: string;
      message: BoundedText;
      type: "dialog_opened";
    }>
  | Readonly<{ downloadId: string; suggestedFilename: string; type: "download_started"; url: string }>
  | Readonly<{
      encodedDataLength?: number;
      headers: JournalHeaders;
      requestId: string;
      status: number;
      statusText: string;
      type: "response";
      url: string;
    }>
  | Readonly<{ error: BoundedText; socketId: string; type: "websocket_error" }>
  | Readonly<{ errorCode: number; status: BoundedText; type: "target_crashed" }>
  | Readonly<{ failureText: BoundedText; requestId: string; type: "request_failed"; url?: string }>
  | Readonly<{
      headers: JournalHeaders;
      isNavigation: boolean;
      method: string;
      requestId: string;
      resourceType: string;
      type: "request";
      url: string;
    }>
  | Readonly<{ measuredBytes: number; originalType: JournalEventType; type: "journal_drop" }>
  | Readonly<{ message: BoundedText; name: string; stack?: BoundedText; type: "page_error" }>
  | Readonly<{ openerTargetId?: string; popupTargetId: string; type: "popup" }>
  | Readonly<{ socketId: string; type: "websocket_closed" }>
  | Readonly<{ socketId: string; type: "websocket_open"; url: string }>;

export type BrowserJournalEvent = BrowserJournalInput &
  Readonly<{
    monotonicTime: number;
    ownerGeneration: number;
    sequence: number;
    targetId: string;
    wallTime: string;
  }>;

export type EventCursor = Readonly<{
  ownerGeneration: number;
  sequence: number;
}>;

export type JournalReadOptions = Readonly<{
  after?: EventCursor;
  includeStackTraces?: boolean;
  limit?: number;
  target?: string;
  types?: readonly JournalEventType[];
}>;

export type JournalReadResult = Readonly<{
  droppedBefore: EventCursor | null;
  events: BrowserJournalEvent[];
  nextCursor: EventCursor;
  ownerReset: boolean;
}>;

export type EventJournalOptions = Readonly<{
  maxBytes?: number;
  maxEventBytes?: number;
  maxEvents?: number;
  monotonicNow?: () => number;
  wallNow?: () => number;
}>;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

export const collectConsoleStackTrace = (value: unknown) => {
  const frames: ConsoleStackTrace["frames"] = [];
  let current = value;
  let asyncDepth = 0;
  let isTruncated = false;
  let hasUnavailableParents = false;
  let bytes = 0;

  while (typeof current === "object" && current !== null && !Array.isArray(current)) {
    const callFrames: unknown = Reflect.get(current, "callFrames");
    if (!Array.isArray(callFrames)) {
      break;
    }

    for (const raw of callFrames) {
      const parsed = consoleStackTraceSchema.shape.frames.element.safeParse(
        typeof raw === "object" && raw !== null ?
          {
            asyncDepth,
            columnNumber: Reflect.get(raw, "columnNumber"),
            functionName: Reflect.get(raw, "functionName"),
            lineNumber: Reflect.get(raw, "lineNumber"),
            url: Reflect.get(raw, "url"),
          }
        : raw,
      );
      if (!parsed.success) {
        isTruncated = true;
        continue;
      }

      const frameBytes = utf8Bytes(JSON.stringify(parsed.data)) + 1;
      const hasReachedCaptureLimit =
        frames.length >= CONSOLE_STACK_MAX_FRAMES || bytes + frameBytes > CONSOLE_STACK_MAX_BYTES - 256;
      if (hasReachedCaptureLimit) {
        isTruncated = true;
        break;
      }

      frames.push(parsed.data);
      bytes += frameBytes;
    }

    if (Reflect.get(current, "parentId") !== undefined) {
      hasUnavailableParents = true;
    }

    const parent: unknown = Reflect.get(current, "parent");
    if (parent === undefined) {
      break;
    }

    const hasReachedParentLimit =
      asyncDepth >= CONSOLE_STACK_MAX_ASYNC_DEPTH || frames.length >= CONSOLE_STACK_MAX_FRAMES || isTruncated;
    if (hasReachedParentLimit) {
      isTruncated = true;
      break;
    }

    asyncDepth += 1;
    current = parent;
  }

  if (value === undefined) return undefined;
  return { frames, truncated: isTruncated, unavailableParents: hasUnavailableParents };
};

export const boundedText = (value: string, maxBytes: number): BoundedText => {
  const originalBytes = utf8Bytes(value);
  if (originalBytes <= maxBytes) {
    return Object.freeze({ originalBytes, preview: value, previewTruncated: false });
  }
  let used = 0;
  let preview = "";
  for (const character of value) {
    const bytes = utf8Bytes(character);
    if (used + bytes > maxBytes) break;
    preview += character;
    used += bytes;
  }
  return Object.freeze({ originalBytes, preview, previewTruncated: true });
};

export const boundedHeaders = (
  headers: Record<string, string>,
  maxBytes = JOURNAL_HEADER_VALUE_BYTES,
): JournalHeaders => {
  const normalized: Record<string, BoundedText> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = boundedText(value, maxBytes);
  }
  return Object.freeze(normalized);
};

const eventBytes = (event: BrowserJournalEvent): number => utf8Bytes(JSON.stringify(event));

const createReplacementDrop = (
  event: BrowserJournalEvent,
  measuredBytes: number,
  originalType: JournalEventType,
): BrowserJournalEvent => {
  return Object.freeze({
    measuredBytes,
    monotonicTime: event.monotonicTime,
    originalType,
    ownerGeneration: event.ownerGeneration,
    sequence: event.sequence,
    targetId: event.targetId,
    type: "journal_drop",
    wallTime: event.wallTime,
  });
};

export class BoundedEventJournal {
  readonly ownerGeneration: number;

  #bytes = 0;
  #events: { bytes: number; event: BrowserJournalEvent }[] = [];
  #generationStartedAt: number;
  #maxBytes: number;
  #maxEventBytes: number;
  #maxEvents: number;
  #monotonicNow: () => number;
  #sequence = 0;
  #wallNow: () => number;

  constructor(ownerGeneration: number, options: EventJournalOptions = {}) {
    this.ownerGeneration = ownerGeneration;
    this.#maxBytes = options.maxBytes ?? JOURNAL_MAX_BYTES;
    this.#maxEventBytes = options.maxEventBytes ?? JOURNAL_MAX_EVENT_BYTES;
    this.#maxEvents = options.maxEvents ?? JOURNAL_MAX_EVENTS;
    this.#monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
    this.#wallNow = options.wallNow ?? Date.now;
    this.#generationStartedAt = this.#monotonicNow();
  }

  get byteSize(): number {
    return this.#bytes;
  }

  get count(): number {
    return this.#events.length;
  }

  get currentCursor(): EventCursor {
    return Object.freeze({ ownerGeneration: this.ownerGeneration, sequence: this.#sequence });
  }

  get firstRetainedCursor(): EventCursor {
    return Object.freeze({
      ownerGeneration: this.ownerGeneration,
      sequence: this.#events[0]?.event.sequence ?? this.#sequence + 1,
    });
  }

  append(targetId: string, input: BrowserJournalInput): BrowserJournalEvent {
    const event = this.#createEvent(targetId, input);
    const measuredBytes = eventBytes(event);
    const retained =
      measuredBytes <= this.#maxEventBytes ? event : createReplacementDrop(event, measuredBytes, input.type);
    const retainedBytes = eventBytes(retained);
    this.#events.push({ bytes: retainedBytes, event: retained });
    this.#bytes += retainedBytes;
    this.#evict();
    return retained;
  }

  read(options: JournalReadOptions = {}): JournalReadResult {
    const limit = options.limit ?? JOURNAL_READ_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < JOURNAL_READ_MIN_LIMIT || limit > JOURNAL_READ_MAX_LIMIT) {
      throw new Error(
        `Journal limit must be from ${JOURNAL_READ_MIN_LIMIT} through ${JOURNAL_READ_MAX_LIMIT}`,
      );
    }

    const supplied = options.after;
    const ownerReset = supplied !== undefined && supplied.ownerGeneration !== this.ownerGeneration;
    const afterSequence = ownerReset ? 0 : (supplied?.sequence ?? 0);
    const firstSequence = this.#events[0]?.event.sequence ?? this.#sequence + 1;
    const droppedBefore = afterSequence < firstSequence - 1 ? this.firstRetainedCursor : null;
    const types = options.types ? new Set(options.types) : undefined;
    const events: BrowserJournalEvent[] = [];
    let scannedSequence = afterSequence;

    for (const entry of this.#events) {
      if (entry.event.sequence <= afterSequence) continue;
      scannedSequence = entry.event.sequence;
      if (options.target && options.target !== "all" && entry.event.targetId !== options.target) continue;
      if (types && !types.has(entry.event.type)) continue;
      if (entry.event.type === "console" && !options.includeStackTraces) {
        const { stackTrace, ...event } = entry.event;
        events.push(event);
      } else {
        events.push(entry.event);
      }
      if (events.length === limit) break;
    }
    if (events.length < limit) scannedSequence = this.#sequence;
    return Object.freeze({
      droppedBefore,
      events,
      nextCursor: Object.freeze({ ownerGeneration: this.ownerGeneration, sequence: scannedSequence }),
      ownerReset,
    });
  }

  #createEvent(targetId: string, input: BrowserJournalInput): BrowserJournalEvent {
    this.#sequence++;
    return Object.freeze({
      ...input,
      monotonicTime: this.#monotonicNow() - this.#generationStartedAt,
      ownerGeneration: this.ownerGeneration,
      sequence: this.#sequence,
      targetId,
      wallTime: new Date(this.#wallNow()).toISOString(),
    });
  }

  #evict(): void {
    while (this.#events.length > this.#maxEvents || this.#bytes > this.#maxBytes) {
      const removed = this.#events.shift();
      if (!removed) break;
      this.#bytes -= removed.bytes;
    }
  }
}

export class ClientEventCursorStore {
  #cursors = new Map<string, EventCursor>();

  mark(clientId: string, journal: BoundedEventJournal): EventCursor {
    const cursor = journal.currentCursor;
    this.#cursors.set(clientId, cursor);
    return cursor;
  }

  read(
    clientId: string,
    journal: BoundedEventJournal,
    options: JournalReadOptions & Readonly<{ advance?: boolean }> = {},
  ): JournalReadResult {
    const after = options.after ?? this.#cursors.get(clientId);
    const result = journal.read({ ...options, ...(after ? { after } : {}) });
    if (options.after === undefined || options.advance === true) {
      this.#cursors.set(clientId, result.nextCursor);
    }
    return result;
  }

  removeClient(clientId: string): void {
    this.#cursors.delete(clientId);
  }
}
