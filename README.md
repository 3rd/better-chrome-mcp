# Better Chrome MCP

A Playwright-based MCP server that lets a coding agent drive, inspect, and measure things in Chrome.

It runs on [Bun](https://bun.sh), talks to the client over standard input/output, and works on Linux, macOS, and Windows with Google Chrome or Chromium.

This project is not affiliated to Google/Chrome/Chromium.

## Requirements

- Bun 1.4.0 or newer.
- Google Chrome or Chromium.
- Linux only: the `flock` command from util-linux.
- Optional: `ffmpeg` for video capture.
- Optional, Linux only: Xvfb for the `isolated-virtual-display` browser mode.

## Install

To have a coding agent do the setup, ask it to follow [SETUP.md](SETUP.md). That guide covers the installation, each client's configuration, and a browser check through each client. To do it yourself:

1. Clone this repository and install its dependencies:

   ```bash
   git clone <repository URL> better-chrome-mcp
   cd better-chrome-mcp
   bun install --frozen-lockfile
   ```

2. Check that the server starts:

   ```bash
   bun src/index.ts --version
   ```

The server runs from the checkout and needs no build. A client starts it with `bun /absolute/path/to/checkout/src/index.ts`, where the path is the folder you cloned into.

To update, `git pull` and `bun install --frozen-lockfile` in the checkout, then start a new session in your client.

## Connect a client

The client starts the server itself. Do not start it in a terminal or configure a URL for it.

The server works on one project folder, called its workspace. Relative output paths, shared browser profiles, and React detection all use it. By default the workspace is the folder the server is started in. If your client does not start servers in the project folder, pass `--workspace /absolute/path/to/project`.

Claude Code, run from the project folder:

```bash
claude mcp add chrome-mcp -- bun /absolute/path/to/checkout/src/index.ts
```

Codex:

```bash
codex mcp add chrome-mcp -- bun /absolute/path/to/checkout/src/index.ts --workspace /absolute/path/to/project
```

OpenCode, run from the project folder:

```bash
opencode mcp add chrome-mcp -- bun /absolute/path/to/checkout/src/index.ts --workspace /absolute/path/to/project
```

Clients configured with an `mcpServers` object:

```json
{
  "mcpServers": {
    "chrome-mcp": {
      "command": "bun",
      "args": ["/absolute/path/to/checkout/src/index.ts", "--workspace", "/absolute/path/to/project"]
    }
  }
}
```

Start a new session afterwards. If the client cannot start the server, use Bun's absolute path in place of `bun`, because graphical clients can have a shorter `PATH` than your terminal.

## What the agent gets

### Tools

Seven tools are always offered:

- `run_playwright`: run async JavaScript with `page`, `context`, `browser`, `args`, and a `chrome` helper already available.
- `performance_start_trace`, `performance_stop_trace`, and `performance_analyze_insight`: record and analyze a Chrome performance trace.
- `lighthouse_audit`: audit the selected page.
- `take_heapsnapshot` and `analyze_heapsnapshot`: save and query a memory snapshot.

Six React tools list, inspect, and temporarily update components and record render profiles. The `--react` [startup option](#startup-options) decides whether they are offered.

### Browser modes

Every browser-selecting call names a browser mode:

- `isolated-headless`: the default. A temporary browser without a window. Each call passes a `browserInstanceId` the agent chooses; reusing the ID keeps that browser across calls, and a new ID starts another.
- `isolated`: a temporary browser with a visible window.
- `isolated-virtual-display`: a temporary browser with a real window on a private Xvfb display, for checking text rendering at the screen's native scale. Linux only.
- `shared-headless` and `shared`: profiles that persist for the workspace and are shared by every client connected to it, one without a window and one with.
- `main`: your own running Chrome. It needs Chrome 144 or newer with remote debugging switched on at `chrome://inspect/#remote-debugging`, and Chrome asks you to approve the connection.

A first `run_playwright` call names the mode, the browser ID, and the script:

```json
{
  "browser": "isolated-headless",
  "browserInstanceId": "example",
  "code": "await page.goto('https://example.com'); return { title: await page.title() };"
}
```

### Documents and artifacts

The server ships its reference documentation as 18 documents that the agent reads on demand through the client's MCP resource reader. `chrome-docs://run-playwright` is the starting point, and `chrome-docs://helper-api.d.ts` lists every helper.

Screenshots, recordings, and large results come back as `chrome-artifact://` resources that belong to the connection that produced them.

## How the usage rules reach the model

The server sends its usage rules to the client in the MCP `instructions` field when the connection opens. The rules say which browser mode to pick, when a visible window is allowed, when your own Chrome may be touched, and what to close. Each client decides whether to show that field to the model. Claude Code and OpenCode do. Codex did not when tested (version 0.167.0), and some chat clients do not.

To check your client, ask the model to quote this server's instructions before it calls a tool. If it has none, what to do depends on the client:

- If the model can read MCP resources on its own, it can still get the rules: the same text is the document `chrome-docs://instructions`, and the description of `run_playwright` tells the model to read it.
- If it cannot, paste the text into the client's own instruction file for the project. The text is `src/chrome/instructions.md` in the checkout.

## Security

- `run_playwright` runs the agent's JavaScript on your machine with your permissions, and so do the persistent bindings a script can register. The separate worker process is there for stability; it is not a sandbox. Read the code before you approve a call, and keep your client's approval prompts on.
- The usage rules tell the model to use the `main` mode only when you ask for your own browser. Chrome shows an approval prompt and an automation banner. Once attached, the agent's code can reach every tab and cookie in that browser.
- The event log keeps request headers as they were sent, including cookies and authorization tokens. Whatever the agent reads from the log can end up in the conversation.
- A browser the server starts accepts debugging connections on a local port on `127.0.0.1`, so other programs on the same machine can connect to it.
- Trace analysis runs locally. The server does not look up field data from the Chrome UX Report.

## Startup options

Pass options after `src/index.ts`, as in the `--workspace` examples under [Connect a client](#connect-a-client).

- `--workspace <path>`: the project folder. Default: the folder the server is started in.
- `--executable-path <path>`: the Chrome or Chromium program to run. Default: the first one the server finds; see [Which Chrome runs](#which-chrome-runs).
- `--react <auto|on|off>`: whether to offer the React tools. `auto`, the default, offers them when the project that contains the workspace, or a project nested up to four folders below it, has React installed in `node_modules`. `off` keeps them out of the tool list, and `on` offers them regardless.
- `--main-user-data-dir <path>`: the profile folder of the running browser that the `main` mode attaches to. Default: Google Chrome's own profile folder. Set it for Chromium or another Chrome channel. Sessions on one workspace that use `main` at the same time need the same value.
- `--help` and `--version`: print the options or the version, then exit.

### Which Chrome runs

The Chrome program comes from `--executable-path`, or from the environment variable `CHROME_MCP_EXECUTABLE_PATH` when the option is absent.

With neither set, the server looks for `google-chrome-stable`, `google-chrome`, `chromium`, and `chromium-browser` on `PATH`. It then looks for Google Chrome and Chromium in the standard install folders: `/Applications` and `~/Applications` on macOS, and `Program Files`, `Program Files (x86)`, and the user's local application data folder on Windows.

Sessions on one workspace share a background process that starts the browsers, and it keeps the Chrome program of the session that started it. After changing the option or the variable, close every client session on that workspace and wait a few seconds before starting a new one.

## Where data is kept

- Runtime state (the background process's log and connection files, temporary browser profiles, and captures) is stored in a `chrome-mcp-u<user id>` folder under `XDG_RUNTIME_DIR` when that variable is set, and otherwise under the system's temporary folder. `CHROME_MCP_RUNTIME_DIR` selects another folder.
- The profiles of the `shared` and `shared-headless` modes persist under `$XDG_DATA_HOME/chrome-mcp/profiles`, by default `~/.local/share/chrome-mcp/profiles` on every operating system.
- The server removes temporary browsers and the files that belong to a connection, and keeps shared profiles for reuse.

## Development

### Run the checks

```bash
bun run test
bun run typecheck
bun run smoke:source
bun run build
bun run smoke
```

`bun run verify` runs all five. The unit tests use synthetic fixtures and skip the tests that need a real browser. Run those separately:

```bash
bun run test:live
```

On Linux the live run starts a private Xvfb display, so it needs Xvfb and no window appears on the desktop. On macOS and Windows it opens Chrome windows, and the Linux-only cases are skipped.

### Install a global command

To run the server as a `better-chrome-mcp` command on `PATH`, or to give it to someone without the repository, build the package archive and install it:

```bash
bun run build
bun pm pack
bun add -g /absolute/path/to/checkout/better-chrome-mcp-0.0.0.tgz
```

`bun run build` writes `dist/`, and `bun pm pack` writes `better-chrome-mcp-<version>.tgz` in the checkout. Run the build yourself, because `bun pm pack` skips it when your Bun configuration sets `ignoreScripts`, and the archive then has no server in it. The archive holds the server and its workers, the patched FastMCP and Chrome DevTools frontend code already bundled, and the third-party license files, so installing it needs no patches and no build. `bun add -g` puts the command in Bun's global bin folder, which `bun pm bin -g` prints (by default `~/.bun/bin`). Use `better-chrome-mcp` wherever this README says `bun /absolute/path/to/checkout/src/index.ts`.

## Third-party notices

Third-party components keep their own licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

