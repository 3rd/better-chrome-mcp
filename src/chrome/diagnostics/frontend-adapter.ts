/**
 * Chrome DevTools Frontend's published MCP entry is bundled here because its npm package ships TypeScript sources and
 * omits the generated locale module. The entry and formatter behavior remain pinned to the package version below.
 * Portions of the parse and formatter flow are adapted from ChromeDevTools/chrome-devtools-mcp.
 * Copyright 2025 Google LLC. Licensed under Apache-2.0.
 */
import { chmod, mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../platform/records";
import { getMcpRuntimeDir } from "../../platform/runtime-paths";

export const CHROME_DEVTOOLS_FRONTEND_VERSION = "1.0.1708524";

const FRONTEND_ADAPTER_CACHE_VERSION = 4;
const FRONTEND_LOCALE = "en-US";
const FRONTEND_CACHE_DIRECTORY = join(getMcpRuntimeDir(), "chrome-mcp", "diagnostics");
const FRONTEND_LOCALE_MODULE = `
export const LOCALES = ["${FRONTEND_LOCALE}"];
export const BUNDLED_LOCALES = ["${FRONTEND_LOCALE}"];
export const DEFAULT_LOCALE = "${FRONTEND_LOCALE}";
export const REMOTE_FETCH_PATTERN = "";
export const LOCAL_FETCH_PATTERN = "";
`;

type UnknownRecord = Record<string, unknown>;
type FrontendFunction = (...argumentsList: unknown[]) => unknown;

const isFileNotFound = (error: unknown): boolean => isRecord(error) && error.code === "ENOENT";

const isFrontendFunction = (value: unknown): value is FrontendFunction => typeof value === "function";

export const requireFrontendRecord = (value: unknown, name: string) => {
  if (!isRecord(value)) throw new Error(`Chrome DevTools Frontend did not provide ${name}`);
  return value;
};

export const readFrontendProperty = (owner: unknown, key: string) => {
  const isPropertyOwner = (typeof owner === "object" && owner !== null) || typeof owner === "function";
  if (!isPropertyOwner) throw new Error(`Chrome DevTools Frontend owner for ${key} is invalid`);

  const value: unknown = Reflect.get(owner, key);

  return value;
};

export const requireFrontendPropertyRecord = (owner: unknown, key: string) => {
  return requireFrontendRecord(readFrontendProperty(owner, key), key);
};

export const requireFrontendFunction = (owner: unknown, key: string) => {
  const value = readFrontendProperty(owner, key);
  if (!isFrontendFunction(value)) throw new Error(`Chrome DevTools Frontend did not provide ${key}()`);

  return value;
};

export const callFrontendMethod = (owner: unknown, method: string, argumentsList: unknown[] = []) => {
  const result: unknown = Reflect.apply(requireFrontendFunction(owner, method), owner, argumentsList);

  return result;
};

const readPackageVersion = async (): Promise<string> => {
  const packagePath = fileURLToPath(import.meta.resolve("chrome-devtools-frontend/package.json"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(packagePath).text());
  } catch {
    throw new Error("Unable to read the Chrome DevTools Frontend package metadata");
  }
  const packageJson = requireFrontendRecord(parsed, "package metadata");
  if (typeof packageJson.version !== "string") {
    throw new TypeError("Chrome DevTools Frontend has no package version");
  }
  return packageJson.version;
};

const cachedBundleExists = async (path: string): Promise<boolean> => {
  try {
    const metadata = await stat(path);
    return metadata.isFile() && metadata.size > 100_000;
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
};

const buildFrontendBundle = async (destination: string, kind: "heap" | "trace") => {
  const entrypoint = fileURLToPath(import.meta.resolve("chrome-devtools-frontend/mcp/mcp.ts"));
  const result = await Bun.build({
    entrypoints: [entrypoint],
    format: "esm",
    minify: true,
    metafile: true,
    plugins: [
      {
        name: "chrome-devtools-frontend-generated-locales",
        setup(build) {
          build.onLoad({ filter: /\/mcp\/mcp\.ts$/ }, () => ({
            contents:
              kind === "heap" ?
                'export * as HeapSnapshotWorker from "../front_end/entrypoints/heap_snapshot_worker/heap_snapshot_worker.js";'
              : [
                  'export * as I18n from "../front_end/core/i18n/i18n.js";',
                  'export * as TraceEngine from "../front_end/models/trace/trace.js";',
                  'export {AgentFocus} from "../front_end/models/ai_assistance/performance/AIContext.js";',
                  'export {PerformanceTraceFormatter} from "../front_end/models/ai_assistance/data_formatters/PerformanceTraceFormatter.js";',
                  'export {PerformanceInsightFormatter} from "../front_end/models/ai_assistance/data_formatters/PerformanceInsightFormatter.js";',
                ].join("\n"),
            loader: "ts",
          }));
          build.onResolve({ filter: /\/locales\.js$/ }, (args) => {
            if (args.path !== "./locales.js" || !args.importer.endsWith("/front_end/core/i18n/i18nImpl.ts")) {
              return;
            }
            return { namespace: "chrome-devtools-locales", path: args.path };
          });
          build.onLoad({ filter: /.*/, namespace: "chrome-devtools-locales" }, () => ({
            contents: FRONTEND_LOCALE_MODULE,
            loader: "js",
          }));
        },
      },
    ],
    target: "bun",
  });
  if (!result.success) {
    const detail = result.logs.map((log) => log.message).join("; ");
    throw new Error(
      detail ?
        `Unable to bundle Chrome DevTools Frontend: ${detail}`
      : "Unable to bundle Chrome DevTools Frontend",
    );
  }
  const output = result.outputs[0];
  if (!output) throw new Error("Chrome DevTools Frontend bundling produced no output");

  const temporaryPath = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporaryPath, output);
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, destination);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  if (!result.metafile) {
    throw new Error("Chrome DevTools Frontend bundling produced no input metadata");
  }

  return Object.keys(result.metafile.inputs);
};

