import { z } from "zod/v4";
import type { GenerationTargetId } from "./target-registry";
import { type CdpClient, cdpRecord } from "./cdp-connection";
import { ChromeRuntimeError } from "./errors";
import {
  parsePersistentBindingJson,
  PERSISTENT_BINDING_MAX_PAYLOAD_BYTES,
} from "./persistent-binding-protocol";
import {
  runPersistentBindingSubprocess,
  validatePersistentBindingSubprocess,
} from "./persistent-binding-subprocess";

export const PERSISTENT_MUTATION_MAX_COUNT_PER_KIND = 32;
export const PERSISTENT_MUTATION_MAX_ENTRY_BYTES = 64 * 1024;
export const PERSISTENT_MUTATION_MAX_TOTAL_BYTES = 256 * 1024;
export const PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS = 16;
export { PERSISTENT_BINDING_MAX_PAYLOAD_BYTES } from "./persistent-binding-protocol";

const mutationIdSchema = z.string().min(1).max(128);
const mutationSourceSchema = z.string().min(1).max(PERSISTENT_MUTATION_MAX_ENTRY_BYTES);
const headerValueSchema = z.string().max(8 * 1024);
const headersSchema = z
  .record(z.string().min(1).max(256), headerValueSchema)
  .superRefine((headers, context) => {
    if (Object.keys(headers).length > 64) {
      context.addIssue({ code: "custom", message: "Route headers cannot exceed 64 entries" });
    }
  });

export const persistentMutationKindSchema = z.enum(["route", "initScript", "binding"]);
export type PersistentMutationKind = z.output<typeof persistentMutationKindSchema>;

const routeActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      errorReason: z
        .enum([
          "Aborted",
          "AccessDenied",
          "AddressUnreachable",
          "BlockedByClient",
          "BlockedByResponse",
          "ConnectionAborted",
          "ConnectionClosed",
          "ConnectionFailed",
          "ConnectionRefused",
          "ConnectionReset",
          "Failed",
          "InternetDisconnected",
          "NameNotResolved",
          "TimedOut",
        ])
        .default("Failed"),
      type: z.literal("abort"),
    })
    .strict(),
  z.object({ type: z.literal("continue") }).strict(),
  z
    .object({
      body: z.string().max(PERSISTENT_MUTATION_MAX_ENTRY_BYTES).default(""),
      headers: headersSchema.default({}),
      status: z.number().int().min(100).max(599).default(200),
      type: z.literal("fulfill"),
    })
    .strict(),
]);

export const persistentRouteInputSchema = z
  .object({
    action: routeActionSchema,
    method: z
      .string()
      .min(1)
      .max(32)
      .transform((value) => value.toUpperCase())
      .optional(),
    urlPattern: z.string().min(1).max(2048),
  })
  .strict();

export const persistentInitScriptInputSchema = z
  .object({
    source: mutationSourceSchema,
  })
  .strict();

export const persistentBindingInputSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u),
    source: mutationSourceSchema,
  })
  .strict();

export const persistentMutationInputSchema = z.discriminatedUnion("kind", [
  persistentRouteInputSchema.extend({ kind: z.literal("route") }).strict(),
  persistentInitScriptInputSchema.extend({ kind: z.literal("initScript") }).strict(),
  persistentBindingInputSchema.extend({ kind: z.literal("binding") }).strict(),
]);

export const persistentMutationEntrySchema = z.discriminatedUnion("kind", [
  persistentRouteInputSchema.extend({ id: mutationIdSchema, kind: z.literal("route") }).strict(),
  persistentInitScriptInputSchema.extend({ id: mutationIdSchema, kind: z.literal("initScript") }).strict(),
  persistentBindingInputSchema.extend({ id: mutationIdSchema, kind: z.literal("binding") }).strict(),
]);

export type PersistentRouteInput = z.output<typeof persistentRouteInputSchema>;
export type PersistentBindingInput = z.output<typeof persistentBindingInputSchema>;
export type PersistentMutationInput = z.output<typeof persistentMutationInputSchema>;
export type PersistentMutationEntry = z.output<typeof persistentMutationEntrySchema>;
export type PersistentRoute = Extract<PersistentMutationEntry, { kind: "route" }>;
export type PersistentInitScript = Extract<PersistentMutationEntry, { kind: "initScript" }>;
export type PersistentBinding = Extract<PersistentMutationEntry, { kind: "binding" }>;

export type PersistentMutationRegistryOptions = Readonly<{
  newId?: (kind: PersistentMutationKind) => string;
  runBinding?: typeof runPersistentBindingSubprocess;
  validateBinding?: typeof validatePersistentBindingSubprocess;
}>;

