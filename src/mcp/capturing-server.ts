import { FastMCP } from "#fastmcp";
import type {
  FastMCPSession,
  FastMCPSessionAuth,
  InputPrompt,
  InputPromptArgument,
  LoadContext,
  Prompt,
  Resource,
  Tool,
  ToolParameters,
} from "#fastmcp";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { advertisedAgentToolSchema } from "./agent-tool-schema";
import { isToolSessionContext, type ToolSessionContext } from "./session-context";

/**
 * fastmcp does not export InputResourceTemplate (FastMCPSession's constructor consumes it),
 * so derive the default-instantiated shape from the registration method itself.
 */
type ResourceTemplateInput<T extends FastMCPSessionAuth = FastMCPSessionAuth> = Parameters<
  FastMCP<T>["addResourceTemplate"]
>[0];

export type CapturedDefinitions<T extends FastMCPSessionAuth = FastMCPSessionAuth> = {
  prompts: Prompt<T>[];
  resources: Resource<T>[];
  resourceTemplates: ResourceTemplateInput<T>[];
  tools: Tool<T>[];
};

export const capturedDefinitionsForSession = <T extends FastMCPSessionAuth>(
  captured: CapturedDefinitions<T>,
  auth: T | undefined,
): CapturedDefinitions<T> => ({
  prompts: captured.prompts,
  resources: captured.resources,
  resourceTemplates: captured.resourceTemplates,
  tools: captured.tools.filter(
    (tool) => tool.canAccess === undefined || (auth !== undefined && tool.canAccess(auth)),
  ),
});

export const SESSION_DISCONNECT_GRACE_MS = 5000;

export type SessionLifecycleCloseReason = "intentional-shutdown" | "unexpected-disconnect";

export type SessionResourcesCapabilities = Readonly<{
  listChanged: boolean;
  subscribe: boolean;
}>;

export type SessionResourceProvider = (
  session: ToolSessionContext,
) => Promise<readonly Resource<ToolSessionContext>[]>;

export type SessionLifecycleContext = Readonly<{
  connectionId: string;
  notifyResourcesListChanged: () => Promise<void>;
  session: ToolSessionContext;
}>;

export type SessionLifecycleHooks = Readonly<{
  onClose?: (context: SessionLifecycleContext) => Promise<void> | void;
  onConnect?: (context: SessionLifecycleContext) => Promise<void> | void;
}>;

export type ConnectedSessionLifecycle = Readonly<{
  context: SessionLifecycleContext;
  hooks: readonly SessionLifecycleHooks[];
}>;

/**
 * Third-party variance boundary, explicitly justified: Tool<T, Params> does not assign to
 * Tool<T> because execute() takes Params in contravariant position, yet fastmcp performs
 * exactly this erasure internally when it stores registrations (its private #tools is the
 * widened array FastMCPSession later consumes). Nothing here ever calls execute() with
 * unvalidated args - FastMCPSession validates against the tool's own parameters schema
 * before invoking it, identically to fastmcp's own start() path.
 */
const widenTool = <T extends FastMCPSessionAuth, Params extends ToolParameters>(
  tool: Tool<T, Params>,
): Tool<T> => tool as unknown as Tool<T>;

const hasJsonSchema = (schema: StandardSchemaV1): schema is StandardJSONSchemaV1 & StandardSchemaV1 => {
  const jsonSchema: unknown = Reflect.get(schema["~standard"], "jsonSchema");
  return (
    typeof jsonSchema === "object" &&
    jsonSchema !== null &&
    typeof Reflect.get(jsonSchema, "input") === "function" &&
    typeof Reflect.get(jsonSchema, "output") === "function"
  );
};

const assertToolSchemaRootObject = (
  toolName: string,
  schema: StandardSchemaV1,
  direction: "input" | "output",
): void => {
  if (!hasJsonSchema(schema)) return;
  const jsonSchema = schema["~standard"].jsonSchema[direction]({ target: "draft-07" });
  if (jsonSchema.type !== "object") {
    throw new Error(`MCP tool '${toolName}' ${direction} schema root must serialize with type object`);
  }
};

