import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { ChromeRuntimeError } from "./errors";

export const launchVirtualDisplay = async (executablePath = Bun.which("Xvfb")) => {
  const isUnavailable = process.platform !== "linux" || !executablePath;
  if (isUnavailable) {
    throw new ChromeRuntimeError(
      "CHROME_MCP_UNSUPPORTED_CAPABILITY",
      "isolated-virtual-display requires Linux and Xvfb on PATH; no headless fallback was started",
    );
  }

  const child = spawn(
    executablePath,
    ["-displayfd", "3", "-screen", "0", "1920x1080x24", "-nolisten", "tcp", "-noreset"],
    {
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    },
  );
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<void>((resolve) => {
    child.once("close", () => {
      if (shutdownTimer) {
        clearTimeout(shutdownTimer);
      }

      resolve();
    });
  });

  const stop = () => {
    const hasStoppedOrStopping =
      child.exitCode !== null || child.signalCode !== null || shutdownTimer !== undefined;
    if (hasStoppedOrStopping) return;

    child.kill("SIGTERM");
    shutdownTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
  };

  const close = async () => {
    stop();
    await stopped;
  };

  let diagnostics = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4096);
  });

  try {
    const display = await new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;

      const rejectStartup = (message: string) => {
        clearTimeout(timer);
        const errorDetails = diagnostics ? `: ${diagnostics}` : "";
        reject(new ChromeRuntimeError("CHROME_MCP_BROWSER_DISCONNECTED", `${message}${errorDetails}`));
      };

      timer = setTimeout(() => rejectStartup("Xvfb did not publish a display within 10000 ms"), 10_000);
      child.on("error", (error) => rejectStartup(`Xvfb failed: ${error.message}`));
      child.once("exit", () => rejectStartup("Xvfb exited before publishing a display"));

      const readiness = child.stdio[3];
      if (!(readiness instanceof Readable)) {
        rejectStartup("Xvfb readiness pipe is unavailable");
        return;
      }

      let output = "";
      readiness.on("data", (chunk: Buffer) => {
        output += chunk.toString();

        if (output.length > 32) {
          rejectStartup("Xvfb returned an invalid display number");
          return;
        }

        if (!output.includes("\n")) return;

        const number = output.trim();
        if (!/^\d+$/u.test(number)) {
          rejectStartup("Xvfb returned an invalid display number");
          return;
        }

        clearTimeout(timer);
        resolve(`:${number}`);
      });
    });
    return Object.freeze({ close, display, stop });
  } catch (error: unknown) {
    await close();
    throw error;
  }
};
