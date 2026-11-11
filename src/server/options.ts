import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CHROME_MCP_METADATA } from "../chrome/server/metadata";
import { REACT_TOOLS_MODES } from "../chrome/server/react-access";

export const SERVER_HELP = `Better Chrome MCP ${CHROME_MCP_METADATA.version}

Usage: better-chrome-mcp [options]

Options:
  --executable-path <path>     Chrome executable (or CHROME_MCP_EXECUTABLE_PATH)
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

export const parseServerOptions = (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: {
      "executable-path": { type: "string" },
      workspace: { type: "string" },
      react: { type: "string" },
      "main-user-data-dir": { type: "string" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  const mainUserDataDir = values["main-user-data-dir"];

  return {
    executablePath: values["executable-path"],
    workspacePath: resolve(values.workspace ?? process.cwd()),
    reactTools: parseReactToolsMode(values.react),
    mainUserDataDir: mainUserDataDir === undefined ? undefined : resolve(mainUserDataDir),
    shouldShowHelp: values.help ?? false,
    shouldShowVersion: values.version ?? false,
  };
};
