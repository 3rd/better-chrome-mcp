import type { ContentResult, Context, FastMCP } from "#fastmcp";
import type { ToolSessionContext } from "../../mcp/session-context";
import { advertisedAgentToolJsonSchema } from "../../mcp/agent-tool-schema";
import { HEAP_RESULT_DEFAULT_LIMIT, HEAP_RESULT_MAX_LIMIT } from "../diagnostics/heap-analysis-protocol";
import { copyJsonValue, JsonValidationError } from "../execution/json";
import {
  type AnalyzeHeapSnapshotInput,
  analyzeHeapSnapshotInputSchema,
  type LighthouseAuditInput,
  lighthouseAuditInputSchema,
  type PerformanceAnalyzeInsightInput,
  performanceAnalyzeInsightInputSchema,
  type PerformanceStartTraceInput,
  performanceStartTraceInputSchema,
  type PerformanceStopTraceInput,
  performanceStopTraceInputSchema,
  type ReactHighlightComponentInput,
  type ReactInspectComponentInput,
  reactInspectComponentInputSchema,
  type ReactListComponentsInput,
  reactListComponentsInputSchema,
  type ReactProfileAnalyzeInput,
  reactProfileAnalyzeInputSchema,
  // reactHighlightComponentInputSchema,
  type ReactProfileStartInput,
  reactProfileStartInputSchema,
  type ReactProfileStopInput,
  reactProfileStopInputSchema,
  type ReactUpdateComponentInput,
  reactUpdateComponentInputSchema,
  type RunPlaywrightInput,
  runPlaywrightInputSchema,
  runPlaywrightOutputSchema,
  type TakeHeapSnapshotInput,
  takeHeapSnapshotInputSchema,
} from "./contracts";
import { createReactChromeToolsAccess, type ReactToolsMode } from "./react-access";
import {
  CHROME_INSTRUCTIONS_DOC_NOTICE,
  CHROME_REACT_PROFILE_DOC_URI,
  REACT_PROFILE_STOP_NOTICE,
} from "./register-docs";

export type ChromeToolContext = Context<ToolSessionContext>;

export type ChromeToolHandlers = {
  analyzeHeapSnapshot: (args: AnalyzeHeapSnapshotInput, context: ChromeToolContext) => Promise<ContentResult>;
  runPlaywright: (args: RunPlaywrightInput, context: ChromeToolContext) => Promise<ContentResult>;
  performanceStartTrace: (
    args: PerformanceStartTraceInput,
    context: ChromeToolContext,
  ) => Promise<ContentResult>;
  performanceStopTrace: (
    args: PerformanceStopTraceInput,
    context: ChromeToolContext,
  ) => Promise<ContentResult>;
  performanceAnalyzeInsight: (
    args: PerformanceAnalyzeInsightInput,
    context: ChromeToolContext,
  ) => Promise<ContentResult>;
  lighthouseAudit: (args: LighthouseAuditInput, context: ChromeToolContext) => Promise<ContentResult>;
  takeHeapSnapshot: (args: TakeHeapSnapshotInput, context: ChromeToolContext) => Promise<ContentResult>;
  reactListComponents: (args: ReactListComponentsInput, context: ChromeToolContext) => Promise<ContentResult>;
  reactInspectComponent: (
    args: ReactInspectComponentInput,
    context: ChromeToolContext,
  ) => Promise<ContentResult>;
  reactUpdateComponent: (
    args: ReactUpdateComponentInput,
    context: ChromeToolContext,
  ) => Promise<ContentResult>;
  reactHighlightComponent: (
    args: ReactHighlightComponentInput,
    context: ChromeToolContext,
  ) => Promise<ContentResult>;
  reactProfileStart: (args: ReactProfileStartInput, context: ChromeToolContext) => Promise<ContentResult>;
  reactProfileStop: (args: ReactProfileStopInput, context: ChromeToolContext) => Promise<ContentResult>;
  reactProfileAnalyze: (args: ReactProfileAnalyzeInput, context: ChromeToolContext) => Promise<ContentResult>;
};

const MUTATING_ANNOTATIONS = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
} as const;

const REACT_RENDERERS =
  "Supports React 18/19 client renderers; unsupported renderers on mixed-version pages are excluded.";
const REACT_COMPONENT_IDS =
  "IDs belong to this connection, browser mode/instance and document. Navigation, reload, unmount, or renderer/broker/browser-owner replacement expires affected IDs.";
const REACT_FIRST_CALL = "The first React call may reload once if React loaded before the DevTools hook.";
const REACT_PROFILE_IDS =
  "Profile IDs are connection-owned and page-pinned; they expire with the target or profiling state.";
