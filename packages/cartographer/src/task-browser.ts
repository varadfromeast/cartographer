import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import type {
  Action,
  ActOutcome,
  BrowserSession,
  BrowserSessionFactory,
  Domain,
  LaunchOptions,
  ObservedCandidate,
  TaskId,
} from "./contracts.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fs-json.js";
import { browserProfileDir, browserSessionPath } from "./paths.js";
import { locatorForSelector } from "./playwright-selector.js";
import { waitForLoginIfNeeded } from "./login-wait.js";
import { getSiteConfig } from "./site-config.js";
import { cartographerBrowserExecutablePath } from "./browser-provider.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface TaskBrowserLease {
  taskId: TaskId;
  ownerPid: number;
  updatedAt: string;
}

export interface TaskBrowserRecord {
  schemaVersion: 1;
  domain: Domain;
  profile: string;
  activeTaskIds: TaskId[];
  activeTaskLeases?: TaskBrowserLease[];
  pid: number;
  port: number;
  cdpUrl: string;
  createdAt: string;
  updatedAt: string;
}

const TASK_LEASE_STALE_MS = 6 * 60 * 60 * 1000;

export class TaskScopedBrowserSessionFactory implements BrowserSessionFactory {
  constructor(
    private readonly fallbackFactory = new PlaywrightBrowserSessionFactory(),
  ) {}

  async launch(
    domain: Domain,
    options: LaunchOptions,
  ): Promise<BrowserSession> {
    const site = getSiteConfig(domain);
    if (!options.taskId) return this.fallbackFactory.launch(domain, options);
    const connection = await connectOrStartTaskBrowser(
      domain,
      options.taskId,
      options.profile,
    );
    const session = new PlaywrightBrowserSession(domain, connection, false);
    await waitForLoginIfNeeded(session, site.loginWaitLabel);
    return session;
  }

  async launchInstagram(options: LaunchOptions): Promise<BrowserSession> {
    return this.launch("instagram.com", options);
  }
}

export class PlaywrightBrowserSessionFactory implements BrowserSessionFactory {
  async launch(
    domain: Domain,
    options: LaunchOptions,
  ): Promise<BrowserSession> {
    const site = getSiteConfig(domain);
    const profileDir = browserProfilePath(domain, options.profile);
    await ensureDir(profileDir);
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: cartographerBrowserExecutablePath(),
      headless: options.headless,
      viewport: options.viewport,
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(site.baseUrl, {
      waitUntil: "domcontentloaded",
    });
    const session = new PlaywrightBrowserSession(
      domain,
      { context, page },
      true,
    );
    await waitForLoginIfNeeded(session, site.loginWaitLabel);
    return session;
  }

  async launchInstagram(options: LaunchOptions): Promise<BrowserSession> {
    return this.launch("instagram.com", options);
  }
}

