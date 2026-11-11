import { CHROME_MCP_METADATA } from "../chrome/server/metadata";
import { resolveChromeExecutable } from "../platform/chrome-executable";
import { parseServerOptions, SERVER_HELP } from "./options";

export const startServer = async (args = process.argv.slice(2)) => {
  const options = parseServerOptions(args);
  if (options.shouldShowHelp) {
    console.log(SERVER_HELP);

    return;
  }
  if (options.shouldShowVersion) {
    console.log(CHROME_MCP_METADATA.version);

    return;
  }

  const isSupportedPlatform =
    process.platform === "linux" || process.platform === "darwin" || process.platform === "win32";
  if (!isSupportedPlatform) {
    throw new Error("Better Chrome MCP requires Linux, macOS, or Windows.");
  }

  const executablePath = await resolveChromeExecutable(options);
  const [
    { assertSupportedBunVersion },
    { createChromeMcpServer },
    { createChromeService },
    { createToolSessionContext },
  ] = await Promise.all([
    import("../chrome/execution"),
    import("../chrome/server/create-server"),
    import("../chrome/server/service"),
    import("../mcp/session-context"),
  ]);
  assertSupportedBunVersion();

  const instructions = await Bun.file(new URL("../chrome/instructions.md", import.meta.url)).text();
  const service = await createChromeService({
    executablePath,
    mainUserDataDir: options.mainUserDataDir,
    workspacePath: options.workspacePath,
  });
  const server = createChromeMcpServer(service, {
    authenticate: () => createToolSessionContext({ baseCwd: options.workspacePath }, { mode: "off" }),
    instructions,
    reactTools: options.reactTools,
  });
  let closePromise: Promise<void> | undefined;

  const closeServer = () => {
    closePromise ??= (async () => {
      await server.stop();
      await service.close();
    })();

    return closePromise;
  };

  const handleShutdown = () => {
    closeServer().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
  process.stdin.once("end", handleShutdown);

  try {
    await server.start({ transportType: "stdio" });
  } catch (error) {
    await closeServer();
    throw error;
  }
};