const REACT_COMPLETED_PROFILES =
  "Completed profiles remain analyzable without a browser call until eviction or connection close.";

const runPlaywrightResponseSchema = {
  "~standard": {
    ...runPlaywrightOutputSchema["~standard"],
    jsonSchema: {
      input: () => advertisedAgentToolJsonSchema(runPlaywrightOutputSchema, "output"),
      output: () => advertisedAgentToolJsonSchema(runPlaywrightOutputSchema, "output"),
    },
    validate: async (value: unknown) => {
      const result = await runPlaywrightOutputSchema["~standard"].validate(value);
      const canCopyResponseValue =
        !result.issues && result.value.ok && typeof value === "object" && value !== null;
      if (!canCopyResponseValue) return result;

      const originalValue: unknown = Reflect.get(value, "value");
      if (originalValue === undefined) return result;

      try {
        return { value: { ...result.value, value: copyJsonValue(originalValue) } };
      } catch (error: unknown) {
        if (!(error instanceof JsonValidationError)) {
          throw error;
        }

        return { issues: [{ message: error.message, path: ["value"] }] };
      }
    },
  },
};

export const registerChromeTools = (
  server: FastMCP<ToolSessionContext>,
  handlers: ChromeToolHandlers,
  reactTools: ReactToolsMode = "auto",
): void => {
  const canAccessReactChromeTools = createReactChromeToolsAccess(reactTools);

  server.addTool({
    name: "run_playwright",
    description: `Run async JavaScript on the host as the local user, with prebound Playwright APIs. Await promises and return explicitly. Contract: chrome-docs://run-playwright. ${CHROME_INSTRUCTIONS_DOC_NOTICE}`,
    parameters: runPlaywrightInputSchema,
    outputSchema: runPlaywrightResponseSchema,
    annotations: MUTATING_ANNOTATIONS,
    execution: { taskSupport: "forbidden" },
    execute: handlers.runPlaywright,
  });

  server.addTool({
    name: "performance_start_trace",
    description:
      "Record a Chrome performance trace on the selected page. Defaults navigate away and back, then stop automatically; use reload: false and autoStop: false for start → interact → stop profiling.",
    parameters: performanceStartTraceInputSchema,
    annotations: MUTATING_ANNOTATIONS,
    execution: { taskSupport: "forbidden" },
    execute: handlers.performanceStartTrace,
  });

  server.addTool({
    name: "performance_stop_trace",
    description: "Stop the active Chrome performance trace for this connection and browser owner.",
    parameters: performanceStopTraceInputSchema,
    annotations: MUTATING_ANNOTATIONS,
    execution: { taskSupport: "forbidden" },
    execute: handlers.performanceStopTrace,
  });

  server.addTool({
    name: "performance_analyze_insight",
    description:
      "Read insights from the latest trace this connection completed for the chosen browser, while that browser owner stays open: omit both fields to list exact insightSetId/insightName pairs, or pass one returned pair to analyze it. An empty list is valid; never guess names.",
    parameters: performanceAnalyzeInsightInputSchema,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    execution: { taskSupport: "forbidden" },
    execute: handlers.performanceAnalyzeInsight,
  });

  server.addTool({
    name: "lighthouse_audit",
    description: "Audit the selected page for accessibility, SEO, best practices, and agentic browsing.",
    parameters: lighthouseAuditInputSchema,
    annotations: MUTATING_ANNOTATIONS,
    execution: { taskSupport: "forbidden" },
    execute: handlers.lighthouseAudit,
  });

  server.addTool({
    name: "take_heapsnapshot",
    description:
      "Stream a heap snapshot to file; optionally return bounded summary, diff, dominators, and retaining paths.",
    parameters: takeHeapSnapshotInputSchema,
    annotations: MUTATING_ANNOTATIONS,
    execution: { taskSupport: "forbidden" },
    execute: handlers.takeHeapSnapshot,
  });

  server.addTool({
    name: "analyze_heapsnapshot",
    description: `Query a saved heap without opening Chrome: filter objects, inspect a node's outgoing edges, or analyze context retention. Sizes are bytes; results are paginated (${HEAP_RESULT_DEFAULT_LIMIT} by default, at most ${HEAP_RESULT_MAX_LIMIT}). Class names use literal case-insensitive substring matching; property names match exactly. Reuse nextCursor only with the same query and unchanged snapshot. Node IDs belong to that snapshot.`,
    parameters: analyzeHeapSnapshotInputSchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
    execution: { taskSupport: "forbidden" },
    execute: handlers.analyzeHeapSnapshot,
  });

  server.addTool({
    name: "react_list_components",
    description: `List a bounded flat component-tree page with renderer, root, component, and list-cursor IDs for the selected document. ${REACT_RENDERERS} ${REACT_COMPONENT_IDS} ${REACT_FIRST_CALL} Continue a list cursor only with the query that produced it.`,
    parameters: reactListComponentsInputSchema,
    annotations: MUTATING_ANNOTATIONS,
    canAccess: canAccessReactChromeTools,
    execution: { taskSupport: "forbidden" },
    execute: handlers.reactListComponents,
  });

  server.addTool({
    name: "react_inspect_component",
    description: `Inspect one component by opaque component ID, unique main-document CSS selector, or retained snapshot ref; returns hook and context IDs. ${REACT_COMPONENT_IDS} A ref works only on the connection, browser mode and browserInstanceId, browser generation, and selected page it was captured from, and only while its snapshot is still retained. Child-frame refs are unsupported; main-frame open-shadow refs retain exact node identity. ${REACT_FIRST_CALL} If the reload stales a ref, take a new snapshot and use its new ref; never retarget a replacement node. Production pages expose only what their renderer supports, so do not assume development-build behavior. Report CHROME_MCP_UNKNOWN_REF, CHROME_MCP_SNAPSHOT_TARGET_MISMATCH, CHROME_MCP_STALE_REF, and CHROME_MCP_REACT_UNSUPPORTED_OPERATION; do not retry with a selector.`,
    parameters: reactInspectComponentInputSchema,
    annotations: MUTATING_ANNOTATIONS,
    canAccess: canAccessReactChromeTools,
    execution: { taskSupport: "forbidden" },
    execute: handlers.reactInspectComponent,
  });

  server.addTool({
    name: "react_update_component",
    description: `Temporarily update renderer-supported React props, state, hooks, or context. Changes only the live renderer, never source or storage. applied means complete readback matched; overwritten means complete readback differed; unverified means preview data, inspection limits, or an intervening component update prevented verification. Inspection marks DevTools previews as opaque and truncated. Applied overrides may be replaced by later application renders. Report unsupported-operation errors instead of assuming development-build behavior.`,
    parameters: reactUpdateComponentInputSchema,
    annotations: MUTATING_ANNOTATIONS,
    canAccess: canAccessReactChromeTools,
    execution: { taskSupport: "forbidden" },
    execute: handlers.reactUpdateComponent,
  });

  // server.addTool({
  //   name: "react_highlight_component",
  //   description: `Show or clear the React DevTools host-node highlight overlay for a component. ${REACT_COMPONENT_IDS}`,
  //   parameters: reactHighlightComponentInputSchema,
  //   annotations: MUTATING_ANNOTATIONS,
  //   canAccess: canAccessReactChromeTools,
  //   execution: { taskSupport: "forbidden" },
  //   execute: handlers.reactHighlightComponent,
  // });

  server.addTool({
    name: "react_profile_start",
    description: `Start React commit profiling on the selected page. ${REACT_RENDERERS} ${REACT_FIRST_CALL} ${REACT_PROFILE_IDS} Stop with the returned ID even if another page is selected.`,
    parameters: reactProfileStartInputSchema,
    annotations: MUTATING_ANNOTATIONS,
    canAccess: canAccessReactChromeTools,
    execution: { taskSupport: "forbidden" },
    execute: handlers.reactProfileStart,
  });

  server.addTool({
    name: "react_profile_stop",
    description: `Stop a React profile and retain its normalized data for analysis, even if another page is selected. ${REACT_PROFILE_IDS} ${REACT_COMPLETED_PROFILES} ${REACT_PROFILE_STOP_NOTICE} Read ${CHROME_REACT_PROFILE_DOC_URI} for clean-baseline setup.`,
    parameters: reactProfileStopInputSchema,
    annotations: MUTATING_ANNOTATIONS,
    canAccess: canAccessReactChromeTools,
    execution: { taskSupport: "forbidden" },
    execute: handlers.reactProfileStop,
  });

  server.addTool({
    name: "react_profile_analyze",
    description: `Rank completed React profiles by render or commit cost. Read ${CHROME_REACT_PROFILE_DOC_URI} for result fields, artifacts, limits, and cursor rules.`,
    parameters: reactProfileAnalyzeInputSchema,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    canAccess: canAccessReactChromeTools,
    execution: { taskSupport: "forbidden" },
    execute: handlers.reactProfileAnalyze,
  });
};
