/**
 * This adapter uses the public Lighthouse and Puppeteer package entry points. Lighthouse execution stays attached to
 * the broker-selected target and never launches or closes Chrome.
 * Portions of the audit flow are adapted from ChromeDevTools/chrome-devtools-mcp.
 * Copyright 2025 Google LLC. Licensed under Apache-2.0.
 */
import { fileURLToPath } from "node:url";
import type { Flags as LighthouseFlags } from "lighthouse";
import type { LighthouseEngineResult, LighthouseRunnerInput } from "./types";
import { isRecord } from "../../platform/records";

export const LIGHTHOUSE_VERSION = "13.3.0";

type UnknownRecord = Record<string, unknown>;

type LighthouseConnectionTarget = {
  browserURL?: string;
  browserWSEndpoint?: string;
  targetId: string;
};

const verifyLighthouseVersion = async (): Promise<void> => {
  const packagePath = fileURLToPath(import.meta.resolve("lighthouse/package.json"));
  let decoded: unknown;
  try {
    decoded = JSON.parse(await Bun.file(packagePath).text());
  } catch {
    throw new Error("Unable to read the Lighthouse package metadata");
  }
  if (!isRecord(decoded) || decoded.version !== LIGHTHOUSE_VERSION) {
    const installed = isRecord(decoded) && typeof decoded.version === "string" ? decoded.version : "unknown";
    throw new Error(`Lighthouse ${installed} is installed; diagnostics require ${LIGHTHOUSE_VERSION}`);
  }
};

const requireRecord = (value: unknown, name: string): UnknownRecord => {
  if (!isRecord(value)) throw new Error(`Lighthouse returned invalid ${name}`);
  return value;
};

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Lighthouse returned invalid ${name}`);
  return value;
};

const requireNumber = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Lighthouse returned invalid ${name}`);
  }
  return value;
};

const requireScore = (value: unknown, name: string): number | null => {
  if (value === null) return null;
  return requireNumber(value, name);
};

const connectionTarget = (value: UnknownRecord): LighthouseConnectionTarget => {
  const targetId = requireString(value.targetId, "targetId");
  const browserWSEndpoint = typeof value.browserWSEndpoint === "string" ? value.browserWSEndpoint : undefined;
  const browserURL = typeof value.browserURL === "string" ? value.browserURL : undefined;
  if (!browserWSEndpoint && !browserURL) {
    throw new Error("The broker did not provide a Lighthouse browserWSEndpoint or browserURL");
  }
  return {
    ...(browserURL ? { browserURL } : {}),
    ...(browserWSEndpoint ? { browserWSEndpoint } : {}),
    targetId,
  };
};

const lighthouseFlags = (input: LighthouseRunnerInput): LighthouseFlags => ({
  formFactor: input.device,
  logLevel: "silent",
  maxWaitForLoad: input.maxWaitForLoadMs,
  onlyCategories: [...input.categories],
  screenEmulation: input.screenEmulation,
});

const normalizeLighthouseCategories = (value: unknown) => {
  const categories = requireRecord(value, "categories");
  return Object.values(categories).map((categoryValue) => {
    const category = requireRecord(categoryValue, "category");
    return {
      id: requireString(category.id, "category id"),
      score: requireScore(category.score, "category score"),
      title: requireString(category.title, "category title"),
    };
  });
};

const normalizeLighthouseAudits = (value: unknown) => {
  const audits = requireRecord(value, "audits");
  return Object.values(audits).map((auditValue) => {
    const audit = requireRecord(auditValue, "audit");
    return { score: requireScore(audit.score, "audit score") };
  });
};

export const normalizeLighthouseResult = (
  runnerResult: unknown,
  reportGenerator: unknown,
): LighthouseEngineResult => {
  const result = requireRecord(runnerResult, "runner result");
  const lhr = requireRecord(result.lhr, "result document");
  if (typeof reportGenerator !== "function") throw new Error("Lighthouse did not export generateReport()");
  const json: unknown = Reflect.apply(reportGenerator, undefined, [lhr, "json"]);
  const html: unknown = Reflect.apply(reportGenerator, undefined, [lhr, "html"]);
  const timing = requireRecord(lhr.timing, "timing");
  const mainDocumentUrl = [lhr.mainDocumentUrl, lhr.finalDisplayedUrl, lhr.finalUrl].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return {
    audits: normalizeLighthouseAudits(lhr.audits),
    categories: normalizeLighthouseCategories(lhr.categories),
    mainDocumentUrl: requireString(mainDocumentUrl, "main document URL"),
    reports: {
      html: requireString(html, "HTML report"),
      json: requireString(json, "JSON report"),
    },
    totalTiming: requireNumber(timing.total, "total timing"),
  };
};

export const runLighthouseEngine = async (input: LighthouseRunnerInput): Promise<LighthouseEngineResult> => {
  await verifyLighthouseVersion();
  const target = connectionTarget(input.engineTarget);
  const [lighthouse, puppeteer] = await Promise.all([import("lighthouse"), import("puppeteer-core")]);
  const browser =
    target.browserWSEndpoint ?
      await puppeteer.connect({ browserWSEndpoint: target.browserWSEndpoint })
    : await puppeteer.connect({ browserURL: target.browserURL });
  try {
    let selectedPage: Awaited<ReturnType<typeof browser.pages>>[number] | undefined;
    for (const page of await browser.pages()) {
      const cdp = await page.createCDPSession();
      try {
        const payload: unknown = await cdp.send("Target.getTargetInfo");
        const envelope = requireRecord(payload, "target information");
        const targetInfo = requireRecord(envelope.targetInfo, "target information");
        if (targetInfo.targetId === target.targetId) {
          selectedPage = page;
          break;
        }
      } finally {
        await cdp.detach();
      }
    }
    if (!selectedPage) throw new Error("The broker-selected target is not available to Lighthouse");

    const flags = lighthouseFlags(input);
    const runnerResult: unknown =
      input.mode === "navigation" ?
        await lighthouse.navigation(selectedPage, selectedPage.url(), { flags })
      : await lighthouse.snapshot(selectedPage, { flags });
    if (!runnerResult) throw new Error("Lighthouse audit failed.");
    return normalizeLighthouseResult(runnerResult, lighthouse.generateReport);
  } finally {
    await browser.disconnect();
  }
};
