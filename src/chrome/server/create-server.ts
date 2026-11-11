import type { ReactToolsMode } from "./react-access";
import type { ChromeService } from "./service";
import { CapturingFastMCP } from "../../mcp/capturing-server";
import { createStandaloneToolSessionContext, type ToolSessionContext } from "../../mcp/session-context";
import { registerArtifactResourceTemplates } from "../artifacts";
import { CHROME_MCP_METADATA } from "./metadata";
import { registerChromeDocs } from "./register-docs";
import { registerChromeTools } from "./register-tools";

export type ChromeMcpServerOptions = Readonly<{
  authenticate?: () => Promise<ToolSessionContext>;
  instructions?: string;
  reactTools?: ReactToolsMode;
}>;

export const createChromeMcpServer = (
  service: ChromeService,
  options: ChromeMcpServerOptions = {},
): CapturingFastMCP<ToolSessionContext> => {
  const server = new CapturingFastMCP<ToolSessionContext>({
    ...CHROME_MCP_METADATA,
    authenticate: options.authenticate ?? (() => createStandaloneToolSessionContext()),
    instructions: options.instructions,
  });

  registerChromeDocs(server);
  registerArtifactResourceTemplates(server, {
    owner: service.artifactOwner,
    store: service.artifactStore,
  });
  server.setSessionResourcesCapabilities(service.resourcesCapabilities);
  server.setSessionResourceProvider(service.sessionResources);
  server.addSessionLifecycleHooks(service.sessionLifecycle);
  registerChromeTools(server, service.handlers, options.reactTools);

  return server;
};