const mutationBytes = (value: PersistentMutationEntry): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const mutationLimit = (message: string): ChromeRuntimeError =>
  new ChromeRuntimeError("CHROME_MCP_MUTATION_LIMIT", message);

const mutationFailure = (message: string, cause?: unknown): ChromeRuntimeError =>
  new ChromeRuntimeError("CHROME_MCP_MUTATION_FAILED", message, cause === undefined ? undefined : { cause });

export class PersistentMutationRegistry {
  readonly #bindings = new Map<string, PersistentBinding>();
  readonly #bindingRunner: typeof runPersistentBindingSubprocess;
  readonly #initScripts = new Map<string, PersistentInitScript>();
  readonly #routes = new Map<string, PersistentRoute>();
  readonly #newId: (kind: PersistentMutationKind) => string;
  readonly #validateBinding: typeof validatePersistentBindingSubprocess;
  #activeBindingInvocations = 0;
  #totalBytes = 0;

  constructor(options: PersistentMutationRegistryOptions = {}) {
    this.#bindingRunner = options.runBinding ?? runPersistentBindingSubprocess;
    this.#newId = options.newId ?? ((kind) => `${kind}-${crypto.randomUUID()}`);
    this.#validateBinding = options.validateBinding ?? validatePersistentBindingSubprocess;
  }

  get empty(): boolean {
    return this.#bindings.size === 0 && this.#initScripts.size === 0 && this.#routes.size === 0;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  async add(inputValue: PersistentMutationInput): Promise<PersistentMutationEntry> {
    const input = persistentMutationInputSchema.parse(inputValue);
    const entry = persistentMutationEntrySchema.parse({ ...input, id: this.#newId(input.kind) });
    const collection = this.#collection(entry.kind);
    if (collection.size >= PERSISTENT_MUTATION_MAX_COUNT_PER_KIND) {
      throw mutationLimit(
        `Persistent ${entry.kind} registry cannot exceed ${PERSISTENT_MUTATION_MAX_COUNT_PER_KIND} entries`,
      );
    }
    if (entry.kind === "binding" && this.bindings().some((binding) => binding.name === entry.name)) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_MUTATION_CONFLICT",
        `Persistent binding name is already registered: ${entry.name}`,
      );
    }
    const bytes = mutationBytes(entry);
    if (bytes > PERSISTENT_MUTATION_MAX_ENTRY_BYTES) {
      throw mutationLimit(
        `Persistent ${entry.kind} entry exceeds ${PERSISTENT_MUTATION_MAX_ENTRY_BYTES} bytes`,
      );
    }
    if (this.#totalBytes + bytes > PERSISTENT_MUTATION_MAX_TOTAL_BYTES) {
      throw mutationLimit(
        `Persistent mutation registry exceeds ${PERSISTENT_MUTATION_MAX_TOTAL_BYTES} bytes`,
      );
    }
    if (entry.kind === "binding") await this.#validateBinding(entry.source);
    collection.set(entry.id, entry);
    this.#totalBytes += bytes;
    return entry;
  }

