import type { FastMCP } from "#fastmcp";
import type { ToolSessionContext } from "../../mcp/session-context";
import {
  ARTIFACT_CHUNK_BYTES,
  ARTIFACT_CONNECTION_MAX_BYTES,
  ARTIFACT_DIRECT_CONTENT_BYTES,
  ARTIFACT_MAX_BYTES,
  ORDINARY_CALL_MAX_ARTIFACTS,
  ORDINARY_CALL_MAX_BYTES,
} from "../artifacts";
import { MAX_NATIVE_DEVICE_SCALE_FACTOR, MIN_NATIVE_DEVICE_SCALE_FACTOR } from "../browser-modes";
import { CAPTURE_BODY_LIMITS, MAX_HAR_BYTES } from "../captures";
import { HEAP_RESULT_DEFAULT_LIMIT, HEAP_RESULT_MAX_LIMIT } from "../diagnostics/heap-analysis-protocol";
import {
  BROWSER_MODES,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  EXECUTION_ERROR_CODES,
  INLINE_IMAGE_MAX_BYTES,
  INLINE_IMAGE_MAX_COUNT,
  INLINE_IMAGE_MAX_TOTAL_BYTES,
  INLINE_TEXT_MAX_BYTES,
  MAX_EXECUTION_TIMEOUT_MS,
  MIN_EXECUTION_TIMEOUT_MS,
  SNAPSHOT_DEFAULT_MAX_BYTES,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_DEPTH,
  SNAPSHOT_MIN_BYTES,
  SNAPSHOT_MIN_DEPTH,
  SNAPSHOT_RETAINED_COUNT,
  STATE_KEY_MAX_BYTES,
  STATE_TOTAL_MAX_BYTES,
  STATE_VALUE_MAX_BYTES,
} from "../execution";
import instructions from "../instructions.md" with { type: "text" };
import {
  JOURNAL_EVENT_TYPES,
  JOURNAL_MAX_BYTES,
  JOURNAL_MAX_EVENTS,
  JOURNAL_READ_DEFAULT_LIMIT,
  JOURNAL_READ_MAX_LIMIT,
  JOURNAL_READ_MIN_LIMIT,
  PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS,
  PERSISTENT_BINDING_MAX_PAYLOAD_BYTES,
  PERSISTENT_BINDING_WORKER_TIMEOUT_MS,
  PERSISTENT_MUTATION_MAX_COUNT_PER_KIND,
  PERSISTENT_MUTATION_MAX_ENTRY_BYTES,
  PERSISTENT_MUTATION_MAX_TOTAL_BYTES,
} from "../runtime";
import {
  CONSOLE_STACK_MAX_ASYNC_DEPTH,
  CONSOLE_STACK_MAX_BYTES,
  CONSOLE_STACK_MAX_FRAMES,
} from "../runtime/event-journal";
import { REACT_ANALYSIS_RESULT_MAX_BYTES } from "../runtime/react-inspection-protocol";
import {
  CHROME_CAPABILITY_CAPTURE_TYPES,
  CHROME_CAPABILITY_CDP_METHODS,
  CHROME_CAPABILITY_LIMIT_FIELDS,
} from "./contracts";

const mebibytes = (bytes: number): number => bytes / (1024 * 1024);
const browserModeType = BROWSER_MODES.map((mode) => JSON.stringify(mode)).join(" | ");
const executionErrorCodeType = EXECUTION_ERROR_CODES.map((code) => JSON.stringify(code)).join(" | ");
const journalEventType = JOURNAL_EVENT_TYPES.map((type) => JSON.stringify(type)).join(" | ");
const capabilityCaptureType = CHROME_CAPABILITY_CAPTURE_TYPES.map((type) => JSON.stringify(type)).join(" | ");
const capabilityLimitField = CHROME_CAPABILITY_LIMIT_FIELDS.map((field) => JSON.stringify(field)).join(" | ");
const capabilityCdpMethod = CHROME_CAPABILITY_CDP_METHODS.map((method) => JSON.stringify(method)).join(" | ");

type ChromeDoc = Readonly<{
  mimeType?: string;
  name: string;
  text: string;
  uri: string;
}>;

type ChromeHelperDocumentation = Readonly<{
  uri: string;
  imports: readonly string[];
  types: readonly string[];
  members: Readonly<Record<string, string>>;
}>;

const jsonDeclaration = "type Json = null | boolean | number | string | Json[] | { [key: string]: Json };";
const artifactDeclaration =
  "type Artifact = { artifactId: string; name: string; uri: string; mediaType: string; size: number; sha256: string; complete: boolean; createdAt: string; expiresAt: string | null };";
const journalDeclarations = [
  jsonDeclaration,
  "type EventCursor = { ownerGeneration: number; sequence: number };",
  "type JournalReadResult = { events: Json[]; nextCursor: EventCursor; droppedBefore: EventCursor | null; ownerReset: boolean };",
];

const coreHelpers: ChromeHelperDocumentation = {
  uri: "chrome-docs://run-playwright",
  imports: ["Page"],
  types: [
    jsonDeclaration,
    `type ChromeMcpErrorCode = ${executionErrorCodeType};`,
    "interface ChromeMcpError extends Error { readonly code: ChromeMcpErrorCode }",
  ],
  members: {
    evaluateWorker: "(input: { targetId: string; expression: string }): Promise<Json | undefined>;",
    selectPageForSession: "(page: Page): Promise<void>;",
    reportCallProgress: "(message: string, current?: number, total?: number): Promise<void>;",
  },
};

const stateHelpers: ChromeHelperDocumentation = {
  uri: "chrome-docs://state",
  imports: [],
  types: [jsonDeclaration],
  members: {
    clearSessionState: "(): undefined;",
    deleteSessionStateValue: "(key: string): undefined;",
    getSessionStateValue: "(key: string): Json | undefined;",
    listSessionStateEntries: "(): [string, Json][];",
    setSessionStateValue: "(key: string, value: Json): undefined;",
  },
};

const eventHelpers: ChromeHelperDocumentation = {
  uri: "chrome-docs://events",
  imports: [],
  types: [
    ...journalDeclarations,
    "type ConsoleStackTrace = { frames: { asyncDepth: number; columnNumber: number; functionName: string; lineNumber: number; url: string }[]; truncated: boolean; unavailableParents: boolean };",
    `type JournalEventType = ${journalEventType};`,
    `type EventReadOptions = {
  after?: EventCursor;
  advance?: boolean;
  includeStackTraces?: boolean;
  /** Integer from ${JOURNAL_READ_MIN_LIMIT} through ${JOURNAL_READ_MAX_LIMIT}, inclusive; defaults to ${JOURNAL_READ_DEFAULT_LIMIT}. */
  limit?: number;
  target?: "selected" | "all" | string;
  types?: JournalEventType[];
};`,
  ],
  members: {
    events:
      ": { mark(): Promise<EventCursor>; read(options?: EventReadOptions): Promise<JournalReadResult> };",
  },
};

const snapshotHelpers: ChromeHelperDocumentation = {
  uri: "chrome-docs://snapshots",
  imports: ["Locator"],
  types: [
    artifactDeclaration,
    "type SnapshotOptions = { root?: Locator; depth?: number; includeBoxes?: boolean; maxBytes?: number; diffFrom?: string; view?: 'bounded' | 'full' };",
    "type SnapshotCounts = { treeLines: number; refs: number; added: number; removed: number; changed: number };",
    "type SnapshotData = { snapshotId: string; targetId: string; url: string; title: string; capturedAt: string; tree?: string; added?: string[]; removed?: string[]; changed?: string[]; refs: Record<string, { role: string; name: string }> };",
    "type SnapshotResult = Omit<SnapshotData, 'url' | 'title'> & { view: 'bounded' | 'full'; url?: string; title?: string; totals: SnapshotCounts; omitted: SnapshotCounts & { metadataFields: ('url' | 'title')[] }; omissionReason: 'maxBytes' | null; artifact?: Artifact; dataArtifact?: Artifact };",
  ],
  members: {
    captureAccessibilitySnapshot: "(options?: SnapshotOptions): Promise<SnapshotResult>;",
    resolveSnapshotRefToLocator: "(ref: string): Promise<Locator>;",
  },
};