const advertiseTool = <T extends FastMCPSessionAuth, Params extends ToolParameters>(
  tool: Tool<T, Params>,
): Tool<T> => {
  const widened = widenTool(tool);
  const parameters =
    widened.parameters === undefined ? undefined : advertisedAgentToolSchema(widened.parameters, "input");
  const outputSchema =
    widened.outputSchema === undefined ?
      undefined
    : advertisedAgentToolSchema(widened.outputSchema, "output");
  if (parameters !== undefined) assertToolSchemaRootObject(widened.name, parameters, "input");
  if (outputSchema !== undefined) assertToolSchemaRootObject(widened.name, outputSchema, "output");
  return {
    ...widened,
    ...(parameters === undefined ? {} : { parameters }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
};

const sessionLoadContext = (
  context: LoadContext<FastMCPSessionAuth> | undefined,
  session: ToolSessionContext,
): LoadContext<ToolSessionContext> | undefined =>
  context === undefined ? undefined : { ...context, session };

const adaptSessionResource = (resource: Resource<ToolSessionContext>): Resource<FastMCPSessionAuth> => {
  const complete = resource.complete;
  return {
    ...(complete === undefined ?
      {}
    : {
        complete: async (name, value, auth) => {
          if (!isToolSessionContext(auth)) {
            throw new Error("Tool session context is unavailable for resource completion");
          }
          return complete(name, value, auth);
        },
      }),
    description: resource.description,
    load: async (auth, context) => {
      if (!isToolSessionContext(auth)) {
        throw new Error("Tool session context is unavailable for resource reading");
      }
      return resource.load(auth, sessionLoadContext(context, auth));
    },
    mimeType: resource.mimeType,
    name: resource.name,
    uri: resource.uri,
  };
};

/** Same upstream variance erasure as widenTool, for the resource-template load() callback. */
const widenResourceTemplate = <T extends FastMCPSessionAuth, Input extends { name: string }>(
  resource: Input,
): ResourceTemplateInput<T> => resource as unknown as ResourceTemplateInput<T>;

/** Mirrors FastMCP's replace-by-name batch semantics so captured arrays match its private state. */
const replaceByName = <Item extends { name: string }>(existing: Item[], added: Item[]): Item[] => {
  const addedNames = new Set(added.map((item) => item.name));
  return [...existing.filter((item) => !addedNames.has(item.name)), ...added];
};

export type WaitForDisconnectGrace = (durationMs: number, signal: AbortSignal) => Promise<void>;

const waitForDisconnectGrace: WaitForDisconnectGrace = (durationMs, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
  });

const closeLifecycleHooks = async (
  hooks: readonly SessionLifecycleHooks[],
  context: SessionLifecycleContext,
): Promise<void> => {
  const failures: unknown[] = [];
  for (const hook of [...hooks].reverse()) {
    try {
      await hook.onClose?.(context);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "MCP session lifecycle cleanup failed");
};

export const connectSessionLifecycle = async (
  hooks: readonly SessionLifecycleHooks[],
  context: SessionLifecycleContext,
): Promise<ConnectedSessionLifecycle | undefined> => {
  if (hooks.length === 0) return undefined;

  const connected: SessionLifecycleHooks[] = [];
  try {
    for (const hook of hooks) {
      await hook.onConnect?.(context);
      connected.push(hook);
    }
  } catch (error) {
    await closeLifecycleHooks(connected, context);
    throw error;
  }
  return Object.freeze({ context, hooks: Object.freeze(connected) });
};

export const closeSessionLifecycle = async (
  lifecycle: ConnectedSessionLifecycle | undefined,
  options: Readonly<{
    reason: SessionLifecycleCloseReason;
    signal?: AbortSignal;
    wait?: WaitForDisconnectGrace;
  }>,
): Promise<void> => {
  if (!lifecycle) return;
  if (options.reason === "unexpected-disconnect") {
    const signal = options.signal ?? new AbortController().signal;
    await (options.wait ?? waitForDisconnectGrace)(SESSION_DISCONNECT_GRACE_MS, signal);
  }
  await closeLifecycleHooks(lifecycle.hooks, lifecycle.context);
};

export const createSessionLifecycleContext = (
  session: ToolSessionContext,
  notifyResourcesListChanged: () => Promise<void>,
): SessionLifecycleContext =>
  Object.freeze({
    connectionId: session.connectionId,
    notifyResourcesListChanged,
    session,
  });

export class CapturingFastMCP<T extends FastMCPSessionAuth = FastMCPSessionAuth> extends FastMCP<T> {
  readonly captured: CapturedDefinitions<T> = {
    prompts: [],
    resources: [],
    resourceTemplates: [],
    tools: [],
  };
  readonly capturedSessionLifecycles: SessionLifecycleHooks[] = [];
  readonly #directSessionLifecycles = new WeakMap<
    FastMCPSession,
    Promise<ConnectedSessionLifecycle | undefined>
  >();

  constructor(...args: ConstructorParameters<typeof FastMCP<T>>) {
    super(args[0]);
    this.on("connect", ({ session }) => {
      if (!isToolSessionContext(session.auth)) return;
      const context = createSessionLifecycleContext(session.auth, () =>
        session.triggerListChangedNotification("notifications/resources/list_changed"),
      );
      const connected = connectSessionLifecycle(this.capturedSessionLifecycles, context);
      this.#directSessionLifecycles.set(session, connected);
      connected.catch((error: unknown) => this.#logSessionLifecycleError("connect", error));
    });
    this.on("disconnect", ({ session }) => {
      const connected = this.#directSessionLifecycles.get(session);
      if (!connected) return;
      this.#directSessionLifecycles.delete(session);
      connected
        .then((lifecycle) => closeSessionLifecycle(lifecycle, { reason: "unexpected-disconnect" }))
        .catch((error: unknown) => this.#logSessionLifecycleError("close", error));
    });
  }

  #logSessionLifecycleError(stage: "close" | "connect", error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    (this.options.logger ?? console).error(`[FastMCP error] session lifecycle ${stage} failed: ${message}`);
  }

  addSessionLifecycleHooks(this: CapturingFastMCP<ToolSessionContext>, hooks: SessionLifecycleHooks): void {
    this.capturedSessionLifecycles.push(hooks);
  }

  setSessionResourceProvider(
    this: CapturingFastMCP<ToolSessionContext>,
    provider: SessionResourceProvider,
  ): void {
    this.options.sessionResourceProvider = async (auth) => {
      if (!isToolSessionContext(auth)) {
        throw new Error("Tool session context is unavailable for resource listing");
      }
      const resources = await provider(auth);

      return resources.map(adaptSessionResource);
    };
  }

  setSessionResourcesCapabilities(
    this: CapturingFastMCP<ToolSessionContext>,
    capabilities: SessionResourcesCapabilities,
  ): void {
    this.options.resourcesCapabilities = capabilities;
  }

  override addTool<Params extends ToolParameters>(tool: Tool<T, Params>): void {
    const advertised = advertiseTool(tool);
    this.captured.tools = replaceByName(this.captured.tools, [advertised]);
    super.addTool(advertised);
  }

  override addTools<Params extends ToolParameters>(tools: Tool<T, Params>[]): void {
    const advertised = tools.map(advertiseTool);
    this.captured.tools = replaceByName(this.captured.tools, advertised);
    super.addTools(advertised);
  }

  override addPrompt<const Args extends InputPromptArgument<T>[]>(prompt: InputPrompt<T, Args>): void {
    this.captured.prompts = replaceByName(this.captured.prompts, [prompt]);
    super.addPrompt(prompt);
  }

  override addPrompts<const Args extends InputPromptArgument<T>[]>(prompts: InputPrompt<T, Args>[]): void {
    this.captured.prompts = replaceByName(this.captured.prompts, prompts);
    super.addPrompts(prompts);
  }

  override addResource(resource: Resource<T>): void {
    this.captured.resources = replaceByName(this.captured.resources, [resource]);
    super.addResource(resource);
  }

  override addResources(resources: Resource<T>[]): void {
    this.captured.resources = replaceByName(this.captured.resources, resources);
    super.addResources(resources);
  }

  override addResourceTemplate<const Args extends Parameters<FastMCP<T>["addResourceTemplate"]>>(
    ...args: Args
  ): void {
    this.captured.resourceTemplates = replaceByName(this.captured.resourceTemplates, [
      widenResourceTemplate(args[0]),
    ]);
    super.addResourceTemplate(args[0]);
  }

  override addResourceTemplates(resources: Parameters<FastMCP<T>["addResourceTemplates"]>[0]): void {
    this.captured.resourceTemplates = replaceByName(
      this.captured.resourceTemplates,
      resources.map(widenResourceTemplate),
    );
    super.addResourceTemplates(resources);
  }
}
