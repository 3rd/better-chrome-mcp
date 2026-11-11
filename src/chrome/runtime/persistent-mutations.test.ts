import { describe, expect, test } from "bun:test";
import { FakeCdpClient } from "./fake-cdp-client.test-support";
import {
  PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS,
  PERSISTENT_MUTATION_MAX_COUNT_PER_KIND,
  PersistentBrowserMutations,
  type PersistentMutationKind,
  PersistentMutationRegistry,
} from "./persistent-mutations";

const target = (targetId: string) => ({ ownerGeneration: 1, targetId });

const record = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) output[key] = item;
  return output;
};

const createPendingPageBinding = async () => {
  const invocationStarted = Promise.withResolvers<void>();
  const releaseInvocation = Promise.withResolvers<void>();
  const settlementCompleted = Promise.withResolvers<void>();
  let connection: FakeCdpClient | undefined;
  const pageGlobal: Record<string, unknown> = {
    hostValue: (payload: unknown) => {
      if (typeof payload !== "string" || !connection) {
        throw new Error("persistent binding transport payload was invalid");
      }
      connection.emit(
        "Runtime.bindingCalled",
        {
          executionContextId: 1,
          name: "hostValue",
          payload,
        },
        "session-a",
      );
    },
  };
  let nextScript = 1;
  connection = new FakeCdpClient(undefined, async (command) => {
    if (command.method === "Page.addScriptToEvaluateOnNewDocument") {
      return { identifier: `binding-script-${nextScript++}` };
    }
    if (command.method === "Runtime.evaluate" && typeof command.params.expression === "string") {
      const evaluate = new Function("globalThis", command.params.expression);
      Reflect.apply(evaluate, undefined, [pageGlobal]);
      if (command.params.expression.includes("?.settle(")) settlementCompleted.resolve();
    }
    return {};
  });
  const mutations = new PersistentBrowserMutations(connection, () => undefined);
  const registry = new PersistentMutationRegistry({
    newId: () => "binding-a",
    runBinding: async (request) => {
      invocationStarted.resolve();
      await releaseInvocation.promise;
      return request.args[0] ?? null;
    },
    validateBinding: async () => undefined,
  });
  mutations.addClient("client-a", registry);
  await mutations.attachTarget({ sessionId: "session-a", targetId: "page-a" });
  const binding = await registry.add({ kind: "binding", name: "hostValue", source: "(value) => value" });
  if (binding.kind !== "binding") throw new Error("expected a persistent binding");
  await mutations.claimTarget("client-a", target("page-a"));
  const exposed = pageGlobal.hostValue;
  if (typeof exposed !== "function") throw new Error("persistent binding was not installed");
  const pending = Reflect.apply(exposed, pageGlobal, ["pending"]);
  if (!(pending instanceof Promise)) throw new Error("persistent binding did not return a Promise");
  await invocationStarted.promise;
  return { binding, mutations, pending, registry, releaseInvocation, settlementCompleted };
};

const removalFailures: Readonly<{
  kind: PersistentMutationKind;
  label: string;
  method: string;
}>[] = [
  { kind: "route", label: "route removal", method: "Fetch.disable" },
  { kind: "initScript", label: "init-script removal", method: "Page.removeScriptToEvaluateOnNewDocument" },
  { kind: "binding", label: "binding page removal", method: "Runtime.evaluate" },
  { kind: "binding", label: "binding-script removal", method: "Page.removeScriptToEvaluateOnNewDocument" },
  { kind: "binding", label: "binding transport removal", method: "Runtime.removeBinding" },
];

