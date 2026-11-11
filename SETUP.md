# Set up Better Chrome MCP

These instructions are for a coding agent. Install this server on the user's machine, connect it to the coding agent clients they name, and verify that each client can control a disposable Chrome browser.

The steps apply to Linux, macOS, and Windows; where a step differs between them, the difference is stated. Sections 1 to 4 set the server up from a checkout of the repository. If a check fails because of a fault in the server itself, see [Repair from the repository](#repair-from-the-repository).

## Rules for every step

- Inspect the machine and the existing client configuration before changing anything.
- Use the clients and project the user named. If those are unclear, ask which clients and which project to configure in one question.
- Preserve existing MCP entries, credentials, and unrelated settings.
- Configure each requested client separately; configuring one does not configure the others.
- Do not use the user's personal Chrome profile for the setup check. The checks in section 4 use a temporary headless browser and the project's own `shared-headless` profile.

## 1. Check prerequisites

Check that Bun is installed and note its version, then record the operating system and architecture:

```bash
bun --version
bun -e 'console.log({ platform: process.platform, architecture: process.arch })'
```

The server requires Bun 1.4.0 or newer and Google Chrome or Chromium. If Bun is missing, follow the [Bun installation instructions](https://bun.sh/docs/installation). If Chrome is missing, use the [Chrome download page](https://www.google.com/chrome/) or the package manager the user already uses. Recheck the versions afterwards.

Platform notes:

- **Linux:** the `flock` command from util-linux must be on `PATH`. Xvfb is needed only for the `isolated-virtual-display` mode.
- **macOS:** nothing else is required. The profile lock and process checks use system libraries.
- **Windows:** nothing else is required. The profile lock and process checks use `kernel32.dll`.

`ffmpeg` is optional on every platform and needed only for video capture.

Without an explicit path, the server finds Chrome on `PATH` under the names `google-chrome-stable`, `google-chrome`, `chromium`, or `chromium-browser`, then in the standard install folders: `/Applications` and `~/Applications` on macOS, and `Program Files`, `Program Files (x86)`, and the user's local application data folder on Windows. For any other location, record the absolute path of the Chrome program for `--executable-path`. On macOS that is the program inside the `.app` bundle, not the bundle itself.

## 2. Install

Use the checkout the user gave you. If there is none, clone the repository from the URL the user gives you:

```bash
git clone <repository URL> better-chrome-mcp
```

Install the dependencies in the checkout, then check that the server starts:

```bash
bun install --frozen-lockfile
bun src/index.ts --version
bun src/index.ts --help
```

The server runs from the checkout and needs no build. Record the checkout's absolute path: every client starts the server with `bun /absolute/path/to/checkout/src/index.ts`. Record Bun's absolute path as well; clients whose `PATH` lacks Bun's folder need it in place of `bun`.

If the user gave you an archive (`better-chrome-mcp-<version>.tgz`) instead of the repository, install it as a global command and use `better-chrome-mcp` wherever these steps say `bun /absolute/path/to/checkout/src/index.ts`:

```bash
bun add -g /absolute/path/to/better-chrome-mcp-0.0.0.tgz
bun pm bin -g
better-chrome-mcp --version
```

`bun pm bin -g` prints the folder that holds the command.

## 3. Configure the requested clients

The client starts this server over standard input/output. Do not configure a URL or start the server in the background. Run by hand, the server prints nothing, because it is waiting for MCP messages on standard input.

The examples register the server as `chrome-mcp`. If another server already uses that name, inspect the existing entry and choose a different name, such as `chrome-mcp-2`.

The workspace is the user's project. It controls relative output paths, shared browser profiles, and React detection. It defaults to the folder the server is started in. Leave `--workspace` out only after confirming that the client starts MCP servers in the project folder; otherwise pass `--workspace` with the project's absolute path. An entry that applies to every project but carries a fixed `--workspace` keeps using that one project.

Append further options as separate arguments, keeping a path that contains spaces as one argument:

- `--executable-path <path>` when Chrome is not found on its own.
- `--react off` when the user does not want the React tools offered, or `--react on` to offer them regardless of the project.
- `--main-user-data-dir <path>` when the user's own browser is Chromium or another Chrome channel and they want the `main` mode to attach to it.

### Claude Code

Check `claude mcp add --help` against the installed version, then register the server from the project folder:

```bash
claude mcp add --transport stdio --scope local chrome-mcp -- bun /absolute/path/to/checkout/src/index.ts
```

The `local` scope covers this user's current project; use `user` when the user wants the entry everywhere. Reopen the session and inspect its MCP connection status.

### Codex

Codex keeps its MCP entries in its configuration file, by default `~/.codex/config.toml`. Inspect the existing entries there and check `codex mcp add --help` against the installed version, then register the server:

```bash
codex mcp add chrome-mcp -- bun /absolute/path/to/checkout/src/index.ts --workspace "/absolute/path/to/project"
```

Start a new Codex session afterwards.

### OpenCode

Check `opencode mcp add --help` against the installed version, then register the server from the project folder:

```bash
opencode mcp add chrome-mcp -- bun /absolute/path/to/checkout/src/index.ts --workspace "/absolute/path/to/project"
opencode mcp list
```

The command writes the entry to the project's configuration; `--global` writes it for every project. OpenCode's [MCP configuration](https://opencode.ai/docs/mcp-servers/) describes the entry it writes. That shape differs between OpenCode versions, so if you edit the file by hand, follow the documentation for the installed version and preserve the existing entries.

Restart OpenCode. If permissions restrict tools globally or for a named agent, check that this server's tools reach the intended agent without changing unrelated permissions.

### Other MCP clients

Read the installed client's MCP configuration instructions. For clients that use `mcpServers`, merge an entry of this shape into the existing configuration:

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

Use the client's documented configuration file and reload mechanism. Do not paste this shape into a client with a different schema.

## 4. Verify through each client

Use a new or reconnected session of each configured client. If the current session cannot reload its MCP tools, finish the configuration and give the user the exact restart-and-test step; do not report a successful browser test yet.

Do these steps in each configured client, with a different `browserInstanceId` in each. Record each tool result as returned, including errors. A successful registration, or a model's summary, is not evidence that the browser works.

1. Confirm that `run_playwright` and the performance, Lighthouse, and heap tools are listed. Six React tools are listed as well when the project has React installed or the server runs with `--react on`.

2. Check that the usage rules reached the model. Before calling a tool, state whether your context holds this server's instructions on browser modes, visible windows, the user's own Chrome, and closing browsers. If it does not, read `chrome-docs://instructions` through the client's MCP resource reader. If the client offers no way for the model to read MCP resources, tell the user, and offer to add the text of `src/chrome/instructions.md` from the checkout to the client's instruction file for the project.

3. Choose a unique `browserInstanceId`, such as `setup-check-<client>-<random suffix>`. Call `run_playwright` with `browser: "isolated-headless"`, that ID, and the following `code`. It uses a synthetic page, with no network request and no development server:

   ```javascript
   await page.setContent("<title>MCP setup check</title><button>Increment</button><output>0</output>");
   await page.evaluate(() => {
     const button = document.querySelector("button");
     const output = document.querySelector("output");
     button.addEventListener("click", () => {
       output.textContent = String(Number(output.textContent) + 1);
     });
   });
   await page.getByRole("button", { name: "Increment" }).click();
   const count = await page.locator("output").textContent();
   if (count !== "1") throw new Error(`Expected count 1, received ${count}`);
   return { title: await page.title(), count };
   ```

   Expect `ok: true` and a value with `title: "MCP setup check"` and `count: "1"`.

4. Make a second call through the same client connection, with the same browser mode and ID:

   ```javascript
   try {
     const count = await page.locator("output").textContent();
     if (count !== "1") throw new Error(`Expected persisted count 1, received ${count}`);
     return { persistedCount: count };
   } finally {
     await browser.close();
   }
   ```

   Expect `ok: true` and `persistedCount: "1"`. If step 3 or this call fails, close this check's browser, and no other, before finishing.

   Together, steps 3 and 4 check that Chrome starts, that JavaScript runs, that a Playwright click reaches the page's listener, that the browser persists between calls, and that it closes on request. They also exercise the background broker, its connection, and the process identity check, which differ per operating system.

5. Check the profile lock. It also differs per operating system, and only the `shared` and `shared-headless` modes use it. Make one more call, with `browser: "shared-headless"` and no `browserInstanceId`:

   ```javascript
   try {
     await page.setContent("<title>MCP shared profile check</title>");
     return { sharedTitle: await page.title() };
   } finally {
     await browser.close();
   }
   ```

   Expect `ok: true` and `sharedTitle: "MCP shared profile check"`. The call creates the project's persistent `shared-headless` profile, in the folder named under [Diagnose common failures](#diagnose-common-failures), and closes the browser it started. If another session already has this project's shared browser open, the close fails with `CHROME_MCP_BROWSER_CLOSE_FORBIDDEN`; leave that browser open and treat this step as skipped.

## Diagnose common failures

- **The client cannot start the server:** check that the configured path to `src/index.ts` exists and that `bun install --frozen-lockfile` has run in the checkout. Graphical clients can have a different `PATH` from the terminal; use Bun's absolute path in place of `bun`.
- **Chrome is not found:** pass the Chrome program's absolute path with `--executable-path`. Sessions on one project share the broker, and it keeps the Chrome program of the session that started it, so after changing this option close every client session on the project and wait a few seconds before starting a new one.
- **Tools are listed, but the first browser call fails:** read the tool's `error.code` and message, the server's stderr as captured by the client, and the broker's log. The log is `broker.log` under `chrome-brokers` in the runtime folder, which is `CHROME_MCP_RUNTIME_DIR` when set, otherwise a `chrome-mcp-u<user id>` folder under `XDG_RUNTIME_DIR` or the system's temporary folder. The handshake does not start the broker; the first browser call does.
- **Profile lock or process identity errors:** on Linux, check that `flock` is on `PATH`. On macOS and Windows these use native system calls; reproduce with the platform tests under [Repair from the repository](#repair-from-the-repository). Do not delete another browser's profile, bypass the lock, or replace the identity check with a bare process ID to make startup succeed.
- **React tools are missing:** the project needs React installed in `node_modules`; a dependency declaration alone is not enough. Check `--workspace`, or pass `--react on`.
- **React tools appear in a project without React:** pass `--react off`.
- **The `main` mode reports `CHROME_MCP_MAIN_UNAVAILABLE`:** remote debugging must be switched on in the user's browser at `chrome://inspect/#remote-debugging`. For a browser other than Google Chrome, pass its profile folder with `--main-user-data-dir`. Sessions on one project that use `main` at the same time need the same folder.

The profiles of the `shared` and `shared-headless` modes persist under `$XDG_DATA_HOME/chrome-mcp/profiles`, by default `~/.local/share/chrome-mcp/profiles`. Preserve them during diagnosis. Limit cleanup to the processes and temporary files this check created.

## Repair from the repository

A fault in the server itself is repaired in a checkout of the repository, which holds the sources, tests, and dependency patches. If the user has only the archive, report the failure with its evidence and ask for the repository.

Before editing, capture the failing command or tool input, the exact error, the operating system and architecture, and the Bun, Chrome, and client versions. Reproduce the failure at the narrowest boundary that shows it. Preserve the user's existing changes, and fix the code that makes the wrong decision instead of adding a fallback around the symptom.

### Code map

The request path:

1. [src/index.ts](src/index.ts) calls [start-server.ts](src/server/start-server.ts), which parses the startup options in [options.ts](src/server/options.ts), finds Chrome, and starts the stdio MCP server.
2. [create-server.ts](src/chrome/server/create-server.ts) wires tools, documents, artifact resources, and session hooks. [register-tools.ts](src/chrome/server/register-tools.ts) registers the tools, and [contracts.ts](src/chrome/server/contracts.ts) holds their input schemas.
3. [service.ts](src/chrome/server/service.ts) coordinates the tool handlers, browser selection, execution, diagnostics, captures, and connection cleanup.
4. [broker-runtime.ts](src/chrome/server/broker-runtime.ts) gives the service its browser sessions through [broker-rpc/](src/chrome/broker-rpc/), which connects to a separate Bun process, the broker, that owns the browsers across calls. The connection is a Unix socket on Linux and macOS and a named pipe on Windows.
5. [runtime/](src/chrome/runtime/) owns Chrome processes, profiles, pages, profile leases, and persistent browser state. [execution/](src/chrome/execution/) runs each `run_playwright` call in a new Bun worker.

Where to start for a given problem:

- **Startup and Chrome discovery:** [options.ts](src/server/options.ts), [start-server.ts](src/server/start-server.ts), and [chrome-executable.ts](src/platform/chrome-executable.ts).
- **Process identity:** [process-identity.ts](src/chrome/runtime/process-identity.ts) picks the reader for the current system. Linux reads `/proc` in [linux/process-identity.ts](src/platform/linux/process-identity.ts). macOS calls `libproc` in [darwin/process-identity.ts](src/platform/darwin/process-identity.ts). Windows calls `kernel32.dll` in [windows/process-identity.ts](src/platform/windows/process-identity.ts). All native calls go through `bun:ffi`.
- **Profile lock:** [profile-lease.ts](src/chrome/runtime/profile-lease.ts) coordinates leases and starts a child process that holds the lock. Linux runs the `flock` command; macOS runs [darwin/profile-lock-child.ts](src/platform/darwin/profile-lock-child.ts); Windows runs [windows/profile-lock-child.ts](src/platform/windows/profile-lock-child.ts).
- **Broker startup, connection, and log:** [client.ts](src/chrome/broker-rpc/client.ts), [child.ts](src/chrome/broker-rpc/child.ts), and [paths.ts](src/chrome/broker-rpc/paths.ts), which decides the socket or pipe name. [child-environment.ts](src/chrome/broker-rpc/child-environment.ts) builds the broker's command and environment.
- **Child process environment:** [runner.ts](src/chrome/execution/runner.ts) and [browser-launcher.ts](src/chrome/runtime/browser-launcher.ts) list the variables that workers and Chrome receive; [windows/environment.ts](src/platform/windows/environment.ts) adds the ones Windows programs need.
- **Browser launch and ownership:** [browser-launcher.ts](src/chrome/runtime/browser-launcher.ts) starts Chrome through `playwright-core`, and [browser-owner.ts](src/chrome/runtime/browser-owner.ts) owns its lifetime. [paths.ts](src/chrome/runtime/paths.ts) decides the profile folders.
- **Script execution and helpers:** [runner.ts](src/chrome/execution/runner.ts), [worker.ts](src/chrome/execution/worker.ts), [playwright-session.ts](src/chrome/execution/playwright-session.ts), and [helpers.ts](src/chrome/execution/helpers.ts).
- **Diagnostics and captures:** [diagnostics/](src/chrome/diagnostics/) holds traces, Lighthouse, and heap snapshots. [captures/](src/chrome/captures/) holds screenshots and recordings, and [artifacts/](src/chrome/artifacts/) stores their results.
- **React tools:** [react-project.ts](src/chrome/server/react-project.ts) detects installed React, and [react-access.ts](src/chrome/server/react-access.ts) applies the `--react` option. [react-inspection-manager.ts](src/chrome/runtime/react-inspection-manager.ts) holds the browser-side integration, [react-inspection-protocol.ts](src/chrome/runtime/react-inspection-protocol.ts) holds its request and result schemas, and [react-profile-analysis.ts](src/chrome/server/react-profile-analysis.ts) turns a recorded profile into ranked component rows.
- **MCP transport, documents, and rules:** [src/mcp/](src/mcp/) holds the FastMCP wrapper and session context. [register-docs.ts](src/chrome/server/register-docs.ts) publishes the documents, and [instructions.md](src/chrome/instructions.md) is the rules text sent to clients.
- **Packaging:** [scripts/build.ts](scripts/build.ts) recreates `dist/` and bundles the patched dependencies. Dependency changes belong in [package.json](package.json), its lockfile, and [patches/](patches/).

Edit the sources under `src/`, never the generated `dist/`. Child processes load sibling files by path, so keep the folder layout.

### Validate a repair

Tests are in the same folders as the code, as `*.test.ts` files. For process identity, the profile lock, or Chrome discovery, start with:

```bash
bun test ./src/platform ./src/chrome/runtime/process-identity.test.ts ./src/chrome/runtime/profile-lease.test.ts
```

The macOS and Windows process tests each include one check that runs only on that system. For broker or service changes, add:

```bash
bun test ./src/chrome/broker-rpc ./src/chrome/server/service.test.ts
```

After a source repair, run:

```bash
bun run typecheck
bun run test
bun run smoke:source
```

For changes to browser ownership, launch, locking, execution, or cleanup, run the live browser tests too. On macOS and Windows they open Chrome windows, so tell the user before starting them:

```bash
bun run test:live
```

Then start a new session in each affected client, so it runs the repaired checkout, and repeat section 4. If a client uses the command installed from an archive, first run `bun run build` and `bun pm pack`, then install the new archive.

## Handoff

Report:

- What was installed and where, and each configured client entry with its scope and workspace.
- The operating system, architecture, and the Bun, Chrome, and client versions tested.
- The browser-check results as returned for each client, and whether the usage rules reached the model.
- Any source files changed, the cause that was reproduced, and the checks that were skipped.
- How to update later: run `git pull` and `bun install --frozen-lockfile` in the checkout, then restart each client's session.
