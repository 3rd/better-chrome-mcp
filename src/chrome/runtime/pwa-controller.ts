import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { z } from "zod/v4";
import { isNodeError } from "../../platform/node-errors";
import { CDP_METHOD_NOT_FOUND, CdpCommandError } from "./cdp-connection";
import { ChromeRuntimeError } from "./errors";
import { type BrowserMode, isIsolatedMode } from "./modes";

const httpUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
}, "Use an absolute HTTP(S) URL without credentials");

const manifestIdSchema = httpUrlSchema.refine(
  (value) => !new URL(value).hash,
  "Manifest ID must not contain a fragment",
);
const pwaIdentitySchema = z.object({ manifestId: manifestIdSchema }).strict();
export const PWA_CDP_METHODS = [
  "PWA.changeAppUserSettings",
  "PWA.getOsAppState",
  "PWA.install",
  "PWA.launch",
  "PWA.uninstall",
] as const;
export type PwaCdpMethod = (typeof PWA_CDP_METHODS)[number];
export type PwaCommand = (
  method: PwaCdpMethod,
  params: { manifestId: string; [key: string]: unknown },
) => Promise<unknown>;

export const isPwaCdpMethod = (method: string): method is PwaCdpMethod => {
  for (const cdpMethod of PWA_CDP_METHODS) {
    if (method === cdpMethod) return true;
  }

  return false;
};
const pwaCapabilitiesSchema = z.record(z.enum(PWA_CDP_METHODS), z.boolean());
export const pwaInstallInputSchema = pwaIdentitySchema
  .extend({
    displayMode: z.enum(["browser", "standalone"]).optional(),
    installUrl: httpUrlSchema,
  })
  .strict();
export const pwaLaunchInputSchema = pwaIdentitySchema.extend({ url: httpUrlSchema.optional() }).strict();
export const pwaOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("capabilities") }).strict(),
  pwaInstallInputSchema.extend({ operation: z.literal("install") }),
  pwaLaunchInputSchema.extend({ operation: z.literal("launch") }),
  pwaIdentitySchema.extend({ operation: z.literal("getState") }),
  pwaIdentitySchema.extend({ operation: z.literal("uninstall") }),
]);

export type PwaOperation = z.infer<typeof pwaOperationSchema>;
export type PwaInstallInput = z.infer<typeof pwaInstallInputSchema>;
export type PwaLaunchInput = z.infer<typeof pwaLaunchInputSchema>;

export const pwaStateSchema = z
  .object({
    badgeCount: z.number().int().nonnegative(),
    fileHandlers: z.array(
      z
        .object({
          accepts: z.array(z.object({ fileExtensions: z.array(z.string()), mediaType: z.string() }).strict()),
          action: z.string(),
          displayName: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export const pwaResultSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("capabilities"), cdp: pwaCapabilitiesSchema }).strict(),
  z
    .object({
      operation: z.literal("install"),
      manifestId: manifestIdSchema,
      displayMode: z.enum(["browser", "standalone"]),
    })
    .strict(),
  z.object({ operation: z.literal("launch"), targetId: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("getState"), state: pwaStateSchema }).strict(),
  z.object({ operation: z.literal("uninstall"), manifestId: manifestIdSchema }).strict(),
]);

export type PwaResult = z.infer<typeof pwaResultSchema>;

const PWA_INSTALL_MAX_COUNT = 32;
export const PWA_INSTALL_RECEIPT_FILE = "pwa-installs.json";
const receiptSchema = z.array(manifestIdSchema).max(PWA_INSTALL_MAX_COUNT);
const isMissingFile = (error: unknown) => isNodeError(error, "ENOENT");

export const readPwaReceipts = async (receiptPath: string) => {
  let data: unknown;

  try {
    data = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }

    data = [];
  }

  return receiptSchema.parse(data);
};