  bindings(): PersistentBinding[] {
    return [...this.#bindings.values()];
  }

  clear(kind: PersistentMutationKind): PersistentMutationEntry[] {
    const collection = this.#collection(kind);
    const removed = [...collection.values()];
    collection.clear();
    for (const entry of removed) {
      this.#totalBytes -= mutationBytes(entry);
    }
    return removed;
  }

  entries(kind: PersistentMutationKind): PersistentMutationEntry[] {
    return [...this.#collection(kind).values()];
  }

  initScripts(): PersistentInitScript[] {
    return [...this.#initScripts.values()];
  }

  remove(kind: PersistentMutationKind, id: string): PersistentMutationEntry | undefined {
    const collection = this.#collection(kind);
    const entry = collection.get(id);
    if (!entry) return undefined;
    collection.delete(id);
    this.#totalBytes -= mutationBytes(entry);
    return entry;
  }

  restore(entries: readonly PersistentMutationEntry[]): void {
    for (const entry of entries) {
      const collection = this.#collection(entry.kind);
      if (collection.has(entry.id)) continue;
      collection.set(entry.id, entry);
      this.#totalBytes += mutationBytes(entry);
    }
  }

  routes(): PersistentRoute[] {
    return [...this.#routes.values()];
  }

  async runBinding(bindingId: string, args: unknown[]): Promise<unknown> {
    const binding = this.#bindings.get(bindingId);
    if (!binding) throw mutationFailure(`Persistent binding is no longer registered: ${bindingId}`);
    if (this.#activeBindingInvocations >= PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS) {
      throw mutationLimit(
        `Persistent binding registry cannot exceed ${PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS} active invocations`,
      );
    }
    this.#activeBindingInvocations += 1;
    try {
      return await this.#bindingRunner({
        args: args.map(parsePersistentBindingJson),
        source: binding.source,
      });
    } finally {
      this.#activeBindingInvocations -= 1;
    }
  }

  #collection(kind: PersistentMutationKind): Map<string, PersistentMutationEntry> {
    if (kind === "route") return this.#routes;
    if (kind === "initScript") return this.#initScripts;
    return this.#bindings;
  }
}

type InstalledBinding = {
  name: string;
  pageInstalled: boolean;
  runtimeBinding: boolean;
  scriptId?: string;
  source: string;
};

type InstalledInitScript = Readonly<{
  scriptId: string;
  source: string;
}>;

type InstalledTarget = {
  bindingScripts: Map<string, InstalledBinding>;
  clientId?: string;
  dirty: boolean;
  initScripts: Map<string, InstalledInitScript>;
  pendingClientId?: string;
  routes: PersistentRoute[];
  routeSessionId?: string;
  sessionId: string;
  targetId: string;
};

type InstallationState = {
  bindingScripts: Map<string, InstalledBinding>;
  dirty: boolean;
  initScripts: Map<string, InstalledInitScript>;
  routes: PersistentRoute[];
  routeSessionId?: string;
};

type PersistentMutationCleanupTarget = {
  bindingScripts: Map<string, InstalledBinding>;
  initScripts: Map<string, InstalledInitScript>;
  routes: PersistentRoute[];
};

export type PersistentMutationCleanupTombstone = {
  clientId: string;
  registry: PersistentMutationRegistry;
  targets: Map<string, PersistentMutationCleanupTarget>;
};

type DesiredMutations = Readonly<{
  bindings: PersistentBinding[];
  initScripts: PersistentInitScript[];
  routes: PersistentRoute[];
}>;

type AttachedTarget = Readonly<{
  activeConnectionId?: string;
  openerTargetId?: string;
  sessionId: string;
  targetId: string;
}>;

const globPattern = (value: string): RegExp => {
  let pattern = "^";
  for (const character of value) {
    if (character === "*") pattern += ".*";
    else if (character === "?") pattern += ".";
    else pattern += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  return new RegExp(`${pattern}$`, "u");
};

const bindingRegistryName = "__chromeMcpPersistentBindings";

const bindingInstallSource = (binding: PersistentBinding): string => {
  const name = JSON.stringify(binding.name);
  const bindingId = JSON.stringify(binding.id);
  const registryName = JSON.stringify(bindingRegistryName);
  const maximumPayloadBytes = String(PERSISTENT_BINDING_MAX_PAYLOAD_BYTES);
  return `(() => {
    const registry = globalThis[${registryName}] ??= Object.create(null);
    if (registry[${bindingId}]) return;
    const transport = globalThis[${name}];
    if (typeof transport !== "function") throw new Error("Chrome MCP binding transport is unavailable");
    let nextCallId = 1;
    const pending = new Map();
    const exposed = (...args) => new Promise((resolve, reject) => {
      const callId = String(nextCallId++);
      pending.set(callId, { reject, resolve });
      let payload;
      try { payload = JSON.stringify({ args, callId, bindingId: ${bindingId} }); }
      catch (error) { pending.delete(callId); reject(error); return; }
      if (new TextEncoder().encode(payload).byteLength > ${maximumPayloadBytes}) {
        pending.delete(callId);
        reject(new Error("CHROME_MCP_MUTATION_LIMIT: Persistent binding payload exceeds ${maximumPayloadBytes} bytes"));
        return;
      }
      try { transport(payload); }
      catch (error) { pending.delete(callId); reject(error); }
    });
    Object.defineProperty(exposed, "__chromeMcpPersistentBindingId", { value: ${bindingId} });
    registry[${bindingId}] = {
      rejectAll(reason) {
        for (const waiter of pending.values()) waiter.reject(new Error(String(reason)));
        pending.clear();
      },
      settle(callId, ok, value) {
        const waiter = pending.get(callId);
        if (!waiter) return;
        pending.delete(callId);
        if (ok) waiter.resolve(value); else waiter.reject(new Error(String(value)));
      }
    };
    Object.defineProperty(globalThis, ${name}, { configurable: true, value: exposed });
  })();`;
};

const bindingRemoveSource = (binding: Readonly<{ id: string; name: string }>, reason: string): string => {
  const name = JSON.stringify(binding.name);
  const bindingId = JSON.stringify(binding.id);
  const registryName = JSON.stringify(bindingRegistryName);
  return `(() => {
    const registry = globalThis[${registryName}];
    registry?.[${bindingId}]?.rejectAll(${JSON.stringify(reason)});
    if (globalThis[${name}]?.__chromeMcpPersistentBindingId === ${bindingId}) delete globalThis[${name}];
    if (registry) delete registry[${bindingId}];
  })();`;
};

const requireString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const desiredMutations = (registry: PersistentMutationRegistry): DesiredMutations => ({
  bindings: registry.bindings(),
  initScripts: registry.initScripts(),
  routes: registry.routes(),
});

const emptyMutations: DesiredMutations = Object.freeze({ bindings: [], initScripts: [], routes: [] });

const copyInstallation = (target: InstalledTarget): InstallationState => ({
  bindingScripts: new Map([...target.bindingScripts].map(([id, binding]) => [id, { ...binding }])),
  dirty: target.dirty,
  initScripts: new Map(target.initScripts),
  routes: [...target.routes],
  ...(target.routeSessionId ? { routeSessionId: target.routeSessionId } : {}),
});

const publishInstallation = (target: InstalledTarget, state: InstallationState): void => {
  target.bindingScripts = state.bindingScripts;
  target.dirty = state.dirty;
  target.initScripts = state.initScripts;
  target.routes = state.routes;
  target.routeSessionId = state.routeSessionId;
};

const cleanupTarget = (target: InstalledTarget): PersistentMutationCleanupTarget => ({
  bindingScripts: new Map([...target.bindingScripts].map(([id, binding]) => [id, { ...binding }])),
  initScripts: new Map(target.initScripts),
  routes: [...target.routes],
});

export class PersistentBrowserMutations {
  readonly #connection: CdpClient;
  readonly #registries = new Map<string, PersistentMutationRegistry>();
  readonly #targets = new Map<string, InstalledTarget>();
  readonly #targetOwners = new Map<string, string>();
  readonly #unlisten: (() => void)[] = [];

  constructor(connection: CdpClient, onError: (error: unknown) => void) {
    this.#connection = connection;
    this.#unlisten.push(
      connection.on("Fetch.requestPaused", (params, sessionId) => {
        this.#handleRoute(params, sessionId).catch(onError);
      }),
    );
    this.#unlisten.push(
      connection.on("Runtime.bindingCalled", (params, sessionId) => {
        this.#handleBinding(params, sessionId).catch(onError);
      }),
    );
  }

