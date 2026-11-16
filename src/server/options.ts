import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { redactEndpointUrl } from "../chrome/runtime/endpoint-redaction";
import { CHROME_MCP_METADATA } from "../chrome/server/metadata";
import { REACT_TOOLS_MODES } from "../chrome/server/react-access";

export const SERVER_HELP = `Better Chrome MCP ${CHROME_MCP_METADATA.version}

Usage: better-chrome-mcp [options]

Options:
  --executable-path <path>     Chrome executable (or CHROME_MCP_EXECUTABLE_PATH), or the selected engine's program
  --engine <name>              Browser engine to launch: chrome, obscura, lightpanda, or a name from --engine-config (default: chrome)
  --engine-config <file>       JSON file with more engine recipes, validated at start
  --cdp-endpoint <url>         Browser endpoint (http(s):// or ws(s)://) that the "remote" mode attaches to
  --workspace <path>           Workspace for relative files and shared profiles (default: current directory)
  --react <auto|on|off>        Offer the React tools; auto offers them when the workspace has React installed (default: auto)
  --main-user-data-dir <path>  Profile folder of the running browser that the "main" mode attaches to (default: Google Chrome's)
  --help                       Show this help
  --version                    Show the server version

The server uses MCP over standard input/output. Bun 1.4+ is required.
`;

const parseReactToolsMode = (value: string | undefined) => {
  if (value === undefined) return undefined;

  const mode = REACT_TOOLS_MODES.find((candidate) => candidate === value);
  if (mode === undefined) {
    throw new Error(`--react must be one of ${REACT_TOOLS_MODES.join(", ")}; received "${value}"`);
  }

  return mode;
};

const CDP_ENDPOINT_PROTOCOLS = ["http:", "https:", "ws:", "wss:"];

const parseCdpEndpoint = (value: string | undefined) => {
  if (value === undefined) return undefined;

  try {
    const url = new URL(value);
    if (CDP_ENDPOINT_PROTOCOLS.includes(url.protocol)) return url.href;
  } catch {
    // Reported below with the received value.
  }

  throw new Error(`--cdp-endpoint must be an http(s):// or ws(s):// URL; received "${redactEndpointUrl(value)}"`);
};

export const parseServerOptions = (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: {
      "executable-path": { type: "string" },
      workspace: { type: "string" },
      react: { type: "string" },
      "main-user-data-dir": { type: "string" },
      engine: { type: "string" },
      "engine-config": { type: "string" },
      "cdp-endpoint": { type: "string" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  const mainUserDataDir = values["main-user-data-dir"];
  const engineConfig = values["engine-config"];
  const cdpEndpoint = parseCdpEndpoint(values["cdp-endpoint"]);

  return {
    executablePath: values["executable-path"],
    workspacePath: resolve(values.workspace ?? process.cwd()),
    reactTools: parseReactToolsMode(values.react),
    mainUserDataDir: mainUserDataDir === undefined ? undefined : resolve(mainUserDataDir),
    ...(values.engine === undefined ? {} : { engine: values.engine }),
    ...(engineConfig === undefined ? {} : { engineConfigPath: resolve(engineConfig) }),
    ...(cdpEndpoint === undefined ? {} : { cdpEndpoint }),
    shouldShowHelp: values.help ?? false,
    shouldShowVersion: values.version ?? false,
  };
};