const captureHelpers: ChromeHelperDocumentation = {
  uri: "chrome-docs://captures",
  imports: [],
  types: [
    artifactDeclaration,
    `type CaptureStartOptions =
  | { type: "trace"; screenshots?: boolean; snapshots?: boolean; sources?: boolean }
  | { type: "har"; content?: "omit" | "embed" | "attach"; urlFilter?: string }
  | { type: "network-bodies"; maxBodyBytes?: number; maxTotalBytes?: number; mimeTypes?: string[] }
  | { type: "video"; format?: "webm"; width?: number; height?: number; framesPerSecond?: number };`,
    'type CaptureStartResult = { captureId: string; type: CaptureStartOptions["type"]; targetId: string; startedAt: string };',
    'type CaptureStopResult = { captureId: string; type: CaptureStartOptions["type"]; targetId: string; status: "completed" | "incomplete"; startedAt: string; stoppedAt: string; byteCount: number; artifact?: Artifact; artifacts: Artifact[]; warnings: string[] };',
  ],
  members: {
    capture:
      ": { start(options: CaptureStartOptions): Promise<CaptureStartResult>; stop(captureId: string): Promise<CaptureStopResult> };",
  },
};

const checkpointHelpers: ChromeHelperDocumentation = {
  uri: "chrome-docs://checkpoints",
  imports: [],
  types: [
    ...journalDeclarations,
    artifactDeclaration,
    "type CheckpointCreateOptions = { name?: string; screenshot?: boolean; storage?: boolean };",
    "type CheckpointDiffOptions = { snapshot?: boolean; screenshot?: boolean; events?: boolean; storage?: boolean };",
    "type CheckpointResult = { checkpointId: string; targetId: string; eventCursor: EventCursor; snapshotId: string; artifact: Artifact; artifacts: Artifact[] };",
    "type ValueChange<T> = { changed: boolean; before: T; after: T };",
    "type CheckpointDiffReport = { checkpointId: string; targetId: string; comparedAt: string; url: ValueChange<string>; title: ValueChange<string>; viewport: ValueChange<{ width: number; height: number } | null>; snapshot?: { added: { ref?: string; text: string }[]; removed: { ref?: string; text: string }[]; changed: { ref: string; before: string; after: string }[] }; events?: JournalReadResult; storage?: { cookies: { added: string[]; removed: string[]; changed: string[] }; localStorage: { added: string[]; removed: string[]; changed: string[] } }; pixels?: { width: number; height: number; changedPixels: number; totalPixels: number; ratio: number } };",
    "type CheckpointDiffResult = { checkpointId: string; targetId: string; artifact: Artifact; artifacts: Artifact[]; report: CheckpointDiffReport };",
  ],
  members: {
    checkpoint:
      ": { create(options?: CheckpointCreateOptions): Promise<CheckpointResult>; diff(checkpointId: string, options?: CheckpointDiffOptions): Promise<CheckpointDiffResult> };",
  },
};

const artifactHelpers: ChromeHelperDocumentation = {
  uri: "chrome-docs://artifacts",
  imports: [],
  types: [artifactDeclaration],
  members: {
    emitImageResult:
      '(buffer: Uint8Array, options?: { mediaType?: "image/png" | "image/jpeg" | "image/webp" }): undefined;',
    emitTextResult: "(value: string): undefined;",
    publishFileArtifact: "(path: string, mediaType?: string): Promise<Artifact>;",
    reserveArtifactOutputPath: "(name: string, mediaType?: string): Promise<string>;",
  },
};

const capabilityHelpers: ChromeHelperDocumentation = {
  uri: "chrome-docs://capabilities",
  imports: [],
  types: [
    `type BrowserMode = ${browserModeType};`,
    `type ChromeCapabilities = Readonly<{
  playwrightVersion: string;
  chromeProduct: string;
  cdpProtocolVersion: string;
  browserMode: BrowserMode;
  browserOwnership: "attached" | "launched";
  headless: boolean;
  nativeDeviceScaleFactor?: number;
  selectedTargetId: string;
  workspaceShared: boolean;
  captures: Readonly<Record<${capabilityCaptureType}, Readonly<{ activeConflict: boolean; supported: boolean }>>>;
  limits: Readonly<Record<${capabilityLimitField}, number>>;
  journal: Readonly<{ currentSequence: number; eventCount: number; firstRetainedSequence: number; retainedBytes: number }>;
  cdp: Readonly<Record<${capabilityCdpMethod}, boolean>>;
}>;`,
  ],
  members: {
    "readonly capabilities": ": ChromeCapabilities;",
  },
};

const registryHelpers: ChromeHelperDocumentation = {
  uri: "chrome-docs://registry",
  imports: [],
  types: [
    'type PersistentRouteAbortReason = "Aborted" | "AccessDenied" | "AddressUnreachable" | "BlockedByClient" | "BlockedByResponse" | "ConnectionAborted" | "ConnectionClosed" | "ConnectionFailed" | "ConnectionRefused" | "ConnectionReset" | "Failed" | "InternetDisconnected" | "NameNotResolved" | "TimedOut";',
    `type PersistentRouteActionInput =
  | { type: "continue" }
  | { type: "abort"; errorReason?: PersistentRouteAbortReason }
  | { type: "fulfill"; status?: number; headers?: Record<string, string>; body?: string };`,
    `type PersistentRouteAction =
  | { type: "continue" }
  | { type: "abort"; errorReason: PersistentRouteAbortReason }
  | { type: "fulfill"; status: number; headers: Record<string, string>; body: string };`,
    'type PersistentRoute = { id: string; kind: "route"; urlPattern: string; method?: string; action: PersistentRouteAction };',
    'type PersistentInitScript = { id: string; kind: "initScript"; source: string };',
    'type PersistentBinding = { id: string; kind: "binding"; name: string; source: string };',
  ],
  members: {
    "readonly routes":
      ": { add(input: { urlPattern: string; method?: string; action: PersistentRouteActionInput }): Promise<PersistentRoute>; list(): Promise<PersistentRoute[]>; remove(id: string): Promise<boolean>; clear(): Promise<number> };",
    "readonly initScripts":
      ": { add(source: string): Promise<PersistentInitScript>; list(): Promise<PersistentInitScript[]>; remove(id: string): Promise<boolean>; clear(): Promise<number> };",
    "readonly bindings":
      ": { add(input: { name: string; source: string }): Promise<PersistentBinding>; list(): Promise<PersistentBinding[]>; remove(id: string): Promise<boolean>; clear(): Promise<number> };",
  },
};

const modalHelpers: ChromeHelperDocumentation = {
  uri: "chrome-docs://modals",
  imports: [],
  types: ["type FilePayload = { name: string; mimeType: string; buffer: Uint8Array };"],
  members: {
    "readonly dialog":
      ': undefined | { type: "alert" | "beforeunload" | "confirm" | "prompt"; message: string; defaultValue: string; accept(promptText?: string): Promise<void>; dismiss(): Promise<void> };',
    "readonly fileChooser":
      ": undefined | { isMultiple: boolean; accept: string; setFiles(files: string | string[] | FilePayload | FilePayload[]): Promise<void> };",
  },
};

const pwaHelpers: ChromeHelperDocumentation = {
  uri: "chrome-docs://pwa",
  imports: ["Page"],
  types: [
    "type PwaIdentity = { manifestId: string };",
    'type PwaInstallInput = PwaIdentity & { installUrl: string; displayMode?: "browser" | "standalone" };',
    "type PwaLaunchInput = PwaIdentity & { url?: string };",
    "type PwaState = { badgeCount: number; fileHandlers: { action: string; displayName: string; accepts: { mediaType: string; fileExtensions: string[] }[] }[] };",
  ],
  members: {
    "readonly pwa":
      ': { install(input: PwaInstallInput): Promise<{ operation: "install"; manifestId: string; displayMode: "browser" | "standalone" }>; launch(input: PwaLaunchInput): Promise<Page>; getState(input: PwaIdentity): Promise<PwaState>; uninstall(input: PwaIdentity): Promise<{ operation: "uninstall"; manifestId: string }> };',
  },
};

