import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSessionContext } from "../../mcp/session-context";
import type { ChromeService } from "./service";
import { ArtifactStore } from "../artifacts";
import { CHROME_TOOL_NAMES } from "./contracts";
import { createChromeMcpServer } from "./create-server";
import { CHROME_DOC_URIS } from "./register-docs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const session = (connectionId: string): ToolSessionContext => ({
  connectionId,
  pathContext: { baseCwd: process.cwd() },
  recording: { mode: "off" },
});

describe("Chrome MCP server factory", () => {
  test("wires tools, docs, artifact resources, capabilities, and session lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-server-factory-test-"));
    roots.push(root);
    const artifactStore = new ArtifactStore({ root });
    const connected: string[] = [];
    const closed: string[] = [];
    const service: ChromeService = {
      artifactConnection: () => ({ connectionId: "artifact-owner" }),
      artifactOwner: () => ({ connectionId: "artifact-owner" }),
      artifactStore,
      close: () => Promise.resolve(),
      closeConnection: () => Promise.resolve(),
      handlers: {
        analyzeHeapSnapshot: () => Promise.resolve({ content: [{ type: "text", text: "heap-query" }] }),
        lighthouseAudit: () => Promise.resolve({ content: [{ type: "text", text: "lighthouse" }] }),
        performanceAnalyzeInsight: () => Promise.resolve({ content: [{ type: "text", text: "insight" }] }),
        performanceStartTrace: () => Promise.resolve({ content: [{ type: "text", text: "start" }] }),
        performanceStopTrace: () => Promise.resolve({ content: [{ type: "text", text: "stop" }] }),
        runPlaywright: () => Promise.resolve({ content: [{ type: "text", text: "run" }] }),
        takeHeapSnapshot: () => Promise.resolve({ content: [{ type: "text", text: "heap" }] }),
        reactListComponents: () => Promise.resolve({ content: [{ type: "text", text: "react-list" }] }),
        reactInspectComponent: () => Promise.resolve({ content: [{ type: "text", text: "react-inspect" }] }),
        reactUpdateComponent: () => Promise.resolve({ content: [{ type: "text", text: "react-update" }] }),
        reactHighlightComponent: () =>
          Promise.resolve({ content: [{ type: "text", text: "react-highlight" }] }),
        reactProfileStart: () =>
          Promise.resolve({ content: [{ type: "text", text: "react-profile-start" }] }),
        reactProfileStop: () => Promise.resolve({ content: [{ type: "text", text: "react-profile-stop" }] }),
        reactProfileAnalyze: () =>
          Promise.resolve({ content: [{ type: "text", text: "react-profile-analyze" }] }),
      },
      resourcesCapabilities: { listChanged: true, subscribe: false },
      sessionLifecycle: {
        onClose: ({ connectionId }) => {
          closed.push(connectionId);
        },
        onConnect: ({ connectionId }) => {
          connected.push(connectionId);
        },
      },
      sessionResources: (owner) =>
        Promise.resolve([
          {
            load: () => Promise.resolve({ text: owner.connectionId }),
            name: "Owned artifact",
            uri: `chrome-artifact://${owner.connectionId}/manifest`,
          },
        ]),
    };
    const server = createChromeMcpServer(service, { authenticate: () => Promise.resolve(session("auth")) });

    expect(server.captured.tools.map(({ name }) => name)).toEqual([...CHROME_TOOL_NAMES]);
    expect(server.captured.resources.map(({ uri }) => uri)).toEqual(CHROME_DOC_URIS);
    expect(server.captured.resourceTemplates).toHaveLength(3);
    expect(server.options.resourcesCapabilities).toEqual({ listChanged: true, subscribe: false });
    expect(server.capturedSessionLifecycles).toHaveLength(1);

    const provider = server.options.sessionResourceProvider;
    if (!provider) throw new Error("Expected a session resource provider");
    const provided = await provider(session("resources"));
    expect(provided.map(({ uri }) => uri)).toEqual(["chrome-artifact://resources/manifest"]);

    const lifecycle = server.capturedSessionLifecycles[0];
    if (!lifecycle?.onConnect || !lifecycle.onClose) {
      throw new Error("Expected complete Chrome lifecycle hooks");
    }
    const owner = session("owner");
    const context = {
      connectionId: owner.connectionId,
      notifyResourcesListChanged: () => Promise.resolve(),
      session: owner,
    };
    await lifecycle.onConnect(context);
    await lifecycle.onClose(context);
    expect(connected).toEqual(["owner"]);
    expect(closed).toEqual(["owner"]);

    await artifactStore.close();
  });
});
