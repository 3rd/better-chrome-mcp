/**
 * Portions of this file are adapted from ChromeDevTools/chrome-devtools-mcp.
 * Copyright 2025 Google LLC. Licensed under Apache-2.0.
 */
import { join } from "node:path";
import { type DiagnosticFileSystem, NodeDiagnosticFileSystem, replaceExtension } from "./file-system";
import { type DiagnosticOutputPathResolver, rejectingDiagnosticOutputPathResolver } from "./output-path";
import { SubprocessLighthouseRunner } from "./subprocess";
import {
  ChromeDiagnosticError,
  type DiagnosticCall,
  type DiagnosticToolResult,
  LIGHTHOUSE_CATEGORIES,
  LIGHTHOUSE_MAX_WAIT_FOR_LOAD_MS,
  type LighthouseDevice,
  type LighthouseEngineResult,
  type LighthouseInput,
  type LighthouseMode,
  type LighthouseRunner,
  type LighthouseScreenEmulation,
  type SelectedPageProvider,
  textResult,
} from "./types";

type LighthouseDiagnosticsOptions = {
  files?: DiagnosticFileSystem;
  outputPaths?: DiagnosticOutputPathResolver;
  pageProvider: SelectedPageProvider;
  runner?: LighthouseRunner;
};

const screenEmulation = (device: LighthouseDevice): LighthouseScreenEmulation =>
  device === "desktop" ?
    {
      mobile: false,
      width: 1350,
      height: 940,
      deviceScaleFactor: 1,
      disabled: false,
    }
  : {
      mobile: true,
      width: 412,
      height: 823,
      deviceScaleFactor: 1.75,
      disabled: false,
    };

const summarizeLighthouse = (
  result: LighthouseEngineResult,
  mode: LighthouseMode,
  device: LighthouseDevice,
  reports: string[],
) => {
  const scores = result.categories.map(({ id, score, title }) => ({ id, score, title }));
  const failed = result.audits.filter(({ score }) => score !== null && score < 1).length;
  const passed = result.audits.filter(({ score }) => score === 1).length;
  return {
    summary: {
      mode,
      device,
      url: result.mainDocumentUrl,
      scores,
      audits: { failed, passed },
      timing: { total: result.totalTiming },
    },
    reports,
  };
};

const formatLighthouse = (result: ReturnType<typeof summarizeLighthouse>): string[] => {
  const lines = [
    "## Lighthouse Audit Results",
    `Mode: ${result.summary.mode}`,
    `Device: ${result.summary.device}`,
    `URL: ${result.summary.url}`,
    "### Category Scores",
  ];
  for (const score of result.summary.scores) {
    const displayScore = score.score === null ? "unavailable" : score.score * 100;
    lines.push(`- ${score.title}: ${displayScore} (${score.id})`);
  }
  lines.push(
    "### Audit Summary",
    `Passed: ${result.summary.audits.passed}`,
    `Failed: ${result.summary.audits.failed}`,
    `Total Timing: ${result.summary.timing.total}ms`,
    "### Reports",
  );
  for (const report of result.reports) lines.push(`- ${report}`);
  return lines;
};

export class LighthouseDiagnostics {
  readonly #defaultReportsByConnection = new Map<string, Set<string>>();
  readonly #files: DiagnosticFileSystem;
  readonly #pageProvider: SelectedPageProvider;
  readonly #outputPaths: DiagnosticOutputPathResolver;
  readonly #runner: LighthouseRunner;

  constructor(options: LighthouseDiagnosticsOptions) {
    this.#files = options.files ?? new NodeDiagnosticFileSystem();
    this.#pageProvider = options.pageProvider;
    this.#outputPaths = options.outputPaths ?? rejectingDiagnosticOutputPathResolver;
    this.#runner = options.runner ?? new SubprocessLighthouseRunner();
  }

  async audit(call: DiagnosticCall, input: LighthouseInput): Promise<DiagnosticToolResult> {
    const outputDirectory =
      input.outputDirPath ?
        await this.#outputPaths.resolveDirectory({ call, path: input.outputDirPath })
      : undefined;
    const page = await this.#pageProvider.acquire(call);
    const mode = input.mode ?? "navigation";
    const device = input.device ?? "desktop";
    let result: LighthouseEngineResult | undefined;
    let failure: unknown;
    try {
      result = await this.#runner.run({
        categories: LIGHTHOUSE_CATEGORIES,
        device,
        engineTarget: page.engineTarget,
        maxWaitForLoadMs: LIGHTHOUSE_MAX_WAIT_FOR_LOAD_MS,
        mode,
        screenEmulation: screenEmulation(device),
      });
      if (!result) {
        throw new ChromeDiagnosticError("CHROME_MCP_LIGHTHOUSE_FAILED", "Lighthouse audit failed.");
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        await page.restoreEmulation();
      } catch (error) {
        if (failure === undefined) failure = error;
      }
      try {
        await this.#pageProvider.release(page);
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
    if (failure !== undefined) throw failure;
    if (!result) throw new ChromeDiagnosticError("CHROME_MCP_LIGHTHOUSE_FAILED", "Lighthouse audit failed.");

    const reports = await this.#writeReports(call.connectionId, result, outputDirectory);
    const lighthouseResult = summarizeLighthouse(result, mode, device, reports);
    return textResult(formatLighthouse(lighthouseResult), { lighthouseResult });
  }

  async releaseConnection(connectionId: string): Promise<void> {
    const reports = this.#defaultReportsByConnection.get(connectionId);
    this.#defaultReportsByConnection.delete(connectionId);
    if (!reports) return;
    const results = await Promise.allSettled([...reports].map(async (report) => this.#files.remove(report)));
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(({ reason }) => reason),
        "Lighthouse report cleanup failed",
      );
    }
  }

  async #writeReports(
    connectionId: string,
    result: LighthouseEngineResult,
    outputDirPath: string | undefined,
  ): Promise<string[]> {
    const reports: string[] = [];
    try {
      const jsonPath =
        outputDirPath ?
          replaceExtension(join(outputDirPath, "report"), ".json")
        : await this.#files.createTemporaryPath("report.json");
      reports.push(jsonPath);
      const htmlPath =
        outputDirPath ?
          replaceExtension(join(outputDirPath, "report"), ".html")
        : await this.#files.createTemporaryPath("report.html");
      reports.push(htmlPath);
      await this.#files.writeAtomic(jsonPath, result.reports.json, true);
      await this.#files.writeAtomic(htmlPath, result.reports.html, true);
      if (!outputDirPath) {
        const connectionReports = this.#defaultReportsByConnection.get(connectionId) ?? new Set<string>();
        for (const report of reports) connectionReports.add(report);
        this.#defaultReportsByConnection.set(connectionId, connectionReports);
      }
      return reports;
    } catch (error) {
      await Promise.allSettled(reports.map(async (report) => this.#files.remove(report)));
      throw error;
    }
  }
}