  addClient(clientId: string, registry: PersistentMutationRegistry): void {
    const current = this.#registries.get(clientId);
    if (current && current !== registry) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_MUTATION_CONFLICT",
        "Persistent mutation state for this MCP connection is still active",
      );
    }
    this.#registries.set(clientId, registry);
  }

  async attachTarget(input: AttachedTarget): Promise<void> {
    const existingTarget = this.#targets.get(input.targetId);
    const inheritedOwner = input.openerTargetId ? this.#targetOwners.get(input.openerTargetId) : undefined;
    const clientId =
      input.activeConnectionId ??
      inheritedOwner ??
      existingTarget?.clientId ??
      existingTarget?.pendingClientId;
    if (clientId && !this.#registries.has(clientId)) return;
    const existingOwner = this.#targetOwners.get(input.targetId);
    if (clientId && existingOwner && existingOwner !== clientId) return;
    const target: InstalledTarget = existingTarget ?? {
      bindingScripts: new Map(),
      dirty: false,
      initScripts: new Map(),
      routes: [],
      sessionId: input.sessionId,
      targetId: input.targetId,
    };
    target.sessionId = input.sessionId;
    if (!existingTarget) this.#targets.set(input.targetId, target);
    if (!clientId) return;
    target.pendingClientId = clientId;
    await this.#reconcileTarget(target, desiredMutations(this.#requireRegistry(clientId)));
    target.clientId = clientId;
    delete target.pendingClientId;
    this.#targetOwners.set(input.targetId, clientId);
  }

  async claimTarget(clientId: string, target: GenerationTargetId): Promise<void> {
    const registry = this.#requireRegistry(clientId);
    const owner = this.#targetOwners.get(target.targetId);
    if (owner && owner !== clientId) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_MUTATION_CONFLICT",
        "Chrome target has persistent mutations owned by another MCP connection",
      );
    }
    const installed = this.#targets.get(target.targetId);
    if (!installed) {
      throw mutationFailure(`Chrome target is not attached for persistent mutations: ${target.targetId}`);
    }
    const pendingOwner = installed.pendingClientId;
    if (pendingOwner && pendingOwner !== clientId) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_MUTATION_CONFLICT",
        "Chrome target reconciliation belongs to another MCP connection",
      );
    }
    installed.pendingClientId = clientId;
    try {
      await this.#reconcileTarget(installed, desiredMutations(registry));
      installed.clientId = clientId;
      delete installed.pendingClientId;
      this.#targetOwners.set(target.targetId, clientId);
    } catch (error: unknown) {
      if (!installed.dirty) delete installed.pendingClientId;
      throw error;
    }
  }

  assertTargetAccessible(clientId: string, target: GenerationTargetId): void {
    const installed = this.#targets.get(target.targetId);
    const owner = this.#targetOwners.get(target.targetId) ?? installed?.pendingClientId;
    if (owner && owner !== clientId) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_MUTATION_CONFLICT",
        "Chrome target has persistent mutations owned by another MCP connection",
      );
    }
  }

  detachTarget(targetId: string): void {
    this.#targets.delete(targetId);
    this.#targetOwners.delete(targetId);
  }

  async reconcileClient(clientId: string): Promise<void> {
    const registry = this.#requireRegistry(clientId);
    const targets = [...this.#targets.values()].filter(
      (target) => target.clientId === clientId || target.pendingClientId === clientId,
    );
    await Promise.all(
      targets.map(async (target) => {
        await this.#reconcileTarget(target, desiredMutations(registry));
        if (target.pendingClientId !== clientId) return;
        if (registry.empty) {
          delete target.pendingClientId;
          return;
        }
        target.clientId = clientId;
        delete target.pendingClientId;
        this.#targetOwners.set(target.targetId, clientId);
      }),
    );
  }

  claimedTargetIds(clientId: string): string[] {
    return [...this.#targets.values()]
      .filter((target) => target.clientId === clientId)
      .map((target) => target.targetId);
  }

  createCleanupTombstone(clientId: string): PersistentMutationCleanupTombstone | undefined {
    const registry = this.#registries.get(clientId);
    if (!registry) return undefined;
    const targets = new Map(
      [...this.#targets.values()]
        .filter((target) => target.clientId === clientId || target.pendingClientId === clientId)
        .map((target) => [target.targetId, cleanupTarget(target)]),
    );
    if (registry.empty && targets.size === 0) return undefined;
    return { clientId, registry, targets };
  }

  async drainCleanupTombstone(tombstone: PersistentMutationCleanupTombstone): Promise<void> {
    const failures: unknown[] = [];
    for (const [targetId, saved] of tombstone.targets) {
      const target = this.#targets.get(targetId);
      if (!target) {
        tombstone.targets.delete(targetId);
        continue;
      }
      target.bindingScripts = new Map([...saved.bindingScripts].map(([id, binding]) => [id, { ...binding }]));
      target.dirty = true;
      target.initScripts = new Map(saved.initScripts);
      target.routes = [...saved.routes];
      try {
        await this.#resetDirtyTarget(
          target,
          "CHROME_MCP_MUTATION_FAILED: Persistent binding connection closed",
        );
        tombstone.targets.delete(targetId);
      } catch (error: unknown) {
        tombstone.targets.set(targetId, cleanupTarget(target));
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Persistent browser mutation tombstone cleanup failed");
    }
    tombstone.registry.clear("route");
    tombstone.registry.clear("initScript");
    tombstone.registry.clear("binding");
    this.#registries.delete(tombstone.clientId);
    for (const target of this.#targets.values()) {
      if (target.clientId !== tombstone.clientId && target.pendingClientId !== tombstone.clientId) continue;
      delete target.clientId;
      delete target.pendingClientId;
      this.#targetOwners.delete(target.targetId);
    }
  }

  releaseClientTargets(clientId: string): void {
    const registry = this.#requireRegistry(clientId);
    if (!registry.empty) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_MUTATION_CONFLICT",
        "Persistent mutation target ownership cannot be released while registrations remain",
      );
    }
    for (const target of this.#targets.values()) {
      if (target.clientId !== clientId) continue;
      if (target.dirty) {
        throw mutationFailure(
          `Persistent mutation state is still dirty for Chrome target ${target.targetId}`,
        );
      }
      delete target.clientId;
      delete target.pendingClientId;
      this.#targetOwners.delete(target.targetId);
    }
  }

  async removeClient(clientId: string): Promise<void> {
    await this.#removeClient(clientId, true);
  }

  async close(options: Readonly<{ preserveRegistries?: boolean }> = {}): Promise<void> {
    const cleanup = await Promise.allSettled(
      [...this.#registries.keys()].map((clientId) =>
        this.#removeClient(clientId, !options.preserveRegistries),
      ),
    );
    const failures = cleanup.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Persistent browser mutation shutdown failed",
      );
    }
  }

  async #removeClient(clientId: string, clearRegistry: boolean): Promise<void> {
    const targets = [...this.#targets.values()].filter(
      (target) => target.clientId === clientId || target.pendingClientId === clientId,
    );
    const registry = this.#registries.get(clientId);
    if (!registry) return;
    const cleanup = await Promise.allSettled(
      targets.map((target) =>
        this.#reconcileTarget(
          target,
          emptyMutations,
          "CHROME_MCP_MUTATION_FAILED: Persistent binding connection closed",
        ),
      ),
    );
    const failures = cleanup.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Persistent browser mutations failed to clear",
      );
    }
    if (clearRegistry) {
      registry.clear("route");
      registry.clear("initScript");
      registry.clear("binding");
    }
    for (const target of targets) {
      delete target.clientId;
      delete target.pendingClientId;
      this.#targetOwners.delete(target.targetId);
    }
    this.#registries.delete(clientId);
  }

  stop(): void {
    for (const unlisten of this.#unlisten.splice(0)) unlisten();
  }

  async #reconcileTarget(
    target: InstalledTarget,
    desired: DesiredMutations,
    bindingRemovalReason = "CHROME_MCP_MUTATION_FAILED: Persistent binding was removed",
  ): Promise<void> {
    if (target.dirty) await this.#resetDirtyTarget(target, bindingRemovalReason);
    const state = copyInstallation(target);
    const compensation: (() => Promise<void>)[] = [];
    try {
      await this.#reconcileRoutes(target, state, desired.routes, compensation);
      await this.#reconcileInitScripts(target, state, desired.initScripts, compensation);
      await this.#reconcileBindings(target, state, desired.bindings, compensation, bindingRemovalReason);
      state.dirty = false;
      publishInstallation(target, state);
    } catch (error: unknown) {
      const failures: unknown[] = [];
      for (const compensate of compensation.reverse()) {
        try {
          await compensate();
        } catch (compensationError: unknown) {
          failures.push(compensationError);
        }
      }
      state.dirty = failures.length > 0;
      publishInstallation(target, state);
      if (failures.length > 0) {
        throw mutationFailure(
          `Could not restore persistent mutations for Chrome target ${target.targetId}`,
          new AggregateError([error, ...failures]),
        );
      }
      if (error instanceof ChromeRuntimeError) throw error;
      throw mutationFailure(
        `Could not apply persistent mutations to Chrome target ${target.targetId}`,
        error,
      );
    }
  }

  async #reconcileRoutes(
    target: InstalledTarget,
    state: InstallationState,
    routes: PersistentRoute[],
    compensation: (() => Promise<void>)[],
  ): Promise<void> {
    if (
      JSON.stringify(routes) === JSON.stringify(state.routes) &&
      state.routeSessionId === target.sessionId
    ) {
      return;
    }
    if (routes.length === 0 && state.routes.length === 0) {
      state.routeSessionId = target.sessionId;
      return;
    }
    const previous = [...state.routes];
    const previousSessionId = state.routeSessionId;
    state.routes = [...routes];
    state.routeSessionId = target.sessionId;
    compensation.push(async () => {
      await this.#setRoutes(target, previous);
      state.routes = [...previous];
      state.routeSessionId = target.sessionId;
    });
    try {
      await this.#setRoutes(target, routes);
    } catch (error: unknown) {
      state.routeSessionId = previousSessionId;
      throw error;
    }
  }

  async #reconcileInitScripts(
    target: InstalledTarget,
    state: InstallationState,
    scripts: PersistentInitScript[],
    compensation: (() => Promise<void>)[],
  ): Promise<void> {
    const desired = new Map(scripts.map((script) => [script.id, script]));
    for (const [id, installed] of state.initScripts) {
      if (desired.has(id)) continue;
      await this.#connection.send(
        "Page.removeScriptToEvaluateOnNewDocument",
        { identifier: installed.scriptId },
        target.sessionId,
      );
      state.initScripts.delete(id);
      compensation.push(async () => {
        const restored = await this.#addScript(target, installed.source, "init-script");
        state.initScripts.set(id, { scriptId: restored, source: installed.source });
      });
    }
    for (const script of scripts) {
      if (state.initScripts.has(script.id)) continue;
      const scriptId = await this.#addScript(target, script.source, "init-script");
      state.initScripts.set(script.id, { scriptId, source: script.source });
      compensation.push(async () => {
        await this.#connection.send(
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier: scriptId },
          target.sessionId,
        );
        state.initScripts.delete(script.id);
      });
      await this.#evaluate(target, script.source, "Persistent init script");
    }
  }

  async #reconcileBindings(
    target: InstalledTarget,
    state: InstallationState,
    bindings: PersistentBinding[],
    compensation: (() => Promise<void>)[],
    removalReason: string,
  ): Promise<void> {
    const desired = new Map(bindings.map((binding) => [binding.id, binding]));
    for (const [id, installed] of state.bindingScripts) {
      if (desired.has(id)) continue;
      if (installed.pageInstalled) {
        compensation.push(async () => {
          await this.#evaluate(
            target,
            bindingInstallSource({ id, kind: "binding", name: installed.name, source: installed.source }),
            "Persistent binding restoration",
          );
          installed.pageInstalled = true;
          state.bindingScripts.set(id, installed);
        });
        await this.#evaluate(
          target,
          bindingRemoveSource({ id, name: installed.name }, removalReason),
          "Persistent binding removal",
        );
        installed.pageInstalled = false;
      }
      if (installed.scriptId) {
        const scriptId = installed.scriptId;
        await this.#connection.send(
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier: scriptId },
          target.sessionId,
        );
        delete installed.scriptId;
        compensation.push(async () => {
          installed.scriptId = await this.#addScript(
            target,
            bindingInstallSource({ id, kind: "binding", name: installed.name, source: installed.source }),
            "binding-script",
          );
          state.bindingScripts.set(id, installed);
        });
      }
      if (installed.runtimeBinding) {
        await this.#connection.send("Runtime.removeBinding", { name: installed.name }, target.sessionId);
        installed.runtimeBinding = false;
        compensation.push(async () => {
          await this.#connection.send("Runtime.addBinding", { name: installed.name }, target.sessionId);
          installed.runtimeBinding = true;
          state.bindingScripts.set(id, installed);
        });
      }
      state.bindingScripts.delete(id);
    }
    for (const binding of bindings) {
      if (state.bindingScripts.has(binding.id)) continue;
      const installed: InstalledBinding = {
        name: binding.name,
        pageInstalled: false,
        runtimeBinding: true,
        source: binding.source,
      };
      state.bindingScripts.set(binding.id, installed);
      compensation.push(async () => {
        await this.#connection.send("Runtime.removeBinding", { name: binding.name }, target.sessionId);
        installed.runtimeBinding = false;
        if (!installed.scriptId && !installed.pageInstalled) state.bindingScripts.delete(binding.id);
      });
      await this.#connection.send("Runtime.addBinding", { name: binding.name }, target.sessionId);
      const source = bindingInstallSource(binding);
      installed.scriptId = await this.#addScript(target, source, "binding-script");
      compensation.push(async () => {
        const scriptId = installed.scriptId;
        if (!scriptId) return;
        await this.#connection.send(
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier: scriptId },
          target.sessionId,
        );
        delete installed.scriptId;
        if (!installed.runtimeBinding && !installed.pageInstalled) state.bindingScripts.delete(binding.id);
      });
      installed.pageInstalled = true;
      compensation.push(async () => {
        await this.#evaluate(
          target,
          bindingRemoveSource(
            binding,
            "CHROME_MCP_MUTATION_FAILED: Persistent binding installation was rolled back",
          ),
          "Persistent binding rollback",
        );
        installed.pageInstalled = false;
        if (!installed.runtimeBinding && !installed.scriptId) state.bindingScripts.delete(binding.id);
      });
      await this.#evaluate(target, source, "Persistent binding installation");
    }
  }

  async #resetDirtyTarget(target: InstalledTarget, bindingRemovalReason: string): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.#setRoutes(target, []);
      target.routes = [];
      target.routeSessionId = target.sessionId;
    } catch (error: unknown) {
      failures.push(error);
    }
    for (const [id, script] of target.initScripts) {
      try {
        await this.#connection.send(
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier: script.scriptId },
          target.sessionId,
        );
        target.initScripts.delete(id);
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    for (const [id, binding] of target.bindingScripts) {
      if (binding.pageInstalled) {
        try {
          await this.#evaluate(
            target,
            bindingRemoveSource({ id, name: binding.name }, bindingRemovalReason),
            "Persistent binding cleanup",
          );
          binding.pageInstalled = false;
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      if (binding.scriptId) {
        try {
          await this.#connection.send(
            "Page.removeScriptToEvaluateOnNewDocument",
            { identifier: binding.scriptId },
            target.sessionId,
          );
          delete binding.scriptId;
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      if (binding.runtimeBinding) {
        try {
          await this.#connection.send("Runtime.removeBinding", { name: binding.name }, target.sessionId);
          binding.runtimeBinding = false;
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      if (!binding.pageInstalled && !binding.scriptId && !binding.runtimeBinding) {
        target.bindingScripts.delete(id);
      }
    }
    target.dirty = failures.length > 0;
    if (failures.length > 0) {
      throw mutationFailure(
        `Could not recover dirty persistent mutations for Chrome target ${target.targetId}`,
        new AggregateError(failures),
      );
    }
  }

  async #addScript(target: InstalledTarget, source: string, label: string): Promise<string> {
    const result = cdpRecord(
      await this.#connection.send("Page.addScriptToEvaluateOnNewDocument", { source }, target.sessionId),
    );
    const identifier = requireString(result?.identifier);
    if (!identifier) throw mutationFailure(`Chrome did not return a ${label} identifier`);
    return identifier;
  }

  async #evaluate(
    target: InstalledTarget,
    expression: string,
    label: string,
    contextId?: number,
  ): Promise<void> {
    const result = cdpRecord(
      await this.#connection.send(
        "Runtime.evaluate",
        { ...(contextId === undefined ? {} : { contextId }), expression },
        target.sessionId,
      ),
    );
    if (!result) throw mutationFailure(`${label} did not return a CDP result`);
    if (result.exceptionDetails === undefined) return;
    const details = cdpRecord(result.exceptionDetails);
    const description =
      requireString(cdpRecord(details?.exception)?.description) ?? requireString(details?.text);
    const errorDetails = description ? `: ${description}` : "";
    throw mutationFailure(`${label} raised an exception${errorDetails}`);
  }

  async #setRoutes(target: InstalledTarget, routes: PersistentRoute[]): Promise<void> {
    if (routes.length === 0) {
      await this.#connection.send("Fetch.disable", {}, target.sessionId);
      return;
    }
    await this.#connection.send(
      "Fetch.enable",
      {
        patterns: routes.map((route) => ({ requestStage: "Request", urlPattern: route.urlPattern })),
      },
      target.sessionId,
    );
  }

  async #handleRoute(params: unknown, sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    const target = [...this.#targets.values()].find((candidate) => candidate.sessionId === sessionId);
    const record = cdpRecord(params);
    const request = cdpRecord(record?.request);
    const requestId = requireString(record?.requestId);
    if (!requestId) return;
    const url = requireString(request?.url);
    const method = requireString(request?.method)?.toUpperCase();
    const registry = target?.clientId ? this.#registries.get(target.clientId) : undefined;
    const route =
      url && method ?
        registry
          ?.routes()
          .find(
            (candidate) =>
              (!candidate.method || candidate.method === method) &&
              globPattern(candidate.urlPattern).test(url),
          )
      : undefined;
    if (!route || route.action.type === "continue") {
      await this.#connection.send("Fetch.continueRequest", { requestId }, sessionId);
      return;
    }
    if (route.action.type === "abort") {
      await this.#connection.send(
        "Fetch.failRequest",
        { errorReason: route.action.errorReason, requestId },
        sessionId,
      );
      return;
    }
    await this.#connection.send(
      "Fetch.fulfillRequest",
      {
        body: Buffer.from(route.action.body, "utf8").toString("base64"),
        requestId,
        responseCode: route.action.status,
        responseHeaders: Object.entries(route.action.headers).map(([name, value]) => ({ name, value })),
      },
      sessionId,
    );
  }

  async #handleBinding(params: unknown, sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    const target = [...this.#targets.values()].find((candidate) => candidate.sessionId === sessionId);
    const registry = target?.clientId ? this.#registries.get(target.clientId) : undefined;
    const record = cdpRecord(params);
    const name = requireString(record?.name);
    const payload = requireString(record?.payload);
    const executionContextId = record?.executionContextId;
    if (!registry || !name || !payload || typeof executionContextId !== "number") return;
    if (Buffer.byteLength(payload, "utf8") > PERSISTENT_BINDING_MAX_PAYLOAD_BYTES) {
      throw mutationLimit(`Persistent binding payload exceeds ${PERSISTENT_BINDING_MAX_PAYLOAD_BYTES} bytes`);
    }
    let call: unknown;
    try {
      call = JSON.parse(payload);
    } catch (error: unknown) {
      throw mutationFailure(`Persistent binding ${name} received invalid JSON`, error);
    }
    const callRecord = cdpRecord(call);
    const bindingId = requireString(callRecord?.bindingId);
    const callId = requireString(callRecord?.callId);
    const args = Array.isArray(callRecord?.args) ? callRecord.args : undefined;
    const binding =
      bindingId ?
        registry.bindings().find((entry) => entry.id === bindingId && entry.name === name)
      : undefined;
    if (!binding || !callId || !args) return;
    let ok = true;
    let value: unknown;
    try {
      value = await registry.runBinding(binding.id, args);
    } catch (error: unknown) {
      ok = false;

      if (error instanceof ChromeRuntimeError) {
        value = `${error.code}: ${error.message}`;
      } else if (error instanceof Error) {
        value = error.message;
      } else {
        value = String(error);
      }
    }
    const expression = `globalThis[${JSON.stringify(bindingRegistryName)}]?.[${JSON.stringify(binding.id)}]?.settle(${JSON.stringify(callId)}, ${String(ok)}, ${JSON.stringify(value)})`;
    if (!target) return;
    await this.#evaluate(target, expression, "Persistent binding settlement", executionContextId);
  }

  #requireRegistry(clientId: string): PersistentMutationRegistry {
    const registry = this.#registries.get(clientId);
    if (!registry) {
      throw mutationFailure("Persistent mutation registry is unavailable for this MCP connection");
    }
    return registry;
  }
}
