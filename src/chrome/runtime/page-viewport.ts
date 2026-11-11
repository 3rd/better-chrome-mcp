import { z } from "zod/v4";
import type { BrowserContext, Page } from "playwright-core";
import { cdpRecord } from "./cdp-connection";
import { ChromeRuntimeError } from "./errors";

const viewportDimensionSchema = z.int32().nonnegative();

export const viewportSizeSchema = z
  .object({ width: viewportDimensionSchema, height: viewportDimensionSchema })
  .strict();
export const pageViewportStateSchema = viewportSizeSchema.nullable();
export const pageViewportRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read"), targetId: z.string().min(1) }).strict(),
  z
    .object({ operation: z.literal("set"), targetId: z.string().min(1), viewport: viewportSizeSchema })
    .strict(),
]);

export type PageViewportRequest = z.output<typeof pageViewportRequestSchema>;
export type PageViewportState = z.output<typeof pageViewportStateSchema>;
export type PageViewportController = (
  request: PageViewportRequest,
  signal: AbortSignal,
) => Promise<PageViewportState>;

export const parseViewportSize = (value: unknown) => {
  const parsed = viewportSizeSchema.safeParse(value);
  if (!parsed.success) {
    throw new ChromeRuntimeError("CHROME_MCP_INVALID_INPUT", parsed.error.message);
  }

  return parsed.data;
};

type ViewportPageRegistry = {
  pages: Map<string, Page>;
  registrations: WeakMap<Page, Promise<string | undefined>>;
};

type ViewportPageLookup = {
  contexts: readonly BrowserContext[];
  registry: ViewportPageRegistry;
  targetId: string;
  signal: AbortSignal;
};

const registerViewportPage = (registry: ViewportPageRegistry, page: Page) => {
  const existing = registry.registrations.get(page);
  if (existing) {
    return existing;
  }

  const register = async () => {
    const session = await page.context().newCDPSession(page);
    let targetId: unknown;
    try {
      const result: unknown = await session.send("Target.getTargetInfo");
      targetId = cdpRecord(cdpRecord(result)?.targetInfo)?.targetId;
    } finally {
      await session.detach();
    }

    if (typeof targetId !== "string" || page.isClosed()) {
      return undefined;
    }

    const registeredTargetId = targetId;
    registry.pages.set(registeredTargetId, page);
    page.once("close", () => registry.pages.delete(registeredTargetId));
    return registeredTargetId;
  };
  const registration = register().catch((error: unknown) => {
    registry.registrations.delete(page);
    throw error;
  });
  registry.registrations.set(page, registration);
  return registration;
};

const findViewportPage = async ({ contexts, registry, targetId, signal }: ViewportPageLookup) => {
  signal.throwIfAborted();
  const registeredPage = registry.pages.get(targetId);
  if (registeredPage) {
    return registeredPage;
  }

  const found = Promise.withResolvers<Page>();
  let finished = false;
  const inspect = async (page: Page) => {
    if (finished || page.isClosed()) {
      return;
    }

    try {
      if ((await registerViewportPage(registry, page)) === targetId) {
        found.resolve(page);
      }
    } catch (error: unknown) {
      if (!page.isClosed()) {
        throw error;
      }
    }
  };
  const onPage = (page: Page) => {
    inspect(page).catch(found.reject);
  };
  const onAbort = () => found.reject(signal.reason);
  const onClose = () => found.reject(new Error("Chrome viewport context closed during page registration"));

  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (const context of contexts) {
      context.on("page", onPage);
      context.on("close", onClose);
      for (const page of context.pages()) {
        onPage(page);
      }
    }

    return await found.promise;
  } finally {
    finished = true;
    signal.removeEventListener("abort", onAbort);
    for (const context of contexts) {
      context.off("page", onPage);
      context.off("close", onClose);
    }
  }
};

export const createPageViewportController = (contexts: readonly BrowserContext[]): PageViewportController => {
  const registry: ViewportPageRegistry = { pages: new Map(), registrations: new WeakMap() };

  return async (request, signal) => {
    const page = await findViewportPage({ contexts, registry, targetId: request.targetId, signal });
    signal.throwIfAborted();
    if (request.operation === "set") {
      const viewport = parseViewportSize(request.viewport);
      await page.setViewportSize(viewport);
    }

    return page.viewportSize();
  };
};

export const connectPageViewportController = async (endpoint: string) => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
  const contexts = browser.contexts();
  for (const context of contexts) {
    context.on("dialog", () => undefined);
  }

  return {
    pageViewport: createPageViewportController(contexts),
    disconnect: () => browser.close(),
  };
};