export class PwaController {
  private readonly sendCommand: PwaCommand | undefined;
  private readonly resolvePageTarget: (targetId: string, signal: AbortSignal) => Promise<string>;
  private readonly browserMode: BrowserMode;
  private readonly receiptPath: string;
  private installedManifestIds = new Set<string>();
  private hasLoadedReceipts = false;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    sendCommand?: PwaCommand;
    mode: BrowserMode;
    receiptPath: string;
    resolvePageTarget: (targetId: string, signal: AbortSignal) => Promise<string>;
  }) {
    this.sendCommand = options.sendCommand;
    this.resolvePageTarget = options.resolvePageTarget;
    this.browserMode = options.mode;
    this.receiptPath = options.receiptPath;
  }

  execute(input: PwaOperation, signal: AbortSignal) {
    return this.enqueueOperation(() => this.executeOperation(input, signal));
  }

  close() {
    return this.enqueueOperation(() => this.cleanupInstallations());
  }

  private enqueueOperation<Result>(runOperation: () => Promise<Result>) {
    const completion = this.operationTail.then(runOperation);
    this.operationTail = completion.then(
      () => undefined,
      () => undefined,
    );
    return completion;
  }

  private async executeOperation(input: PwaOperation, signal: AbortSignal) {
    signal.throwIfAborted();

    if (input.operation === "capabilities") {
      const entries = await Promise.all(
        PWA_CDP_METHODS.map(async (method) => {
          const canSendCommands = isIsolatedMode(this.browserMode) && this.sendCommand !== undefined;
          if (!canSendCommands) return [method, false];

          try {
            await this.sendCommand(method, { manifestId: "" });
          } catch (error: unknown) {
            const isMissingCommand = error instanceof CdpCommandError && error.code === CDP_METHOD_NOT_FOUND;
            if (isMissingCommand) return [method, false];

            if (!(error instanceof CdpCommandError)) {
              throw error;
            }
          }

          return [method, true];
        }),
      );
      signal.throwIfAborted();
      return {
        operation: "capabilities",
        cdp: pwaCapabilitiesSchema.parse(Object.fromEntries(entries)),
      } satisfies PwaResult;
    }

    if (!isIsolatedMode(this.browserMode)) {
      throw new ChromeRuntimeError("CHROME_MCP_INVALID_MODE", "PWA helpers require an isolated browser");
    }

    if (!this.sendCommand) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_UNSUPPORTED_CAPABILITY",
        "PWA helpers require this owner's trusted Chrome pipe connection",
      );
    }

    await this.loadReceipts();
    signal.throwIfAborted();

    if (input.operation === "install") {
      const hasReachedInstallLimit =
        !this.installedManifestIds.has(input.manifestId) &&
        this.installedManifestIds.size >= PWA_INSTALL_MAX_COUNT;
      if (hasReachedInstallLimit) {
        throw new ChromeRuntimeError(
          "CHROME_MCP_PWA_FAILED",
          `At most ${PWA_INSTALL_MAX_COUNT} PWA installations can belong to one browser owner`,
        );
      }

      const didOwnInstallation = this.installedManifestIds.has(input.manifestId);
      this.installedManifestIds.add(input.manifestId);
      await this.writeReceipts();
      signal.throwIfAborted();

      try {
        await this.sendCdp("PWA.install", {
          manifestId: input.manifestId,
          installUrlOrBundleUrl: input.installUrl,
        });
      } catch (error: unknown) {
        const didRejectMissingCommand =
          !didOwnInstallation &&
          error instanceof ChromeRuntimeError &&
          error.code === "CHROME_MCP_UNSUPPORTED_CAPABILITY";
        if (didRejectMissingCommand) {
          this.installedManifestIds.delete(input.manifestId);
          await this.writeReceipts();
        }

        throw error;
      }

      signal.throwIfAborted();

      const displayMode = input.displayMode ?? "browser";
      await this.sendCdp("PWA.changeAppUserSettings", { manifestId: input.manifestId, displayMode });
      signal.throwIfAborted();
      return { operation: "install", manifestId: input.manifestId, displayMode } satisfies PwaResult;
    }

    if (input.operation === "launch") {
      const result = await this.sendCdp("PWA.launch", {
        manifestId: input.manifestId,
        ...(input.url === undefined ? {} : { url: input.url }),
      });
      signal.throwIfAborted();

      const launched = pwaResultSchema.parse({ operation: "launch", ...result });
      if (launched.operation !== "launch") {
        throw new ChromeRuntimeError("CHROME_MCP_PWA_FAILED", "PWA launch did not return a target");
      }

      return {
        operation: "launch",
        targetId: await this.resolvePageTarget(launched.targetId, signal),
      } satisfies PwaResult;
    }

    if (input.operation === "getState") {
      const state = pwaStateSchema.parse(
        await this.sendCdp("PWA.getOsAppState", { manifestId: input.manifestId }),
      );
      signal.throwIfAborted();
      return { operation: "getState", state } satisfies PwaResult;
    }

    await this.sendCdp("PWA.uninstall", { manifestId: input.manifestId });
    this.installedManifestIds.delete(input.manifestId);
    await this.writeReceipts();
    signal.throwIfAborted();
    return { operation: "uninstall", manifestId: input.manifestId } satisfies PwaResult;
  }

  private async cleanupInstallations() {
    if (!isIsolatedMode(this.browserMode)) return;

    await this.loadReceipts();
    const errors: unknown[] = [];

    for (const manifestId of this.installedManifestIds) {
      try {
        let isInstalled = true;

        try {
          if (!this.sendCommand) {
            throw new ChromeRuntimeError(
              "CHROME_MCP_UNSUPPORTED_CAPABILITY",
              "PWA cleanup requires the owner's trusted Chrome pipe connection",
            );
          }

          await this.sendCommand("PWA.getOsAppState", { manifestId });
        } catch (error: unknown) {
          const isUnknownManifest =
            error instanceof CdpCommandError && error.message === `Unknown web-app manifest id ${manifestId}`;
          if (!isUnknownManifest) {
            throw error;
          }

          isInstalled = false;
        }

        if (isInstalled) {
          await this.sendCdp("PWA.uninstall", { manifestId });
        }

        this.installedManifestIds.delete(manifestId);
        await this.writeReceipts();
      } catch (error: unknown) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "PWA cleanup failed; the profile and installation receipts were preserved",
      );
    }
  }

  private async sendCdp(method: PwaCdpMethod, params: Parameters<PwaCommand>[1]) {
    if (!this.sendCommand) {
      throw new ChromeRuntimeError(
        "CHROME_MCP_UNSUPPORTED_CAPABILITY",
        "PWA commands require the owner's trusted Chrome pipe connection",
      );
    }

    try {
      const result = await this.sendCommand(method, params);
      const hasInvalidResult = typeof result !== "object" || result === null || Array.isArray(result);
      if (hasInvalidResult) {
        throw new ChromeRuntimeError("CHROME_MCP_PWA_FAILED", `${method} returned an invalid result`);
      }

      return result;
    } catch (error: unknown) {
      if (error instanceof CdpCommandError) {
        const code =
          error.code === CDP_METHOD_NOT_FOUND ? "CHROME_MCP_UNSUPPORTED_CAPABILITY" : "CHROME_MCP_PWA_FAILED";
        throw new ChromeRuntimeError(code, `${method}: ${error.message}`, { cause: error });
      }

      throw error;
    }
  }

  private async loadReceipts() {
    if (this.hasLoadedReceipts) return;

    this.installedManifestIds = new Set(await readPwaReceipts(this.receiptPath));
    this.hasLoadedReceipts = true;
  }

  private async writeReceipts() {
    if (this.installedManifestIds.size === 0) {
      try {
        await unlink(this.receiptPath);
      } catch (error: unknown) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }

      return;
    }

    const temporaryPath = `${this.receiptPath}.${crypto.randomUUID()}.tmp`;

    try {
      await writeFile(temporaryPath, JSON.stringify([...this.installedManifestIds]), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.receiptPath);
    } catch (error: unknown) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError: unknown) {
        if (!isMissingFile(cleanupError)) {
          throw new AggregateError([error, cleanupError], "PWA receipt write and cleanup failed");
        }
      }
      throw error;
    }
  }
}