describe("PersistentMutationRegistry", () => {
  test("supports bounded add, list, remove, and clear operations", async () => {
    let nextId = 1;
    const registry = new PersistentMutationRegistry({ newId: (kind) => `${kind}-${nextId++}` });
    const route = await registry.add({
      action: { body: "stub", headers: {}, status: 200, type: "fulfill" },
      kind: "route",
      urlPattern: "https://api.example.test/*",
    });
    const script = await registry.add({ kind: "initScript", source: "globalThis.marker = true" });
    const binding = await registry.add({ kind: "binding", name: "hostValue", source: "(value) => value" });

    expect(registry.entries("route")).toEqual([route]);
    expect(registry.entries("initScript")).toEqual([script]);
    expect(registry.entries("binding")).toEqual([binding]);
    expect(registry.remove("route", route.id)).toEqual(route);
    expect(registry.clear("initScript")).toEqual([script]);
    expect(registry.entries("route")).toEqual([]);
    expect(registry.entries("initScript")).toEqual([]);
    expect(registry.entries("binding")).toEqual([binding]);
  });

  test("rejects duplicate binding names and registry overflow with stable codes", async () => {
    let nextId = 1;
    const registry = new PersistentMutationRegistry({ newId: (kind) => `${kind}-${nextId++}` });
    await registry.add({ kind: "binding", name: "hostValue", source: "() => 1" });
    expect(registry.add({ kind: "binding", name: "hostValue", source: "() => 2" })).rejects.toMatchObject({
      code: "CHROME_MCP_MUTATION_CONFLICT",
    });

    for (let index = 0; index < PERSISTENT_MUTATION_MAX_COUNT_PER_KIND; index++) {
      await registry.add({
        action: { type: "continue" },
        kind: "route",
        urlPattern: `https://example.test/${index}`,
      });
    }
    expect(
      registry.add({ action: { type: "continue" }, kind: "route", urlPattern: "https://overflow.test" }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_MUTATION_LIMIT" });
  });

  test("validates binding source without committing or invoking the handler", async () => {
    let nextId = 1;
    const registry = new PersistentMutationRegistry({ newId: () => `binding-${nextId++}` });
    expect(registry.add({ kind: "binding", name: "badSyntax", source: "(value =>" })).rejects.toMatchObject({
      code: "CHROME_MCP_MUTATION_FAILED",
    });
    expect(registry.entries("binding")).toEqual([]);
    expect(
      registry.add({ kind: "binding", name: "notAFunction", source: "({ value: 1 })" }),
    ).rejects.toMatchObject({
      code: "CHROME_MCP_MUTATION_FAILED",
    });
    expect(registry.entries("binding")).toEqual([]);

    const valid = await registry.add({
      kind: "binding",
      name: "needsArgument",
      source:
        "(required) => { if (required === undefined) throw new Error('handler was invoked'); return required; }",
    });
    expect(registry.entries("binding")).toEqual([valid]);
  });

  test("caps active binding subprocesses and releases capacity after completion", async () => {
    const gate = Promise.withResolvers<void>();
    let blocked = true;
    const registry = new PersistentMutationRegistry({
      newId: () => "binding-a",
      runBinding: async (request) => {
        if (blocked) await gate.promise;
        return request.args[0] ?? null;
      },
    });
    const binding = await registry.add({ kind: "binding", name: "hostValue", source: "(value) => value" });
    const active = Array.from({ length: PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS }, (_, index) =>
      registry.runBinding(binding.id, [index]),
    );
    expect(registry.runBinding(binding.id, ["overflow"])).rejects.toMatchObject({
      code: "CHROME_MCP_MUTATION_LIMIT",
    });

    blocked = false;
    gate.resolve();
    expect(await Promise.all(active)).toEqual(
      Array.from({ length: PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS }, (_, index) => index),
    );
    expect(await registry.runBinding(binding.id, ["recovered"])).toBe("recovered");
  });
});

describe("PersistentBrowserMutations", () => {
  test("rejects oversized page arguments before transport and keeps the installed binding usable", async () => {
    let installSource = "";
    const connection = new FakeCdpClient(undefined, async (command) => {
      if (command.method === "Page.addScriptToEvaluateOnNewDocument") {
        if (
          typeof command.params.source === "string" &&
          command.params.source.includes("__chromeMcpPersistentBindings")
        ) {
          installSource = command.params.source;
        }
        return { identifier: "binding-script" };
      }
      return {};
    });
    const mutations = new PersistentBrowserMutations(connection, () => undefined);
    const registry = new PersistentMutationRegistry({ newId: () => "binding-a" });
    mutations.addClient("client-a", registry);
    await mutations.attachTarget({ sessionId: "session-a", targetId: "page-a" });
    await registry.add({ kind: "binding", name: "hostValue", source: "(value) => value" });
    await mutations.claimTarget("client-a", target("page-a"));
    expect(installSource).not.toBe("");

    const pageGlobal: Record<string, unknown> = {};
    let transportCalls = 0;
    pageGlobal.hostValue = (payloadValue: unknown) => {
      transportCalls += 1;
      if (typeof payloadValue !== "string") throw new Error("binding payload was not text");
      const call = record(JSON.parse(payloadValue));
      const bindingId = typeof call?.bindingId === "string" ? call.bindingId : undefined;
      const callId = typeof call?.callId === "string" ? call.callId : undefined;
      const registryValue = record(pageGlobal.__chromeMcpPersistentBindings);
      const installed = bindingId ? record(registryValue?.[bindingId]) : undefined;
      const settle = installed?.settle;
      if (!callId || typeof settle !== "function") throw new Error("binding settlement is unavailable");
      queueMicrotask(() => Reflect.apply(settle, installed, [callId, true, call?.args ?? null]));
    };
    const install = new Function("globalThis", installSource);
    Reflect.apply(install, undefined, [pageGlobal]);
    const exposed = pageGlobal.hostValue;
    if (typeof exposed !== "function") throw new Error("persistent binding was not installed");

    const oversized: unknown = Reflect.apply(exposed, pageGlobal, ["x".repeat(70_000)]);
    expect(oversized).rejects.toThrow();
    expect(transportCalls).toBe(0);
    const later: unknown = Reflect.apply(exposed, pageGlobal, ["small"]);
    expect(await later).toEqual(["small"]);
    expect(transportCalls).toBe(1);
  });

  test("settles excess concurrent page calls immediately and accepts calls after capacity recovers", async () => {
    const gate = Promise.withResolvers<void>();
    const overflowSettled = Promise.withResolvers<void>();
    const firstBatchSettled = Promise.withResolvers<void>();
    const laterSettled = Promise.withResolvers<void>();
    let blocked = true;
    let settlements = 0;
    let overflowExpression = "";
    const connection = new FakeCdpClient(undefined, async (command) => {
      if (command.method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "binding-script" };
      if (
        command.method === "Runtime.evaluate" &&
        typeof command.params.expression === "string" &&
        command.params.expression.includes("?.settle(")
      ) {
        settlements += 1;
        if (command.params.expression.includes("CHROME_MCP_MUTATION_LIMIT")) {
          overflowExpression = command.params.expression;
          overflowSettled.resolve();
        }
        if (settlements === PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS + 1) firstBatchSettled.resolve();
        if (settlements === PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS + 2) laterSettled.resolve();
      }
      return {};
    });
    const errors: unknown[] = [];
    const mutations = new PersistentBrowserMutations(connection, (error) => errors.push(error));
    const registry = new PersistentMutationRegistry({
      newId: () => "binding-a",
      runBinding: async (request) => {
        if (blocked) await gate.promise;
        return request.args[0] ?? null;
      },
      validateBinding: async () => undefined,
    });
    mutations.addClient("client-a", registry);
    await mutations.attachTarget({ sessionId: "session-a", targetId: "page-a" });
    const binding = await registry.add({ kind: "binding", name: "hostValue", source: "(value) => value" });
    if (binding.kind !== "binding") throw new Error("expected a persistent binding");
    await mutations.claimTarget("client-a", target("page-a"));

    for (let index = 0; index <= PERSISTENT_BINDING_MAX_CONCURRENT_INVOCATIONS; index += 1) {
      connection.emit(
        "Runtime.bindingCalled",
        {
          executionContextId: 1,
          name: binding.name,
          payload: JSON.stringify({ args: [index], bindingId: binding.id, callId: String(index) }),
        },
        "session-a",
      );
    }
    await overflowSettled.promise;
    expect(overflowExpression).toContain("CHROME_MCP_MUTATION_LIMIT");

    blocked = false;
    gate.resolve();
    await firstBatchSettled.promise;
    connection.emit(
      "Runtime.bindingCalled",
      {
        executionContextId: 1,
        name: binding.name,
        payload: JSON.stringify({ args: ["later"], bindingId: binding.id, callId: "later" }),
      },
      "session-a",
    );
    await laterSettled.promise;
    expect(errors).toEqual([]);
  });

  test("applies current registrations, handles routes, and removes them on connection cleanup", async () => {
    let scriptId = 0;
    let fulfilledRequest: (() => void) | undefined;
    const requestFulfilled = new Promise<void>((resolve) => {
      fulfilledRequest = resolve;
    });
    const connection = new FakeCdpClient(undefined, async (command) => {
      if (command.method === "Page.addScriptToEvaluateOnNewDocument") {
        return { identifier: `script-${++scriptId}` };
      }
      if (command.method === "Fetch.fulfillRequest") fulfilledRequest?.();
      return {};
    });
    const errors: unknown[] = [];
    const mutations = new PersistentBrowserMutations(connection, (error) => errors.push(error));
    let nextId = 1;
    const registry = new PersistentMutationRegistry({ newId: (kind) => `${kind}-${nextId++}` });
    mutations.addClient("client-a", registry);
    await mutations.attachTarget({ sessionId: "session-a", targetId: "page-a" });
    await registry.add({
      action: { body: "stubbed", headers: { "content-type": "text/plain" }, status: 201, type: "fulfill" },
      kind: "route",
      urlPattern: "https://api.example.test/*",
    });
    await registry.add({ kind: "initScript", source: "globalThis.__marker = 1" });
    await registry.add({ kind: "binding", name: "hostValue", source: "(value) => ({ value })" });
    await mutations.claimTarget("client-a", target("page-a"));

    const installedMethods = connection.commands.map((command) => command.method);
    expect(installedMethods).toContain("Fetch.enable");
    expect(installedMethods).toContain("Page.addScriptToEvaluateOnNewDocument");
    expect(installedMethods).toContain("Runtime.addBinding");
    expect(installedMethods).toContain("Runtime.evaluate");
    connection.emit(
      "Fetch.requestPaused",
      {
        request: { method: "GET", url: "https://api.example.test/data" },
        requestId: "request-a",
      },
      "session-a",
    );
    await requestFulfilled;
    expect(connection.commands).toContainEqual(
      expect.objectContaining({
        method: "Fetch.fulfillRequest",
        params: expect.objectContaining({ requestId: "request-a", responseCode: 201 }),
        sessionId: "session-a",
      }),
    );

    await mutations.removeClient("client-a");
    expect(registry.empty).toBe(true);
    const cleanupMethods = connection.commands.map((command) => command.method);
    expect(cleanupMethods).toContain("Fetch.disable");
    expect(cleanupMethods).toContain("Page.removeScriptToEvaluateOnNewDocument");
    expect(cleanupMethods).toContain("Runtime.removeBinding");
    expect(errors).toEqual([]);
  });

  test("isolates owned targets and replays one connection registry into a recovered generation", async () => {
    const first = new FakeCdpClient(undefined, async (command) =>
      command.method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "first-script" } : {},
    );
    const registryA = new PersistentMutationRegistry({ newId: () => "init-a" });
    await registryA.add({ kind: "initScript", source: "globalThis.connection = 'a'" });
    const registryB = new PersistentMutationRegistry({ newId: () => "init-b" });
    const firstMutations = new PersistentBrowserMutations(first, () => undefined);
    firstMutations.addClient("client-a", registryA);
    firstMutations.addClient("client-b", registryB);
    await firstMutations.attachTarget({ sessionId: "session-a", targetId: "page-a" });
    await firstMutations.claimTarget("client-a", target("page-a"));
    expect(() => firstMutations.assertTargetAccessible("client-b", target("page-a"))).toThrow(
      expect.objectContaining({ code: "CHROME_MCP_MUTATION_CONFLICT" }),
    );
    firstMutations.stop();

    const recovered = new FakeCdpClient(undefined, async (command) =>
      command.method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "recovered-script" } : {},
    );
    const recoveredMutations = new PersistentBrowserMutations(recovered, () => undefined);
    recoveredMutations.addClient("client-a", registryA);
    await recoveredMutations.attachTarget({
      activeConnectionId: "client-a",
      sessionId: "session-recovered",
      targetId: "page-recovered",
    });

    expect(registryA.entries("initScript")).toHaveLength(1);
    expect(recovered.commands).toContainEqual(
      expect.objectContaining({
        method: "Page.addScriptToEvaluateOnNewDocument",
        params: { source: "globalThis.connection = 'a'" },
        sessionId: "session-recovered",
      }),
    );
    expect(registryB.empty).toBe(true);
  });

  test("releases a target claim as soon as the owning connection clears its last mutation", async () => {
    const connection = new FakeCdpClient();
    const mutations = new PersistentBrowserMutations(connection, () => undefined);
    const registryA = new PersistentMutationRegistry({ newId: () => "route-a" });
    const registryB = new PersistentMutationRegistry({ newId: () => "route-b" });
    mutations.addClient("client-a", registryA);
    mutations.addClient("client-b", registryB);
    await mutations.attachTarget({ sessionId: "session-a", targetId: "page-a" });
    await registryA.add({ action: { type: "continue" }, kind: "route", urlPattern: "https://a.example/*" });
    await mutations.claimTarget("client-a", target("page-a"));
    expect(() => mutations.assertTargetAccessible("client-b", target("page-a"))).toThrow(
      expect.objectContaining({ code: "CHROME_MCP_MUTATION_CONFLICT" }),
    );

    registryA.clear("route");
    await mutations.reconcileClient("client-a");
    mutations.releaseClientTargets("client-a");
    await registryB.add({ action: { type: "continue" }, kind: "route", urlPattern: "https://b.example/*" });
    await mutations.claimTarget("client-b", target("page-a"));
    expect(() => mutations.assertTargetAccessible("client-a", target("page-a"))).toThrow(
      expect.objectContaining({ code: "CHROME_MCP_MUTATION_CONFLICT" }),
    );
  });

  test("retries a failed inherited target installation before publishing its ownership", async () => {
    let failInstall = true;
    const connection = new FakeCdpClient(undefined, async (command) => {
      if (command.method === "Fetch.enable" && failInstall) {
        failInstall = false;
        throw new Error("injected inherited target failure");
      }
      return {};
    });
    const mutations = new PersistentBrowserMutations(connection, () => undefined);
    const registry = new PersistentMutationRegistry({ newId: () => "route-a" });
    mutations.addClient("client-a", registry);
    mutations.addClient("client-b", new PersistentMutationRegistry());
    await registry.add({
      action: { type: "continue" },
      kind: "route",
      urlPattern: "https://api.example.test/*",
    });

    expect(
      mutations.attachTarget({
        activeConnectionId: "client-a",
        sessionId: "session-a",
        targetId: "page-a",
      }),
    ).rejects.toMatchObject({ code: "CHROME_MCP_MUTATION_FAILED" });
    expect(mutations.claimedTargetIds("client-a")).toEqual([]);
    expect(() => mutations.assertTargetAccessible("client-b", target("page-a"))).toThrow(
      expect.objectContaining({ code: "CHROME_MCP_MUTATION_CONFLICT" }),
    );

    await mutations.reconcileClient("client-a");
    expect(mutations.claimedTargetIds("client-a")).toEqual(["page-a"]);
  });

  test("rearms session-scoped routes without duplicating target-scoped resources after reattachment", async () => {
    let nextScript = 1;
    const connection = new FakeCdpClient(undefined, async (command) =>
      command.method === "Page.addScriptToEvaluateOnNewDocument" ?
        { identifier: `script-${nextScript++}` }
      : {},
    );
    const mutations = new PersistentBrowserMutations(connection, () => undefined);
    const registry = new PersistentMutationRegistry({ validateBinding: async () => undefined });
    mutations.addClient("client-a", registry);
    await registry.add({
      action: { type: "continue" },
      kind: "route",
      urlPattern: "https://api.example.test/*",
    });
    await registry.add({ kind: "initScript", source: "globalThis.__reattached = true" });
    await registry.add({ kind: "binding", name: "hostValue", source: "(value) => value" });
    await mutations.attachTarget({
      activeConnectionId: "client-a",
      sessionId: "session-a",
      targetId: "page-a",
    });
    const registrations = connection.commands.filter(
      (command) => command.method === "Page.addScriptToEvaluateOnNewDocument",
    ).length;

    await mutations.attachTarget({
      activeConnectionId: "client-a",
      sessionId: "session-b",
      targetId: "page-a",
    });
    expect(
      connection.commands.filter((command) => command.method === "Page.addScriptToEvaluateOnNewDocument"),
    ).toHaveLength(registrations);
    expect(connection.commands.filter((command) => command.method === "Runtime.addBinding")).toHaveLength(1);
    expect(
      connection.commands
        .filter((command) => command.method === "Fetch.enable")
        .map((command) => command.sessionId),
    ).toEqual(["session-a", "session-b"]);
    expect(mutations.claimedTargetIds("client-a")).toEqual(["page-a"]);

    await mutations.removeClient("client-a");
    expect(
      connection.commands
        .filter((command) => command.method === "Fetch.disable")
        .map((command) => command.sessionId),
    ).toEqual(["session-b"]);
    expect(
      connection.commands.filter((command) => command.method === "Page.removeScriptToEvaluateOnNewDocument"),
    ).toHaveLength(2);
    expect(
      connection.commands.filter(
        (command) => command.method === "Runtime.removeBinding" && command.sessionId === "session-b",
      ),
    ).toHaveLength(1);
  });

  for (const failure of [
    { label: "route installation", method: "Fetch.enable", occurrence: 1 },
    { label: "init-script registration", method: "Page.addScriptToEvaluateOnNewDocument", occurrence: 1 },
    { label: "init-script evaluation", method: "Runtime.evaluate", occurrence: 1 },
    { label: "binding transport", method: "Runtime.addBinding", occurrence: 1 },
    { label: "binding-script registration", method: "Page.addScriptToEvaluateOnNewDocument", occurrence: 2 },
    { label: "binding evaluation", method: "Runtime.evaluate", occurrence: 2 },
  ]) {
    test(`compensates a failed ${failure.label} before publishing target ownership`, async () => {
      let matchingCommands = 0;
      let failed = false;
      let nextScript = 1;
      let pageBindingInstalled = false;
      let routesEnabled = false;
      const bindings = new Set<string>();
      const scripts = new Set<string>();
      const connection = new FakeCdpClient(undefined, async (command) => {
        if (command.method === failure.method) {
          matchingCommands += 1;
          if (!failed && matchingCommands === failure.occurrence) {
            failed = true;
            throw new Error(`injected ${failure.label} failure`);
          }
        }
        if (command.method === "Page.addScriptToEvaluateOnNewDocument") {
          const identifier = `script-${nextScript++}`;
          scripts.add(identifier);
          return { identifier };
        }
        if (
          command.method === "Page.removeScriptToEvaluateOnNewDocument" &&
          typeof command.params.identifier === "string"
        ) {
          scripts.delete(command.params.identifier);
        }
        if (command.method === "Fetch.enable") routesEnabled = true;
        if (command.method === "Fetch.disable") routesEnabled = false;
        if (command.method === "Runtime.addBinding" && typeof command.params.name === "string") {
          bindings.add(command.params.name);
        }
        if (command.method === "Runtime.removeBinding" && typeof command.params.name === "string") {
          bindings.delete(command.params.name);
        }
        if (
          command.method === "Runtime.evaluate" &&
          typeof command.params.expression === "string" &&
          command.params.expression.includes("__chromeMcpPersistentBindings")
        ) {
          pageBindingInstalled = !command.params.expression.includes("?.rejectAll(");
        }
        return {};
      });
      const mutations = new PersistentBrowserMutations(connection, () => undefined);
      const registry = new PersistentMutationRegistry({ validateBinding: async () => undefined });
      mutations.addClient("client-a", registry);
      mutations.addClient("client-b", new PersistentMutationRegistry());
      await mutations.attachTarget({ sessionId: "session-a", targetId: "page-a" });
      await registry.add({
        action: { type: "continue" },
        kind: "route",
        urlPattern: "https://api.example.test/*",
      });
      await registry.add({ kind: "initScript", source: "globalThis.__atomicInit = true" });
      await registry.add({ kind: "binding", name: "hostValue", source: "(value) => value" });

      expect(mutations.claimTarget("client-a", target("page-a"))).rejects.toMatchObject({
        code: "CHROME_MCP_MUTATION_FAILED",
      });
      expect(failed).toBe(true);
      expect(mutations.claimedTargetIds("client-a")).toEqual([]);
      expect(() => mutations.assertTargetAccessible("client-b", target("page-a"))).not.toThrow();
      expect({ bindings: [...bindings], pageBindingInstalled, routesEnabled, scripts: [...scripts] }).toEqual(
        {
          bindings: [],
          pageBindingInstalled: false,
          routesEnabled: false,
          scripts: [],
        },
      );

      await mutations.claimTarget("client-a", target("page-a"));
      expect(mutations.claimedTargetIds("client-a")).toEqual(["page-a"]);
      expect(bindings).toEqual(new Set(["hostValue"]));
      expect(pageBindingInstalled).toBe(true);
      expect(routesEnabled).toBe(true);
      expect(scripts.size).toBe(2);
    });
  }

  for (const failure of removalFailures) {
    test(`restores the prior installation after a failed ${failure.label}`, async () => {
      let injectFailure = false;
      let failed = false;
      let nextScript = 1;
      let pageBindingInstalled = false;
      let routesEnabled = false;
      const bindings = new Set<string>();
      const scripts = new Set<string>();
      const connection = new FakeCdpClient(undefined, async (command) => {
        if (injectFailure && !failed && command.method === failure.method) {
          failed = true;
          throw new Error(`injected ${failure.label} failure`);
        }
        if (command.method === "Page.addScriptToEvaluateOnNewDocument") {
          const identifier = `script-${nextScript++}`;
          scripts.add(identifier);
          return { identifier };
        }
        if (
          command.method === "Page.removeScriptToEvaluateOnNewDocument" &&
          typeof command.params.identifier === "string"
        ) {
          scripts.delete(command.params.identifier);
        }
        if (command.method === "Fetch.enable") routesEnabled = true;
        if (command.method === "Fetch.disable") routesEnabled = false;
        if (command.method === "Runtime.addBinding" && typeof command.params.name === "string") {
          bindings.add(command.params.name);
        }
        if (command.method === "Runtime.removeBinding" && typeof command.params.name === "string") {
          bindings.delete(command.params.name);
        }
        if (
          command.method === "Runtime.evaluate" &&
          typeof command.params.expression === "string" &&
          command.params.expression.includes("__chromeMcpPersistentBindings")
        ) {
          pageBindingInstalled = !command.params.expression.includes("?.rejectAll(");
        }
        return {};
      });
      const mutations = new PersistentBrowserMutations(connection, () => undefined);
      const registry = new PersistentMutationRegistry({ validateBinding: async () => undefined });
      mutations.addClient("client-a", registry);
      await mutations.attachTarget({ sessionId: "session-a", targetId: "page-a" });
      await registry.add({
        action: { type: "continue" },
        kind: "route",
        urlPattern: "https://api.example.test/*",
      });
      await registry.add({ kind: "initScript", source: "globalThis.__atomicInit = true" });
      await registry.add({ kind: "binding", name: "hostValue", source: "(value) => value" });
      await mutations.claimTarget("client-a", target("page-a"));

      const removed = registry.clear(failure.kind);
      injectFailure = true;
      expect(mutations.reconcileClient("client-a")).rejects.toMatchObject({
        code: "CHROME_MCP_MUTATION_FAILED",
      });
      expect(failed).toBe(true);
      injectFailure = false;
      registry.restore(removed);
      await mutations.reconcileClient("client-a");
      expect(mutations.claimedTargetIds("client-a")).toEqual(["page-a"]);
      expect(bindings).toEqual(new Set(["hostValue"]));
      expect(pageBindingInstalled).toBe(true);
      expect(routesEnabled).toBe(true);
      expect(scripts.size).toBe(2);
    });
  }

  test("tracks dirty installation state when compensation fails and recovers it on the next reconcile", async () => {
    let failEvaluation = true;
    let failCompensation = true;
    let nextScript = 1;
    const connection = new FakeCdpClient(undefined, async (command) => {
      if (command.method === "Page.addScriptToEvaluateOnNewDocument") {
        return { identifier: `script-${nextScript++}` };
      }
      if (command.method === "Runtime.evaluate" && failEvaluation) {
        failEvaluation = false;
        return { exceptionDetails: { text: "binding install exploded" } };
      }
      if (command.method === "Page.removeScriptToEvaluateOnNewDocument" && failCompensation) {
        failCompensation = false;
        throw new Error("injected compensation failure");
      }
      return {};
    });
    const mutations = new PersistentBrowserMutations(connection, () => undefined);
    const registry = new PersistentMutationRegistry({
      newId: () => "binding-a",
      validateBinding: async () => undefined,
    });
    mutations.addClient("client-a", registry);
    await mutations.attachTarget({ sessionId: "session-a", targetId: "page-a" });
    await registry.add({ kind: "binding", name: "hostValue", source: "(value) => value" });

    expect(mutations.claimTarget("client-a", target("page-a"))).rejects.toMatchObject({
      code: "CHROME_MCP_MUTATION_FAILED",
    });
    expect(mutations.claimedTargetIds("client-a")).toEqual([]);
    await mutations.claimTarget("client-a", target("page-a"));
    expect(mutations.claimedTargetIds("client-a")).toEqual(["page-a"]);
  });

  test("preserves registry and ownership metadata when connection cleanup fails", async () => {
    let failCleanup = true;
    const connection = new FakeCdpClient(undefined, async (command) => {
      if (command.method === "Fetch.disable" && failCleanup) {
        failCleanup = false;
        throw new Error("injected connection cleanup failure");
      }
      return {};
    });
    const mutations = new PersistentBrowserMutations(connection, () => undefined);
    const registry = new PersistentMutationRegistry({ newId: () => "route-a" });
    mutations.addClient("client-a", registry);
    mutations.addClient("client-b", new PersistentMutationRegistry());
    await mutations.attachTarget({ sessionId: "session-a", targetId: "page-a" });
    await registry.add({
      action: { type: "continue" },
      kind: "route",
      urlPattern: "https://api.example.test/*",
    });
    await mutations.claimTarget("client-a", target("page-a"));

    expect(mutations.removeClient("client-a")).rejects.toThrow();
    expect(registry.entries("route")).toHaveLength(1);
    expect(mutations.claimedTargetIds("client-a")).toEqual(["page-a"]);
    expect(() => mutations.assertTargetAccessible("client-b", target("page-a"))).toThrow(
      expect.objectContaining({ code: "CHROME_MCP_MUTATION_CONFLICT" }),
    );

    await mutations.removeClient("client-a");
    expect(registry.empty).toBe(true);
    expect(() => mutations.assertTargetAccessible("client-b", target("page-a"))).not.toThrow();
  });

  test("rejects pending page binding calls when the binding is removed", async () => {
    const { binding, mutations, pending, registry, releaseInvocation, settlementCompleted } =
      await createPendingPageBinding();
    const rejected = pending.then(
      () => false,
      () => true,
    );
    registry.remove("binding", binding.id);
    await mutations.reconcileClient("client-a");
    expect(await rejected).toBe(true);
    releaseInvocation.resolve();
    await settlementCompleted.promise;
  });

  test("rejects pending page binding calls when bindings are cleared", async () => {
    const { mutations, pending, registry, releaseInvocation, settlementCompleted } =
      await createPendingPageBinding();
    const rejected = pending.then(
      () => false,
      () => true,
    );
    registry.clear("binding");
    await mutations.reconcileClient("client-a");
    expect(await rejected).toBe(true);
    releaseInvocation.resolve();
    await settlementCompleted.promise;
  });

  test("rejects pending page binding calls when the connection closes", async () => {
    const { mutations, pending, releaseInvocation, settlementCompleted } = await createPendingPageBinding();
    const rejected = pending.then(
      () => false,
      () => true,
    );
    await mutations.removeClient("client-a");
    expect(await rejected).toBe(true);
    releaseInvocation.resolve();
    await settlementCompleted.promise;
  });
});
