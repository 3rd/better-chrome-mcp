import { BROKER_SHUTDOWN_MAX_ATTEMPTS } from "./constants";

type BrokerChildCleanupOptions = Readonly<{
  cleanupMetadata: () => Promise<void>;
  cleanupServer: (reason: string) => Promise<void>;
  onRetry: (error: unknown) => void;
  waitBeforeRetry: () => Promise<void>;
}>;

type BrokerChildTerminationOptions = BrokerChildCleanupOptions &
  Readonly<{
    exit: (code: 0 | 1) => void;
    timeoutMs: number;
  }>;

export type BrokerChildTerminationSeverity = "fatal" | "graceful";

const cleanupServer = async (options: BrokerChildCleanupOptions, reason: string): Promise<void> => {
  let failure: unknown;
  for (let attempt = 1; attempt <= BROKER_SHUTDOWN_MAX_ATTEMPTS; attempt += 1) {
    try {
      await options.cleanupServer(reason);
      return;
    } catch (error: unknown) {
      failure = error;
      if (attempt === BROKER_SHUTDOWN_MAX_ATTEMPTS) break;
      options.onRetry(error);
      await options.waitBeforeRetry();
    }
  }
  throw new AggregateError(
    [failure],
    `Chrome broker shutdown failed after ${BROKER_SHUTDOWN_MAX_ATTEMPTS} attempts`,
  );
};

export const cleanupBrokerChild = async (
  options: BrokerChildCleanupOptions,
  reason: string,
): Promise<void> => {
  const results = await Promise.allSettled([cleanupServer(options, reason), options.cleanupMetadata()]);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Chrome broker shutdown cleanup failed",
    );
  }
};

export const createBrokerChildTermination = (options: BrokerChildTerminationOptions) => {
  let exitCode: 0 | 1 = 0;
  let exited = false;
  let terminating = false;

  const exitOnce = (code: 0 | 1): void => {
    if (code === 1) exitCode = 1;
    if (exited) return;
    exited = true;
    options.exit(exitCode);
  };

  const terminate = async (reason: string): Promise<void> => {
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      timeout.reject(
        new Error(`Chrome broker shutdown did not complete within ${options.timeoutMs} milliseconds`),
      );
    }, options.timeoutMs);
    try {
      await Promise.race([cleanupBrokerChild(options, reason), timeout.promise]);
      exitOnce(0);
    } catch {
      exitOnce(1);
    } finally {
      clearTimeout(timer);
    }
  };

  const request = (reason: string, severity: BrokerChildTerminationSeverity): void => {
    if (severity === "fatal") exitCode = 1;
    if (terminating) return;
    terminating = true;
    terminate(reason).catch(() => exitOnce(1));
  };

  return Object.freeze({ request });
};