export async function connectOrStartTaskBrowser(
  domain: Domain,
  taskId: TaskId,
  profile = "default",
): Promise<{
  browser?: Browser;
  context: BrowserContext;
  page: Page;
  cdpUrl: string;
}> {
  const existing = await readJsonFile<TaskBrowserRecord>(
    browserSessionPath(domain, profile),
  );
  if (existing && (await isCdpAlive(existing.cdpUrl))) {
    const normalized = normalizeTaskBrowserRecord(existing);
    await writeJsonFile(
      browserSessionPath(domain, profile),
      withTaskLease(normalized, taskId),
    );
    try {
      return await connectTaskBrowser(existing.cdpUrl);
    } catch {
      terminatePid(existing.pid);
      await fs.rm(browserSessionPath(domain, profile), { force: true });
    }
  }

  const recordPath = browserSessionPath(domain, profile);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const port = await reservePort();
    const cdpUrl = `http://127.0.0.1:${port}`;
    const profileDir = browserProfilePath(domain, profile);
    await ensureDir(profileDir);
    await ensureDir(path.dirname(recordPath));
    const child = spawn(
      cartographerBrowserExecutablePath(),
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        getSiteConfig(domain).baseUrl,
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();

    const record: TaskBrowserRecord = {
      schemaVersion: 1,
      domain,
      profile,
      activeTaskIds: [taskId],
      activeTaskLeases: [
        {
          taskId,
          ownerPid: process.pid,
          updatedAt: new Date().toISOString(),
        },
      ],
      pid: child.pid || 0,
      port,
      cdpUrl,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFile(recordPath, record);
    try {
      await waitForCdp(cdpUrl);
      return await connectTaskBrowser(cdpUrl);
    } catch (error) {
      terminatePid(record.pid);
      await fs.rm(recordPath, { force: true });
      if (attempt === 1) throw error;
    }
  }
  throw new Error("Task browser startup retry exhausted.");
}

function browserProfilePath(domain: Domain, profile = "default"): string {
  return (
    process.env.CARTOGRAPHER_BROWSER_PROFILE_DIR ||
    browserProfileDir(domain, profile)
  );
}

export async function closeTaskBrowser(
  domain: Domain,
  taskId: TaskId,
  profile = "default",
  options: { keepBrowserOpen?: boolean } = {},
): Promise<{
  closed: boolean;
  recordPath: string;
  remainingTaskIds?: TaskId[];
}> {
  const recordPath = browserSessionPath(domain, profile);
  const record = await readJsonFile<TaskBrowserRecord>(recordPath);
  if (!record) return { closed: false, recordPath };
  const normalized = normalizeTaskBrowserRecord(record);
  const remainingLeases = (normalized.activeTaskLeases || []).filter(
    (lease) => lease.taskId !== taskId,
  );
  const remainingTaskIds = remainingLeases.map((lease) => lease.taskId);
  if (remainingTaskIds.length) {
    await writeJsonFile(recordPath, {
      ...normalized,
      activeTaskIds: remainingTaskIds,
      activeTaskLeases: remainingLeases,
      updatedAt: new Date().toISOString(),
    });
    return { closed: false, recordPath, remainingTaskIds };
  }
  if (options.keepBrowserOpen) {
    await writeJsonFile(recordPath, {
      ...normalized,
      activeTaskIds: [],
      activeTaskLeases: [],
      updatedAt: new Date().toISOString(),
    });
    return { closed: false, recordPath, remainingTaskIds: [] };
  }
  try {
    const browser = await chromium.connectOverCDP(record.cdpUrl);
    await browser.close();
  } catch {
    terminatePid(record.pid);
  }
  if (isPidAlive(record.pid)) terminatePid(record.pid);
  await fs.rm(recordPath, { force: true });
  return { closed: true, recordPath, remainingTaskIds: [] };
}

function withTaskLease(
  record: TaskBrowserRecord,
  taskId: TaskId,
): TaskBrowserRecord {
  const updatedAt = new Date().toISOString();
  const leases = [
    ...(record.activeTaskLeases || []).filter(
      (lease) => lease.taskId !== taskId,
    ),
    { taskId, ownerPid: process.pid, updatedAt },
  ];
  return {
    ...record,
    activeTaskIds: leases.map((lease) => lease.taskId),
    activeTaskLeases: leases,
    updatedAt,
  };
}

export function normalizeTaskBrowserRecord(
  record: TaskBrowserRecord,
): TaskBrowserRecord {
  const activeTaskLeases = (record.activeTaskLeases || []).filter((lease) =>
    isTaskLeaseAlive(lease),
  );
  return {
    ...record,
    activeTaskIds: activeTaskLeases.map((lease) => lease.taskId),
    activeTaskLeases,
  };
}

export function activeTaskIdsFor(record?: TaskBrowserRecord): TaskId[] {
  return record ? normalizeTaskBrowserRecord(record).activeTaskIds : [];
}

function isTaskLeaseAlive(lease: TaskBrowserLease): boolean {
  if (Date.now() - Date.parse(lease.updatedAt) > TASK_LEASE_STALE_MS)
    return false;
  return isPidAlive(lease.ownerPid);
}

function isPidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminatePid(pid: number): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

async function connectTaskBrowser(cdpUrl: string): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdpUrl: string;
}> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());
  return { browser, context, page, cdpUrl };
}