const helperDocumentation = [
  coreHelpers,
  stateHelpers,
  eventHelpers,
  snapshotHelpers,
  captureHelpers,
  checkpointHelpers,
  artifactHelpers,
  capabilityHelpers,
  registryHelpers,
  modalHelpers,
  pwaHelpers,
];

export const renderChromeHelperDeclarations = (families: readonly ChromeHelperDocumentation[]) => {
  const imports = [...new Set(families.flatMap((family) => family.imports))];
  const types = [...new Set(families.flatMap((family) => family.types))];
  const members = families.flatMap((family) =>
    Object.entries(family.members).map(([name, signature]) => `  ${name}${signature}`),
  );
  return [
    ...(imports.length === 0 ? [] : [`import type { ${imports.join(", ")} } from "playwright-core";`]),
    ...types,
    "interface ChromeSessionHelper {",
    ...members,
    "}",
    "declare const chrome: ChromeSessionHelper;",
  ].join("\n");
};

const helperIndex = helperDocumentation
  .map(
    (family) =>
      `- ${Object.keys(family.members)
        .map((name) => `\`chrome.${name.replace(/^readonly /, "")}\``)
        .join(", ")}: ${family.uri}`,
  )
  .join("\n");

export const CHROME_REACT_PROFILE_DOC_URI = "chrome-docs://react-profiling";
export const CHROME_INSTRUCTIONS_DOC_URI = "chrome-docs://instructions";
export const CHROME_INSTRUCTIONS_DOC_NOTICE = `If this server's instructions are not in your context, read ${CHROME_INSTRUCTIONS_DOC_URI} before the first browser call: it holds the rules for browser modes, visible windows, the user's own Chrome, and closing browsers.`;
export const REACT_PROFILE_STOP_NOTICE =
  "react_profile_stop stops commit recording but leaves React DevTools instrumentation installed. Later React updates can still send bridge messages, and reload is not a reliable reset.";

const DOCS: readonly ChromeDoc[] = [
  {
    uri: coreHelpers.uri,
    name: "run_playwright contract",
    text: `# run_playwright

${CHROME_INSTRUCTIONS_DOC_NOTICE}