const assertFrontendPackageVersion = async () => {
  const installedVersion = await readPackageVersion();
  if (installedVersion !== CHROME_DEVTOOLS_FRONTEND_VERSION) {
    throw new Error(
      `Chrome DevTools Frontend ${installedVersion} is installed; diagnostics require ${CHROME_DEVTOOLS_FRONTEND_VERSION}`,
    );
  }
};

export const buildChromeFrontendBundles = async (destinationDirectory: string) => {
  await assertFrontendPackageVersion();
  await mkdir(destinationDirectory, { recursive: true });
  const bundledInputs = await Promise.all([
    buildFrontendBundle(join(destinationDirectory, "frontend-trace.mjs"), "trace"),
    buildFrontendBundle(join(destinationDirectory, "frontend-heap.mjs"), "heap"),
  ]);

  return bundledInputs.flat();
};

const resolveFrontendBundle = async (kind: "heap" | "trace"): Promise<string> => {
  const shippedBundle = fileURLToPath(new URL(`./frontend-${kind}.mjs`, import.meta.url));
  if (await cachedBundleExists(shippedBundle)) return shippedBundle;

  await assertFrontendPackageVersion();
  await mkdir(FRONTEND_CACHE_DIRECTORY, { mode: 0o700, recursive: true });
  await chmod(FRONTEND_CACHE_DIRECTORY, 0o700);
  const bunVersion = Bun.version.replaceAll(/[^\d.A-Za-z-]/g, "-");
  const bundlePath = join(
    FRONTEND_CACHE_DIRECTORY,
    `chrome-devtools-frontend-${kind}-${CHROME_DEVTOOLS_FRONTEND_VERSION}-adapter-${FRONTEND_ADAPTER_CACHE_VERSION}-bun-${bunVersion}.mjs`,
  );
  if (!(await cachedBundleExists(bundlePath))) await buildFrontendBundle(bundlePath, kind);
  return bundlePath;
};

export const loadChromeFrontend = async (): Promise<UnknownRecord> => {
  const loaded: unknown = await import(await resolveFrontendBundle("trace"));
  const frontend = requireFrontendRecord(loaded, "MCP entry exports");
  const i18nNamespace = requireFrontendPropertyRecord(frontend, "I18n");
  const i18n = requireFrontendPropertyRecord(i18nNamespace, "i18n");
  const localeNamespace = requireFrontendPropertyRecord(i18nNamespace, "DevToolsLocale");
  callFrontendMethod(readFrontendProperty(localeNamespace, "DevToolsLocale"), "instance", [
    {
      create: true,
      data: {
        settingLanguage: FRONTEND_LOCALE,
        navigatorLanguage: FRONTEND_LOCALE,
        lookupClosestDevToolsLocale: requireFrontendFunction(i18n, "lookupClosestSupportedDevToolsLocale"),
      },
    },
  ]);
  callFrontendMethod(i18n, "registerLocaleDataForTest", [FRONTEND_LOCALE, {}]);
  return frontend;
};

export const loadHeapFrontend = async () => {
  const loaded: unknown = await import(await resolveFrontendBundle("heap"));
  return requireFrontendPropertyRecord(
    requireFrontendRecord(loaded, "heap entry exports"),
    "HeapSnapshotWorker",
  );
};