async function isCdpAlive(cdpUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(cdpUrl: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (await isCdpAlive(cdpUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Task browser did not expose CDP at ${cdpUrl}`);
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

class PlaywrightBrowserSession implements BrowserSession {
  constructor(
    public readonly domain: Domain,
    private readonly connection: {
      browser?: Browser;
      context: BrowserContext;
      page: Page;
    },
    private readonly closeContext: boolean,
  ) {}

  async currentUrl(): Promise<string> {
    return this.connection.page.url();
  }

  async goto(url: string): Promise<void> {
    await this.connection.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async observe(_instruction: string): Promise<ObservedCandidate[]> {
    throw new Error("Task-scoped Playwright sessions do not support observe.");
  }

  async act(): Promise<ActOutcome> {
    throw new Error(
      "Task-scoped Playwright sessions do not support candidate act.",
    );
  }

  async actRaw(action: Action): Promise<ActOutcome> {
    const locator = locatorForSelector(
      this.connection.page,
      action.selector,
    ).first();
    const args = action.arguments || [];
    try {
      if (action.method === "click") {
        await locator.click();
      } else if (action.method === "dblclick") {
        await requireLocatorMethod(locator, "dblclick")();
      } else if (action.method === "hover") {
        await requireLocatorMethod(locator, "hover")();
      } else if (action.method === "fill") {
        await locator.fill(args[0] || "");
      } else if (action.method === "type") {
        await requireLocatorMethod(locator, "type")(args[0] || "");
      } else if (action.method === "press") {
        await requireLocatorMethod(locator, "press")(args[0] || "");
      } else if (action.method === "check") {
        await requireLocatorMethod(locator, "check")();
      } else if (action.method === "uncheck") {
        await requireLocatorMethod(locator, "uncheck")();
      } else if (action.method === "select") {
        await requireLocatorMethod(locator, "selectOption")(args);
      } else if (action.method === "upload") {
        await requireLocatorMethod(locator, "setInputFiles")(args);
      } else if (action.method === "goto") {
        await this.goto(action.selector);
      } else {
        return {
          success: false,
          message: `Unsupported replay method: ${action.method || "unknown"}`,
          actions: [],
        };
      }
      return {
        success: true,
        message: `Action ${action.method} completed.`,
        actions: [action],
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
        actions: [],
      };
    }
  }

  async exists(selector: string): Promise<boolean> {
    return (
      (await locatorForSelector(this.connection.page, selector).count()) > 0
    );
  }

  async readText(selector = "body"): Promise<string> {
    return await locatorForSelector(this.connection.page, selector).innerText();
  }

  async readTextExcluding(
    selector: string,
    excludeSelectors: string[],
  ): Promise<string> {
    return await locatorForSelector(this.connection.page, selector).evaluateAll(
      (elements, excludes) => {
        const shouldSkip = (element: Element): boolean =>
          excludes.some((exclude) => {
            try {
              return (
                element.matches(exclude) || Boolean(element.closest(exclude))
              );
            } catch {
              return false;
            }
          });
        const textFrom = (node: Node): string => {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
          if (!(node instanceof Element)) return "";
          if (shouldSkip(node)) return "";
          if (
            node instanceof HTMLInputElement ||
            node instanceof HTMLTextAreaElement ||
            node instanceof HTMLSelectElement
          ) {
            return "";
          }
          return Array.from(node.childNodes).map(textFrom).join(" ");
        };
        return elements.map(textFrom).join(" ").replace(/\s+/g, " ").trim();
      },
      excludeSelectors,
    );
  }

  async isVisible(selector: string): Promise<boolean> {
    return await locatorForSelector(this.connection.page, selector)
      .first()
      .isVisible();
  }

  async isEnabled(selector: string): Promise<boolean> {
    return await locatorForSelector(this.connection.page, selector)
      .first()
      .isEnabled();
  }

  async scrollIntoView(selector: string): Promise<void> {
    await locatorForSelector(this.connection.page, selector)
      .first()
      .scrollIntoViewIfNeeded();
  }

  async wait(milliseconds: number): Promise<void> {
    await this.connection.page.waitForTimeout(milliseconds);
  }

  async waitForSettle(): Promise<void> {
    await this.connection.page.waitForLoadState("networkidle").catch(() => {});
    await this.connection.page
      .waitForFunction(() => document.readyState === "complete", undefined, {
        timeout: 2000,
      })
      .catch(() => {});
    await this.connection.page.waitForTimeout(100);
  }

  async screenshot(label: string): Promise<string> {
    const { FileEvidenceStore } = await import("./evidence-store.js");
    const artifact = await new FileEvidenceStore().captureScreenshot({
      domain: this.domain,
      label,
      screenshot: () => this.connection.page.screenshot(),
    });
    return artifact.path;
  }

  async waitForUser(label: string): Promise<void> {
    const rl = readline.createInterface({ input, output });
    try {
      await rl.question(`${label} Press Enter to continue... `);
    } finally {
      rl.close();
    }
  }

  async close(): Promise<void> {
    if (this.closeContext) {
      await this.connection.context.close();
      return;
    }
    disconnectBrowserClient(this.connection.browser);
  }
}

function requireLocatorMethod<T extends (...args: any[]) => Promise<any>>(
  locator: unknown,
  method: string,
): T {
  const fn = (locator as Record<string, unknown>)[method];
  if (typeof fn !== "function") {
    throw new Error(
      `Playwright locator replay does not support method: ${method}`,
    );
  }
  return fn.bind(locator) as T;
}

function disconnectBrowserClient(browser: Browser | undefined): void {
  (browser as { disconnect?: () => void } | undefined)?.disconnect?.();
}