Submit a non-empty async JavaScript statement body. The runtime binds the Playwright \`page\`, \`context\`, and \`browser\` objects from the active browser, structured-cloned \`args\`, and the \`chrome\` session helper. Use an explicit \`return\`; the runtime does not rewrite a final expression. This is trusted host code execution, not a sandbox.

Browser ownership is scoped to the MCP connection and browser mode, not to one call or agent. \`isolated-headless\` and \`isolated-virtual-display\` additionally require a caller-chosen \`browserInstanceId\` on every browser-selecting call. Omit it for all other modes. Pass the same ID on later browser and diagnostic calls to reuse that instance; React profile stop and analyze use only the returned profile ID, without browser arguments. Use another ID to launch another reusable browser. Different IDs can run concurrently; calls using the same ID execute in FIFO order. Do not add a cleanup-only call to close the prebound \`page\` when finishing a task; leave it open for reuse and automatic cleanup. Close extra pages you created with \`page.close()\` when no longer needed. The runtime selects a surviving page automatically; use \`await chrome.selectPageForSession(replacementPage)\` only when a particular replacement matters. Closing the last usable page makes call finalization fail with \`CHROME_MCP_PAGE_CLOSED\`; browser actions are not undone, so do not retry a completed close. A context created with \`browser.newContext()\` lives only until the call ends: Playwright disposes it with the worker connection, so its pages cannot be selected for the session and \`selectPageForSession\` rejects them with \`CHROME_MCP_FOREIGN_PAGE\`. Open a page that must persist with \`context.newPage()\` in the prebound context. Browser-owner close is one terminal transaction across Playwright execution, owner authorization, Chrome process exit, selection invalidation, broker admission completion, service mode termination, and next-call recovery. When an isolated browser is no longer needed by its owning task, call \`browser.close()\` or close the prebound default \`context\`, including after earlier calls or recovery. The MCP connection must be its sole client and no other call may be queued. For \`isolated-headless\` and \`isolated-virtual-display\`, close the same \`browserInstanceId\` used by the task and preserve its native scale. Keep each ID dedicated to its owning task; do not close an instance another agent still needs. A visible \`isolated\` browser has no idle timeout: only the root agent closes it once the requested work no longer needs it and the user does not want it left open; a subagent leaves it for its parent. Shared modes may be closed only in a newly launched owner's first admitted call, with one client and nothing queued; prior shared use, adoption, or recovery remains protected. Rejected owner closes report \`CHROME_MCP_BROWSER_CLOSE_FORBIDDEN\`. Raw CDP \`Browser.close\` follows the same rule. Attached browsers remain user-owned; close pages or additional contexts created by your call instead of the browser owner. An authorized owner close is terminal for the current statement body. Return immediately after it succeeds; do not use \`page\`, \`context\`, \`browser\`, or \`chrome\` helpers afterward. The result has no selected target. The next call recovers a fresh browser owner; selected-page state, session state, refs, event cursors, and active captures tied to the terminated owner are invalidated.

One call can perform a complete flow. The selected browser, the prebound context, its pages, and permissions granted with \`context.grantPermissions\` survive across calls that use the same browser mode and, for \`isolated-headless\` or \`isolated-virtual-display\`, the same \`browserInstanceId\`; \`context.clearPermissions()\` is the only reset short of owner close. The JavaScript worker, any context the call created, and emulation applied through the worker's own CDP sessions such as \`context.setGeolocation\` and \`context.setExtraHTTPHeaders\` are disposable and end with the call, so apply them in the call that depends on them. Native \`page.route()\` and \`context.route()\` handlers are worker-local and end with the call. Register them in each call that needs them; for persistent declarative routes, use \`chrome.routes\` as documented in \`chrome-docs://registry\`. When a call ends, the broker aborts requests still paused by that call's native route handlers before detaching their sessions, including after timeout, cancellation, or worker failure. If cleanup cannot be confirmed, the call reports an error and retains the affected sessions rather than releasing their paused requests. This does not undo requests already sent or protect against browser disconnection. For UI-only checks, prefer a synthetic response over leaving a real mutation paused. Keep a reliable flow together; split a long or failure-prone flow after useful browser-visible or helper-state checkpoints so a later call on the same browser instance can resume without rebuilding everything. Await every Promise helper, including \`chrome.captureAccessibilitySnapshot()\`, \`chrome.resolveSnapshotRefToLocator(ref)\`, and \`chrome.selectPageForSession(page)\`, plus the exact navigation, page, dialog, file chooser, response, or download event you need. \`chrome.resolveSnapshotRefToLocator(ref)\` resolves to a Playwright Locator; the Promise itself has no locator methods. There is no automatic settle delay and no automatic snapshot, event log, page list, or source echo. The worker execution \`timeoutMs\` accepts ${MIN_EXECUTION_TIMEOUT_MS} through ${MAX_EXECUTION_TIMEOUT_MS} milliseconds and defaults to ${DEFAULT_EXECUTION_TIMEOUT_MS}. It excludes queue waiting, browser setup, and call finalization; it is not an end-to-end call deadline.

Raw device-metrics overrides are owned by the CDP session that applies them. Playwright \`page.screenshot()\` and \`locator.screenshot()\` capture through a different session; Chromium can apply and restore that session's metrics, changing DPR or capturing at the wrong scale. \`scale: "css"\` selects image pixel scaling and does not preserve a raw override. For exact-DPR capture, apply the override and send \`Page.captureScreenshot\` through the same CDP session in the same call, then verify DPR and image dimensions. A context created with \`deviceScaleFactor\` supports isolated one-call checks but does not persist across calls. Use \`isolated-virtual-display\` for persistent native-scale Linux geometry; its software-rendered profile does not verify GPU performance.

Playwright operations have independent timeouts and can outlast the worker's remaining budget. For exploratory queries whose element may be absent, set a per-operation timeout below that remaining budget (for example, \`await locator.waitFor({ timeout: 5000 })\` early in a default-budget call) so Playwright can return its locator and call-log diagnostic before worker termination.

Keep loops and returned values bounded, and make the script stop on its first unexpected error. Helper rejections expose a stable \`error.code\`; converting one with \`String(error)\` keeps only its message.

Each call creates a new Playwright-over-CDP connection. Dedicated workers created before that connection can be absent from \`page.workers()\` even while running. Discover their target IDs with \`Target.getTargets\` and evaluate them with \`await chrome.evaluateWorker({ targetId, expression })\`; do not reload the page merely to rediscover a worker. This helper accepts only a live dedicated-worker target in the current browser, awaits a returned Promise, and returns finite JSON data or top-level \`undefined\`. A worker target with an empty URL is rejected before evaluation because its script may still be initializing. Wait for the application's worker-ready signal before calling the helper again; a nonempty URL alone does not guarantee readiness. Convert typed arrays and other non-JSON values explicitly in the expression. Thrown exceptions and rejected Promises fail the helper. Its temporary CDP attachment is released after completion; timeout, cancellation, and worker-process failure use the call's scoped cleanup. Worker-side effects are not rolled back. The helper leaves the selected page unchanged.

Returned numeric typed arrays become ordinary arrays, including nested views; only the view's elements are returned, and every number must be finite. A directly returned \`Uint8Array\` or \`Buffer\` with a recognized PNG, JPEG, or WebP image signature returns an image; other byte arrays return numbers. To return image-signature bytes as numbers, wrap them in an object, such as \`return { values: bytes };\`. Use \`chrome.emitImageResult(bytes)\` when bytes must be validated as an image. BigInt values and BigInt typed arrays require an explicit representation, such as decimal strings. Other class instances require explicit plain data; the runtime does not invoke custom serialization methods.

Returned objects omit properties whose value is \`undefined\`, including nested properties. Returned arrays replace \`undefined\` entries with \`null\` without shifting positions. A top-level \`undefined\` return completes without a value. Other returned data must be JSON-safe. Arguments and session-state values remain strictly JSON-safe; return-value normalization does not apply to them.

If return serialization fails, the script has completed but the call fails with \`CHROME_MCP_INVALID_INPUT\`. Browser actions are not undone; session-state and selected-page changes do not commit. Inspect the current browser state before repeating actions. Call-local variables are not available to a later call.

Successful virtual-display calls that retain a browser return \`rendering\` metadata for the selected page: \`chromeProduct\`, \`profile\`, \`nativeDeviceScaleFactor\`, observed \`devicePixelRatio\`, CSS \`viewport\`, \`visualViewportScale\`, and \`pageZoom\` when Chrome reports it. Metadata is omitted while a JavaScript dialog blocks the selected page. Handle dialogs during their triggering call when rendering metadata is required. Native launch scale, emulated device-pixel ratio, and page zoom are separate settings; record them with visual findings.

Read the family resource for each helper you use. Each includes its exact signatures and required types; you do not need unrelated families to resolve those types. This common contract applies to every family. For work across many families, read \`chrome-docs://helper-api.d.ts\` as the complete current declaration view instead of loading each family's declarations. Family resources also supply operation-specific guidance.

${helperIndex}

\`selectPageForSession\` changes the target for later target-scoped helpers and retains it for later calls only after success. \`reportCallProgress\` reports transient progress, not final result content.

If user code or a helper throws after \`chrome.emitTextResult()\` or \`chrome.emitImageResult()\`, the failure response includes the error first, then a bounded prefix of explicitly emitted text and images, plus \`partialEmittedCount\` and \`partialOmittedCount\`. Transactional session state and selected-page changes still roll back. Timeouts, worker crashes, browser disconnects, and unfinished return values have no partial-result guarantee. Files already published with \`chrome.publishFileArtifact()\` remain available as artifacts. \`chrome.reportCallProgress()\` is transient and is not part of the final result.

Inline text and canonical JSON share a ${INLINE_TEXT_MAX_BYTES / 1024} KiB limit. Up to ${INLINE_IMAGE_MAX_COUNT} images of ${mebibytes(INLINE_IMAGE_MAX_BYTES)} MiB each and ${mebibytes(INLINE_IMAGE_MAX_TOTAL_BYTES)} MiB total can remain inline. Larger valid values and images become artifact resources. A non-capture call can publish at most ${ORDINARY_CALL_MAX_ARTIFACTS} artifacts totaling ${mebibytes(ORDINARY_CALL_MAX_BYTES)} MiB.`,
  },
  {
    uri: CHROME_INSTRUCTIONS_DOC_URI,
    name: "Server instructions",
    text: instructions,
  },
  {
    uri: "chrome-docs://modes",
    name: "Chrome browser modes",
    text: `# Browser modes

- \`isolated\`: explicitly selected temporary headed profile owned by this MCP connection. Agents sharing that connection also share its browser.
- \`isolated-headless\`: default temporary headless profile owned by this MCP connection. Every browser-selecting call requires a \`browserInstanceId\`, including when \`browser\` is omitted; a missing ID fails validation before a browser is acquired. Each distinct ID opens a reusable owner. Only this mode and \`isolated-virtual-display\` accept \`browserInstanceId\`. React profile stop and analyze accept neither browser argument; they use \`profileId\`.
- \`isolated-virtual-display\`: temporary headed Linux Chrome on a private Xvfb display, with no visible desktop window. Every browser-selecting call requires \`browserInstanceId\` and \`nativeDeviceScaleFactor\` (${MIN_NATIVE_DEVICE_SCALE_FACTOR} through ${MAX_NATIVE_DEVICE_SCALE_FACTOR}). The factor is immutable per instance; use another ID for a different factor. Linux and Xvfb on PATH are required, with no fallback to headless. The browser and Xvfb close with the connection or after 30 idle minutes. Use this software-rendered profile for native-scale glyph geometry, not GPU/compositor or performance parity. Match the target font, viewport, and page zoom. CDP-emulated scale and headless rendering are not substitutes for native launch scale.
- \`shared\`: workspace-scoped persistent headed profile shared across MCP connections.
- \`shared-headless\`: separately persisted headless shared profile.
- \`main\`: attaches to the user's running Chrome through its remote-debugging endpoint. Select it only under the server instructions' \`main\` rule; a mention of Chrome or the browser does not select it. Remote debugging must already be enabled. It never launches, closes, falls back to another browser, or changes the user's global download policy, so it captures no downloads and records no download events.

Visible headed modes use the visible Chrome window as the page viewport. Virtual-display mode starts with a 1,920 by 1,080 viewport at its native launch scale; \`page.setViewportSize()\` preserves that scale through the persistent browser owner. Headless modes start with a deterministic 1,920 by 1,080 viewport.

Browser state never crosses modes or named instance IDs. Continue an authorized sign-in workflow in the visible browser while it needs that browser's authenticated or page state; switching to headless does not transfer that state. Shared modes share their respective browser profiles across connections, not with each other, and selection, helper state, refs, cursors, captures, checkpoints, and artifacts remain connection-scoped. Calls for one mutable browser owner execute in FIFO order.`,
  },
  {
    uri: CHROME_REACT_PROFILE_DOC_URI,
    name: "React profile analysis",
    text: `# React profile analysis

Start recording with \`react_profile_start\`, then stop with the returned \`profileId\`, even if another page is selected. Stop and analyze accept \`profileId\`, not browser arguments. Completed profiles belong to the MCP connection and remain analyzable without a browser call until eviction or connection close.

${REACT_PROFILE_STOP_NOTICE}

For page-interaction latency measurements without that instrumentation, use a new \`browserInstanceId\` in \`isolated-headless\` or \`isolated-virtual-display\`, restore the same build, workload, and measurement settings, and avoid React tools on that browser; a visible \`isolated\` browser follows the server instructions' close rules. A fresh browser removes this instrumentation variable; it does not eliminate other DevTools overhead or prove latency causality.

\`react_profile_analyze\` deterministically ranks component rows by render cost or by costs of commits where they rendered. The first requested metric determines the ranking. Rows include \`componentId\`, capture-time \`displayName\` (\`null\` when unknown), scalar metrics, and \`changeSummary\`. Captured names survive unmounts, including components mounted during recording.

\`changeSummary\` counts recorded descriptions in \`records\` and descriptions indicating \`mounts\`, \`props\`, \`state\`, \`hooks\`, or \`context\` changes. These counts overlap and are observations, not proven render causes. A \`null\` summary means descriptions are unavailable; recorded descriptions with no indicated changes produce zero category counts.

Per-commit arrays are omitted from inline rows. Set \`includeChangeDescriptions: true\` to publish the returned page's complete records as \`changeDescriptionsArtifact\`, grouped by \`componentId\` with each record's \`commitIndex\`. Read the artifact URI through the MCP resource reader, following manifest and chunk URIs when present.

The complete serialized MCP response, including text, structured data, and resource metadata, is bounded to ${REACT_ANALYSIS_RESULT_MAX_BYTES / 1024} KiB. Pages may contain fewer than \`limit\` rows. An individually oversized row is preserved in \`resultsArtifact\` instead of being truncated. Read that artifact to obtain the complete page, then continue with \`nextCursor\` until it is \`null\`.

The pagination cursor is single-use. Repeating the same first-page query reuses its continuation; a different query replaces it. Keep \`metrics\` and \`includeChangeDescriptions\` unchanged when continuing.`,
  },
  {
    uri: eventHelpers.uri,
    name: "Chrome event journals",
    text: `# Event journals

Call \`await chrome.events.mark()\` before an action to ignore startup noise. Call \`await chrome.events.read()\` afterward. Reads accept \`after\`, \`advance\`, \`limit\`, \`target\`, and \`types\`. \`target\` defaults to the selected page; pass \`"all"\` to read every page, including pages in other contexts, or a target ID for one page. The journal retains at most ${JOURNAL_MAX_EVENTS.toLocaleString("en-US")} events and ${mebibytes(JOURNAL_MAX_BYTES)} MiB and reports \`droppedBefore\` and \`ownerReset\` instead of hiding gaps.

Stable event types cover console output, page errors, target crashes, requests, responses, request failures, WebSocket lifecycle and frames, popups, downloads, dialogs, and file choosers. Payloads are bounded metadata; response bodies require an explicit capture.

Pass \`includeStackTraces: true\` to include a console event's optional \`stackTrace: ConsoleStackTrace\`; it is omitted by default. Stack frames retain Chrome's zero-based line and column numbers. \`asyncDepth: 0\` is the synchronous stack; higher depths are inline asynchronous parents. Capture is bounded to ${CONSOLE_STACK_MAX_FRAMES} frames, ${CONSOLE_STACK_MAX_ASYNC_DEPTH} asynchronous parents, and ${CONSOLE_STACK_MAX_BYTES / 1024} KiB per stack. \`truncated\` reports a capture limit; \`unavailableParents\` reports an async parent ID without inline frames. No debugger is enabled and missing parents are not fetched. These flags describe stack completeness, independently of journal retention gaps.

\`target_crashed\` retains Chrome's termination \`errorCode\` and bounded-text \`status\`, with the target ID, owner generation, and event timestamps. Failed \`run_playwright\` calls attach \`diagnostics\` when a selected-target crash, browser disconnection, or diagnostic coverage gap was observed. These diagnostics preserve the original error and emitted results; a selected-target crash does not establish why the renderer crashed, and a disconnected browser CDP connection does not prove browser-process exit. Crashes from other targets remain available through the journal instead of being attributed to the selected target's failure.`,
  },
  {
    uri: snapshotHelpers.uri,
    name: "Compact snapshots and refs",
    text: `# Snapshots and refs

\`await chrome.captureAccessibilitySnapshot(options)\` returns Playwright's compact AI-oriented ARIA tree and refs scoped to the connection, mode, browser generation, and target, plus \`browserInstanceId\` in \`isolated-headless\` or \`isolated-virtual-display\`. It includes iframe and open-shadow content supported by Playwright and omits inaccessible content instead of guessing it. Options include \`root\`, \`depth\`, \`includeBoxes\`, \`maxBytes\`, \`diffFrom\`, and \`view\`.

The default \`view: "bounded"\` budgets the entire canonical JSON helper result, including refs, metadata, counts, and artifact descriptors. \`maxBytes\` defaults to ${SNAPSHOT_DEFAULT_MAX_BYTES / 1024} KiB. \`totals\` and \`omitted\` count tree lines, refs, and added/removed/changed entries; \`omissionReason\` is \`"maxBytes"\` when anything is omitted and \`null\` otherwise. An oversized \`url\` or \`title\` is omitted whole and named in \`omitted.metadataFields\`. Complete tree lines and their current refs stay together. Diff previews select prefixes round-robin across added, changed, and removed entries. Refs in removed or before-change text are historical, not current actionable entries.

Any omission publishes \`dataArtifact\`, whose JSON content is the complete \`SnapshotData\` from the same capture. Read its URI through the MCP resource reader when omitted evidence is needed, following manifest/chunk URIs as applicable. Text overflow also publishes the complete text as \`artifact\`. Artifact-publication failure fails the call rather than returning a successful preview with inaccessible omitted data. Reading an artifact does not extend ref validity.

Use \`view: "full"\` when same-call code must search every ref or change. It returns complete captured data without preview truncation; \`maxBytes\` still sets the text-overflow artifact threshold. Capture depth, artifact quotas, and the call-wide ${INLINE_TEXT_MAX_BYTES / 1024} KiB text/JSON limit still apply. Large explicit previews, full results, multiple snapshots, or additional emitted text can become a \`valueArtifact\`. Default maps and change arrays are no longer exhaustive; request full mode or retrieve the complete artifact before concluding that a node or change is absent.

\`await chrome.resolveSnapshotRefToLocator(ref)\` resolves an exact element retained from one of the ${SNAPSHOT_RETAINED_COUNT} latest snapshots on that target to a public Playwright Locator. Replacement, detachment, navigation, and snapshot eviction make the ref stale instead of selecting a similar element. Refs do not cross any of those scope boundaries. Unknown, stale, or target-mismatched refs fail with distinct codes.

Ref role and name describe accessibility structure, not current Playwright visibility or actionability. When visibility is the deciding fact, prefer one direct Playwright role locator or resolve only the retained ref you intend to use.`,
  },
  {
    uri: captureHelpers.uri,
    name: "Browser captures",
    text: `# Captures

\`await chrome.capture.start(options)\` starts a capture for the current browser owner and returns its ID. \`await chrome.capture.stop(captureId)\` finalizes it as an artifact from that same browser owner. Supported types are \`trace\`, \`har\`, \`video\`, and \`network-bodies\` when runtime capabilities permit them.

Trace options default screenshots, snapshots, and sources to true. HAR supports omit, embed, and attach content modes and is capped at ${mebibytes(MAX_HAR_BYTES)} MiB. Network-body captures default to ${mebibytes(CAPTURE_BODY_LIMITS.defaultBodyBytes)} MiB per body and ${mebibytes(CAPTURE_BODY_LIMITS.defaultTotalBytes)} MiB total, with hard maxima of ${mebibytes(CAPTURE_BODY_LIMITS.maximumBodyBytes)} MiB and ${mebibytes(CAPTURE_BODY_LIMITS.maximumTotalBytes)} MiB. Video uses CDP screencast frames plus an available local encoder and never recreates a context. Conflicting captures fail instead of replacing the active owner.`,
  },
  {
    uri: checkpointHelpers.uri,
    name: "Browser checkpoints",
    text: `# Checkpoints

\`await chrome.checkpoint.create(options)\` records URL, title, viewport, event cursor, compact snapshot, and optional screenshot and storage state. \`await chrome.checkpoint.diff(checkpointId, options)\` compares the current selected target with that observation and can include snapshot, screenshot, event, and storage differences.

Checkpoints observe browser state. They do not restore, roll back, or navigate. Complete reports and requested image differences are artifact resources.`,
  },
  {
    uri: artifactHelpers.uri,
    name: "Chrome artifacts",
    text: `# Artifacts

\`chrome.publishFileArtifact(path, mediaType)\` copies a regular file into the connection-owned artifact store. \`await chrome.reserveArtifactOutputPath(name, mediaType)\` reserves a temporary output path that must later be published with \`chrome.publishFileArtifact\`. Opaque \`chrome-artifact://\` URIs never expose host paths.

\`chrome.emitTextResult\` emits text and \`chrome.emitImageResult(bytes, options?)\` emits a validated image. The image options accept only \`mediaType\`; image labels and filenames are not supported. These emissions follow the common contract's partial-failure and inline-limit rules.

Artifacts up to ${mebibytes(ARTIFACT_DIRECT_CONTENT_BYTES)} MiB have a direct content resource. Larger artifacts expose a manifest and virtual ${mebibytes(ARTIFACT_CHUNK_BYTES)} MiB chunks with byte ranges and SHA-256 digests. One artifact may be at most ${mebibytes(ARTIFACT_MAX_BYTES)} MiB and one live connection may own at most ${mebibytes(ARTIFACT_CONNECTION_MAX_BYTES) / 1024} GiB.`,
  },
  {
    uri: capabilityHelpers.uri,
    name: "Chrome runtime capabilities",
    text: `# Capabilities

\`chrome.capabilities\` is an immutable JSON-safe view. It reports the Playwright version, Chrome product and CDP protocol version, browser mode and ownership, selected target, sharing and headless state, native launch scale when using a virtual display, capture support and conflicts, all runtime limits, journal bounds, and required experimental CDP method support.

Snapshot limits report \`snapshotMinDepth\` ${SNAPSHOT_MIN_DEPTH}, \`snapshotMaxDepth\` ${SNAPSHOT_MAX_DEPTH}, \`snapshotMinBytes\` ${SNAPSHOT_MIN_BYTES}, \`snapshotMaxBytes\` ${SNAPSHOT_MAX_BYTES}, and \`snapshotRetainedCount\` ${SNAPSHOT_RETAINED_COUNT}. Persistent mutation limits report \`mutationCountPerKind\` ${PERSISTENT_MUTATION_MAX_COUNT_PER_KIND}, \`mutationEntryBytes\` ${PERSISTENT_MUTATION_MAX_ENTRY_BYTES}, and \`mutationTotalBytes\` ${PERSISTENT_MUTATION_MAX_TOTAL_BYTES}. Persistent binding limits report \`bindingPayloadBytes\` ${PERSISTENT_BINDING_MAX_PAYLOAD_BYTES}, \`bindingConcurrency\` ${PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS}, and \`bindingTimeoutMs\` ${PERSISTENT_BINDING_WORKER_TIMEOUT_MS}.

Capabilities describe observed support. Caller code must detect browser disconnection and read capabilities again after reconnection because a reported capability may disappear.`,
  },
  {
    uri: "chrome-docs://recipes/playwright",
    name: "Playwright recipes",
    text: `# Playwright recipes

Select a popup explicitly:

\`\`\`js
const popupPromise = context.waitForEvent("page");
await page.getByRole("link", { name: "Open" }).click();
const popup = await popupPromise;
await popup.waitForLoadState();
await chrome.selectPageForSession(popup);
const snapshot = await chrome.captureAccessibilitySnapshot();
return { snapshotTargetId: snapshot.targetId, url: popup.url(), title: await popup.title() };
\`\`\`

After \`selectPageForSession\` resolves, later target-scoped helper calls in the same statement body use that page and \`chrome.capabilities.selectedTargetId\` reports the staged target. The selection is validated when \`selectPageForSession\` runs, so an unknown, closed, or call-created-context page rejects inside the statement body, and it commits for later calls only when the statement body succeeds.

Capture a download:

\`\`\`js
const downloadPromise = page.waitForEvent("download");
await page.getByRole("button", { name: "Export" }).click();
const download = await downloadPromise;
const path = await download.path();
if (!path) throw new Error("Download did not produce a file");
await chrome.publishFileArtifact(path, "application/octet-stream");
return { suggestedFilename: download.suggestedFilename() };
\`\`\`

Playwright download events fire for owned browsers (\`isolated\`, \`isolated-headless\`, \`isolated-virtual-display\`, \`shared\`, \`shared-headless\`). \`main\` never changes the user's download policy, so it captures no downloads: neither Playwright download events nor journal download entries exist there; confirm a download through the page instead. Register the \`waitForEvent\` promise before the action that starts the download. In owned browsers every download also lands in the journal as \`download_started\` and \`download_finished\` with an \`artifactUri\`. If a call times out after the triggering action, the download usually still completed, so read the journal before clicking again rather than producing a duplicate.

Accept a dialog opened by this call:

\`\`\`js
const dialogPromise = page.waitForEvent("dialog");
const clickPromise = page.getByRole("button", { name: "Delete" }).click();
const dialog = await dialogPromise;
const message = dialog.message();
await dialog.accept();
await clickPromise;
return { message };
\`\`\`

Set files on a chooser opened by this call:

\`\`\`js
const chooserPromise = page.waitForEvent("filechooser");
await page.getByLabel("Upload").click();
const chooser = await chooserPromise;
await chooser.setFiles(args.files);
return { multiple: chooser.isMultiple() };
\`\`\`

Publish a full-page screenshot and PDF:

\`\`\`js
const screenshotPath = await chrome.reserveArtifactOutputPath("page.png", "image/png");
await page.screenshot({ path: screenshotPath, fullPage: true });
const screenshot = await chrome.publishFileArtifact(screenshotPath, "image/png");
const pdfPath = await chrome.reserveArtifactOutputPath("page.pdf", "application/pdf");
await page.pdf({ path: pdfPath, printBackground: true });
const pdf = await chrome.publishFileArtifact(pdfPath, "application/pdf");
return { screenshot, pdf };
\`\`\`

Capture an accessibility snapshot and lossless DOM artifact:

\`\`\`js
const accessibility = await page.locator("body").ariaSnapshot();
const domPath = await chrome.reserveArtifactOutputPath("page.html", "text/html");
await Bun.write(domPath, await page.content());
const dom = await chrome.publishFileArtifact(domPath, "text/html");
return { accessibility, dom };
\`\`\`

Intercept one request family and always remove the route:

\`\`\`js
const pattern = "**/api/feature-flags";
const handler = async route => {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(args.flags) });
};
await page.route(pattern, handler);
try {
  await page.reload();
  return await page.getByTestId("flags").textContent();
} finally {
  await page.unroute(pattern, handler);
}
\`\`\`

Persist a route across later calls:

\`\`\`js
const route = await chrome.routes.add({
  urlPattern: "*://*/api/feature-flags*",
  method: "GET",
  action: {
    type: "fulfill",
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args.flags),
  },
});
chrome.setSessionStateValue("featureFlagsRoute", route.id);
await page.reload();
return route;
\`\`\`

Use \`await chrome.routes.remove(id)\` or \`await chrome.routes.clear()\` when the stub is no longer needed. See \`chrome-docs://run-playwright\` for native-route lifetime. Persistent routes remain connection- and mode-scoped until explicitly removed or the connection ends.

Initialize every future document deterministically:

\`\`\`js
const preloadMarkerKey = "__chromeDeterministicClockPreload_" + crypto.randomUUID();
const script = await chrome.initScripts.add(
  'Object.defineProperty(Date, "now", { value: () => 1700000000000 }); window[' + JSON.stringify(preloadMarkerKey) + '] = true;',
);

try {
  await page.reload({ waitUntil: "domcontentloaded" });
  const hasPreloadMarker = await page.evaluate(key => window[key] === true, preloadMarkerKey);
  if (!hasPreloadMarker) {
    throw new Error("Deterministic clock preload did not run");
  }

  return { scriptId: script.id, now: await page.evaluate(() => Date.now()) };
} catch (error) {
  await chrome.initScripts.remove(script.id);
  throw error;
}
\`\`\`

Use \`chrome.initScripts.add(source)\` when the preload must survive later calls. Retain the returned script ID and remove it with \`await chrome.initScripts.remove(id)\` in the workflow's final cleanup; the example removes its registration if setup fails.

For document-open instrumentation, register the preload before navigation, then verify a marker key unique to that registration immediately after navigation before waiting for application state or interpreting measurements. An earlier preload must not satisfy or overwrite the current registration's marker. For a raw \`context.newCDPSession(page)\`, await \`cdp.send("Page.enable")\` on that same session before \`Page.addScriptToEvaluateOnNewDocument\`; the returned identifier confirms registration, not execution. Keep raw-CDP registration, navigation, marker verification, and application-mode checks in one call. Startup tracing can begin before navigation; marker verification validates the capture afterward. Same-document SPA transitions do not execute new-document preloads.

Register and verify a document-open preload for one call, then remove the script and detach the session:

\`\`\`js
const preloadMarkerKey = "__chromeDocumentOpenPreload_" + crypto.randomUUID();
const cdp = await context.newCDPSession(page);
try {
  await cdp.send("Page.enable");
  const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: "window[" + JSON.stringify(preloadMarkerKey) + "] = true;",
  });

  try {
    await page.goto(args.url, { waitUntil: "domcontentloaded" });
    const hasPreloadMarker = await page.evaluate(key => window[key] === true, preloadMarkerKey);
    if (!hasPreloadMarker) {
      throw new Error("Document-open preload did not run");
    }

    return { hasPreloadMarker };
  } finally {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
} finally {
  await cdp.detach();
}
\`\`\`

Expose a page-callable function across calls:

\`\`\`js
const binding = await chrome.bindings.add({
  name: "lookupTestUser",
  source: 'async userId => ({ id: userId, role: "tester" })',
});
return binding;
\`\`\`

Binding source is a self-contained function expression. It cannot close over \`args\`, \`page\`, or statement-local variables.

Run one action offline, then restore the context:

\`\`\`js
await context.setOffline(true);
try {
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  return await page.getByRole("status").textContent();
} finally {
  await context.setOffline(false);
}
\`\`\`

Grant geolocation for one origin:

\`\`\`js
const origin = new URL(page.url()).origin;
await context.grantPermissions(["geolocation"], { origin });
await context.setGeolocation({ latitude: args.latitude, longitude: args.longitude });
return await page.evaluate(() => new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject)));
\`\`\`

Collect JavaScript and CSS coverage around one interaction:

\`\`\`js
await Promise.all([page.coverage.startJSCoverage(), page.coverage.startCSSCoverage()]);
try {
  await page.getByRole("button", { name: "Run" }).click();
  const [javascript, css] = await Promise.all([page.coverage.stopJSCoverage(), page.coverage.stopCSSCoverage()]);
  return {
    javascript: javascript.map(entry => ({ url: entry.url, functions: entry.functions })),
    css: css.map(entry => ({ url: entry.url, ranges: entry.ranges })),
  };
} catch (error) {
  await Promise.all([page.coverage.stopJSCoverage(), page.coverage.stopCSSCoverage()]);
  throw error;
}
\`\`\`

Publish storage state:

\`\`\`js
const path = await chrome.reserveArtifactOutputPath("storage-state.json", "application/json");
await context.storageState({ path });
return await chrome.publishFileArtifact(path, "application/json");
\`\`\`

Record a Playwright trace within one call:

\`\`\`js
const path = await chrome.reserveArtifactOutputPath("trace.zip", "application/zip");
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
try {
  await page.getByRole("button", { name: "Run" }).click();
} finally {
  await context.tracing.stop({ path });
}
return await chrome.publishFileArtifact(path, "application/zip");
\`\`\`

For a trace that spans calls, use \`chrome.capture.start({ type: "trace" })\` and stop it later with the returned capture ID.`,
  },
  {
    uri: "chrome-docs://recipes/cdp",
    name: "Chrome DevTools Protocol recipes",
    text: `# CDP recipes

Raw Tracing export may represent finished synchronous spans as \`X\` events with \`dur\`; it need not contain \`E\` events. After \`Tracing.end\`, await \`Tracing.tracingComplete\` and check \`dataLossOccurred\`, then assess bounds separately: use \`X.dur\` or match \`B\`/\`E\` within each \`pid\`/\`tid\`, and label unmatched synchronous beginnings as unbounded. Later events or a complete artifact do not supply an end time. For attribution, include \`toplevel\` and thread metadata and report \`Chrome_DevToolsHandlerThread\` task wall time separately; it is not proof of CPU cost or page-latency causality.

Use a page session for target-scoped domains:

\`\`\`js
const cdp = await context.newCDPSession(page);
try {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.start");
  // Perform the measured interaction.
  return await cdp.send("Profiler.stop");
} finally {
  await cdp.detach();
}
\`\`\`

Apply advanced network emulation and restore it:

\`\`\`js
const cdp = await context.newCDPSession(page);
try {
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: args.latency,
    downloadThroughput: args.downloadThroughput,
    uploadThroughput: args.uploadThroughput,
    connectionType: "cellular3g",
  });
  await page.reload();
  return await page.title();
} finally {
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  }).catch(() => undefined);
  await cdp.detach();
}
\`\`\`

Publish a CPU profile:

\`\`\`js
const cdp = await context.newCDPSession(page);
try {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.start");
  await page.getByRole("button", { name: "Calculate" }).click();
  const profile = await cdp.send("Profiler.stop");
  const path = await chrome.reserveArtifactOutputPath("cpu-profile.json", "application/json");
  await Bun.write(path, JSON.stringify(profile));
  return await chrome.publishFileArtifact(path, "application/json");
} finally {
  await cdp.detach();
}
\`\`\`

Inspect debugger call frames without leaving the page paused:

\`\`\`js
const cdp = await context.newCDPSession(page);
try {
  await cdp.send("Debugger.enable");
  const paused = new Promise(resolve => cdp.once("Debugger.paused", resolve));
  const evaluation = cdp.send("Runtime.evaluate", { expression: "debugger; 42" });
  const event = await paused;
  const frames = event.callFrames.map(frame => ({ functionName: frame.functionName, url: frame.url, location: frame.location }));
  await cdp.send("Debugger.resume");
  await evaluation;
  return frames;
} finally {
  await cdp.send("Debugger.resume").catch(() => undefined);
  await cdp.detach();
}
\`\`\`

Observe WebSocket frames around one action:

\`\`\`js
const cdp = await context.newCDPSession(page);
const frames = [];
const sent = event => frames.push({ direction: "sent", opcode: event.response.opcode, payload: event.response.payloadData });
const received = event => frames.push({ direction: "received", opcode: event.response.opcode, payload: event.response.payloadData });
try {
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketFrameSent", sent);
  cdp.on("Network.webSocketFrameReceived", received);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByText("connected").waitFor();
  return frames;
} finally {
  cdp.off("Network.webSocketFrameSent", sent);
  cdp.off("Network.webSocketFrameReceived", received);
  await cdp.detach();
}
\`\`\`

Use a browser-level CDP session for target discovery:

\`\`\`js
const cdp = await browser.newBrowserCDPSession();
try {
  const result = await cdp.send("Target.getTargets");
  return result.targetInfos.map(target => ({ targetId: target.targetId, type: target.type, url: target.url }));
} finally {
  await cdp.detach();
}
\`\`\`

For a dedicated worker, use the exact target ID and expression selected from that discovery. Read the worker-evaluation contract and signature in \`chrome-docs://run-playwright\`; this works even when a later call's \`page.workers()\` is empty:

\`\`\`js
return await chrome.evaluateWorker({ targetId: args.targetId, expression: args.expression });
\`\`\`

Detach every temporary CDP session. Keep returned frame payloads bounded or publish them as artifacts.`,
  },
  {
    uri: pwaHelpers.uri,
    name: "Isolated PWA lifecycle",
    text: `# PWA helpers

Use \`chrome.pwa\` only in \`isolated\`, \`isolated-headless\`, or \`isolated-virtual-display\`. Shared and main browsers reject these helpers before any native operation. Chrome requires the launcher's trusted pipe connection for PWA automation; an adopted browser without that connection reports \`CHROME_MCP_UNSUPPORTED_CAPABILITY\` rather than bypassing the gate. Use an absolute HTTP(S) manifest ID (the resolved manifest \`id\`, not the manifest file URL) and installation page URL. Missing Chrome commands report \`CHROME_MCP_UNSUPPORTED_CAPABILITY\`; failed native operations report \`CHROME_MCP_PWA_FAILED\`. Check the \`PWA.*\` entries in \`chrome.capabilities.cdp\` when compatibility matters.

Install with \`await chrome.pwa.install({ manifestId, installUrl })\`. Browser display mode is the default; pass \`displayMode: "standalone"\` explicitly for an app window. Installation can create operating-system integration, including shortcuts. The browser owner records installation ownership before calling Chrome. Owner teardown uninstalls recorded apps before deleting the profile, including pending installs left by cancellation. If cleanup cannot be confirmed, it reports an error and preserves the profile and receipts. Explicitly uninstall when the test is done; do not delete profiles as a substitute.

\`const appPage = await chrome.pwa.launch({ manifestId })\` returns a real Playwright Page and selects it for later helpers and successful subsequent calls. The prebound \`page\` variable still refers to the original Page in the current call, so interact through \`appPage\`. An optional launch \`url\` must be inside the application's scope; Chrome rejects invalid launches. \`await chrome.pwa.getState({ manifestId })\` returns native badge and file-handler registration state, not manifest declarations or notification permission. \`await chrome.pwa.uninstall({ manifestId })\` closes app windows and removes the owned installation. If another ordinary page must survive uninstall, open or select it first.

\`\`\`js
await chrome.pwa.install({ manifestId: args.manifestId, installUrl: args.installUrl });
const appPage = await chrome.pwa.launch({ manifestId: args.manifestId });
await appPage.getByRole("button", { name: "Continue" }).click();
return { url: appPage.url(), state: await chrome.pwa.getState({ manifestId: args.manifestId }) };
\`\`\``,
  },
  {
    uri: "chrome-docs://heap-queries",
    name: "Saved heap queries",
    text: `# Saved heap queries

\`analyze_heapsnapshot\` reads a saved local \`.heapsnapshot\` without opening Chrome. Use the \`filePath\` from \`take_heapsnapshot\` or an existing file, resolved against the session's working directory. The original summary, diff, dominator, and retainer analysis on \`take_heapsnapshot\` is unchanged.

Choose one \`query\`: \`{ kind: "objects", className?, propertyName?, minRetainedBytes?, sort? }\`, \`{ kind: "edges", nodeId, excludePrimitives?, minRetainedBytes?, sort? }\`, or \`{ kind: "contexts" }\`. Class names use literal case-insensitive substring matching; property names require an exact outgoing property edge. Object sorting accepts \`retainedSize\` (default), \`selfSize\`, or \`id\`. Edge sorting accepts \`targetRetainedSize\` (default) or \`name\`. \`excludePrimitives\` excludes string variants, numbers, bigints, and symbols. Invalid node IDs fail rather than returning an empty edge list.

All sizes are bytes. Object rows contain \`id, name, type, selfSize, retainedSize\`; edge rows contain \`name, type, target\` with the same object fields. Retained size is computed from strong-root reachability; \`null\` means unreachable from those roots and is excluded by \`minRetainedBytes\`. Retained sizes can overlap and must not be summed. Context rows use DevTools' native context attribution and contain \`nodeId, nodeName, attributedSize, retainedSize, selfSize\`; \`sharedSize\`, \`noAttributionSize\`, and \`retention\` report whole-snapshot totals, independent of pagination. This attributes memory to JavaScript contexts; it does not identify an owning iframe from a URL alone.

Results contain \`kind, rows, totalMatches, snapshotSha256, nextCursor\`. \`limit\` defaults to ${HEAP_RESULT_DEFAULT_LIMIT} and accepts 1 through ${HEAP_RESULT_MAX_LIMIT}. Pass a non-null \`nextCursor\` as \`cursor\` with the identical query and unchanged snapshot; changing content or filters rejects it. Node IDs belong to that snapshot, not another capture. Empty matches are successful. Names are bounded; query results do not include unrestricted heap contents. Malformed files, parser errors, and worker timeouts fail with \`CHROME_MCP_HEAP_PROTOCOL\`. The worker is reaped on timeout or connection cancellation.`,
  },
  {
    uri: "chrome-docs://helper-api.d.ts",
    name: "run_playwright helper API",
    mimeType: "text/typescript",
    text: renderChromeHelperDeclarations(helperDocumentation),
  },
  {
    uri: stateHelpers.uri,
    name: "Chrome session state",
    text: `# Session state

Session-state methods keep JSON-safe values across successful calls for the same connection, browser mode, and named instance ID. Failed calls discard staged state changes. Missing keys return \`undefined\`. Stored values do not preserve worker-local variables, functions, or closures.

Each value is limited to ${STATE_VALUE_MAX_BYTES} bytes (${STATE_VALUE_MAX_BYTES / 1024} KiB), measured as UTF-8 JSON. Keys are limited to ${STATE_KEY_MAX_BYTES} UTF-8 bytes, and the full serialized entries array is limited to ${STATE_TOTAL_MAX_BYTES} bytes (${mebibytes(STATE_TOTAL_MAX_BYTES)} MiB). Keep compact summaries, cursors, or artifact references in session state. For complete batch evidence, publish per-batch artifacts using the workflow in \`chrome-docs://artifacts\` and read their content or manifest chunks through the same MCP connection. An oversized state write throws \`CHROME_MCP_INVALID_STATE\`. If the error fails the call, staged state changes are discarded while completed browser actions remain.`,
  },
  {
    uri: registryHelpers.uri,
    name: "Chrome persistent registry",
    text: `# Persistent registry

Routes, init scripts, and bindings persist across workers for the same connection and browser mode. Remove them by their returned IDs or clear the relevant registry when they are no longer needed. See \`chrome-docs://run-playwright\` for native-route lifetime. Binding source must be a self-contained function expression and cannot close over \`args\`, \`page\`, or statement-local variables. See \`chrome-docs://recipes/playwright\` for registration and cleanup examples; \`chrome-docs://capabilities\` exposes the runtime limits.`,
  },
  {
    uri: modalHelpers.uri,
    name: "Chrome blocking modals",
    text: `# Blocking modals

Use \`chrome.dialog\` and \`chrome.fileChooser\` to handle a modal already blocking the selected page. Each is \`undefined\` when that modal is absent. Await acceptance, dismissal, or file selection before continuing. These handles identify the observed modal; a stale modal fails instead of acting on a replacement. For a modal opened by the current call, use Playwright's event handling shown in \`chrome-docs://recipes/playwright\`.`,
  },
];

export const CHROME_DOC_URIS = DOCS.map((doc) => doc.uri);

export const registerChromeDocs = (server: FastMCP<ToolSessionContext>): void => {
  for (const doc of DOCS) {
    const family = helperDocumentation.find((candidate) => candidate.uri === doc.uri);
    const text =
      family === undefined ?
        doc.text
      : `${doc.text}\n\n## Helper API\n\n\`\`\`typescript\n${renderChromeHelperDeclarations([family])}\n\`\`\``;
    server.addResource({
      name: doc.name,
      uri: doc.uri,
      mimeType: doc.mimeType ?? "text/markdown",
      load: async () => ({ text }),
    });
  }
};
